import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { ALLOWED_TIER_B_OPERATIONS, ExternalError } from "../services/router-core-sim/src/external-protocol.ts";
import { ExternalDeviceStore } from "../services/router-core-sim/src/external-device-store.ts";
import { ExternalControlServer } from "../services/router-core-sim/src/external-control.ts";
import { AudioChannel, SilenceSource, VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { fixture, testRoot, USER, GUILD, VC } from "./helpers/external-control-fixture.ts";
import { connectWs } from "./helpers/external-ws.ts";

const target = { kind: "user", discordUserId: USER };
const code = (r: any, expected: string, status?: number) => { assert.equal(r.body.code, expected); if (status) assert.equal(r.status, status); };
type Fixture = Awaited<ReturnType<typeof fixture>>;
const grant = (f: Fixture, operations: string[], deviceId = f.registration.deviceId) => f.api.manage({ action: "permissions", deviceId, readDisplayNames: false, allowedTierBOperations: operations });
const arm = (f: Fixture, operation = "bus.limiter.set", args: unknown = { busId: "bus", enabled: false }) => f.raw(f.request(operation, args), "/arm");
const execution = (f: Fixture, armId: string, extra = {}) => ({ requestId: randomUUID(), instanceId: f.api.state.instanceId, armId, ...extra });
const execute = (f: Fixture, armId: string) => f.raw(execution(f, armId), "/execute");
async function ready(f: Fixture, operations = ["bus.limiter.set"]) { grant(f, operations); f.api.manage({ action: "enable" }); }

test("B permissions persist exactly; A/unknown/duplicate grants corrupt the whole registration without overwriting", () => {
  const root = testRoot(), store = new ExternalDeviceStore(root), registered = store.register("Device");
  store.change(registered.deviceId, "permissions", true, ALLOWED_TIER_B_OPERATIONS);
  const saved = readFileSync(store.path, "utf8"), reloaded = new ExternalDeviceStore(root);
  assert.deepEqual(reloaded.authenticate(registered.token)?.allowedTierBOperations, [...ALLOWED_TIER_B_OPERATIONS].sort());
  reloaded.change(registered.deviceId, "permissions", false);
  assert.deepEqual(reloaded.authenticate(registered.token)?.allowedTierBOperations, [...ALLOWED_TIER_B_OPERATIONS].sort());
  for (const value of [["scene.preview"], ["tx.take"], ["unknown"], ["bus.limiter.set", "bus.limiter.set"], [null], "all"]) {
    const raw = JSON.parse(saved); raw.devices[0].allowedTierBOperations = value; const bytes = JSON.stringify(raw);
    writeFileSync(store.path, bytes); const broken = new ExternalDeviceStore(root);
    assert.equal(broken.available, false); assert.equal(Boolean(broken.authenticate(registered.token)), false);
    assert.throws(() => broken.setEnabled(true), ExternalError); assert.equal(readFileSync(store.path, "utf8") === bytes, true);
  }
});

test("Stop stays disabled after a failed save, exposes safe status, and stale enabled:true cannot reactivate on restart", async t => {
  const f = await fixture(t); await ready(f); const a = await arm(f); assert.equal(a.status, 200);
  const saved = join(f.root, "enabled-backup.json"); renameSync(f.store.path, saved); mkdirSync(f.store.path);
  f.api.manage({ action: "stop" }); assert.equal(f.store.enabled, false); assert.equal(f.api.managementSnapshot().stopSaveFailed, true);
  code(await execute(f, a.body.data.armId), "DISABLED", 503);
  const restartRoot = testRoot(); writeFileSync(join(restartRoot, "external-control.json"), readFileSync(saved));
  const restarted = new ExternalDeviceStore(restartRoot); assert.equal(restarted.available, true); assert.equal(restarted.enabled, false);
  restarted.setEnabled(true); assert.equal(restarted.enabled, true);
  rmdirSync(f.store.path); renameSync(saved, f.store.path); f.api.manage({ action: "enable" });
  assert.equal(f.store.stopSaveFailed, false); code(await execute(f, a.body.data.armId), "ARM_INVALID", 409);
});

test("128 slots count revoked records; only revoked devices can be deleted and deletion never revives credentials", () => {
  const root = testRoot(), initial = new ExternalDeviceStore(root), first = initial.register("Active");
  const raw = JSON.parse(readFileSync(initial.path, "utf8"));
  for (let i = 1; i < 128; i++) raw.devices.push({ ...raw.devices[0], deviceId: randomUUID(), name: "Revoked", revoked: true,
    tokenHash: createHash("sha256").update(`synthetic-${i}`).digest("hex") });
  writeFileSync(initial.path, JSON.stringify(raw)); const store = new ExternalDeviceStore(root);
  assert.equal(store.list().length, 128); assert.equal(store.summary().deviceCount, 1);
  assert.throws(() => store.register("Extra"), (e: any) => e.code === "RATE_LIMITED");
  assert.throws(() => store.delete(first.deviceId), (e: any) => e.code === "INVALID");
  const removed = raw.devices[1].deviceId; store.delete(removed); const next = store.register("Replacement");
  assert.equal(store.list().length, 128); assert.equal(store.list().some(d => d.deviceId === removed), false);
  assert.equal(next.deviceId !== removed, true); assert.equal(new ExternalDeviceStore(root).list().length, 128);
});

for (const [ms, expected, status] of [[999, "ARM_TOO_EARLY", 409], [1000, "SUCCESS", 200], [4999, "SUCCESS", 200], [5000, "ARM_EXPIRED", 410]] as const) {
  test(`B execute monotonic boundary ${ms} ms, consumption and deduplication`, async t => {
    const f = await fixture(t); await ready(f); const a = await arm(f); assert.equal(a.status, 200);
    assert.ok(typeof a.body.data.armId === "string" && Buffer.from(a.body.data.armId, "base64url").length >= 16);
    assert.equal(a.body.data.minimumHoldMs, 1000); assert.equal(a.body.data.expiresInMs, 5000);
    f.advance(ms); const body = execution(f, a.body.data.armId);
    const [reply, simultaneous] = await Promise.all([f.raw(body, "/execute"), f.raw(body, "/execute")]);
    assert.equal(simultaneous.status, status);
    assert.equal(reply.status, status); if (expected !== "SUCCESS") code(reply, expected); else assert.equal(reply.body.data.value, false);
    const commits = f.commands.length; assert.equal((await f.raw(body, "/execute")).status, status); assert.equal(f.commands.length, commits);
    code(await execute(f, a.body.data.armId), "ARM_INVALID", 409);
    assert.equal(f.bus.limiter.enabled, expected !== "SUCCESS");
  });
}

test("arm ownership, replacement, expiry tombstones, cross-path requestIds and execute shape prevent replay/overrides", async t => {
  const f = await fixture(t); await ready(f); const other = f.store.register("Other"); grant(f, ["bus.limiter.set"], other.deviceId);
  const a = await arm(f); assert.equal(a.status, 200); f.advance(1000);
  code(await f.raw(execution(f, a.body.data.armId), "/execute", { ...f.headers, authorization: `Bearer ${other.token}` }), "ARM_INVALID", 409);
  for (const extra of [{ operation: "bus.limiter.set" }, { args: {} }, { confirmed: true }, { expectedRevision: 1 }]) code(await f.raw(execution(f, a.body.data.armId, extra), "/execute"), "INVALID", 400);
  assert.equal((await execute(f, a.body.data.armId)).status, 200);
  const b = await arm(f), c = await arm(f); code(await execute(f, b.body.data.armId), "ARM_INVALID");
  f.advance(5000); code(await execute(f, c.body.data.armId), "ARM_EXPIRED", 410);
  const expired = await arm(f); f.advance(60000); code(await execute(f, expired.body.data.armId), "ARM_INVALID");
  const request = f.request("bus.limiter.set", { busId: "bus", enabled: true }); const armed = await f.raw(request, "/arm"); assert.equal(armed.status, 200);
  code(await f.raw(request), "INVALID"); code(await f.raw(execution(f, armed.body.data.armId, { requestId: request.requestId }), "/execute"), "INVALID");
});

for (const family of ["channel", "bus", "send", "tx"]) test(`${family} B fader returns to 0 dB outside A's burst, with scoped ABA dependencies`, async t => {
  const f = await fixture(t), operation = `${family}.fader.set`;
  await ready(f, [operation]); const args = family === "channel" ? { target } : family === "bus" ? { busId: "bus" } : family === "send" ? { target, busId: "bus" } : { profileId: "TX1" };
  assert.equal((await f.action(operation, { ...args, db: -40 })).status, 200);
  code(await f.action(operation, { ...args, db: 0 }), "CONFIRMATION_REQUIRED", 409);
  const a = await arm(f, operation, { ...args, db: 0 }); assert.equal(a.status, 200);
  assert.equal(a.body.data.summary.currentDb, -40); assert.equal(a.body.data.summary.targetDb, 0); assert.equal(a.body.data.summary.increaseDb, 40);
  await f.action(family === "bus" ? "channel.fader.adjust" : "bus.fader.adjust", family === "bus" ? { target, deltaDb: -1 } : { busId: "bus", deltaDb: -1 });
  f.advance(1000); assert.equal((await execute(f, a.body.data.armId)).status, 200);
  assert.equal((await f.action(operation, { ...args, db: -40 })).status, 200);
  const b = await arm(f, operation, { ...args, db: 0 }); assert.equal(b.status, 200);
  await f.action(operation, { ...args, db: -41 }); await f.action(operation, { ...args, db: -40 });
  code(await execute(f, b.body.data.armId), "STALE_REVISION", 409); // ABA despite same current dB.
  const c = await arm(f, operation, { ...args, db: 0 }); await f.action(operation, { ...args, db: -34 });
  f.advance(1000); code(await execute(f, c.body.data.armId), "STALE_REVISION");
  grant(f, []); code(await f.action(operation, { ...args, db: 0 }), "TIER_FORBIDDEN", 403);
  code(await arm(f, operation, { ...args, db: 0 }), "TIER_FORBIDDEN", 403);
  assert.equal(f.channel.approvalGateOpen, false); assert.equal(f.channel.vcSends.get("bus")!.mute, true);
});

test("A arm is INVALID; all future scene/recording operations stay forbidden even with grants; info/state disclose actual tiers", async t => {
  const f = await fixture(t); await ready(f, [...ALLOWED_TIER_B_OPERATIONS]);
  code(await arm(f, "tx.clear", {}), "INVALID", 400);
  code(await arm(f, "channel.fader.set", { target, db: -1 }), "INVALID", 400);
  for (const name of ["scene.preview", "scene.recall", "recording.start", "recording.stop"]) {
    code(await f.raw(f.request(name, {})), "TIER_FORBIDDEN", 403); code(await arm(f, name, {}), "TIER_FORBIDDEN", 403);
  }
  f.advance(); const response = await fetch(f.base + "/info", { headers: f.headers }), info = (await response.json() as any).data;
  assert.deepEqual(info.permissions.allowedTierBOperations, [...ALLOWED_TIER_B_OPERATIONS].sort());
  assert.deepEqual((await f.state()).permissions, info.permissions);
  for (const operation of info.operations) {
    assert.equal(/^(scene|recording)\./.test(operation.name), false);
    assert.deepEqual(operation.tiers, operation.name === "bus.limiter.set" || operation.name === "bus.compressor.set" ? ["B"]
      : operation.name.endsWith(".fader.set") || ["emergency.set", "settings.lock.set"].includes(operation.name) ? ["A", "B"] : ["A"]);
  }
  assert.equal(new Set(info.operations.map((o: any) => o.name)).size, info.operations.length);
});

test("compressor checks only changed parameters and Bus identity, detects ABA, and preserves unspecified parameters", async t => {
  const f = await fixture(t); await ready(f, ["bus.compressor.set"]);
  const a = await arm(f, "bus.compressor.set", { busId: "bus", ratio: 5 }); assert.equal(a.status, 200);
  f.control.execute({ type: "SET_BUS_COMPRESSOR", busId: "bus", thresholdDb: -30 }); f.api.observe();
  await f.action("bus.fader.adjust", { busId: "bus", deltaDb: -1 }); f.advance(1000);
  const reply = await execute(f, a.body.data.armId); assert.equal(reply.status, 200); assert.equal(reply.body.data.value.ratio, 5); assert.equal(reply.body.data.value.thresholdDb, -30);
  const b = await arm(f, "bus.compressor.set", { busId: "bus", ratio: 6 });
  f.control.execute({ type: "SET_BUS_COMPRESSOR", busId: "bus", ratio: 7 }); f.api.observe();
  f.control.execute({ type: "SET_BUS_COMPRESSOR", busId: "bus", ratio: 5 }); f.api.observe(); f.advance(1000);
  code(await execute(f, b.body.data.armId), "STALE_REVISION");
  const c = await arm(f, "bus.compressor.set", { busId: "bus", ratio: 6 });
  f.engine.buses.set("bus", new VcBus("bus", "Replacement", 480, 48000)); f.api.observe(); f.advance(1000);
  code(await execute(f, c.body.data.armId), "STALE_REVISION");
  for (const args of [{}, { ratio: 21 }, { attackMs: 0 }, { releaseMs: 2001 }, { thresholdDb: -61 }, { makeupDb: 25 }, { enabled: 1 }, { ratio: 3, confirmed: true }]) {
    code(await arm(f, "bus.compressor.set", { busId: "bus", ...args }), "INVALID", 400);
  }
});

test("limiter preserves structural locks and its own value generation; arm performs safety checks without executing", async t => {
  const f = await fixture(t); await ready(f); const a = await arm(f); assert.equal(f.commands.length, 0);
  f.control.execute({ type: "SET_LIMITER", busId: "bus", enabled: false }); f.api.observe();
  f.control.execute({ type: "SET_LIMITER", busId: "bus", enabled: true }); f.api.observe(); f.advance(1000);
  code(await execute(f, a.body.data.armId), "STALE_REVISION");
  const b = await arm(f); f.control.state = "ON_AIR"; f.advance(1000); code(await execute(f, b.body.data.armId), "LOCKED", 409);
  code(await arm(f), "LOCKED", 409); f.control.state = "READY"; code(await arm(f), "LOCKED", 409);
  assert.equal((await arm(f, "bus.limiter.set", { busId: "bus", enabled: true })).status, 200);
  code(await f.action("bus.limiter.set", { busId: "missing", enabled: false }), "CONFIRMATION_REQUIRED", 409);
});

test("opaque Bus IDs cannot collide with other targets' dependency keys", async t => {
  const f = await fixture(t); await ready(f, ["bus.compressor.set"]);
  f.engine.addBus(new VcBus("bus:compressor:ratio", "Opaque target", 480, 48000));
  const a = await arm(f, "bus.compressor.set", { busId: "bus", ratio: 5 });
  f.engine.buses.set("bus:compressor:ratio", new VcBus("bus:compressor:ratio", "Unrelated replacement", 480, 48000));
  f.api.observe(); f.advance(1000); assert.equal((await execute(f, a.body.data.armId)).status, 200);
});

test("emergency release requires epoch and READY/recovered devices, ignores unrelated faders and rechecks at execute", async t => {
  const f = await fixture(t); await ready(f, ["emergency.set"]); await f.action("emergency.set", { active: true });
  code(await arm(f, "emergency.set", { active: false }), "INVALID", 400);
  const args = { active: false, expectedEmergencyEpoch: f.control.emergencyEpoch };
  code(await arm(f, "emergency.set", args), "LOCKED", 409); f.control.state = "READY";
  const a = await arm(f, "emergency.set", args); assert.equal(a.status, 200); assert.equal(f.engine.emergencyMuted, true);
  await f.action("channel.fader.adjust", { target, deltaDb: -1 }); f.advance(1000);
  const reply = await execute(f, a.body.data.armId); assert.equal(reply.status, 200); assert.equal(reply.body.data.value, false);
  assert.equal((f.commands.at(-1) as any).confirmed, true);
  await f.action("emergency.set", { active: true }); const nextArgs = { ...args, expectedEmergencyEpoch: f.control.emergencyEpoch };
  const b = await arm(f, "emergency.set", nextArgs); f.control.state = "FAULT"; f.advance(1000);
  code(await execute(f, b.body.data.armId), "LOCKED", 409); f.control.state = "READY";
  const c = await arm(f, "emergency.set", nextArgs); f.control.emergencyEpoch++; f.advance(1000);
  code(await execute(f, c.body.data.armId), "STALE_REVISION");
  code(await arm(f, "emergency.set", nextArgs), "STALE_REVISION");
});

test("settings unlock is B with state ABA protection, SETUP no-op, and no implicit recovery/mute release", async t => {
  const f = await fixture(t); await ready(f, ["settings.lock.set"]); await f.action("settings.lock.set", { locked: true });
  const a = await arm(f, "settings.lock.set", { locked: false }); assert.equal(a.status, 200); f.advance(1000);
  assert.equal((await execute(f, a.body.data.armId)).status, 200); assert.equal(f.control.state, "SETUP");
  const before = f.commands.length, noop = await arm(f, "settings.lock.set", { locked: false }); f.advance(1000);
  assert.equal((await execute(f, noop.body.data.armId)).status, 200); assert.equal(f.commands.length, before);
  const b = await arm(f, "settings.lock.set", { locked: false });
  await f.action("settings.lock.set", { locked: true }); f.control.execute({ type: "SET_STATE", state: "SETUP", confirmed: true }); f.api.observe(); f.advance(1000);
  code(await execute(f, b.body.data.armId), "STALE_REVISION");
  for (const state of ["READY", "FAULT"] as const) { f.control.state = state; code(await arm(f, "settings.lock.set", { locked: false }), "LOCKED"); }
});

test("fixed participant ignores unrelated joins; slot, participant reappearance, send replacement and TX metadata ABA invalidate arms", async t => {
  const f = await fixture(t); await ready(f, ["channel.fader.set", "send.fader.set", "tx.fader.set"]);
  await f.action("channel.fader.set", { target, db: -40 });
  const a = await arm(f, "channel.fader.set", { target, db: 0 });
  const channel = new AudioChannel(`discord-user:${GUILD}:${VC}:100000000000000002`, "Another private guest", "DiscordUser", new SilenceSource(), 480, 48000);
  f.engine.addChannel(channel); f.sessions.join(channel, "100000000000000002", VC, channel.label); f.api.observe(); f.advance(1000);
  assert.equal((await execute(f, a.body.data.armId)).status, 200);
  await f.action("channel.fader.set", { target, db: -40 });
  const b = await arm(f, "channel.fader.set", { target, db: 0 });
  f.sessions.leave(f.channel); f.sessions.join(f.channel, USER, VC, f.channel.label); f.api.observe(); f.advance(1000);
  code(await execute(f, b.body.data.armId), "STALE_REVISION");
  const slot = { kind: "slot", scope: { kind: "all" }, index: 1, expectedParticipantsRevision: f.api.state.participantsRevision };
  const c = await arm(f, "channel.fader.set", { target: slot, db: 0 }); assert.equal(c.status, 200);
  f.sessions.leave(channel); f.engine.channels.delete(channel.id); f.api.observe(); f.advance(1000); code(await execute(f, c.body.data.armId), "STALE_REVISION");
  await f.action("send.fader.set", { target, busId: "bus", db: -40 });
  const d = await arm(f, "send.fader.set", { target, busId: "bus", db: 0 });
  f.channel.vcSends.set("bus", { ...f.channel.vcSends.get("bus")! }); f.api.observe(); f.advance(1000); code(await execute(f, d.body.data.armId), "STALE_REVISION");
  await f.action("tx.fader.set", { profileId: "TX1", db: -40 });
  const e = await arm(f, "tx.fader.set", { profileId: "TX1", db: 0 }); f.botState(0, { txDestination: "INTERVIEW" }); f.botState(0); f.advance(1000);
  code(await execute(f, e.body.data.armId), "STALE_REVISION");
});

for (const action of ["permissions", "reissue", "revoke"] as const) test(`${action} invalidates arm and WS, and SETUP is required`, async t => {
  const f = await fixture(t); await ready(f); const ws = await connectWs(f.api.port, f.headers.authorization); t.after(() => ws.socket.destroy()); await ws.next();
  const a = await arm(f); f.control.state = "ON_AIR";
  const payload = { action, deviceId: f.registration.deviceId, ...(action === "permissions" ? { readDisplayNames: false, allowedTierBOperations: ["bus.limiter.set"] } : {}) };
  assert.throws(() => f.api.manage(payload), (e: any) => e.code === "LOCKED"); f.control.state = "SETUP";
  const result = f.api.manage(payload) as any; assert.equal((await ws.next()).closeCode, 4001); f.advance(1000);
  if (action === "permissions") code(await execute(f, a.body.data.armId), "ARM_INVALID");
  else code(await execute(f, a.body.data.armId), "UNAUTHORIZED", 401);
  if (action === "reissue") code(await f.raw(execution(f, a.body.data.armId), "/execute", { ...f.headers, authorization: `Bearer ${result.token}` }), "ARM_INVALID");
});

test("WS disconnect discards arm; HTTP connection completion does not", async t => {
  const f = await fixture(t); await ready(f); const ws = await connectWs(f.api.port, f.headers.authorization); await ws.next();
  const a = await arm(f); ws.socket.destroy(); await new Promise(resolve => setTimeout(resolve, 30)); f.advance(1000);
  code(await execute(f, a.body.data.armId), "ARM_INVALID");
  const b = await arm(f); f.advance(1000); assert.equal((await execute(f, b.body.data.armId)).status, 200);
});

test("revoked B grant returns TIER_FORBIDDEN for its owner; regrant cannot revive the invalidated arm", async t => {
  const f = await fixture(t); await ready(f); const a = await arm(f); grant(f, []); f.advance(1000);
  code(await execute(f, a.body.data.armId), "TIER_FORBIDDEN", 403);
  grant(f, ["bus.limiter.set"]); code(await execute(f, a.body.data.armId), "ARM_INVALID", 409);
  assert.equal(f.commands.length, 0);
});

test("B TX arm rejects FAULT and emergency arm/execute both recheck device recovery without adding confirmed", async t => {
  const f = await fixture(t); await ready(f, ["tx.fader.set", "emergency.set"]);
  await f.action("tx.fader.set", { profileId: "TX1", db: -40 }); f.control.state = "FAULT";
  code(await arm(f, "tx.fader.set", { profileId: "TX1", db: 0 }), "LOCKED", 409);
  f.control.state = "READY"; await f.action("emergency.set", { active: true });
  const args = { active: false, expectedEmergencyEpoch: f.control.emergencyEpoch };
  let outputReady = false, inputReady = true;
  (f.control as any).outputManager = { snapshot: () => ({ state: outputReady ? "READY" : "FAULT" }) };
  (f.control as any).inputManager = { snapshot: () => ({ state: inputReady ? "READY" : "FAULT" }) };
  code(await arm(f, "emergency.set", args), "LOCKED", 409); outputReady = true;
  const a = await arm(f, "emergency.set", args); assert.equal(a.status, 200); inputReady = false; f.advance(1000);
  const before = f.commands.length; code(await execute(f, a.body.data.armId), "LOCKED", 409); assert.equal(f.commands.length, before);
  assert.equal(f.engine.emergencyMuted, true); (f.control as any).outputManager = undefined; (f.control as any).inputManager = undefined;
});

for (const change of ["stop", "permissions", "reissue", "revoke"] as const) test(`body-in-flight execute cannot commit after ${change}`, async t => {
  const f = await fixture(t); await ready(f); const a = await arm(f); f.advance(1000);
  const payload = JSON.stringify(execution(f, a.body.data.armId)); let finish!: () => void;
  const arrived = new Promise<void>(resolve => f.api.server.once("request", () => resolve()));
  const response = new Promise<number>((resolve, reject) => {
    const req = httpRequest(f.base + "/execute", { method: "POST", headers: { ...f.headers, "content-length": Buffer.byteLength(payload) } }, res => { res.resume(); resolve(res.statusCode!); });
    req.on("error", reject); req.write(payload.slice(0, 10)); finish = () => req.end(payload.slice(10));
  });
  await arrived;
  if (change === "stop") { f.api.manage({ action: "stop" }); f.api.manage({ action: "enable" }); }
  else if (change === "permissions") grant(f, ["bus.limiter.set"]);
  else f.api.manage({ action: change, deviceId: f.registration.deviceId });
  finish(); assert.equal(await response, change === "stop" ? 503 : change === "permissions" ? 403 : 401);
  assert.equal(f.commands.length, 0); assert.equal(f.bus.limiter.enabled, true);
});

test("restart drops arm, explicit enable is necessary, and old instance cannot execute", async t => {
  const f = await fixture(t); await ready(f); const a = await arm(f); await f.api.close();
  const restarted = new ExternalControlServer({ ...f.api.options, store: new ExternalDeviceStore(f.root) }); await restarted.start(); t.after(() => restarted.close());
  f.advance(1000); code(await execute(f, a.body.data.armId), "DISABLED", 503); restarted.manage({ action: "enable" });
  code(await execute(f, a.body.data.armId), "STALE_REVISION");
  code(await f.raw(execution(f, a.body.data.armId, { instanceId: restarted.state.instanceId }), "/execute"), "ARM_INVALID");
});

test("idle/disabled observation sleeps, resumes monotonically, rejects old slots/targets and preserves A dedup", async t => {
  const f = await fixture(t); let observations = 0; const observe = f.api.state.observe.bind(f.api.state);
  f.api.state.observe = () => { observations++; observe(); };
  for (let i = 0; i < 10; i++) { f.api.tick(); f.api.observe(); } assert.equal(observations, 0);
  f.api.manage({ action: "enable" }); const state = await f.state(); assert.ok(observations > 0);
  const committed = f.request("channel.fader.adjust", { target, deltaDb: -1 }); assert.equal((await f.raw(committed)).status, 200);
  f.advance(31000); f.api.tick(); const asleep = observations;
  f.control.execute({ type: "SET_CHANNEL_FADER", channelId: f.channel.id, db: -2 }); f.api.observe();
  f.control.execute({ type: "SET_CHANNEL_FADER", channelId: f.channel.id, db: -1 }); f.api.observe();
  for (let i = 0; i < 10; i++) f.api.tick(); assert.equal(observations, asleep);
  const resumed = await f.state(); assert.ok(resumed.revision > state.revision); assert.ok(resumed.participantsRevision > state.participantsRevision); assert.ok(resumed.tx.targetsRevision > state.tx.targetsRevision);
  code(await f.action("tx.targets.set", { selection: { kind: "profiles", profileIds: ["TX1"] }, expectedTargetsRevision: state.tx.targetsRevision }), "STALE_REVISION");
  code(await f.action("channel.mute.set", { target: { kind: "slot", scope: { kind: "all" }, index: 1, expectedParticipantsRevision: state.participantsRevision }, mute: true }), "STALE_REVISION");
  assert.equal((await f.raw(committed)).status, 200); assert.equal(f.channel.faderDb, -1);
});

test("external action log has deviceId, actual B tier and phase; no names/hash/token/arm/raw body in state/log", async t => {
  const f = await fixture(t); await ready(f); const a = await arm(f); f.advance(1000);
  const body = execution(f, a.body.data.armId); assert.equal((await f.raw(body, "/execute")).status, 200); assert.equal((await f.raw(body, "/execute")).status, 200);
  const log = f.logs.join("\n"); assert.ok(log.includes(`deviceId=${f.registration.deviceId}`));
  assert.match(log, /tier=B result=SUCCESS phase=arm/); assert.match(log, /tier=B result=SUCCESS phase=execute/); assert.match(log, /deduplicated=true/);
  const state = JSON.stringify(await f.state());
  for (const secret of [f.registration.token, a.body.data.armId, JSON.parse(readFileSync(f.store.path, "utf8")).devices[0].tokenHash, "Private guest", "Private device", '"armId"']) {
    assert.equal(log.includes(secret), false); assert.equal(state.includes(secret), false);
  }
  assert.equal(state.includes(f.registration.deviceId), false);
  grant(f, []); code(await f.raw(body, "/execute"), "TIER_FORBIDDEN", 403);
});

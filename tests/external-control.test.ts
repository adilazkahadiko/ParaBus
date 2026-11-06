import { clientFrame, connectWs } from "./helpers/external-ws.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { COMMAND_POLICIES, OPERATIONS, TIER_B_OPERATIONS, Bucket, ExternalError, classifyCommand, strictJson } from "../services/router-core-sim/src/external-protocol.ts";
import { ExternalDeviceStore } from "../services/router-core-sim/src/external-device-store.ts";
import { ExternalControlServer } from "../services/router-core-sim/src/external-control.ts";
import { ExternalState } from "../services/router-core-sim/src/external-state.ts";
import { AudioChannel, SilenceSource, VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { websocketReceiver } from "../services/router-core-sim/src/websocket.ts";
import { decodeDiscordFrame, DiscordFrameType, DiscordTxFlags } from "../packages/discord-ipc/src/index.ts";
import type { ControlCommand } from "../packages/shared-types/src/index.ts";
import { fixture, testRoot, USER, GUILD, VC } from "./helpers/external-control-fixture.ts";

const target = { kind: "user", discordUserId: USER };
const code = (reply: any, expected: string, status?: number) => { assert.equal(reply.body.code, expected); if (status) assert.equal(reply.status, status); };

test("external classification is exhaustive, unique and closed for every ControlCommand", () => {
  const source = readFileSync(new URL("../packages/shared-types/src/index.ts", import.meta.url), "utf8").split("export type ControlCommand =")[1].split("export interface CommandResult")[0];
  const types = [...new Set([...source.matchAll(/type: "([A-Z_]+)"/g)].map(m => m[1]))];
  assert.equal(types.length, 56); assert.deepEqual(Object.keys(COMMAND_POLICIES).sort(), types.sort());
  assert.equal(new Set(OPERATIONS).size, OPERATIONS.length);
  const context = { state: "SETUP" };
  assert.equal(classifyCommand({ type: "NEW_UNCLASSIFIED" } as unknown as ControlCommand, context), "C");
  for (const [type, policy] of Object.entries(COMMAND_POLICIES)) if (["A", "B", "C"].includes(policy)) assert.equal(classifyCommand({ type } as ControlCommand, context), policy);
  assert.equal(classifyCommand({ type: "START_TX" }, context), "C");
  assert.equal(classifyCommand({ type: "START_TX", profileId: "TX1" }, context), "A");
  assert.equal(classifyCommand({ type: "SET_STATE", state: "ON_AIR" }, context), "A");
  assert.equal(classifyCommand({ type: "SET_STATE", state: "SETUP" }, { state: "ON_AIR" }), "B");
  assert.equal(classifyCommand({ type: "SET_STATE", state: "READY" }, context), "C");
  assert.equal(classifyCommand({ type: "EMERGENCY_MUTE", active: true }, context), "A");
  assert.equal(classifyCommand({ type: "EMERGENCY_MUTE", active: false, expectedEmergencyEpoch: 1 }, context), "B");
  assert.equal(classifyCommand({ type: "SET_CHANNEL_FADER", channelId: "x", db: 0 }, context), "C");
  for (const increaseDb of [0, 6, 6.001]) for (const adjust of [true, false]) {
    assert.equal(classifyCommand({ type: "SET_BUS_MASTER", busId: "b", db: 0 }, { ...context, increaseDb, adjust }), increaseDb <= 6 ? "A" : adjust ? "C" : "B");
  }
});

test("strict JSON rejects duplicate escaped keys, nesting abuse and non-finite numbers", () => {
  for (const input of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":2}}', "1e999", "[1,]", "{}{}", "NaN", "Infinity", "[".repeat(40) + "0" + "]".repeat(40)]) {
    assert.throws(() => strictJson(input), ExternalError);
  }
  assert.deepEqual(strictJson('{"a":[true,null,-1.5e2,"a\\\"b"]}'), { a: [true, null, -150, 'a"b'] });
});

test("registration persists only protected hashes and metadata, reissue/revoke and corrupt fail closed", () => {
  const root = testRoot(), store = new ExternalDeviceStore(root);
  assert.equal(store.enabled, false); assert.equal(store.port, 4175);
  for (const name of ["", "  ", "x\ny", "a".repeat(81)]) assert.throws(() => store.register(name), ExternalError);
  const { token, deviceId } = store.register("Device <text>");
  const serialized = readFileSync(store.path, "utf8"); assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes(createHash("sha256").update(token).digest("hex")), true);
  assert.equal(JSON.stringify(store.list()).includes("token"), false);
  assert.equal(store.authenticate(token)?.readDisplayNames, false); assert.deepEqual(store.authenticate(token)?.allowedTierBOperations, []);
  store.setEnabled(true); assert.equal(new ExternalDeviceStore(root).enabled, false);
  const renewed = store.change(deviceId, "reissue") as { token: string }; assert.equal(store.authenticate(token), undefined); assert.ok(store.authenticate(renewed.token));
  store.change(deviceId, "permissions", true); assert.equal(store.authenticate(renewed.token)?.readDisplayNames, true);
  store.change(deviceId, "revoke"); assert.equal(store.authenticate(renewed.token), undefined); assert.deepEqual(store.summary(), { deviceCount: 0, enabled: true });
  writeFileSync(join(root, "external-control.json"), "{"); const corrupt = new ExternalDeviceStore(root); assert.equal(corrupt.available, false); assert.equal(corrupt.enabled, false);
});

test("Node 22 fetch succeeds with Bearer while browser, Host and alternate authentication are rejected", async t => {
  const f = await fixture(t);
  code(await f.raw(f.request("tx.clear", {})), "DISABLED", 503);
  const unauth = await fetch(f.base + "/info"); assert.equal(unauth.status, 401); assert.equal(unauth.headers.get("www-authenticate"), "Bearer");
  f.api.manage({ action: "enable" });
  const observations: Array<{ mode: unknown; origin: boolean; site: boolean; bearer: boolean }> = [];
  f.api.server.prependListener("request", request => observations.push({ mode: request.headers["sec-fetch-mode"], origin: "origin" in request.headers,
    site: "sec-fetch-site" in request.headers, bearer: Boolean(request.headers.authorization?.startsWith("Bearer ")) }));
  const info = await fetch(f.base + "/info", { headers: { authorization: f.headers.authorization } }); assert.equal(info.status, 200); assert.equal(info.headers.get("cache-control"), "no-store");
  assert.deepEqual(observations[0], { mode: "cors", origin: false, site: false, bearer: true });
  const data = (await info.json() as any).data; assert.equal(data.paraBusVersion, "0.1.0"); assert.deepEqual(data.operations.map((o: any) => o.name), [...OPERATIONS, ...TIER_B_OPERATIONS]);
  assert.equal(data.features.includes("confirmation.arm-execute"), true); assert.equal(data.features.includes("meters.ws"), true); assert.deepEqual(data.operations.find((o: any) => o.name === "tx.take").tiers, ["A"]);
  for (const header of [{ origin: "null" }, { origin: `http://127.0.0.1:${f.api.port}` }, { origin: "https://example.invalid" }, { "sec-fetch-site": "same-origin" }] as Record<string, string>[]) {
    f.advance(); const response = await fetch(f.base + "/info", { headers: { ...f.headers, ...header } }); assert.equal(response.status, 403); assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal((await response.json() as any).code, "ORIGIN_FORBIDDEN");
  }
  assert.equal((await fetch(f.base + "/info", { method: "OPTIONS", headers: f.headers })).status, 403);
  for (const headers of [{ cookie: `token=${f.registration.token}` }, { "sec-websocket-protocol": f.registration.token }, { authorization: "Bearer wrong" }] as Record<string, string>[]) {
    f.advance(); assert.equal((await fetch(f.base + "/info", { headers })).status, 401);
  }
  assert.equal((await fetch(f.base + `/info?token=${f.registration.token}`)).status, 401);
  for (const headers of [{ "x-forwarded-host": `127.0.0.1:${f.api.port}` }, { forwarded: "for=127.0.0.1" }] as Record<string, string>[]) {
    f.advance(); assert.equal((await fetch(f.base + "/info", { headers: { ...f.headers, ...headers } })).status, 403);
  }
  for (const host of [null, "localhost:" + f.api.port, [`127.0.0.1:${f.api.port}`, `127.0.0.1:${f.api.port}`]]) {
    const result = await new Promise<number>((resolve, reject) => {
      const socket = createConnection(f.api.port, "127.0.0.1");
      socket.on("error", reject);
      socket.on("connect", () => socket.write(`GET /external/v1/info HTTP/1.1\r\n${host === null ? "" : (Array.isArray(host) ? host : [host]).map(h => `Host: ${h}\r\n`).join("")}Authorization: ${f.headers.authorization}\r\nConnection: close\r\n\r\n`));
      socket.once("data", data => { socket.destroy(); resolve(Number(data.toString().split(" ")[1])); });
    }); assert.equal(result, 403);
  }
  assert.equal((f.api.server.address() as { address: string }).address, "127.0.0.1");
});

for (const family of ["channel", "bus", "send", "tx"]) test(`${family} faders enforce floor, A/B boundaries, shared dB bucket and saturation`, async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" });
  const args = family === "channel" ? { target } : family === "bus" ? { busId: "bus" } : family === "send" ? { target, busId: "bus" } : { profileId: "TX1" };
  assert.equal((await f.action(`${family}.fader.set`, { ...args, db: -90 })).status, 200);
  assert.equal((await f.action(`${family}.fader.set`, { ...args, db: -40 })).status, 200);
  assert.equal((await f.action(`${family}.fader.set`, { ...args, db: -90 })).status, 200);
  assert.equal((await f.action(`${family}.fader.set`, { ...args, db: -34 })).body.data.value, -34);
  code(await f.action(`${family}.fader.adjust`, { ...args, deltaDb: 6.001 }), "INVALID", 400);
  code(await f.action(`${family}.fader.set`, { ...args, db: 0 }), "TIER_FORBIDDEN", 403);
  code(await f.action(`${family}.fader.set`, { ...args, db: 13 }), "INVALID", 400);
  code(await f.action(`${family}.fader.adjust`, { ...args, deltaDb: 0 }), "INVALID", 400);
  assert.equal((await f.action(`${family}.fader.adjust`, { ...args, deltaDb: -1e200 })).body.data.value, -90);
  assert.equal((await f.action(`${family}.fader.set`, { ...args, db: -20 })).body.code, "TIER_FORBIDDEN");
  await f.action(`${family}.fader.set`, { ...args, db: -40 }); f.advance();
  const first = f.request(`${family}.fader.adjust`, { ...args, deltaDb: 6 }); assert.equal((await f.raw(first)).status, 200);
  code(await f.raw(f.request(`${family}.fader.set`, { ...args, db: -28 })), "RATE_LIMITED", 429);
  assert.equal((await f.raw(f.request(`${family}.fader.adjust`, { ...args, deltaDb: 4 }))).status, 200);
  await f.raw(f.request(`${family}.fader.adjust`, { ...args, deltaDb: -1 }));
  code(await f.raw(f.request(`${family}.fader.adjust`, { ...args, deltaDb: 1 })), "RATE_LIMITED", 429);
  f.advance(50); assert.equal((await f.raw(f.request(`${family}.fader.adjust`, { ...args, deltaDb: 1 }))).status, 200);
  for (let i = 0; i < 20; i++) { f.advance(50); assert.equal((await f.raw(f.request(`${family}.fader.adjust`, { ...args, deltaDb: 1 }))).status, 200); }
  assert.equal((await f.action(`${family}.fader.adjust`, { ...args, deltaDb: 1e200 })).body.code, "INVALID");
  for (const db of [-4, 2, 6]) assert.equal((await f.action(`${family}.fader.set`, { ...args, db })).status, 200);
  assert.equal((await f.action(`${family}.fader.adjust`, { ...args, deltaDb: 1e200 })).body.data.value, 12);
  assert.equal(f.channel.approvalGateOpen, false); assert.equal(f.channel.mute, false); assert.equal(f.channel.vcSends.get("bus")!.mute, true);
});

test("all mute mappings use per-target expectedMute and idempotent set without global CAS", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" });
  for (const [family, args, initial] of [["channel", { target }, false], ["bus", { busId: "bus" }, false], ["send", { target, busId: "bus" }, true]] as const) {
    code(await f.action(`${family}.mute.toggle`, args), "INVALID");
    assert.equal((await f.action(`${family}.mute.toggle`, { ...args, expectedMute: initial }, { expectedRevision: 999999 })).body.data.value, !initial);
    const stale = await f.action(`${family}.mute.toggle`, { ...args, expectedMute: initial }); code(stale, "STALE_REVISION", 409); assert.deepEqual(stale.body.current, { mute: !initial });
    const before = f.control.revision; await f.action(`${family}.mute.set`, { ...args, mute: !initial }); assert.equal(f.control.revision, before);
  }
  f.channel.vcSends.delete("bus"); code(await f.action("send.mute.set", { target, busId: "bus", mute: false }), "NOT_FOUND");
  assert.equal(f.channel.vcSends.has("bus"), false);
});

test("all remaining A mappings, external confirmed rejection and B/C default refusal", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" });
  assert.deepEqual((await f.action("pfl.set", { source: { kind: "channel", target } })).body.data, { source: { kind: "channel", target } });
  assert.equal(f.engine.monitorSourceId, f.channel.id);
  assert.equal((await f.action("pfl.set", { source: { kind: "bus", busId: "bus" } })).status, 200);
  assert.equal((await f.action("pfl.set", { source: null })).status, 200);
  assert.equal((await f.action("loudness.reset", { busId: "bus" })).status, 200);
  assert.equal((await f.action("settings.lock.set", { locked: true })).status, 200); assert.equal(f.control.state, "ON_AIR");
  const before = f.control.revision; await f.action("settings.lock.set", { locked: true }); assert.equal(f.control.revision, before);
  for (const [operation, args] of [["settings.lock.set", { locked: false }], ["emergency.set", { active: false, expectedEmergencyEpoch: 1 }], ["bus.limiter.set", { busId: "bus", enabled: true }], ["bus.compressor.set", { busId: "bus", enabled: true }], ["scene.recall", {}], ["recording.start", {}], ["recording.stop", {}]] as const) code(await f.action(operation, args), "TIER_FORBIDDEN", 403);
  for (const operation of Object.keys(COMMAND_POLICIES)) code(await f.action(operation, {}), "TIER_FORBIDDEN", 403);
  code(await f.action("channel.mute.set", { target, mute: true, confirmed: true }), "INVALID");
  code(await f.action("channel.mute.set", { target, mute: true }, { confirmed: true }), "INVALID");
  assert.equal((await f.action("emergency.set", { active: true })).body.data.emergencyEpoch, 1);
  f.control.state = "FAULT"; code(await f.action("settings.lock.set", { locked: true }), "LOCKED", 409);
  assert.equal((await f.action("emergency.set", { active: true })).status, 200);
});

test("participants generations follow online appearances, order, VC and Bus identity; fixed target remains independent", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" }); const first = await f.state();
  const slot = { kind: "slot", scope: { kind: "all" }, index: 1, expectedParticipantsRevision: first.participantsRevision };
  assert.equal((await f.action("channel.mute.set", { target: slot, mute: true })).status, 200);
  const second = new AudioChannel(`discord-user:${GUILD}:${VC}:100000000000000002`, "Other guest", "DiscordUser", new SilenceSource(), 480, 48000);
  f.engine.addChannel(second); f.sessions.join(second, "100000000000000002", VC, second.label);
  code(await f.action("channel.mute.set", { target: slot, mute: false }), "STALE_REVISION");
  assert.equal((await f.action("channel.mute.toggle", { target, expectedMute: true })).status, 200);
  const secondState = await f.state(); assert.ok(secondState.participantsRevision > first.participantsRevision);
  f.channel.preferredStripPosition = 10; f.api.state.observe(); const ordered = await f.state(); assert.equal(ordered.participantOrders[0].users[0], "100000000000000002");
  f.sessions.leave(f.channel); f.engine.channels.delete(f.channel.id); f.api.state.observe();
  code(await f.action("channel.mute.set", { target, mute: true }), "NOT_FOUND");
  f.engine.addChannel(f.channel); f.sessions.join(f.channel, USER, VC, "Returned"); f.api.state.observe(); assert.ok((await f.state()).participantsRevision > ordered.participantsRevision);
  const generation = f.api.state.participantsRevision; f.engine.buses.delete("bus"); f.api.state.observe(); f.engine.addBus(new VcBus("bus", "Replacement", 480, 48000)); f.api.state.observe();
  assert.ok(f.api.state.participantsRevision > generation);
  code(await f.action("channel.mute.set", { target: { ...slot, scope: { kind: "bus", busId: "bus" }, expectedParticipantsRevision: f.api.state.participantsRevision }, mute: true }), "INVALID");
});

test("public projection is exact, name opt-in, revisions exclude meters/time/internal no-ops and detect ABA", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" }); const state = await f.state();
  assert.deepEqual(Object.keys(state).sort(), ["instanceId", "revision", "participantsRevision", "enabled", "state", "settingsLocked", "emergencyMuted", "emergencyEpoch", "outputCount", "participants", "registeredUsers", "participantOrders", "buses", "pfl", "tx", "recorder", "scenes", "currentSceneId", "permissions"].sort());
  const serialized = JSON.stringify(state); for (const privateValue of [f.registration.token, f.registration.deviceId, "Private device", "Private guest", "Private bot", "Private bus label"]) assert.equal(serialized.includes(privateValue), false);
  assert.deepEqual(Object.keys(state.participants[0]).sort(), ["discordUserId", "faderDb", "mute", "sends"].sort());
  assert.deepEqual(Object.keys(state.tx.bots[0]).sort(), ["profileId", "destination", "state", "active", "masterDb", "sourceInputChannelIds", "sourceMode"].sort());
  f.channel.outputMeter.process(new Float32Array(480), 48000); f.control.revision += 50; f.advance(500); assert.equal((await f.state()).revision, state.revision);
  f.channel.faderDb = -40; f.api.state.observe(); f.channel.faderDb = 0; f.api.state.observe(); assert.ok((await f.state()).revision >= state.revision + 2);
  f.api.manage({ action: "permissions", deviceId: f.registration.deviceId, readDisplayNames: true });
  assert.equal((await f.state()).participants[0].displayName, "Private guest");
});

for (const teams of [0, 1, 3]) test(`TX take is A with ${teams} configured teams, with empty/stale/safety gates and clear semantics`, async t => {
  const f = await fixture(t, teams); f.api.manage({ action: "enable" });
  const arm = async (selection: unknown) => f.action("tx.targets.set", { selection, expectedTargetsRevision: (await f.state()).tx.targetsRevision });
  const take = async () => f.action("tx.take", { expectedTargetsRevision: (await f.state()).tx.targetsRevision });
  code(await take(), "INVALID");
  code(await arm({ kind: "profiles", profileIds: ["TX1", "TX1"] }), "INVALID");
  code(await arm({ kind: "profiles", profileIds: ["missing"] }), "NOT_FOUND");
  code(await arm({ kind: "destinations", destinations: ["TEAM_20"] }), "NOT_FOUND");
  if (!teams) code(await arm({ kind: "allTeams" }), "NOT_FOUND");
  else {
    assert.equal((await arm({ kind: "allTeams" })).status, 200); const state = await f.state();
    assert.equal(state.tx.selectionKind, "allTeams"); assert.equal(state.tx.takeTier, "A"); assert.equal(state.tx.allTeams, true);
    code(await f.action("tx.take", { expectedTargetsRevision: state.tx.targetsRevision - 1 || 9999 }), "STALE_REVISION");
    assert.equal((await take()).status, 200); assert.equal(f.ingest.snapshot().txTargets!.live.length, teams);
    assert.equal((await f.state()).tx.selectionKind, "allTeams");
    assert.equal((f.commands.find((c: any) => c.type === "START_ARMED") as any).confirmed, true);
  }
  await arm({ kind: "destinations", destinations: ["INTERVIEW", "SPARE"] }); assert.equal((await take()).status, 200);
  const live = f.ingest.snapshot().txTargets!.live; assert.equal(live.length, 2);
  assert.equal((await f.action("tx.stop", { profileId: live[0] })).status, 200); assert.ok(f.ingest.snapshot().txTargets!.armed.includes(live[0]));
  await arm({ kind: "profiles", profileIds: [] }); assert.equal((await f.state()).tx.takeTier, null); assert.equal(f.ingest.snapshot().txTargets!.live.length, 1);
  assert.equal((await f.action("tx.clear", {})).status, 200); assert.deepEqual(f.ingest.snapshot().txTargets!.live, []);
  await arm({ kind: "profiles", profileIds: ["TX1"] }); f.engine.emergencyMuted = true; code(await take(), "LOCKED"); code(await f.action("tx.start", { profileId: "TX1" }), "LOCKED");
  f.engine.emergencyMuted = false; f.control.state = "FAULT"; code(await take(), "LOCKED");
});

test("API group START failure preserves backend all-stop/flush behavior", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" });
  await f.action("tx.targets.set", { selection: { kind: "profiles", profileIds: ["TX1", "TX2"] }, expectedTargetsRevision: (await f.state()).tx.targetsRevision });
  f.adapter.failStartBot = f.bots[1].botId;
  code(await f.action("tx.take", { expectedTargetsRevision: (await f.state()).tx.targetsRevision }), "INTERNAL", 500); assert.deepEqual(f.ingest.snapshot().txTargets!.live, []);
  const starts = f.adapter.writes.map(decodeDiscordFrame).filter(frame => frame.type === DiscordFrameType.TX_CONTROL && (frame.flags ?? 0) & DiscordTxFlags.START); assert.equal(starts.length, 1);
});

test("dedup caches success and failure for 60s, canonical keys, content conflict and instance protection", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" });
  const body = f.request("channel.fader.adjust", { target, deltaDb: -1 });
  const first = await f.raw(body), again = await f.raw({ args: { deltaDb: -1, target }, operation: body.operation, instanceId: body.instanceId, requestId: body.requestId });
  assert.deepEqual(again.body, first.body); assert.equal(f.channel.faderDb, -1); assert.equal(f.commands.length, 1);
  code(await f.raw({ ...body, args: { target, deltaDb: -2 } }), "INVALID");
  const failed = f.request("channel.mute.toggle", { target, expectedMute: true }); code(await f.raw(failed), "STALE_REVISION"); f.channel.mute = true;
  code(await f.raw(failed), "STALE_REVISION"); assert.equal(f.channel.mute, true);
  f.advance(60000); assert.equal((await f.raw(body)).status, 200); assert.equal(f.channel.faderDb, -2);
  code(await f.action("channel.mute.set", { target, mute: true }, { instanceId: randomUUID() }), "STALE_REVISION");
  f.api.manage({ action: "stop" }); code(await f.raw(body), "DISABLED"); assert.equal(new ExternalDeviceStore(f.root).enabled, false);
});

test("parallel requests serialize fader budgets and safe directions use finite reservation after normal exhaustion", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" }); f.channel.faderDb = -40;
  const results = await Promise.all(Array.from({ length: 12 }, () => f.raw(f.request("channel.fader.adjust", { target, deltaDb: 1 }))));
  assert.equal(results.filter(r => r.status === 200).length, 10); assert.equal(f.channel.faderDb, -30);
  f.advance();
  for (let i = 0; i < 20; i++) assert.equal((await f.raw(f.request("channel.mute.set", { target, mute: true }))).status, 200);
  code(await f.raw(f.request("pfl.set", { source: null })), "RATE_LIMITED", 429);
  for (let i = 0; i < 5; i++) assert.equal((await f.raw(f.request("emergency.set", { active: true }))).status, 200);
  const exceeded = await f.raw(f.request("tx.clear", {})); code(exceeded, "RATE_LIMITED", 429); assert.equal(exceeded.headers.get("retry-after"), "1");
  assert.equal(f.engine.emergencyMuted, true);
});

test("unauthenticated limiter is separate, aggregates secrets-free logs and device activity expires", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" });
  for (let i = 0; i < 22; i++) { const response = await fetch(f.base + "/info", { headers: { authorization: "Bearer invalid" } }); assert.equal(response.status, i < 20 ? 401 : 429); }
  for (let i = 0; i < 20; i++) assert.equal((await f.raw(f.request("channel.mute.set", { target, mute: false }))).status, 200);
  assert.equal(f.api.managementSnapshot().activeDeviceCount, 1); assert.equal(f.logs.filter(s => s === "External control authentication rejected").length, 1);
  f.advance(60000); f.api.tick(); assert.ok(f.logs.some(s => s === "External control authentication suppressed=21")); assert.equal(f.api.managementSnapshot().activeDeviceCount, 0);
  const text = f.logs.join("\n"); for (const secret of [f.registration.token, "Private device"]) assert.equal(text.includes(secret), false);
});

test("HTTP errors use fixed status/messages and reject management, unknown fields, malformed and oversized input", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" });
  for (const path of ["/execute", "/shutdown", "/settings", "/actions?token=x"]) code(await f.raw(f.request("tx.clear", {}), path), "INVALID", 400);
  for (const body of ["{", '{"a":1,"a":2}', "[]", JSON.stringify(f.request("new.operation", {})), JSON.stringify(f.request("channel.fader.set", { target, db: null }))]) { f.advance(); code(await f.raw(body), "INVALID", 400); }
  f.advance(); code(await f.raw(" ".repeat(16385)), "INVALID", 413);
  f.advance(); code(await f.raw("{}", "/actions", { ...f.headers, "content-type": "text/plain" }), "INVALID", 415);
  f.advance(); code(await f.raw("{}", "/actions", { ...f.headers, "content-encoding": "gzip" } as any), "INVALID", 415);
  assert.equal(f.commands.length, 0);
});

test("authenticated Expect 100-continue is admitted before body and still uses normal validation", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" });
  const payload = JSON.stringify(f.request("emergency.set", { active: true }));
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(f.base + "/actions", { method: "POST", headers: { ...f.headers, expect: "100-continue", "content-length": Buffer.byteLength(payload) } }, response => { response.resume(); resolve(response.statusCode!); });
    request.on("error", reject); request.setTimeout(3000, () => request.destroy(new Error("Continue response timed out")));
    request.on("continue", () => request.end(payload)); request.flushHeaders();
  });
  assert.equal(status, 200); assert.equal(f.engine.emergencyMuted, true);
});

test("port bind failure is isolated without fallback and SETUP changes apply only after restart", async t => {
  const f = await fixture(t), blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve)); t.after(() => blocker.close()); const port = (blocker.address() as any).port;
  f.api.manage({ action: "port", port }); assert.equal(f.api.port !== port, true);
  const blocked = new ExternalControlServer({ ...f.api.options, store: new ExternalDeviceStore(f.root) }); await blocked.start(); t.after(() => blocked.close());
  assert.equal(blocked.available, false); assert.equal(blocked.server.listening, false); assert.equal(blocked.port, port);
  assert.equal(f.api.available, true); assert.equal(f.control.execute({ type: "EMERGENCY_MUTE", active: true }).ok, true);
});

test("state-only WS authenticates native client, shares projection, refuses browser and closes on stop/revoke", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" });
  const ws = await connectWs(f.api.port, f.headers.authorization); t.after(() => ws.socket.destroy());
  assert.equal(ws.status, 101); const initial = await ws.next(); assert.equal(initial.type, "state"); assert.deepEqual(initial.payload, await f.state());
  const second = await connectWs(f.api.port, f.headers.authorization); t.after(() => second.socket.destroy()); await second.next();
  const third = await connectWs(f.api.port, f.headers.authorization); assert.equal(third.status, 429);
  assert.equal(f.api.managementSnapshot().activeDeviceCount, 1);
  for (const header of ["Origin: null\r\n", "Origin: http://127.0.0.1\r\n", "Sec-Fetch-Site: same-origin\r\n"]) {
    f.advance(); assert.equal((await connectWs(f.api.port, f.headers.authorization, header)).status, 403);
  }
  f.advance(); assert.equal((await connectWs(f.api.port, undefined)).status, 401);
  ws.socket.write(clientFrame(JSON.stringify({ type: "command", payload: { type: "EMERGENCY_MUTE", active: true } })));
  assert.equal((await ws.next()).payload.code, "INVALID"); assert.equal(f.engine.emergencyMuted, false);
  f.api.manage({ action: "stop" }); const stopped = await ws.next(); assert.equal(stopped.payload.code, "DISABLED"); assert.equal((await ws.next()).closeCode, 4003);
  assert.equal(new ExternalDeviceStore(f.root).enabled, false); f.api.manage({ action: "enable" }); f.advance();
  const renewed = await connectWs(f.api.port, f.headers.authorization); t.after(() => renewed.socket.destroy()); await renewed.next();
  f.api.manage({ action: "revoke", deviceId: f.registration.deviceId }); assert.equal((await renewed.next()).closeCode, 4001);
  code(await f.raw(f.request("tx.clear", {})), "UNAUTHORIZED", 401);
});

test("shared WebSocket receiver bounds partial frames and heartbeat removes silent external clients", async t => {
  const frames: string[] = [], receive = websocketReceiver(16, (_opcode, payload) => frames.push(payload.toString())); const frame = clientFrame("test");
  receive(frame.subarray(0, 3)); receive(frame.subarray(3)); assert.deepEqual(frames, ["test"]); assert.throws(() => receive(clientFrame("x".repeat(17))), RangeError);
  const f = await fixture(t); f.api.manage({ action: "enable" }); const ws = await connectWs(f.api.port, f.headers.authorization); t.after(() => ws.socket.destroy()); await ws.next();
  f.advance(15000); f.api.tick(); assert.equal((await ws.next()).opcode, 9);
  f.advance(30000); f.api.tick(); assert.equal((await ws.next()).closeCode, 1001);
});

test("dedup capacity never evicts live entries; malformed shape failures also retain request IDs", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" });
  const malformed = f.request("emergency.set", { active: true }, { confirmed: true });
  code(await f.raw(malformed), "INVALID"); const corrected: Record<string, unknown> = { ...malformed }; delete corrected.confirmed;
  code(await f.raw(corrected), "INVALID"); assert.equal(f.engine.emergencyMuted, false);
  // Populate the cache directly to exercise its bound independently of the stricter POST rate.
  const runtime = (f.api as any).runtime(f.store.authenticate(f.registration.token)); runtime.cache.clear();
  for (let i = 0; i < 2048; i++) runtime.cache.set(randomUUID(), { at: 1000, payload: "{}", reply: { status: 200, body: {} } });
  code(await f.raw(f.request("emergency.set", { active: true })), "RATE_LIMITED", 429); assert.equal(runtime.cache.size, 2048);
  assert.equal(f.engine.emergencyMuted, false); f.advance(60000); assert.equal((await f.raw(f.request("emergency.set", { active: true }))).status, 200);
});

test("global normal and safety limits apply across devices, and reads have a separate finite bucket", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" });
  const clients = [f.registration, ...Array.from({ length: 5 }, (_, i) => f.store.register(`Device ${i}`))];
  const send = (index: number, operation: string, args: unknown) => f.raw(f.request(operation, args), "/actions", { ...f.headers, authorization: `Bearer ${clients[index].token}` });
  for (let device = 0; device < 5; device++) for (let i = 0; i < 20; i++) assert.equal((await send(device, "channel.mute.set", { target, mute: false })).status, 200);
  code(await send(5, "channel.mute.set", { target, mute: false }), "RATE_LIMITED", 429);
  for (let device = 0; device < 4; device++) for (let i = 0; i < 5; i++) assert.equal((await send(device, "emergency.set", { active: true })).status, 200);
  code(await send(4, "tx.clear", {}), "RATE_LIMITED", 429);
  for (let i = 0; i < 10; i++) assert.equal((await fetch(f.base + "/state", { headers: f.headers })).status, 200);
  assert.equal((await fetch(f.base + "/state", { headers: f.headers })).status, 429);
});

test("stop invalidates body-in-flight requests even after reenable and retains already committed dedup results", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" });
  const payload = JSON.stringify(f.request("emergency.set", { active: true })); let finish!: () => void;
  const response = new Promise<number>((resolve, reject) => {
    const req = httpRequest(f.base + "/actions", { method: "POST", headers: { ...f.headers, "content-length": Buffer.byteLength(payload) } }, res => { res.resume(); resolve(res.statusCode!); });
    req.on("error", reject); req.write(payload.slice(0, 10)); finish = () => req.end(payload.slice(10));
  });
  const deadline = Date.now() + 3000;
  while (!f.api.managementSnapshot().activeDeviceCount) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  f.api.manage({ action: "stop" }); f.api.manage({ action: "enable" }); finish(); assert.equal(await response, 503); assert.equal(f.engine.emergencyMuted, false);
  const committed = f.request("channel.fader.adjust", { target, deltaDb: -1 }); assert.equal((await f.raw(committed)).status, 200);
  f.api.manage({ action: "stop" }); f.api.manage({ action: "enable" }); assert.equal((await f.raw(committed)).status, 200); assert.equal(f.channel.faderDb, -1);
  f.api.manage({ action: "permissions", deviceId: f.registration.deviceId, readDisplayNames: true });
  assert.equal((await f.raw(committed)).status, 200); assert.equal(f.channel.faderDb, -1);
});

test("external source guard rejects IPv6 and non-loopback sockets and reports unavailable/internal errors safely", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" });
  for (const [remoteAddress, remoteFamily] of [["::1", "IPv6"], ["::ffff:127.0.0.1", "IPv6"], ["127.0.0.2", "IPv4"], ["192.0.2.1", "IPv4"]]) {
    assert.throws(() => (f.api as any).boundary({ rawHeaders: ["Host", `127.0.0.1:${f.api.port}`], headers: { host: `127.0.0.1:${f.api.port}` }, method: "GET", socket: { remoteAddress, remoteFamily } }), (error: any) => error.code === "HOST_FORBIDDEN");
  }
  const controller = f.control.txController as any, original = controller.clearAllTx; controller.clearAllTx = undefined;
  code(await f.action("tx.clear", {}), "UNAVAILABLE", 503); controller.clearAllTx = original;
  const execute = f.api.options.execute; f.api.options.execute = () => { throw new Error("Private backend path/token must not escape"); };
  const reply = await f.action("emergency.set", { active: true }); code(reply, "INTERNAL", 500); assert.equal(reply.body.message, "Internal control failure"); f.api.options.execute = execute;
});

test("configured TX without an Adapter is projected as NO_BOT and metadata ABA advances targets revision", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" }); await f.state(); const state = new ExternalState(f.control, () => f.ingest.snapshot(), undefined, [{ profileId: "OFFLINE", destination: "SPARE" }]);
  const projection = state.project({ readDisplayNames: false, allowedTierBOperations: [] }, true);
  assert.equal(projection.tx.bots.find(bot => bot.profileId === "OFFLINE")!.state, "NO_BOT");
  const before = f.api.state.targetsRevision;
  f.botState(0, { txDestination: "INTERVIEW" }); f.botState(0);
  assert.ok(f.api.state.targetsRevision >= before + 2);
});

test("WS total capacity, permission invalidation, bounded backpressure and state change delivery", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" });
  const clients = [f.registration, ...Array.from({ length: 8 }, (_, i) => f.store.register(`WS ${i}`))], connections: Awaited<ReturnType<typeof connectWs>>[] = [];
  t.after(() => { for (const ws of connections) ws.socket.destroy(); });
  for (let i = 0; i < 16; i++) {
    const ws = await connectWs(f.api.port, `Bearer ${clients[Math.floor(i / 2)].token}`); connections.push(ws); assert.equal(ws.status, 101); await ws.next();
  }
  assert.equal((await connectWs(f.api.port, `Bearer ${clients[8].token}`)).status, 429);
  await f.action("channel.mute.set", { target, mute: true }); f.api.tick(); assert.equal((await connections[0].next()).payload.participants[0].mute, true);
  f.api.manage({ action: "permissions", deviceId: f.registration.deviceId, readDisplayNames: true }); assert.equal((await connections[0].next()).closeCode, 4001);
  let closeCode = 0;
  const socket = { destroyed: false, writableLength: 262144, end(frame: Buffer) { closeCode = frame.readUInt16BE(2); }, destroy() {}, once() {} };
  const peer = { socket, closing: false, device: { deviceId: f.registration.deviceId } }; (f.api as any).send(peer, { type: "state", payload: {} }); assert.equal(closeCode, 1013); assert.equal(peer.closing, true);
});

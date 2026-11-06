import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { RecorderManager } from "../services/router-core-sim/src/recorder.ts";
import { AudioChannel, SilenceSource, VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { fixture, USER, GUILD, VC } from "./helpers/external-control-fixture.ts";
import { clientFrame, connectWs } from "./helpers/external-ws.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const target = { kind: "user", discordUserId: USER };
const code = (r: any, expected: string, status?: number) => { assert.equal(r.body.code, expected); if (status) assert.equal(r.status, status); };
const grant = (f: Fixture, ops = ["scene.recall", "recording.start", "recording.stop"]) => f.api.manage({ action: "permissions", deviceId: f.registration.deviceId, readDisplayNames: false, allowedTierBOperations: ops });
async function setup(t: Parameters<typeof fixture>[0]) { const f = await fixture(t); grant(f); f.api.manage({ action: "enable" }); return f; }
const arm = (f: Fixture, operation: string, args: unknown) => f.raw(f.request(operation, args), "/arm");
const execute = (f: Fixture, id: string) => f.raw({ requestId: randomUUID(), instanceId: f.api.state.instanceId, armId: id }, "/execute");
function scene(f: Fixture) {
  f.control.execute({ type: "SAVE_SCENE", name: "Private scene" });
  const id = f.control.currentSceneId!;
  f.control.execute({ type: "SET_CHANNEL_FADER", channelId: f.channel.id, db: -20 });
  return id;
}
const preview = (f: Fixture, sceneId: string) => f.raw(f.request("scene.preview", { sceneId }));
const recall = (f: Fixture, sceneId: string, previewId: string) => arm(f, "scene.recall", { sceneId, previewId });
const selection = { outputs: [0], busIds: ["bus"], participants: [target] };
function recorder(f: Fixture, t: Parameters<typeof fixture>[0], folder = join(f.root, "recordings"), scheduleDrain?: (callback: () => void) => void) {
  const r = new RecorderManager(f.engine, folder, { scheduleDrain }); Object.defineProperty(f.control, "recorder", { value: r, configurable: true });
  t.after(() => r.close()); return r;
}

test("scene.preview is A, read-only, strictly projected and hides names while retaining raw-value comparisons", async t => {
  const f = await setup(t), id = scene(f); f.channel.label = "Current private guest";
  const before = { revision: f.control.revision, scene: f.control.currentSceneId, db: f.channel.faderDb, commands: f.commands.length };
  const p = await preview(f, id); assert.equal(p.status, 200);
  assert.deepEqual(Object.keys(p.body.data).sort(), ["previewId", "sceneId", "changes", "excludedParticipantCount"].sort());
  assert.ok(Buffer.from(p.body.data.previewId, "base64url").length >= 16);
  for (const change of p.body.data.changes) assert.deepEqual(Object.keys(change).sort(), ["target", "field", "from", "to", "recallSafe", "locked"].sort());
  const label = p.body.data.changes.find((c: any) => c.field.endsWith(".label")); assert.equal(label.from, null); assert.equal(label.to, null);
  assert.equal(JSON.stringify(p.body.data).includes("private guest"), false);
  assert.deepEqual({ revision: f.control.revision, scene: f.control.currentSceneId, db: f.channel.faderDb, commands: f.commands.length }, before);
  f.channel.label = "Different hidden name"; f.api.observe(); code(await recall(f, id, p.body.data.previewId), "STALE_REVISION", 409);
  f.api.manage({ action: "permissions", deviceId: f.registration.deviceId, readDisplayNames: true, allowedTierBOperations: ["scene.recall"] });
  const named = await preview(f, id); assert.equal(named.body.data.changes.find((c: any) => c.field.endsWith(".label")).from, "Different hidden name");
  code(await arm(f, "scene.preview", { sceneId: id }), "INVALID", 400);
  for (const command of ["SAVE_SCENE", "DELETE_SCENE"]) code(await f.raw(f.request(command, {})), "TIER_FORBIDDEN", 403);
});

for (const elapsed of [29999, 30000]) test(`preview monotonic ${elapsed}ms boundary; accepted arm owns its own deadline`, async t => {
  const f = await setup(t), id = scene(f), p = await preview(f, id); f.advance(elapsed);
  const a = await recall(f, id, p.body.data.previewId);
  if (elapsed === 30000) code(a, "INVALID", 400);
  else { assert.equal(a.status, 200); f.advance(1000); assert.equal((await execute(f, a.body.data.armId)).status, 200); assert.equal(f.channel.faderDb, 0); }
});

test("preview ownership, unknown/mismatched IDs, permissions, stop and disconnect invalidate previews", async t => {
  const f = await setup(t), id = scene(f), p = await preview(f, id), other = f.store.register("Other");
  f.api.manage({ action: "permissions", deviceId: other.deviceId, readDisplayNames: false, allowedTierBOperations: ["scene.recall"] });
  code(await f.raw(f.request("scene.recall", { sceneId: id, previewId: p.body.data.previewId }), "/arm", { ...f.headers, authorization: `Bearer ${other.token}` }), "INVALID", 400);
  code(await recall(f, id, "unknown"), "INVALID", 400); code(await recall(f, "different", p.body.data.previewId), "INVALID", 400);
  grant(f, []); code(await recall(f, id, p.body.data.previewId), "TIER_FORBIDDEN", 403); grant(f);
  code(await recall(f, id, p.body.data.previewId), "INVALID", 400);
  const next = await preview(f, id); f.api.manage({ action: "stop" }); f.api.manage({ action: "enable" }); code(await recall(f, id, next.body.data.previewId), "INVALID");
  const ws = await connectWs(f.api.port, f.headers.authorization); await ws.next();
  const disconnected = await preview(f, id); ws.socket.destroy(); await new Promise(resolve => setTimeout(resolve, 30));
  code(await recall(f, id, disconnected.body.data.previewId), "INVALID");
});

test("scene recall ignores unrelated faders, enforces Recall Safe and ON AIR locks, and confirms only at execute", async t => {
  const f = await setup(t); f.control.execute({ type: "SET_LIMITER", busId: "bus", enabled: false }); const id = scene(f);
  f.control.execute({ type: "SET_LIMITER", busId: "bus", enabled: true });
  const parameter = `channel.${f.channel.id}.faderDb`;
  f.control.execute({ type: "SET_RECALL_SAFE", parameter, safe: true }); f.control.state = "ON_AIR";
  const p = await preview(f, id); assert.ok(p.body.data.changes.some((c: any) => c.field === parameter && c.recallSafe));
  assert.ok(p.body.data.changes.some((c: any) => c.field.endsWith(".limiterEnabled") && c.locked));
  const a = await recall(f, id, p.body.data.previewId); assert.equal(a.status, 200);
  f.control.execute({ type: "SET_TX_MASTER", profileId: "TX1", db: -1 }); f.advance(1000);
  assert.equal((await execute(f, a.body.data.armId)).status, 200); assert.equal(f.channel.faderDb, -20); assert.equal(f.bus.limiter.enabled, true);
  assert.equal((f.commands.at(-1) as any).type, "RECALL_SCENE"); assert.equal((f.commands.at(-1) as any).confirmed, true);
});

for (const phase of ["preview-arm", "arm-execute"]) test(`scene diff/Recall Safe/content ABA is detected at ${phase} without projections on every command`, async t => {
  const f = await setup(t), id = scene(f), p = await preview(f, id);
  const a = phase === "arm-execute" ? await recall(f, id, p.body.data.previewId) : null;
  let observeCalls = 0; const observe = f.api.state.observe.bind(f.api.state); f.api.state.observe = () => { observeCalls++; observe(); };
  f.control.execute({ type: "SET_CHANNEL_FADER", channelId: f.channel.id, db: -21 });
  f.control.execute({ type: "SET_CHANNEL_FADER", channelId: f.channel.id, db: -20 });
  assert.equal(observeCalls, 0); f.advance(1000);
  code(a ? await execute(f, a.body.data.armId) : await recall(f, id, p.body.data.previewId), "STALE_REVISION", 409);
  const q = await preview(f, id), parameter = `channel.${f.channel.id}.faderDb`;
  f.control.execute({ type: "SET_RECALL_SAFE", parameter, safe: true }); f.control.execute({ type: "SET_RECALL_SAFE", parameter, safe: false });
  code(await recall(f, id, q.body.data.previewId), "STALE_REVISION");
  const r = await preview(f, id), values = { ...f.control.scenes.get(id)!.values };
  f.control.scenes.get(id)!.values[parameter] = -2; f.api.noteChange(); f.control.scenes.get(id)!.values = values; f.api.noteChange();
  code(await recall(f, id, r.body.data.previewId), "STALE_REVISION");
});

test("scene related targets, excluded participants and locks are rechecked, FAULT blocks execution", async t => {
  const f = await setup(t), id = scene(f), p = await preview(f, id), a = await recall(f, id, p.body.data.previewId);
  f.control.state = "FAULT"; f.advance(1000); code(await execute(f, a.body.data.armId), "LOCKED", 409); f.control.state = "SETUP";
  const q = await preview(f, id); f.engine.channels.delete(f.channel.id); f.api.noteChange(); code(await recall(f, id, q.body.data.previewId), "STALE_REVISION");
  f.engine.addChannel(f.channel);
  const extra = new AudioChannel(`discord-user:${GUILD}:${VC}:100000000000000002`, "Excluded private name", "DiscordUser", new SilenceSource(), 480, 48000);
  f.engine.addChannel(extra); f.sessions.join(extra, "100000000000000002", VC, extra.label);
  const r = await preview(f, id); assert.equal(r.body.data.excludedParticipantCount, 1);
  f.engine.channels.delete(extra.id); f.api.noteChange(); code(await recall(f, id, r.body.data.previewId), "STALE_REVISION");
});

test("scene lock transitions are relevant only to locked parameters and preview storage is bounded", async t => {
  const f = await setup(t); f.bus.limiter.enabled = false; const id = scene(f); f.bus.limiter.enabled = true;
  const p = await preview(f, id), a = await recall(f, id, p.body.data.previewId); assert.equal(a.status, 200);
  f.control.execute({ type: "SET_STATE", state: "READY" }); f.advance(1000); code(await execute(f, a.body.data.armId), "STALE_REVISION");
  f.control.state = "SETUP";
  for (let i = 1; i < 32; i++) { assert.equal((await preview(f, id)).status, 200); f.advance(100); }
  f.advance(1000); code(await preview(f, id), "RATE_LIMITED", 429);
  f.advance(30000); f.api.tick(); assert.equal((await preview(f, id)).status, 200);
});

test("unchanged scene diffs accept unrelated participant activity and hidden-name ABA is still detected", async t => {
  const f = await setup(t), id = scene(f); f.channel.label = "Private replacement";
  const p = await preview(f, id);
  f.channel.label = "Another hidden value"; f.api.noteChange(); f.channel.label = "Private replacement"; f.api.noteChange();
  code(await recall(f, id, p.body.data.previewId), "STALE_REVISION");
  const q = await preview(f, id), a = await recall(f, id, q.body.data.previewId);
  const unrelated = new AudioChannel("local-unrelated", "Not in the scene", "LocalMonoInput", new SilenceSource(), 480, 48000);
  f.engine.addChannel(unrelated); f.api.noteChange(); f.advance(1000); assert.equal((await execute(f, a.body.data.armId)).status, 200);
});

test("recording start resolves and fixes explicit selection, stops through B, never auto-includes new participants", async t => {
  const f = await setup(t), r = recorder(f, t);
  const a = await arm(f, "recording.start", { selection }); assert.equal(a.status, 200); assert.equal(r.state, "IDLE");
  const extra = new AudioChannel(`discord-user:${GUILD}:${VC}:100000000000000002`, "Not selected", "DiscordUser", new SilenceSource(), 480, 48000);
  f.engine.addChannel(extra); f.sessions.join(extra, "100000000000000002", VC, extra.label); f.api.noteChange(); f.advance(1000);
  assert.equal((await execute(f, a.body.data.armId)).status, 200); assert.equal(r.state, "RECORDING");
  assert.deepEqual(r.selection, { outputs: [0], busIds: ["bus"], channelIds: [f.channel.id] });
  const command = f.commands.at(-1) as any; assert.equal(command.matrixOutput, 0); assert.equal(command.includeUsers, false); assert.equal(command.includeBuses, false); assert.equal(command.confirmed, true);
  code(await arm(f, "recording.start", { selection }), "LOCKED", 409);
  const stop = await arm(f, "recording.stop", {}); assert.equal(stop.status, 200); f.advance(1000);
  assert.equal((await execute(f, stop.body.data.armId)).status, 200); await r.waitForIdle(); assert.equal(r.state, "IDLE");
  code(await arm(f, "recording.stop", {}), "LOCKED", 409);
});

test("recording selection validates limits, duplicates after slot resolution, output count, fields, existence and empty sets", async t => {
  const f = await setup(t); recorder(f, t);
  const invalid = [
    { outputs: [], busIds: [], participants: [] }, { ...selection, outputs: [4] }, { ...selection, outputs: [-1] }, { ...selection, outputs: [0.1] },
    { ...selection, outputs: [0, 0] }, { ...selection, outputs: Array(65).fill(0) }, { ...selection, busIds: Array(33).fill("bus") },
    { ...selection, participants: Array(113).fill(target) }, { ...selection, participants: [target, target] }, { ...selection, busIds: ["bus", "bus"] },
    { ...selection, path: "forbidden" }, { outputs: [0], busIds: [] },
  ];
  for (const input of invalid) { f.advance(); code(await arm(f, "recording.start", { selection: input }), "INVALID", 400); }
  f.advance(); const s = await f.state(), slot = { kind: "slot", scope: { kind: "all" }, index: 1, expectedParticipantsRevision: s.participantsRevision };
  code(await arm(f, "recording.start", { selection: { ...selection, participants: [target, slot] } }), "INVALID");
  code(await arm(f, "recording.start", { selection: { outputs: [], busIds: ["missing"], participants: [] } }), "NOT_FOUND", 404);
  code(await arm(f, "recording.start", { selection: { outputs: [], busIds: [], participants: [{ kind: "user", discordUserId: "100000000000000099" }] } }), "NOT_FOUND", 404);
  const a = await arm(f, "recording.start", { selection: { outputs: [], busIds: [], participants: [slot] } }); assert.equal(a.status, 200);
  f.channel.preferredStripPosition = 8; f.api.noteChange(); f.advance(1000); code(await execute(f, a.body.data.armId), "STALE_REVISION");
});

test("recording participant/Bus recreation and recorder session ABA invalidate confirmation without relying on the timer", async t => {
  const f = await setup(t), r = recorder(f, t), a = await arm(f, "recording.start", { selection });
  f.engine.buses.set("bus", new VcBus("bus", "New bus", 480, 48000)); f.api.noteChange(); f.advance(1000);
  code(await execute(f, a.body.data.armId), "STALE_REVISION");
  const b = await arm(f, "recording.start", { selection }); r.start({ matrixOutput: 0, includeUsers: false, includeBuses: false }); r.stop(); await r.waitForIdle();
  f.advance(1000); code(await execute(f, b.body.data.armId), "STALE_REVISION");
  r.start({ matrixOutput: 0, includeUsers: false, includeBuses: false }); const c = await arm(f, "recording.stop", {});
  r.stop(); await r.waitForIdle(); r.start({ matrixOutput: 0, includeUsers: false, includeBuses: false }); f.advance(1000);
  code(await execute(f, c.body.data.armId), "STALE_REVISION");
});

test("recording accepts all maximum selection sizes and freezes participant identity/output availability", async t => {
  const f = await fixture(t, 2, 64); grant(f); f.api.manage({ action: "enable" }); recorder(f, t);
  for (let i = 1; i < 32; i++) f.engine.addBus(new VcBus(`bus-${i}`, "Simulated", 480, 48000));
  const participants = [target];
  for (let i = 1; i < 112; i++) {
    const user = String(100000000000000001n + BigInt(i)), c = new AudioChannel(`discord-user:${GUILD}:${VC}:${user}`, "Simulated", "DiscordUser", new SilenceSource(), 480, 48000);
    f.engine.addChannel(c); f.sessions.join(c, user, VC, c.label); participants.push({ kind: "user", discordUserId: user });
  }
  const maximum = { outputs: Array.from({ length: 64 }, (_, i) => i), busIds: [...f.engine.buses.keys()], participants };
  const a = await arm(f, "recording.start", { selection: maximum }); assert.equal(a.status, 200);
  f.sessions.leave(f.channel); f.sessions.join(f.channel, USER, VC, f.channel.label); f.api.noteChange(); f.advance(1000);
  code(await execute(f, a.body.data.armId), "STALE_REVISION");
  const b = await arm(f, "recording.start", { selection }); let available = 64;
  Object.defineProperty(f.control, "outputManager", { value: { snapshot: () => ({ activeChannelCount: available }) }, configurable: true });
  available = 0; f.api.noteChange(); f.advance(1000); code(await execute(f, b.body.data.armId), "STALE_REVISION");
  available = 64; const c = await arm(f, "recording.start", { selection: { outputs: [0], busIds: [], participants: [] } });
  available = 2; f.api.noteChange(); f.advance(1000); assert.equal((await execute(f, c.body.data.armId)).status, 200);
});

test("recorder unavailability, FAULT, STOPPING and storage failure return typed errors without paths", async t => {
  const f = await setup(t); code(await arm(f, "recording.start", { selection }), "UNAVAILABLE", 503);
  const folder = join(f.root, "private-storage-file"); writeFileSync(folder, "fixture"); const r = recorder(f, t, folder);
  const a = await arm(f, "recording.start", { selection }); assert.equal(a.status, 200); f.advance(1000);
  const failed = await execute(f, a.body.data.armId); code(failed, "UNAVAILABLE", 503);
  assert.equal(JSON.stringify(failed.body).includes(folder), false); assert.equal(f.logs.join("\n").includes(folder), false);
  code(await arm(f, "recording.start", { selection }), "UNAVAILABLE", 503); await r.waitForIdle();
  const fresh = new RecorderManager(f.engine, join(f.root, "other-recordings"), { scheduleDrain: () => {} });
  Object.defineProperty(f.control, "recorder", { value: fresh, configurable: true });
  fresh.start({ matrixOutput: 0, includeUsers: false, includeBuses: false }); fresh.stop();
  code(await arm(f, "recording.start", { selection }), "LOCKED", 409); code(await arm(f, "recording.stop", {}), "LOCKED", 409);
  (fresh as any).scheduleDrain = (callback: () => void) => setImmediate(callback); (fresh as any).drain(); t.after(() => fresh.close());
});

test("meter subscribe validation is atomic and bounded, reads existing scalars, sequence continues through replacements", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await setup(t), ws = await connectWs(f.api.port, f.headers.authorization); t.after(() => ws.socket.destroy()); await ws.next();
  let reads = 0; const values = f.api.meters.values.bind(f.api.meters); f.api.meters.values = bindings => { reads++; return values(bindings); };
  f.api.tick(); assert.equal(reads, 0);
  const request = async (value: any) => { f.advance(1000); ws.socket.write(clientFrame(JSON.stringify({ requestId: randomUUID(), ...value }))); return ws.next(); };
  const sources = [{ kind: "channel", target }, { kind: "bus", busId: "bus" }, { kind: "tx", profileId: "TX1" }];
  assert.equal((await request({ type: "meters.subscribe", sources, hz: 10 })).payload.ok, true);
  f.channel.outputMeter.peak = 1.2; f.channel.outputMeter.rms = .5; f.channel.outputMeter.clip = true; f.bus.meter.peak = .4; f.bus.meter.rms = .2;
  f.advance(100); f.api.tick(); const first = await ws.next(); assert.equal(first.type, "meters"); assert.equal(first.sequence, 1);
  assert.deepEqual(first.values[0], { source: sources[0], peak: 1.2, rms: .5, clip: true, stale: false });
  assert.equal(first.values[2].rms, null); assert.equal(first.values[2].clip, null);
  const invalid = [
    { sources, hz: 0 }, { sources, hz: 11 }, { sources, hz: 1.5 }, { sources: Array(33).fill(sources[0]), hz: 1 },
    { sources: [sources[0], sources[0]], hz: 1 }, { sources: [{ kind: "channel", target: { kind: "slot" } }], hz: 1 },
    { sources: [{ kind: "bus", busId: "missing" }], hz: 1 }, { sources, hz: 1, extra: true },
  ];
  // Validation requests advance the injected clock, so suppress timer delivery until each response is read.
  for (const input of invalid) {
    const reply = await request({ type: "meters.subscribe", ...input }); assert.equal(reply.payload.ok, false);
    assert.equal(reply.payload.code, input.sources[0]?.kind === "bus" ? "NOT_FOUND" : "INVALID");
  }
  assert.equal((await request({ type: "meters.subscribe", sources: [sources[1]], hz: 1 })).payload.ok, true);
  f.advance(999); const before = reads; f.api.tick(); assert.equal(reads, before); f.advance(1); f.api.tick();
  const second = await ws.next(); assert.equal(second.sequence, 2); assert.equal(second.values.length, 1);
  assert.equal((await request({ type: "meters.unsubscribe" })).payload.ok, true); const after = reads; f.advance(1000); f.api.tick(); assert.equal(reads, after);
});

test("meters target disappearance never retargets to replacement objects; disconnect drops all subscriptions", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await setup(t), ws = await connectWs(f.api.port, f.headers.authorization); await ws.next();
  ws.socket.write(clientFrame(JSON.stringify({ type: "meters.subscribe", requestId: randomUUID(), sources: [{ kind: "channel", target }, { kind: "bus", busId: "bus" }], hz: 10 })));
  assert.equal((await ws.next()).payload.ok, true);
  f.engine.channels.set(f.channel.id, new AudioChannel(f.channel.id, "Replacement guest", "DiscordUser", new SilenceSource(), 480, 48000));
  f.engine.buses.set("bus", new VcBus("bus", "Replacement", 480, 48000)); f.advance(100); f.api.tick();
  let message = await ws.next(); if (message.type === "state") message = await ws.next();
  assert.equal(message.type, "meters"); for (const v of message.values) { assert.equal(v.stale, true); assert.equal(v.peak, 0); assert.equal(v.rms, null); assert.equal(v.clip, null); }
  ws.socket.destroy(); await new Promise(resolve => setTimeout(resolve, 30));
  let reads = 0; const values = f.api.meters.values.bind(f.api.meters); f.api.meters.values = b => { reads++; return values(b); };
  const next = await connectWs(f.api.port, f.headers.authorization); t.after(() => next.socket.destroy()); await next.next(); f.advance(1000); f.api.tick(); assert.equal(reads, 0);
});

test("meter frames drop at backpressure while state fits first; state overflow still closes 1013", async t => {
  const f = await setup(t); let closed = 0; const writes: Buffer[] = [];
  const socket = { destroyed: false, writableLength: 262140, write(b: Buffer) { writes.push(b); return true; }, end(b: Buffer) { closed = b.readUInt16BE(2); }, once() {}, destroy() {} };
  const peer: any = { socket, device: f.store.authenticate(f.registration.token), closing: false, sequence: 0 };
  assert.equal((f.api as any).send(peer, { type: "meters", values: Array(32).fill({ peak: 1 }) }, true), false);
  assert.equal(peer.closing, false); assert.equal(closed, 0); assert.equal(writes.length, 0);
  (f.api as any).sendState(peer); assert.equal(closed, 1013);
});

test("meters enforce the 32-source limit, preserve requestIds on rate errors and send state before meters", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await setup(t); for (let i = 1; i < 32; i++) f.engine.addBus(new VcBus(`bus-${i}`, "Simulated", 480, 48000));
  const ws = await connectWs(f.api.port, f.headers.authorization); t.after(() => ws.socket.destroy()); await ws.next();
  const sources = [...f.engine.buses.keys()].map(busId => ({ kind: "bus", busId }));
  ws.socket.write(clientFrame(JSON.stringify({ type: "meters.subscribe", requestId: randomUUID(), sources, hz: 10 }))); assert.equal((await ws.next()).payload.ok, true);
  const order: string[] = [], send = (f.api as any).send.bind(f.api);
  (f.api as any).send = (peer: any, message: any, droppable: boolean) => { order.push(message.type); return send(peer, message, droppable); };
  f.control.execute({ type: "SET_CHANNEL_FADER", channelId: f.channel.id, db: -1 }); f.advance(100); f.api.tick();
  assert.deepEqual(order, ["state", "meters"]); assert.equal((await ws.next()).type, "state"); const meters = await ws.next(); assert.equal(meters.values.length, 32);
  let limited = 0;
  for (let i = 0; i < 12; i++) {
    const requestId = randomUUID(); ws.socket.write(clientFrame(JSON.stringify({ type: "meters.unsubscribe", requestId })));
    const reply = await ws.next(); assert.equal(reply.requestId, requestId); if (reply.payload.code === "RATE_LIMITED") limited++;
  }
  assert.ok(limited > 0);
  f.advance(1000); ws.socket.write(clientFrame('{"type":"meters.subscribe","requestId":"invalid"}')); const malformed = await ws.next(); assert.equal(malformed.requestId, null); assert.equal(malformed.payload.code, "INVALID");
});

test("TX meter disappears when Bot identity is replaced and retains null rms/clip without inference", async t => {
  const f = await setup(t), bound = f.api.meters.subscribe({ type: "meters.subscribe", requestId: randomUUID(), sources: [{ kind: "tx", profileId: "TX1" }], hz: 10 });
  const before = f.api.meters.values(bound.bindings); assert.equal(before[0].rms, null); assert.equal(before[0].clip, null);
  const [key, bot] = [...f.ingest.bots.entries()].find(([, b]) => b.profileId === "TX1")!; f.ingest.bots.set(key, { ...bot });
  const after = f.api.meters.values(bound.bindings)[0]; assert.equal(after.stale, true); assert.equal(after.peak, 0); assert.equal(after.rms, null); assert.equal(after.clip, null);
});

test("main-thread fader hook retains 2a ABA and avoids full observes for 60 commands; metering adds no DSP processing", async t => {
  const f = await setup(t); grant(f, ["channel.fader.set"]); await f.action("channel.fader.set", { target, db: -40 });
  const a = await arm(f, "channel.fader.set", { target, db: 0 });
  let full = 0; const observe = f.api.state.observe.bind(f.api.state); f.api.state.observe = () => { full++; observe(); };
  const revision = f.api.state.revision;
  for (let i = 0; i < 60; i++) f.control.execute({ type: "SET_CHANNEL_FADER", channelId: f.channel.id, db: i % 2 ? -40 : -41 });
  assert.equal(full, 0); assert.ok(f.api.state.revision > revision);
  const unchanged = f.api.state.revision; f.control.execute({ type: "SET_CHANNEL_FADER", channelId: f.channel.id, db: -40 }); assert.equal(f.api.state.revision, unchanged);
  f.advance(1000); code(await execute(f, a.body.data.armId), "STALE_REVISION");
  const process = f.engine.processBlock; f.engine.processBlock = () => { throw new Error("No meter-triggered audio processing"); };
  const channelProcess = f.channel.outputMeter.process; f.channel.outputMeter.process = () => { throw new Error("No meter DSP"); };
  const bindings = f.api.meters.subscribe({ type: "meters.subscribe", requestId: randomUUID(), sources: [{ kind: "channel", target }], hz: 10 });
  assert.equal(f.api.meters.values(bindings.bindings).length, 1); f.engine.processBlock = process; f.channel.outputMeter.process = channelProcess;
});

test("preview IDs and recording paths never enter operational log or external state", async t => {
  const f = await setup(t), id = scene(f), p = await preview(f, id); recorder(f, t);
  const a = await recall(f, id, p.body.data.previewId); f.advance(1000); assert.equal((await execute(f, a.body.data.armId)).status, 200);
  const text = f.logs.join("\n"), state = JSON.stringify(await f.state()), hash = JSON.parse(readFileSync(f.store.path, "utf8")).devices[0].tokenHash;
  for (const value of [p.body.data.previewId, a.body.data.armId, f.registration.token, hash, "Private guest", join(f.root, "recordings")]) {
    assert.equal(text.includes(value), false); assert.equal(state.includes(value), false);
  }
  assert.match(text, /operation=scene.preview tier=A result=SUCCESS phase=action deviceId=/);
  assert.match(text, /operation=scene.recall tier=B result=SUCCESS phase=execute deviceId=/);
});

test("a fader mutation followed by a rejected persistence callback still records ABA before the next projection", async t => {
  const f = await setup(t); grant(f, ["channel.fader.set"]); await f.action("channel.fader.set", { target, db: -40 });
  const a = await arm(f, "channel.fader.set", { target, db: 0 });
  const capture = f.sessions.captureChannel; f.sessions.captureChannel = () => { throw new Error("Injected persistence failure"); };
  assert.equal(f.control.execute({ type: "SET_CHANNEL_FADER", channelId: f.channel.id, db: -41 }).ok, false);
  assert.equal(f.control.execute({ type: "SET_CHANNEL_FADER", channelId: f.channel.id, db: -40 }).ok, false);
  f.sessions.captureChannel = capture; f.advance(1000); code(await execute(f, a.body.data.armId), "STALE_REVISION");
});

test("unknown or ill-typed stored scene parameters are refused without echoing private values", async t => {
  const f = await setup(t), id = scene(f), saved = f.control.scenes.get(id)!, original = { ...saved.values };
  for (const [field, value] of [["matrix.route.label", "Private path fixture"], [`channel.${f.channel.id}.faderDb`, "Private path fixture"], ["unknown.source.label", "Private path fixture"]] as const) {
    saved.values = { ...original, [field]: value }; const result = await preview(f, id); code(result, "INVALID", 400);
    assert.equal(JSON.stringify(result.body).includes("Private path fixture"), false);
  }
});

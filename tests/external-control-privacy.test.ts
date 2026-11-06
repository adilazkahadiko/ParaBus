import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AudioChannel, SilenceSource, VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { RecorderManager } from "../services/router-core-sim/src/recorder.ts";
import { ALLOWED_TIER_B_OPERATIONS } from "../services/router-core-sim/src/external-protocol.ts";
import { fixture } from "./helpers/external-control-fixture.ts";
import { clientFrame, connectWs } from "./helpers/external-ws.ts";

const GUILD = "717171717171717171", VC = "828282828282828282", USER = "939393939393939393";
const target = { kind: "user", discordUserId: USER };
const safe = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const marker of [GUILD, VC, "discord-user:", "discord-vc:"]) assert.equal(json.includes(marker), false, "External JSON contains private topology");
};
const code = (result: any, expected: string) => { safe(result.body); assert.equal(result.body.code, expected); };
async function privateFixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await fixture(t); f.sessions.leave(f.channel); f.engine.channels.delete(f.channel.id);
  const bus = new VcBus(`discord-vc:${GUILD}:${VC}`, "Private bus", 480, 48000);
  bus.linkedDiscordGuildId = GUILD; bus.linkedDiscordVoiceChannelId = VC; f.engine.addBus(bus);
  const participant = new AudioChannel(`discord-user:${GUILD}:${VC}:${USER}`, "Private participant", "DiscordUser", new SilenceSource(), 480, 48000);
  participant.vcSends.set(bus.id, { gainDb: -20, mute: true }); f.engine.addChannel(participant); f.sessions.join(participant, USER, VC, participant.label);
  const other = new AudioChannel(`discord-user:${GUILD}:${VC}:legacy-source`, "Private local source", "LocalMonoInput", new SilenceSource(), 480, 48000);
  f.engine.addChannel(other);
  const routeId = `bus-output:${bus.id}`;
  f.engine.addMatrixRoute({ id: routeId, sourceId: bus.id, output: 0, gainDb: 0, mute: false, tap: "POST" });
  const recorder = new RecorderManager(f.engine, join(f.root, "recordings"));
  Object.defineProperty(f.control, "recorder", { value: recorder, configurable: true }); t.after(() => recorder.close());
  f.api.manage({ action: "permissions", deviceId: f.registration.deviceId, readDisplayNames: false, allowedTierBOperations: ALLOWED_TIER_B_OPERATIONS });
  f.api.manage({ action: "enable" });
  f.control.execute({ type: "SAVE_SCENE", name: "Privacy scene" }); const sceneId = f.control.currentSceneId!;
  const saved = f.control.scenes.get(sceneId)!;
  const choose = (parameter: string, low: number, high: number) => { saved.values[parameter] = f.control.sceneParameterValue(parameter) === low ? high : low; };
  for (const c of [participant, other]) {
    saved.values[`channel.${c.id}.label`] = "Saved label"; saved.values[`channel.${c.id}.mute`] = !c.mute;
    choose(`channel.${c.id}.faderDb`, -10, -9); choose(`channel.${c.id}.trimDb`, -2, -1); choose(`channel.${c.id}.order`, 9, 10);
  }
  saved.values[`channel.${participant.id}.send.${bus.id}.gainDb`] = -30; saved.values[`channel.${participant.id}.send.${bus.id}.mute`] = false;
  saved.values[`bus.${bus.id}.label`] = "Saved bus label"; saved.values[`bus.${bus.id}.mute`] = !bus.mute;
  saved.values[`bus.${bus.id}.compressorEnabled`] = !bus.compressorEnabled; saved.values[`bus.${bus.id}.limiterEnabled`] = !bus.limiter.enabled;
  for (const [field, low, high] of [["masterDb", -3, -2], ["compressorThresholdDb", -30, -20], ["compressorRatio", 4, 5], ["compressorAttackMs", 5, 6],
    ["compressorReleaseMs", 300, 400], ["compressorMakeupDb", 1, 2], ["limiterCeilingDb", -2, -3], ["limiterReleaseMs", 200, 300]] as const) choose(`bus.${bus.id}.${field}`, low, high);
  saved.values[`matrix.${routeId}.gainDb`] = -6; saved.values[`matrix.${routeId}.mute`] = true;
  const post = async (operation: string, args: unknown, path = "/actions") => {
    f.advance(1000); const result = await f.raw(f.request(operation, args), path); safe(result.body); return result;
  };
  const execute = async (armId: string) => {
    f.advance(1000); const result = await f.raw({ requestId: randomUUID(), instanceId: f.api.state.instanceId, armId }, "/execute"); safe(result.body); return result;
  };
  const get = async (path: string) => { f.advance(1000); const response = await fetch(f.base + path, { headers: f.headers }); const body = await response.json() as any; safe(body); return body; };
  const publicBusId = (await get("/state")).data.buses.find((b: any) => b.kind === "vc" && b.busId !== "bus").busId as string;
  return { ...f, bus, participant, other, routeId, recorder, sceneId, publicBusId, post, execute, get };
}

test("scene fields are target-relative, Send uses the public Bus ID, and other IDs are per-preview ordinals", async t => {
  const f = await privateFixture(t), p = await f.post("scene.preview", { sceneId: f.sceneId }); assert.equal(p.status, 200);
  const changes = p.body.data.changes;
  const userChanges = changes.filter((c: any) => c.target.kind === "channel");
  assert.deepEqual(userChanges.map((c: any) => c.field).sort(), ["faderDb", "mute", "trimDb", "label", "order", `send.${f.publicBusId}.gainDb`, `send.${f.publicBusId}.mute`].sort());
  assert.ok(userChanges.every((c: any) => c.target.target.discordUserId === USER));
  const busChanges = changes.filter((c: any) => c.target.kind === "bus");
  assert.deepEqual(busChanges.map((c: any) => c.field).sort(), ["masterDb", "mute", "label", "compressorEnabled", "compressorThresholdDb", "compressorRatio", "compressorAttackMs",
    "compressorReleaseMs", "compressorMakeupDb", "limiterEnabled", "limiterCeilingDb", "limiterReleaseMs"].sort());
  assert.ok(busChanges.every((c: any) => c.target.busId === f.publicBusId));
  const others = changes.filter((c: any) => c.target.kind === "other"), ids = [...new Set(others.map((c: any) => c.target.id))];
  assert.deepEqual(ids, ["other-1", "other-2"]);
  assert.deepEqual(others.filter((c: any) => c.target.id === "other-1").map((c: any) => c.field).sort(), ["label", "faderDb", "mute", "trimDb", "order"].sort());
  assert.deepEqual(others.filter((c: any) => c.target.id === "other-2").map((c: any) => c.field).sort(), ["gainDb", "mute"]);
  assert.ok(changes.filter((c: any) => c.field === "label").every((c: any) => c.from === null && c.to === null));
  f.api.manage({ action: "permissions", deviceId: f.registration.deviceId, readDisplayNames: true, allowedTierBOperations: ALLOWED_TIER_B_OPERATIONS });
  const named = await f.post("scene.preview", { sceneId: f.sceneId }); assert.equal(named.status, 200); safe(named.body);
  assert.ok(named.body.data.changes.some((c: any) => c.field === "label" && typeof c.from === "string"));
  const a = await f.post("scene.recall", { sceneId: f.sceneId, previewId: named.body.data.previewId }, "/arm"); assert.equal(a.status, 200);
  assert.equal((await f.execute(a.body.data.armId)).status, 200);
  assert.equal(f.engine.matrixRoutes.get(f.routeId)!.gainDb, -6); assert.equal(f.other.faderDb, -10);
});

test("complete HTTP and WS state/meters/result JSON and every B summary omit Discord topology", async t => {
  const f = await privateFixture(t); assert.equal((await f.get("/info")).ok, true);
  const state = (await f.get("/state")).data; assert.equal(state.participants[0].sends[0].busId, f.publicBusId);
  assert.equal(state.participantOrders.find((o: any) => o.scope.kind === "bus" && o.scope.busId === f.publicBusId).users[0], USER);
  const ws = await connectWs(f.api.port, f.headers.authorization); t.after(() => ws.socket.destroy()); safe(await ws.next());
  const next = async (type: string) => { for (let i = 0; i < 10; i++) { const message = await ws.next(); safe(message); if (message.type === type) return message; } throw Error("Expected external frame missing"); };
  await f.post("pfl.set", { source: { kind: "bus", busId: f.publicBusId } }); assert.equal((await f.get("/state")).data.pfl.busId, f.publicBusId);
  f.api.tick(); await next("state");
  ws.socket.write(clientFrame(JSON.stringify({ type: "meters.subscribe", requestId: randomUUID(), sources: [{ kind: "channel", target }, { kind: "bus", busId: f.publicBusId }, { kind: "tx", profileId: "TX1" }], hz: 10 })));
  assert.equal((await next("result")).payload.ok, true); f.advance(100); f.api.tick(); const meters = await next("meters"); assert.equal(meters.values[1].source.busId, f.publicBusId);
  f.advance(1000); ws.socket.write(clientFrame(JSON.stringify({ type: "meters.subscribe", requestId: randomUUID(), sources: [{ kind: "bus", busId: `${f.bus.id}:missing` }], hz: 10 })));
  assert.equal((await next("result")).payload.code, "NOT_FOUND");
  f.advance(1000); ws.socket.write(clientFrame(JSON.stringify({ type: "meters.unsubscribe", requestId: randomUUID() }))); assert.equal((await next("result")).payload.ok, true);
  const run = async (operation: string, args: unknown) => { const a = await f.post(operation, args, "/arm"); assert.equal(a.status, 200); assert.equal((await f.execute(a.body.data.armId)).status, 200); };
  await f.post("bus.fader.set", { busId: f.publicBusId, db: -40 }); await run("bus.fader.set", { busId: f.publicBusId, db: 0 });
  await f.post("send.fader.set", { target, busId: f.publicBusId, db: -40 }); await run("send.fader.set", { target, busId: f.publicBusId, db: 0 });
  await f.post("channel.fader.set", { target, db: -40 }); await run("channel.fader.set", { target, db: 0 });
  await f.post("tx.fader.set", { profileId: "TX1", db: -40 }); await run("tx.fader.set", { profileId: "TX1", db: 0 });
  await run("settings.lock.set", { locked: false });
  await f.post("emergency.set", { active: true }); f.control.execute({ type: "SET_STATE", state: "READY" });
  await run("emergency.set", { active: false, expectedEmergencyEpoch: f.control.emergencyEpoch }); f.control.execute({ type: "SET_STATE", state: "SETUP" });
  await run("bus.limiter.set", { busId: f.publicBusId, enabled: true }); await run("bus.compressor.set", { busId: f.publicBusId, enabled: true });
  await run("recording.start", { selection: { outputs: [], busIds: [f.publicBusId], participants: [target] } }); await run("recording.stop", {}); await f.recorder.waitForIdle();
  await f.post("loudness.reset", { busId: f.publicBusId });
  const current = (await f.get("/state")).data;
  assert.equal((await f.post("channel.mute.set", { target: { kind: "slot", scope: { kind: "bus", busId: f.publicBusId }, index: 1, expectedParticipantsRevision: current.participantsRevision }, mute: true })).status, 200);
  const p = await f.post("scene.preview", { sceneId: f.sceneId }); await run("scene.recall", { sceneId: f.sceneId, previewId: p.body.data.previewId });
  assert.ok(f.commands.some((c: any) => c.type === "SET_BUS_COMPRESSOR" && c.busId === f.bus.id));
  assert.ok(f.commands.some((c: any) => c.type === "START_RECORDING" && c.selection.busIds[0] === f.bus.id));
  f.api.manage({ action: "stop" }); assert.equal((await next("error")).payload.code, "DISABLED"); safe(await ws.next());
  code(await f.post("bus.mute.set", { busId: f.publicBusId, mute: false }), "DISABLED");
});

test("HTTP error envelopes do not echo topology from invalid inputs or backend failures", async t => {
  const f = await privateFixture(t);
  code(await f.post("not.an.operation", { value: f.participant.id }), "INVALID");
  code(await f.post("bus.mute.set", { busId: `${f.bus.id}:missing`, mute: false }), "NOT_FOUND");
  code(await f.post("bus.limiter.set", { busId: f.publicBusId, enabled: true }), "CONFIRMATION_REQUIRED");
  const unknown = await f.raw({ requestId: randomUUID(), instanceId: f.api.state.instanceId, armId: `${GUILD}:${VC}` }, "/execute"); code(unknown, "ARM_INVALID");
  const a = await f.post("bus.limiter.set", { busId: f.publicBusId, enabled: true }, "/arm");
  code(await f.raw({ requestId: randomUUID(), instanceId: f.api.state.instanceId, armId: a.body.data.armId }, "/execute"), "ARM_TOO_EARLY");
  const b = await f.post("bus.limiter.set", { busId: f.publicBusId, enabled: true }, "/arm"); f.advance(5000); code(await f.execute(b.body.data.armId), "ARM_EXPIRED");
  f.control.state = "ON_AIR"; code(await f.post("bus.limiter.set", { busId: f.publicBusId, enabled: true }, "/arm"), "LOCKED"); f.control.state = "SETUP";
  const original = f.api.options.execute; f.api.options.execute = () => { throw Error(`Injected ${f.participant.id}`); };
  code(await f.post("bus.mute.set", { busId: f.publicBusId, mute: true }), "INTERNAL"); f.api.options.execute = original;
  const stale = await f.raw(f.request("bus.mute.set", { busId: f.publicBusId, mute: true }, { instanceId: randomUUID() })); code(stale, "STALE_REVISION");
  f.api.manage({ action: "permissions", deviceId: f.registration.deviceId, readDisplayNames: false, allowedTierBOperations: [] });
  code(await f.post("scene.recall", { sceneId: f.sceneId, previewId: f.participant.id }, "/arm"), "TIER_FORBIDDEN");
  const unauthorized = await fetch(f.base + "/info"); safe(await unauthorized.json()); assert.equal(unauthorized.status, 401);
  const forbidden = await fetch(f.base + "/state", { headers: { ...f.headers, origin: `https://${GUILD}.invalid/${VC}` } }); safe(await forbidden.json()); assert.equal(forbidden.status, 403);
  for (let i = 0; i < 11; i++) { const response = await fetch(f.base + "/state", { headers: f.headers }); safe(await response.json()); if (i === 10) assert.equal(response.status, 429); }
});

test("display-only projection preserves internal scene parameter checks, ABA, Recall Safe, locks and other generations", async t => {
  const f = await privateFixture(t), parameter = `channel.${f.participant.id}.faderDb`;
  f.control.scenes.get(f.sceneId)!.values = { [parameter]: 0 }; f.participant.faderDb = -40;
  const p = await f.post("scene.preview", { sceneId: f.sceneId }); assert.equal(p.body.data.changes[0].field, "faderDb");
  assert.equal(f.api.scenes.snapshot(f.sceneId).changes[0].parameter === parameter, true);
  f.control.execute({ type: "SET_CHANNEL_FADER", channelId: f.participant.id, db: -41 }); f.control.execute({ type: "SET_CHANNEL_FADER", channelId: f.participant.id, db: -40 });
  code(await f.post("scene.recall", { sceneId: f.sceneId, previewId: p.body.data.previewId }, "/arm"), "STALE_REVISION");
  const q = await f.post("scene.preview", { sceneId: f.sceneId }), a = await f.post("scene.recall", { sceneId: f.sceneId, previewId: q.body.data.previewId }, "/arm");
  f.control.execute({ type: "SET_CHANNEL_FADER", channelId: f.participant.id, db: -41 }); f.control.execute({ type: "SET_CHANNEL_FADER", channelId: f.participant.id, db: -40 });
  code(await f.execute(a.body.data.armId), "STALE_REVISION");
  const r = await f.post("scene.preview", { sceneId: f.sceneId }); f.control.execute({ type: "SET_RECALL_SAFE", parameter, safe: true });
  code(await f.post("scene.recall", { sceneId: f.sceneId, previewId: r.body.data.previewId }, "/arm"), "STALE_REVISION");
  const s = await f.post("scene.preview", { sceneId: f.sceneId }), b = await f.post("scene.recall", { sceneId: f.sceneId, previewId: s.body.data.previewId }, "/arm");
  await f.post("bus.fader.adjust", { busId: f.publicBusId, deltaDb: -1 }); assert.equal((await f.execute(b.body.data.armId)).status, 200); assert.equal(f.participant.faderDb, -40);
  f.control.scenes.get(f.sceneId)!.values = { [`bus.${f.bus.id}.limiterEnabled`]: false }; f.bus.limiter.enabled = true;
  const locked = await f.post("scene.preview", { sceneId: f.sceneId }); f.control.execute({ type: "SET_STATE", state: "READY" });
  code(await f.post("scene.recall", { sceneId: f.sceneId, previewId: locked.body.data.previewId }, "/arm"), "STALE_REVISION");
  const onAir = await f.post("scene.preview", { sceneId: f.sceneId }), c = await f.post("scene.recall", { sceneId: f.sceneId, previewId: onAir.body.data.previewId }, "/arm");
  assert.equal((await f.execute(c.body.data.armId)).status, 200); assert.equal(f.bus.limiter.enabled, true);
  f.control.state = "SETUP"; f.control.scenes.get(f.sceneId)!.values = { [`matrix.${f.routeId}.gainDb`]: -6 };
  const other = await f.post("scene.preview", { sceneId: f.sceneId }); assert.equal(other.body.data.changes[0].target.id, "other-1");
  f.engine.matrixRoutes.set(f.routeId, { ...f.engine.matrixRoutes.get(f.routeId)! }); f.api.noteChange();
  code(await f.post("scene.recall", { sceneId: f.sceneId, previewId: other.body.data.previewId }, "/arm"), "STALE_REVISION");
});

test("Bus aliases remain stable within the launch, old raw input stays compatible, and alias/raw duplicates are rejected", async t => {
  const f = await privateFixture(t); assert.match(f.publicBusId, /^external-bus:[a-f0-9-]{36}$/);
  assert.equal((await f.get("/state")).data.buses.some((b: any) => b.busId === "bus"), true);
  assert.equal(f.api.state.publicBusId(f.bus.id), f.publicBusId);
  assert.equal((await f.post("bus.mute.set", { busId: f.bus.id, mute: true })).status, 200); assert.equal(f.bus.mute, true);
  code(await f.post("recording.start", { selection: { outputs: [], busIds: [f.publicBusId, f.bus.id], participants: [] } }, "/arm"), "INVALID");
  assert.throws(() => f.api.meters.subscribe({ type: "meters.subscribe", requestId: randomUUID(), sources: [{ kind: "bus", busId: f.publicBusId }, { kind: "bus", busId: f.bus.id }], hz: 10 }), (error: any) => error.code === "INVALID");
  await f.post("bus.fader.set", { busId: f.publicBusId, db: -40 }); const a = await f.post("bus.fader.set", { busId: f.publicBusId, db: 0 }, "/arm");
  f.engine.buses.set(f.bus.id, new VcBus(f.bus.id, "Replacement", 480, 48000)); f.api.noteChange(); code(await f.execute(a.body.data.armId), "STALE_REVISION");
});

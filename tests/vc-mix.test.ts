import assert from "node:assert/strict";
import test from "node:test";
import { DiscordFrameType } from "../packages/discord-ipc/src/index.ts";
import { AudioChannel, AudioEngine, SineSource, VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";

function ids(index: number, userOffset = 0) {
  return {
    botId: String(400000000000000001n + BigInt(index)),
    guildId: "410000000000000001",
    voiceChannelId: String(420000000000000001n + BigInt(index)),
    userId: String(430000000000000001n + BigInt(index * 10 + userOffset)),
  };
}

function botMeta(index: number, name: string) {
  const identity = ids(index);
  return {
    type: DiscordFrameType.BOT_META,
    ...identity,
    payload: Buffer.from(JSON.stringify({
      profileId: `RX${index + 1}`,
      label: `RX ${index + 1}`,
      role: "RX",
      gatewayState: "ready",
      voiceState: "ready",
      voiceChannelName: name,
    })),
  } as const;
}

test("Discord VC metadata auto-creates one isolated mono bus per VC", () => {
  const engine = new AudioEngine(48_000, 480, 2);
  const ingest = new DiscordIngestServer(engine, "test-only");
  ingest.ingest(botMeta(0, "INTERVIEW A"));
  ingest.ingest(botMeta(1, "INTERVIEW B"));
  ingest.ingest({ type: DiscordFrameType.USER_META, ...ids(0), payload: Buffer.from("Guest A") });
  ingest.ingest({ type: DiscordFrameType.USER_META, ...ids(1), payload: Buffer.from("Guest B") });

  assert.equal(engine.buses.size, 2);
  const channels = [...engine.channels.values()];
  assert.equal(channels[0].vcSends.size, 1);
  assert.equal(channels[1].vcSends.size, 1);
  assert.notEqual([...channels[0].vcSends.keys()][0], [...channels[1].vcSends.keys()][0]);
  assert.deepEqual([...channels[0].vcSends.values()][0], { gainDb: -12, mute: false });
});

test("SAFE, HOLD and PRESET policies apply only when a participant is created", () => {
  const engine = new AudioEngine(48_000, 480, 2);
  const ingest = new DiscordIngestServer(engine, "test-only");
  const policies = [
    { policy: "SAFE" as const, defaultSendDb: -3, expected: { gainDb: -12, mute: false } },
    { policy: "HOLD" as const, defaultSendDb: -9, expected: { gainDb: -9, mute: true } },
    { policy: "PRESET" as const, defaultSendDb: -4.5, expected: { gainDb: -4.5, mute: false } },
  ];
  policies.forEach((item, index) => {
    ingest.ingest(botMeta(index, `VC ${index + 1}`));
    const bus = [...engine.buses.values()][index];
    bus.newParticipantPolicy = item.policy;
    bus.defaultSendDb = item.defaultSendDb;
    ingest.ingest({ type: DiscordFrameType.USER_META, ...ids(index), payload: Buffer.from(`Guest ${index + 1}`) });
    const channel = engine.channels.get(`discord-user:${ids(index).guildId}:${ids(index).voiceChannelId}:${ids(index).userId}`)!;
    assert.deepEqual(channel.vcSends.get(bus.id), item.expected);
  });
});

test("Quick Mix controls sends, master, compressor and participant count", () => {
  const engine = new AudioEngine(48_000, 480, 2);
  const bus = new VcBus("quick", "QUICK INTERVIEW", 480, 48_000);
  engine.addBus(bus);
  const channel = new AudioChannel("guest", "Guest", "TestTone", new SineSource(1_000, -3), 480, 48_000);
  channel.vcSends.set(bus.id, bus.newParticipantSend());
  engine.addChannel(channel);
  const control = new ControlPlane(engine);

  assert.equal(control.execute({ type: "SET_VC_SEND", channelId: "guest", busId: "quick", db: -5, mute: false }).ok, true);
  assert.equal(control.execute({ type: "SET_BUS_MASTER", busId: "quick", db: -2 }).ok, true);
  assert.equal(control.execute({ type: "SET_BUS_COMPRESSOR", busId: "quick", enabled: true, thresholdDb: -30, ratio: 6, attackMs: 2, releaseMs: 150, makeupDb: 1 }).ok, true);
  for (let block = 0; block < 20; block += 1) engine.processBlock();
  const snapshot = control.snapshot().buses[0];
  assert.equal(snapshot.participantCount, 1);
  assert.equal(snapshot.compressorThresholdDb, -30);
  assert.equal(snapshot.compressorRatio, 6);
  assert.ok(snapshot.compressorGainReductionDb > 0);
  assert.ok(snapshot.inputMeter.peak > 0);
});

test("Bus topology and participant policy lock ON AIR while send levels remain live", () => {
  const engine = AudioEngine.createDemo(1);
  const control = new ControlPlane(engine);
  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  assert.equal(control.execute({ type: "CREATE_VC_BUS", name: "Late Bus" }).ok, false);
  assert.equal(control.execute({ type: "SET_NEW_PARTICIPANT_POLICY", busId: "interview", policy: "HOLD" }).ok, false);
  assert.equal(control.execute({ type: "SET_VC_SEND", channelId: "user-01", busId: "interview", db: -7 }).ok, true);
  assert.equal(engine.channels.get("user-01")?.vcSends.get("interview")?.gainDb, -7);
});

test("VC Bus removal requires confirmation and cleans sends and matrix routes", () => {
  const engine = AudioEngine.createDemo(1);
  const control = new ControlPlane(engine);
  const created = control.execute({ type: "CREATE_VC_BUS", name: "Green Room", policy: "HOLD", defaultSendDb: -18 });
  const busId = (created.data as { busId: string }).busId;
  const channel = engine.channels.get("user-01")!;
  channel.vcSends.set(busId, { gainDb: -18, mute: true });
  engine.addMatrixRoute({ id: "green-out", sourceId: busId, output: 0, gainDb: 0, mute: false, tap: "POST" });
  assert.equal(control.execute({ type: "REMOVE_VC_BUS", busId }).confirmationRequired, true);
  assert.equal(control.execute({ type: "REMOVE_VC_BUS", busId, confirmed: true }).ok, true);
  assert.equal(engine.buses.has(busId), false);
  assert.equal(channel.vcSends.has(busId), false);
  assert.equal(engine.matrixRoutes.has("green-out"), false);
});

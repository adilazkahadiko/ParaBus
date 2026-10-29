import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import test from "node:test";
import { decodeDiscordFrame, DiscordFrameType, DiscordTxFlags, encodeDiscordFrame } from "../packages/discord-ipc/src/index.ts";
import { parseBotRackConfig } from "../services/discord-adapter/src/bot-config.ts";
import { DISCORD_TX_STREAM_HIGH_WATER_MARK_BYTES, DiscordBotConnection } from "../services/discord-adapter/src/bot-connection.ts";
import type { DiscordIpcClient } from "../services/discord-adapter/src/ipc-client.ts";
import { AudioChannel, AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";
import { AudioInputManager } from "../services/router-core-sim/src/audio-input.ts";

test("input reselection during TX is denied without recreating a muted input or changing routing", () => {
  const engine = new AudioEngine(), ingest = new DiscordIngestServer(engine, "test-only");
  const input = new AudioInputManager(engine, null), socket = new FakeAdapterSocket();
  const control = new ControlPlane(engine, undefined, ingest, input);
  try {
    const select = { type: "SELECT_INPUT_DEVICE" as const, deviceId: "mock-studio-8", channelCount: 2 };
    assert.equal(control.execute(select).ok, true);
    const channel = engine.channels.get("local-input:1")!; channel.mute = true;
    const payload = txStatus();
    ingest.ingest({ type: DiscordFrameType.BOT_META, ...txIds, payload }, socket as unknown as Socket);
    ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...txIds, payload }, socket as unknown as Socket);
    ingest.setTxInput(channel.id, "TX_RETURN01"); ingest.startTx("TX_RETURN01");
    const before = input.snapshot(), route = ingest.txSnapshot().sourceInputChannelId;
    for (const request of [select, { ...select, channelCount: 1 }, { ...select, deviceId: "none" }]) {
      assert.equal(control.execute(request).ok, false, "SETUP alone is not permission to replace a live TX input");
      assert.equal(engine.channels.get(channel.id), channel); assert.equal(channel.mute, true);
      assert.equal(input.snapshot().selectedDeviceId, before.selectedDeviceId);
      assert.equal(input.snapshot().activeChannelCount, before.activeChannelCount);
      assert.equal(ingest.txSnapshot().sourceInputChannelId, route);
      engine.processBlock(); ingest.writeTxBlock();
      assert.ok(decodeDiscordFrame(socket.writes.at(-1)!).payload!.every(byte => byte === 0));
    }
    ingest.stopAllTx(); assert.equal(control.execute(select).ok, true);
  } finally { input.stop(); }
});

const txIds = {
  botId: "900000000000000001",
  guildId: "100000000000000001",
  voiceChannelId: "100000000000000101",
};

test("local inputs route independently to TX without any physical or Matrix output assignment", () => {
  const engine = new AudioEngine();
  const ingest = new DiscordIngestServer(engine, "test-only");
  const control = new ControlPlane(engine, undefined, ingest);
  const adapters = [new FakeAdapterSocket(), new FakeAdapterSocket()];
  for (let index = 0; index < 2; index++) {
    const input = new AudioChannel(`local-input:${index + 1}`, `IN ${index + 1}`, "LocalMonoInput", {
      fill(target) { target.fill(index ? -0.2 : 0.1); return true; },
    }, engine.blockSize, engine.sampleRate);
    input.hpfEnabled = input.compressorEnabled = false;
    engine.addChannel(input);
    const ids = { ...txIds, botId: String(BigInt(txIds.botId) + BigInt(index)) };
    const payload = txStatus({ profileId: `TX${index + 1}` });
    ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload }, adapters[index] as unknown as Socket);
    ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...ids, payload }, adapters[index] as unknown as Socket);
    assert.equal(control.execute({ type: "SET_TX_INPUT", profileId: `TX${index + 1}`, channelId: input.id }).ok, true);
    assert.equal(ingest.txSnapshot(Date.now(), `TX${index + 1}`).active, false, "assignment never starts TX");
    ingest.startTx(`TX${index + 1}`);
  }
  engine.processBlock(); ingest.writeTxBlock();
  assert.equal(engine.outputs.every(output => output.every(sample => sample === 0)), true, "physical OUT stays silent");
  assert.equal(engine.channels.get("local-input:1")!.directOutput, undefined);
  assert.equal(engine.channels.get("local-input:1")!.vcSends.size, 0);
  const first = Buffer.from(decodeDiscordFrame(adapters[0].writes.at(-1)!).payload!);
  const second = Buffer.from(decodeDiscordFrame(adapters[1].writes.at(-1)!).payload!);
  assert.equal(first.readInt16LE(0), Math.round(0.1 * 32767));
  assert.equal(first.readInt16LE(2), first.readInt16LE(0), "mono input is duplicated into stereo transport");
  assert.equal(second.readInt16LE(0), Math.round(-0.2 * 32767));
  assert.equal(control.execute({ type: "SET_TX_INPUT", profileId: "TX1", channelId: "local-input:2" }).ok, false);
  engine.channels.get("local-input:1")!.mute = true;
  engine.processBlock(); ingest.writeTxBlock();
  assert.equal(decodeDiscordFrame(adapters[0].writes.at(-1)!).payload!.every(byte => byte === 0), true, "input MUTE is respected");
  assert.notEqual(Buffer.from(decodeDiscordFrame(adapters[1].writes.at(-1)!).payload!).readInt16LE(0), 0);
  engine.channels.delete("local-input:1");
  ingest.writeTxBlock();
  assert.equal(ingest.txSnapshot(Date.now(), "TX1").active, false);
  assert.equal(ingest.txSnapshot(Date.now(), "TX2").active, true);
  assert.equal(control.execute({ type: "SET_TX_INPUT", profileId: "TX1", channelId: null }).ok, true);
  assert.throws(() => ingest.startTx("TX1"), /not assigned/);
  assert.throws(() => ingest.setTxInput("nonexistent", "TX1"), /local input/);
  for (const state of ["ON_AIR", "FAULT"] as const) {
    control.state = state;
    assert.equal(control.execute({ type: "SET_TX_INPUT", profileId: "TX1", channelId: "local-input:2" }).ok, false);
  }
  engine.emergencyMuted = true;
  ingest.writeTxBlock();
  assert.equal(ingest.txSnapshots().every(stem => !stem.active), true);
  engine.emergencyMuted = false; ingest.writeTxBlock();
  assert.equal(ingest.txSnapshots().every(stem => !stem.active), true, "no automatic restart");
});

test("TX masters scale each Bot independently after inputs, preserve stereo and never start transmission", () => {
  const engine = new AudioEngine(), ingest = new DiscordIngestServer(engine, "test-only");
  const control = new ControlPlane(engine, undefined, ingest);
  const sockets = [new FakeAdapterSocket(), new FakeAdapterSocket()];
  for (let i = 1; i <= 2; i++) {
    const channel = new AudioChannel(`local-input:${i}`, `IN ${i}`, "LocalMonoInput", {
      fill(target) { target.fill(i === 1 ? 0.1 : -0.2); return true; },
    }, engine.blockSize, engine.sampleRate);
    channel.hpfEnabled = channel.compressorEnabled = false; engine.addChannel(channel);
  }
  for (let i = 0; i < 2; i++) {
    const ids = { ...txIds, botId: String(BigInt(txIds.botId) + BigInt(i)) };
    const payload = txStatus({ profileId: `TX${i}`, txAudioMode: i ? "STEREO" : "MONO" });
    ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload }, sockets[i] as unknown as Socket);
    ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...ids, payload }, sockets[i] as unknown as Socket);
    ingest.setTxInput("local-input:1", `TX${i}`);
    assert.equal(ingest.txSnapshot(Date.now(), `TX${i}`).masterDb, 0);
    assert.equal(control.execute({ type: "SET_TX_MASTER", profileId: `TX${i}`, db: i ? 6 : -6 }).ok, true);
    assert.equal(ingest.txSnapshot(Date.now(), `TX${i}`).active, false);
    ingest.startTx(`TX${i}`);
  }
  engine.processBlock();
  const post = engine.channels.get("local-input:1")!.post.slice();
  ingest.writeTxBlock();
  const pcm = (i: number) => Buffer.from(decodeDiscordFrame(sockets[i].writes.at(-1)!).payload!);
  assert.equal(pcm(0).readInt16LE(0), Math.round(post[0] * 10 ** (-6 / 20) * 32767));
  assert.equal(pcm(1).readInt16LE(0), Math.round(post[0] * 10 ** (6 / 20) * 32767));
  assert.equal(pcm(1).readInt16LE(2), Math.round(engine.channels.get("local-input:2")!.post[0] * 10 ** (6 / 20) * 32767));
  assert.deepEqual(engine.channels.get("local-input:1")!.post, post, "gain never mutates shared input or recording taps");
  assert.equal(engine.outputs.every(output => output.every(sample => sample === 0)), true);
  assert.equal(control.meterSnapshot().txMeters[0].masterDb, -6);
  assert.ok(control.meterSnapshot().txMeters[1].peak > control.meterSnapshot().txMeters[0].peak);
  assert.doesNotMatch(JSON.stringify(control.meterSnapshot().txMeters), /voiceChannel|queueWindows|token/);
  control.state = "ON_AIR";
  assert.equal(control.execute({ type: "SET_TX_MASTER", profileId: "TX0", db: -90 }).ok, true);
  ingest.writeTxBlock(); assert.ok(pcm(0).every(byte => byte === 0)); assert.ok(pcm(1).some(byte => byte !== 0));
  for (const db of [-91, 13, NaN, Infinity]) {
    assert.equal(control.execute({ type: "SET_TX_MASTER", profileId: "TX0", db }).ok, false);
    assert.throws(() => ingest.setTxMaster(db, "TX0"), /-90..12/);
  }
  assert.equal(control.execute({ type: "SET_TX_MASTER", profileId: "missing", db: 0 }).ok, false);
  control.state = "FAULT";
  assert.equal(control.execute({ type: "SET_TX_MASTER", profileId: "TX0", db: 0 }).ok, false);
  ingest.stopAllTx(); const count = sockets[0].writes.length;
  control.state = "SETUP"; control.execute({ type: "SET_TX_MASTER", profileId: "TX0", db: 0 }); ingest.writeTxBlock();
  assert.equal(sockets[0].writes.length, count, "fader changes cannot restart stopped TX");
  engine.emergencyMuted = true; ingest.writeTxBlock(); engine.emergencyMuted = false; ingest.writeTxBlock();
  assert.ok(ingest.txSnapshots().every(stem => !stem.active));
});

test("Discord TX adapter queue is bounded to ten 10 ms PCM blocks", () => {
  assert.equal(DISCORD_TX_STREAM_HIGH_WATER_MARK_BYTES, 480 * 2 * 2 * 10);
});

test("stereo TX preserves separate adjacent input L/R and stops if either channel disappears", () => {
  const engine = new AudioEngine(), ingest = new DiscordIngestServer(engine, "test-only"), socket = new FakeAdapterSocket();
  for (let index = 1; index <= 2; index++) {
    const channel = new AudioChannel(`local-input:${index}`, `IN ${index}`, "LocalMonoInput", {
      fill(target) { target.fill(index === 1 ? 0.25 : -0.5); return true; },
    }, engine.blockSize, engine.sampleRate);
    channel.hpfEnabled = channel.compressorEnabled = false; engine.addChannel(channel);
  }
  const payload = txStatus({ txAudioMode: "STEREO" });
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...txIds, payload }, socket as unknown as Socket);
  ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...txIds, payload }, socket as unknown as Socket);
  assert.throws(() => ingest.setTxInput("local-input:2", "TX_RETURN01"), /two adjacent/);
  ingest.setTxInput("local-input:1", "TX_RETURN01"); ingest.startTx("TX_RETURN01");
  assert.equal(ingest.txSnapshot().sourceInputRightChannelId, "local-input:2");
  engine.processBlock(); ingest.writeTxBlock();
  const pcm = Buffer.from(decodeDiscordFrame(socket.writes.at(-1)!).payload!);
  assert.equal(pcm.readInt16LE(0), Math.round(0.25 * 32767));
  assert.equal(pcm.readInt16LE(2), Math.round(-0.5 * 32767));
  assert.equal(engine.outputs.every(output => output.every(sample => sample === 0)), true);
  engine.channels.delete("local-input:2"); ingest.writeTxBlock();
  assert.equal(ingest.txSnapshot().active, false);
  assert.throws(() => ingest.startTx("TX_RETURN01"), /right input/);
});

function txStatus(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    profileId: "TX_RETURN01",
    label: "TX STUDIO RETURN",
    role: "TX",
    txSubtype: "CUSTOM",
    txAudioMode: "MONO",
    gatewayState: "ready",
    voiceState: "ready",
    voiceChannelName: "INTERVIEW",
    txEnabled: false,
    txFrames: 0,
    txDroppedFrames: 0,
    ...overrides,
  }));
}

class FakeAdapterSocket extends EventEmitter {
  writable = true;
  destroyed = false;
  writableLength = 0;
  readonly writes: Buffer[] = [];
  resetCount = 0;

  setNoDelay(): this { return this; }

  write(data: Uint8Array): boolean {
    this.writes.push(Buffer.from(data));
    return true;
  }

  resetAndDestroy(): this {
    this.resetCount += 1;
    this.destroyed = true;
    this.writable = false;
    this.writableLength = 0;
    return this;
  }

  destroy(): this { return this.resetAndDestroy(); }
}

test("Phase 7 Bot Rack accepts 20 RX plus four explicit TX profiles", () => {
  const bots = Array.from({ length: 20 }, (_, index) => ({
    id: `RX${index + 1}`,
    role: "RX",
    tokenEnv: `RX_TOKEN_${index + 1}`,
    guildId: "100000000000000001",
    voiceChannelId: String(100000000000000101n + BigInt(index)),
  }));
  const txProfiles = [
    ["GAME", "STEREO"], ["CASTER", "MONO"], ["COMMENTARY", "MONO"], ["IFB", "MONO"],
  ] as const;
  for (const [subtype, mode] of txProfiles) bots.push({
    id: `TX_${subtype}01`, role: "TX", txSubtype: subtype, txAudioMode: mode,
    tokenEnv: `TX_TOKEN_${subtype}`, guildId: "100000000000000001", voiceChannelId: "100000000000000101",
  } as (typeof bots)[number]);
  const environment: NodeJS.ProcessEnv = {};
  for (let index = 0; index < 20; index += 1) environment[`RX_TOKEN_${index + 1}`] = `rx-secret-${index + 1}`;
  for (const [subtype] of txProfiles) environment[`TX_TOKEN_${subtype}`] = `tx-secret-${subtype}`;
  const profiles = parseBotRackConfig({ bots }, environment);
  assert.equal(profiles.length, 24);
  assert.equal(profiles.at(-1)?.role, "TX");
  assert.equal(profiles.at(-1)?.txSubtype, "IFB");
  assert.equal(profiles.at(-1)?.txAudioMode, "MONO");
});

test("Bot Rack rejects a 23rd TX Bot", () => {
  const environment: NodeJS.ProcessEnv = {};
  const suffixes = Array.from({ length: 23 }, (_, index) => String(index + 1));
  const bots = suffixes.map((suffix, index) => ({
    id: `TX_${suffix}`,
    role: "TX",
    tokenEnv: `TX_${suffix}`,
    guildId: "100000000000000001",
    voiceChannelId: String(100000000000000101n + BigInt(index)),
  }));
  for (const suffix of suffixes) environment[`TX_${suffix}`] = suffix;
  assert.throws(() => parseBotRackConfig({ bots }, environment), /at most 22 TX\/DUPLEX bots/);
});

test("one DUPLEX Bot provides an RX bus and a TX stem", () => {
  const profile = parseBotRackConfig({ bots: [{
    id: "BOT01", label: "Studio Duplex", role: "DUPLEX", txSubtype: "GAME", txAudioMode: "STEREO",
    tokenEnv: "DUPLEX_TOKEN", guildId: txIds.guildId, voiceChannelId: txIds.voiceChannelId,
  }] }, { DUPLEX_TOKEN: "duplex-secret" })[0];
  assert.equal(profile.role, "DUPLEX");
  assert.equal(profile.txSubtype, "GAME");
  assert.equal(profile.txAudioMode, "STEREO");

  const engine = AudioEngine.createDemo(1);
  const ingest = new DiscordIngestServer(engine, "test-only");
  const duplexStatus = txStatus({ profileId: "BOT01", label: "Studio Duplex", role: "DUPLEX", txSubtype: "GAME", txAudioMode: "STEREO" });
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...txIds, payload: duplexStatus });
  ingest.ingest({
    type: DiscordFrameType.USER_META,
    ...txIds,
    userId: "700000000000000001",
    payload: Buffer.from("Remote Guest"),
  });
  const snapshot = ingest.snapshot();
  assert.equal(snapshot.bots[0].role, "DUPLEX");
  assert.equal(snapshot.sources.length, 1);
  assert.equal(engine.buses.has(`discord-vc:${txIds.guildId}:${txIds.voiceChannelId}`), true);
  assert.equal(ingest.txSnapshots()[0].profileId, "BOT01");
});

test("DUPLEX adapter accepts TX PCM on the same profile", async () => {
  const sent: unknown[] = [];
  const ipc = { send: (frame: unknown) => sent.push(frame) } as unknown as DiscordIpcClient;
  const profile = parseBotRackConfig({ bots: [{
    id: "BOT01", role: "DUPLEX", txSubtype: "CUSTOM", txAudioMode: "MONO",
    tokenEnv: "DUPLEX_TOKEN", guildId: txIds.guildId, voiceChannelId: txIds.voiceChannelId,
  }] }, { DUPLEX_TOKEN: "duplex-secret" })[0];
  const bot = new DiscordBotConnection(profile, ipc, new Set());
  bot.botId = txIds.botId;
  bot.ingest({ type: DiscordFrameType.TX_CONTROL, flags: DiscordTxFlags.START, ...txIds });
  bot.ingest({ type: DiscordFrameType.TX_PCM, ...txIds, payload: Buffer.alloc(480 * 4) });
  assert.equal(bot.txEnabled, true);
  assert.equal(bot.txFrames, 1);
  await bot.close();
});

test("adapter leave cleanup clears stream sequence timestamp and generation exactly once", async () => {
  const sent: unknown[] = [];
  const ipc = { send: (frame: unknown) => sent.push(frame) } as unknown as DiscordIpcClient;
  const profile = parseBotRackConfig({ bots: [{
    id: "RX_CLEANUP", role: "RX", tokenEnv: "RX_TOKEN", guildId: txIds.guildId, voiceChannelId: txIds.voiceChannelId,
  }] }, { RX_TOKEN: "secret" })[0];
  const bot = new DiscordBotConnection(profile, ipc, new Set());
  bot.botId = txIds.botId;
  const userId = "700000000000000009";
  let destroyed = 0;
  bot.streams.set(userId, { destroy: () => { destroyed += 1; } } as never);
  bot.sequences.set(userId, 41);
  bot.timestamps.set(userId, 39_360);
  bot.sourceGenerations.set(userId, 9);
  (bot as unknown as { releaseUser(user: string, notifyCore: boolean): void }).releaseUser(userId, true);
  (bot as unknown as { releaseUser(user: string, notifyCore: boolean): void }).releaseUser(userId, true);
  assert.equal(destroyed, 1);
  assert.equal(bot.streams.has(userId), false);
  assert.equal(bot.sequences.has(userId), false);
  assert.equal(bot.timestamps.has(userId), false);
  assert.equal(bot.sourceGenerations.has(userId), false);
  assert.deepEqual(sent, [{ type: DiscordFrameType.USER_LEFT, ...txIds, userId, sourceGeneration: 9 }]);
  await bot.close();
});

test("adapter IPC resync sends authority metadata before current memberships and never Opus", async () => {
  const sent: unknown[] = [];
  const ipc = { send: (frame: unknown) => sent.push(frame) } as unknown as DiscordIpcClient;
  const profile = parseBotRackConfig({ bots: [{
    id: "RX_RESYNC", role: "RX", tokenEnv: "RX_TOKEN", guildId: txIds.guildId, voiceChannelId: txIds.voiceChannelId,
  }] }, { RX_TOKEN: "secret" })[0];
  const bot = new DiscordBotConnection(profile, ipc, new Set());
  bot.botId = txIds.botId;
  bot.sourceGenerations.set("700000000000000012", 12);
  bot.sourceGenerations.set("700000000000000013", 13);
  bot.resync();
  const frames = sent as Array<{ type: number; userId?: string; sourceGeneration?: number; payload?: Buffer }>;
  assert.equal(frames[0].type, DiscordFrameType.BOT_META);
  assert.equal(frames[1].type, DiscordFrameType.ADAPTER_STATE);
  assert.deepEqual(frames.slice(2).map((frame) => [frame.type, frame.sourceGeneration]), [
    [DiscordFrameType.USER_META, 12], [DiscordFrameType.USER_META, 13],
  ]);
  assert.equal(frames.some((frame) => frame.type === DiscordFrameType.OPUS), false);
  assert.equal(frames.some((frame) => Buffer.from(frame.payload ?? []).toString("utf8").includes("secret")), false);
  await bot.close();
});

test("RX adapter announces silent VC members on join and removes them on leave", async () => {
  const sent: unknown[] = [];
  const ipc = { send: (frame: unknown) => sent.push(frame) } as unknown as DiscordIpcClient;
  const profile = parseBotRackConfig({ bots: [{
    id: "RX_PRESENCE", role: "RX", tokenEnv: "RX_TOKEN", guildId: txIds.guildId, voiceChannelId: txIds.voiceChannelId,
  }] }, { RX_TOKEN: "secret" })[0];
  const bot = new DiscordBotConnection(profile, ipc, new Set());
  bot.botId = txIds.botId;
  bot.voiceState = "ready";
  const userId = "700000000000000014";

  bot.client.emit("voiceStateUpdate", { id: userId, channelId: null } as never, { id: userId, channelId: txIds.voiceChannelId } as never);
  const joined = sent[0] as { type: number; userId: string; sourceGeneration: number };
  assert.equal(joined.type, DiscordFrameType.USER_META);
  assert.equal(joined.userId, userId);
  assert.ok(joined.sourceGeneration > 0);
  assert.equal(bot.streams.has(userId), false);

  bot.client.emit("voiceStateUpdate", { id: userId, channelId: txIds.voiceChannelId } as never, { id: userId, channelId: null } as never);
  assert.deepEqual(sent[1], { type: DiscordFrameType.USER_LEFT, ...txIds, userId, sourceGeneration: joined.sourceGeneration });
  await bot.close();
});

test("RX adapter initial presence sync is idempotent and ignores configured bots", async () => {
  const sent: unknown[] = [];
  const ignoredUserId = "800000000000000002";
  const ipc = { send: (frame: unknown) => sent.push(frame) } as unknown as DiscordIpcClient;
  const profile = parseBotRackConfig({ bots: [{
    id: "RX_PRESENCE_SYNC", role: "RX", tokenEnv: "RX_TOKEN", guildId: txIds.guildId, voiceChannelId: txIds.voiceChannelId,
  }] }, { RX_TOKEN: "secret" })[0];
  const bot = new DiscordBotConnection(profile, ipc, new Set([ignoredUserId]));
  bot.botId = txIds.botId;
  const userId = "700000000000000015";
  const channel = {
    id: txIds.voiceChannelId,
    members: new Map([[bot.botId, {}], [ignoredUserId, {}], [userId, {}]]),
    guild: { voiceStates: { cache: new Map() }, members: { fetch: async () => ({ displayName: "unused" }) } },
  };

  bot.voiceState = "connecting";
  (bot as unknown as { announceVoiceChannelMembers(channel: unknown): void }).announceVoiceChannelMembers(channel);
  assert.equal(sent.length, 0);
  bot.voiceState = "ready";
  (bot as unknown as { announceVoiceChannelMembers(channel: unknown): void }).announceVoiceChannelMembers(channel);
  (bot as unknown as { announceVoiceChannelMembers(channel: unknown): void }).announceVoiceChannelMembers(channel);
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as { type: number }).type, DiscordFrameType.USER_META);
  assert.equal((sent[0] as { userId: string }).userId, userId);
  await bot.close();
});

test("RX adapter restores silent initial voice states even when GuildMember is not cached", async () => {
  const sent: unknown[] = [];
  const ipc = { send: (frame: unknown) => sent.push(frame) } as unknown as DiscordIpcClient;
  const profile = parseBotRackConfig({ bots: [{
    id: "RX_INITIAL_VOICE_STATE", role: "RX", tokenEnv: "RX_TOKEN", guildId: txIds.guildId, voiceChannelId: txIds.voiceChannelId,
  }] }, { RX_TOKEN: "secret" })[0];
  const bot = new DiscordBotConnection(profile, ipc, new Set());
  bot.botId = txIds.botId;
  bot.voiceState = "ready";
  const userId = "700000000000000016";
  const fetches: string[] = [];
  const channel = {
    id: txIds.voiceChannelId,
    members: new Map([[bot.botId, { displayName: "RX Bot" }]]),
    guild: {
      voiceStates: { cache: new Map([
        [bot.botId, { channelId: txIds.voiceChannelId }],
        [userId, { channelId: txIds.voiceChannelId }],
        ["700000000000000017", { channelId: "100000000000000999" }],
      ]) },
      members: { fetch: async (id: string) => {
        fetches.push(id);
        return { displayName: "Silent Guest" };
      } },
    },
  };

  (bot as unknown as { announceVoiceChannelMembers(channel: unknown): void }).announceVoiceChannelMembers(channel);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fetches, [userId]);
  const joined = sent.find((frame) => (frame as { userId?: string }).userId === userId) as { type: number; payload: Uint8Array };
  assert.equal(joined.type, DiscordFrameType.USER_META);
  assert.equal(Buffer.from(joined.payload).toString("utf8"), "Silent Guest");
  await bot.close();
});

test("RX adapter does not restore a silent member that leaves while its display name is loading", async () => {
  const sent: unknown[] = [];
  const ipc = { send: (frame: unknown) => sent.push(frame) } as unknown as DiscordIpcClient;
  const profile = parseBotRackConfig({ bots: [{
    id: "RX_INITIAL_LEAVE", role: "RX", tokenEnv: "RX_TOKEN", guildId: txIds.guildId, voiceChannelId: txIds.voiceChannelId,
  }] }, { RX_TOKEN: "secret" })[0];
  const bot = new DiscordBotConnection(profile, ipc, new Set());
  bot.botId = txIds.botId;
  bot.voiceState = "ready";
  const userId = "700000000000000018";
  let resolveMember!: (member: { displayName: string }) => void;
  const member = new Promise<{ displayName: string }>((resolve) => { resolveMember = resolve; });
  const voiceState = { channelId: txIds.voiceChannelId };
  const channel = {
    id: txIds.voiceChannelId,
    members: new Map(),
    guild: {
      voiceStates: { cache: new Map([[userId, voiceState]]) },
      members: { fetch: async () => member },
    },
  };

  (bot as unknown as { announceVoiceChannelMembers(channel: unknown): void }).announceVoiceChannelMembers(channel);
  voiceState.channelId = "100000000000000999";
  resolveMember({ displayName: "Already Left" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
  assert.equal(bot.sourceGenerations.has(userId), false);
  await bot.close();
});

test("old receive stream end/error cannot remove a replacement stream", async () => {
  const sent: unknown[] = [];
  const ipc = { send: (frame: unknown) => sent.push(frame) } as unknown as DiscordIpcClient;
  const profile = parseBotRackConfig({ bots: [{
    id: "RX_STREAM", role: "RX", tokenEnv: "RX_TOKEN", guildId: txIds.guildId, voiceChannelId: txIds.voiceChannelId,
  }] }, { RX_TOKEN: "secret" })[0];
  const bot = new DiscordBotConnection(profile, ipc, new Set());
  bot.botId = txIds.botId;
  bot.voiceState = "ready";
  const first = new EventEmitter();
  const second = new EventEmitter();
  Object.assign(first, { destroy: () => undefined, read: (size: number) => { assert.equal(size, 0); return null; } });
  Object.assign(second, { destroy: () => undefined, read: (size: number) => { assert.equal(size, 0); return null; } });
  const streams = [first, second];
  bot.connection = { receiver: { subscribe: () => streams.shift()! }, destroy: () => undefined } as never;
  const userId = "700000000000000010";
  (bot as unknown as { subscribeUser(user: string): void }).subscribeUser(userId);
  first.emit("end");
  (bot as unknown as { subscribeUser(user: string): void }).subscribeUser(userId);
  assert.equal(bot.streams.get(userId), second as never);
  first.emit("error", new Error("late old stream"));
  first.emit("end");
  assert.equal(bot.streams.get(userId), second as never);
  assert.equal(bot.sourceGenerations.has(userId), true);
  await bot.close();
});

test("RX adapter resubscribes after a DAVE receive stream error", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const ipc = { send: () => undefined } as unknown as DiscordIpcClient;
  const profile = parseBotRackConfig({ bots: [{
    id: "RX_DAVE_RETRY", role: "RX", tokenEnv: "RX_TOKEN", guildId: txIds.guildId, voiceChannelId: txIds.voiceChannelId,
  }] }, { RX_TOKEN: "secret" })[0];
  const bot = new DiscordBotConnection(profile, ipc, new Set());
  bot.botId = txIds.botId;
  bot.voiceState = "ready";
  const first = new EventEmitter();
  const second = new EventEmitter();
  Object.assign(first, { destroy: () => undefined, read: (size: number) => { assert.equal(size, 0); return null; } });
  Object.assign(second, { destroy: () => undefined, read: (size: number) => { assert.equal(size, 0); return null; } });
  const streams = [first, second];
  bot.connection = { receiver: { subscribe: () => streams.shift()! }, destroy: () => undefined } as never;
  const userId = "700000000000000019";

  (bot as unknown as { subscribeUser(user: string): void }).subscribeUser(userId);
  first.emit("error", new Error("Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)"));
  assert.equal(bot.receiveRetryTimers.has(userId), true);
  context.mock.timers.tick(200);

  assert.equal(bot.streams.get(userId), second as never);
  assert.equal(bot.receiveRetryTimers.has(userId), false);
  assert.equal(bot.sourceGenerations.has(userId), true);
  second.emit("data", Buffer.from([1, 2, 3]));
  assert.equal(bot.receiveRetryCounts.has(userId), false);
  second.emit("end");
  await bot.close();
});

test("RX silence frames do not hide consecutive DAVE receive failures", async () => {
  const ipc = { send: () => undefined } as unknown as DiscordIpcClient;
  const profile = parseBotRackConfig({ bots: [{
    id: "RX_DAVE_SILENCE", role: "RX", tokenEnv: "RX_TOKEN", guildId: txIds.guildId, voiceChannelId: txIds.voiceChannelId,
  }] }, { RX_TOKEN: "secret" })[0];
  const bot = new DiscordBotConnection(profile, ipc, new Set());
  bot.botId = txIds.botId;
  bot.voiceState = "ready";
  const stream = new EventEmitter();
  Object.assign(stream, { destroy: () => undefined, read: (size: number) => { assert.equal(size, 0); return null; } });
  bot.connection = { receiver: { subscribe: () => stream }, destroy: () => undefined } as never;
  const userId = "700000000000000021";
  (bot as unknown as { subscribeUser(user: string): void }).subscribeUser(userId);
  bot.receiveRetryCounts.set(userId, 3);

  stream.emit("data", Buffer.from([0xf8, 0xff, 0xfe]));
  assert.equal(bot.receiveRetryCounts.get(userId), 3);
  stream.emit("end");
  assert.equal(bot.receiveRetryCounts.get(userId), 3);
  await bot.close();
});

test("RX pending retry cannot survive close or a replaced connection", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const ipc = { send: () => undefined } as unknown as DiscordIpcClient;
  const profile = parseBotRackConfig({ bots: [{
    id: "RX_DAVE_LIFECYCLE", role: "RX", tokenEnv: "RX_TOKEN", guildId: txIds.guildId, voiceChannelId: txIds.voiceChannelId,
  }] }, { RX_TOKEN: "secret" })[0];
  const bot = new DiscordBotConnection(profile, ipc, new Set());
  bot.botId = txIds.botId;
  bot.voiceState = "ready";
  const first = Object.assign(new EventEmitter(), { destroy: () => undefined, read: (size: number) => { assert.equal(size, 0); return null; } });
  let replacementSubscriptions = 0;
  bot.connection = { receiver: { subscribe: () => first }, destroy: () => undefined } as never;
  const userId = "700000000000000022";
  (bot as unknown as { subscribeUser(user: string): void }).subscribeUser(userId);
  first.emit("error", new Error("DAVE session failure"));

  bot.connection = { receiver: { subscribe: () => { replacementSubscriptions += 1; return first; } }, destroy: () => undefined } as never;
  context.mock.timers.tick(200);
  assert.equal(replacementSubscriptions, 0);
  assert.equal(bot.receiveRetryTimers.has(userId), false);

  (bot as unknown as { subscribeUser(user: string): void }).subscribeUser(userId);
  first.emit("error", new Error("DAVE session failure"));
  assert.equal(bot.receiveRetryTimers.has(userId), true);
  await bot.close();
  context.mock.timers.tick(3_000);
  assert.equal(replacementSubscriptions, 1);
  assert.equal(bot.receiveRetryTimers.has(userId), false);
});

test("RX retry backoff is bounded and participant release cancels the pending timer", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const ipc = { send: () => undefined } as unknown as DiscordIpcClient;
  const profile = parseBotRackConfig({ bots: [{
    id: "RX_DAVE_BOUND", role: "RX", tokenEnv: "RX_TOKEN", guildId: txIds.guildId, voiceChannelId: txIds.voiceChannelId,
  }] }, { RX_TOKEN: "secret" })[0];
  const bot = new DiscordBotConnection(profile, ipc, new Set());
  bot.botId = txIds.botId;
  bot.voiceState = "ready";
  const streams = Array.from({ length: 21 }, () => Object.assign(new EventEmitter(), { destroy: () => undefined, read: (size: number) => { assert.equal(size, 0); return null; } }));
  let subscriptions = 0;
  bot.connection = { receiver: { subscribe: () => streams[subscriptions++] }, destroy: () => undefined } as never;
  const userId = "700000000000000020";
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    (bot as unknown as { subscribeUser(user: string): void }).subscribeUser(userId);
    for (let attempt = 1; attempt <= 21; attempt += 1) {
      streams[attempt - 1].emit("error", new Error("DAVE session failure"));
      const delay = Math.min(200 * attempt, 3_000);
      context.mock.timers.tick(delay - 1);
      assert.equal(subscriptions, attempt);
      if (attempt < 21) {
        context.mock.timers.tick(1);
        assert.equal(subscriptions, attempt + 1);
      }
    }
  } finally {
    console.error = originalError;
  }

  assert.equal(errors.length, 2, "only attempts 1 and 20 are logged");
  assert.equal(bot.receiveRetryTimers.has(userId), true);
  (bot as unknown as { releaseUser(user: string, notifyCore: boolean): void }).releaseUser(userId, false);
  assert.equal(bot.receiveRetryTimers.has(userId), false);
  assert.equal(bot.receiveRetryCounts.has(userId), false);
  assert.equal(subscriptions, 21, "release prevents a delayed resubscribe");
  await bot.close();
});

test("DUPLEX VC reassignment releases old participant identity before profile mutation", async () => {
  const sent: unknown[] = [];
  const ipc = { send: (frame: unknown) => sent.push(frame) } as unknown as DiscordIpcClient;
  const profile = parseBotRackConfig({ bots: [{
    id: "DUPLEX_MOVE", role: "DUPLEX", txSubtype: "CUSTOM", txAudioMode: "MONO",
    tokenEnv: "DUPLEX_TOKEN", guildId: txIds.guildId, voiceChannelId: txIds.voiceChannelId,
  }] }, { DUPLEX_TOKEN: "secret" })[0];
  const bot = new DiscordBotConnection(profile, ipc, new Set());
  bot.botId = txIds.botId;
  const userId = "700000000000000011";
  bot.sourceGenerations.set(userId, 4);
  (bot.client.channels as unknown as { fetch(id: string): Promise<unknown> }).fetch = async () => ({
    isVoiceBased: () => true, type: 2, guildId: txIds.guildId, name: "NEW VC",
  });
  (bot as unknown as { joinConfiguredChannel(): Promise<void> }).joinConfiguredChannel = async () => undefined;
  const newVoiceChannelId = "100000000000000202";
  await (bot as unknown as { assignVoiceChannel(guildId: string, voiceChannelId: string): Promise<void> }).assignVoiceChannel(txIds.guildId, newVoiceChannelId);
  assert.deepEqual(sent[0], { type: DiscordFrameType.USER_LEFT, ...txIds, userId, sourceGeneration: 4 });
  assert.equal(profile.voiceChannelId, newVoiceChannelId);
  await bot.close();
});

test("TX Bot never creates an RX bus or source and its User ID is loop-protected", () => {
  const engine = AudioEngine.createDemo(1);
  const ingest = new DiscordIngestServer(engine, "test-only");
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...txIds, payload: txStatus() });
  assert.equal([...engine.buses.keys()].filter((id) => id.includes(txIds.botId)).length, 0);

  const rxIds = { botId: "800000000000000001", guildId: txIds.guildId, voiceChannelId: txIds.voiceChannelId };
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...rxIds, payload: Buffer.from(JSON.stringify({ profileId: "RX01", role: "RX" })) });
  ingest.ingest({ type: DiscordFrameType.USER_META, ...rxIds, userId: txIds.botId, payload: Buffer.from("TX Bot") });
  ingest.ingest({ type: DiscordFrameType.OPUS, ...rxIds, userId: txIds.botId, sequence: 1, payload: Buffer.from([1, 2, 3]) });
  assert.equal([...engine.channels.keys()].some((id) => id.endsWith(`:${txIds.botId}`)), false);
  assert.equal(ingest.snapshot().sources.length, 0);
});

test("TX adapter accepts Core PCM only for its own TX Bot identity", async () => {
  const sent: unknown[] = [];
  const ipc = { send: (frame: unknown) => sent.push(frame) } as unknown as DiscordIpcClient;
  const profile = parseBotRackConfig({ bots: [{
    id: "TX_RETURN01", role: "TX", txSubtype: "CUSTOM", txAudioMode: "MONO",
    tokenEnv: "TX_TOKEN", guildId: txIds.guildId, voiceChannelId: txIds.voiceChannelId,
  }] }, { TX_TOKEN: "secret" })[0];
  const bot = new DiscordBotConnection(profile, ipc, new Set());
  profile.txDestination = "TEAM_01";
  bot.botId = txIds.botId;
  bot.resync();
  const meta = sent.find((frame) => (frame as { type: number }).type === DiscordFrameType.BOT_META) as { payload: Buffer };
  assert.equal(JSON.parse(meta.payload.toString()).txDestination, "TEAM_01");
  bot.ingest({ type: DiscordFrameType.TX_CONTROL, flags: DiscordTxFlags.START, ...txIds });
  bot.ingest({ type: DiscordFrameType.TX_PCM, ...txIds, payload: Buffer.alloc(480 * 4) });
  bot.ingest({ type: DiscordFrameType.TX_PCM, ...txIds, botId: "900000000000000002", payload: Buffer.alloc(480 * 4) });
  assert.equal(bot.txEnabled, true);
  assert.equal(bot.txFrames, 1);
  bot.stopTxImmediately();
  assert.equal(bot.txEnabled, false);
  bot.ingest({ type: DiscordFrameType.TX_CONTROL, ...txIds });
  assert.ok(sent.length >= 2);
  await bot.close();
});

test("Discord voice disconnect fail-closes TX before reconnect", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: unknown[] = [];
  const ipc = { send: (frame: unknown) => sent.push(frame) } as unknown as DiscordIpcClient;
  const profile = parseBotRackConfig({ bots: [{
    id: "TX_DISCONNECT", role: "TX", txSubtype: "CUSTOM", txAudioMode: "MONO",
    tokenEnv: "TX_TOKEN", guildId: txIds.guildId, voiceChannelId: txIds.voiceChannelId,
  }] }, { TX_TOKEN: "secret" })[0];
  const bot = new DiscordBotConnection(profile, ipc, new Set());
  bot.botId = txIds.botId;
  bot.connection = { rejoin: () => true, destroy: () => undefined } as never;
  bot.ingest({ type: DiscordFrameType.TX_CONTROL, flags: DiscordTxFlags.START, ...txIds });
  assert.equal(bot.txEnabled, true);

  (bot as unknown as { handleVoiceDisconnected(): void }).handleVoiceDisconnected();

  assert.equal(bot.txEnabled, false);
  assert.equal(bot.voiceState, "reconnecting");
  const statuses = sent.filter((frame) => (frame as { type?: number }).type === DiscordFrameType.ADAPTER_STATE);
  const disconnected = JSON.parse(Buffer.from((statuses.at(-2) as { payload: Uint8Array }).payload).toString("utf8"));
  assert.equal(disconnected.voiceState, "disconnected");
  assert.equal(disconnected.txEnabled, false);
  await bot.close();
});

test("Matrix output is framed as 48 kHz stereo PCM for one TX Bot", () => {
  const engine = AudioEngine.createDemo(1);
  const socket = new FakeAdapterSocket();
  const ingest = new DiscordIngestServer(engine, "test-only");
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...txIds, payload: txStatus() }, socket as unknown as Socket);
  ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...txIds, payload: txStatus() }, socket as unknown as Socket);
  const control = new ControlPlane(engine, undefined, ingest);

  assert.equal(control.execute({ type: "START_TX" }).confirmationRequired, true);
  assert.equal(control.execute({ type: "START_TX", confirmed: true }).ok, true);
  const start = decodeDiscordFrame(socket.writes[0]);
  assert.equal(start.type, DiscordFrameType.TX_CONTROL);
  assert.ok((start.flags ?? 0) & DiscordTxFlags.START);

  engine.processBlock();
  ingest.writeTxBlock();
  const pcm = decodeDiscordFrame(socket.writes[1]);
  assert.equal(pcm.type, DiscordFrameType.TX_PCM);
  assert.equal(pcm.payload?.length, engine.blockSize * 4);
  assert.equal(pcm.sequence, 1);
  assert.equal(ingest.txSnapshot().framesSent, 1);
  assert.ok(ingest.txSnapshot().peak > 0);

  assert.equal(control.execute({ type: "STOP_TX" }).confirmationRequired, true);
  assert.equal(control.execute({ type: "STOP_TX", confirmed: true }).ok, true);
  assert.equal(decodeDiscordFrame(socket.writes.at(-1)!).type, DiscordFrameType.TX_CONTROL);
  assert.equal(ingest.txSnapshot().active, false);
});

test("TX source selection is structural and locks while ON AIR", () => {
  const engine = AudioEngine.createDemo(1);
  const socket = new FakeAdapterSocket();
  const ingest = new DiscordIngestServer(engine, "test-only");
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...txIds, payload: txStatus() }, socket as unknown as Socket);
  const control = new ControlPlane(engine, undefined, ingest);
  assert.equal(control.execute({ type: "SET_TX_SOURCE", output: 2 }).ok, true);
  assert.equal(ingest.txSnapshot().sourceOutput, 2);
  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  const locked = control.execute({ type: "SET_TX_SOURCE", output: 3 });
  assert.equal(locked.ok, false);
  assert.match(locked.error ?? "", /locked while ON AIR/);
});

test("multiple TX stems send independent Matrix outputs and counters", () => {
  const engine = AudioEngine.createDemo(2);
  const ingest = new DiscordIngestServer(engine, "test-only");
  const gameSocket = new FakeAdapterSocket();
  const casterSocket = new FakeAdapterSocket();
  const gameIds = { ...txIds, botId: "900000000000000011" };
  const casterIds = { ...txIds, botId: "900000000000000012" };
  const gameStatus = txStatus({ profileId: "TX_GAME01", label: "TX GAME", txSubtype: "GAME", txAudioMode: "STEREO" });
  const casterStatus = txStatus({ profileId: "TX_CASTER01", label: "TX CASTER", txSubtype: "CASTER", txAudioMode: "MONO" });
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...gameIds, payload: gameStatus }, gameSocket as unknown as Socket);
  ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...gameIds, payload: gameStatus }, gameSocket as unknown as Socket);
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...casterIds, payload: casterStatus }, casterSocket as unknown as Socket);
  ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...casterIds, payload: casterStatus }, casterSocket as unknown as Socket);

  ingest.setTxSource(10, "TX_GAME01");
  ingest.setTxSource(20, "TX_CASTER01");
  ingest.startTx("TX_GAME01");
  ingest.startTx("TX_CASTER01");
  engine.processBlock();
  ingest.writeTxBlock();

  assert.equal(decodeDiscordFrame(gameSocket.writes[1]).type, DiscordFrameType.TX_PCM);
  assert.equal(decodeDiscordFrame(casterSocket.writes[1]).type, DiscordFrameType.TX_PCM);
  const stems = ingest.txSnapshots();
  assert.deepEqual(stems.map((stem) => [stem.subtype, stem.sourceOutput, stem.framesSent]), [
    ["GAME", 10, 1], ["CASTER", 20, 1],
  ]);
  ingest.stopAllTx();
  assert.equal(ingest.txSnapshots().every((stem) => !stem.active), true);
});

test("multiple TX Bots require an explicit profileId for every mutating command", () => {
  const engine = AudioEngine.createDemo(2);
  const ingest = new DiscordIngestServer(engine, "test-only");
  const firstIds = { ...txIds, botId: "900000000000000021" };
  const secondIds = { ...txIds, botId: "900000000000000022" };
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...firstIds, payload: txStatus({ profileId: "TX_ONE" }) });
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...secondIds, payload: txStatus({ profileId: "TX_TWO" }) });

  assert.throws(() => ingest.setTxSource(1), /profileId/);
  assert.throws(() => ingest.startTx(), /profileId/);
  assert.throws(() => ingest.stopTx(), /profileId/);
});

test("Adapter IPC disconnect clears Core TX state and queued PCM", () => {
  const engine = AudioEngine.createDemo(1);
  const socket = new FakeAdapterSocket();
  const ingest = new DiscordIngestServer(engine, "test-only");
  (ingest as unknown as { accept(socket: Socket): void }).accept(socket as unknown as Socket);
  socket.emit("data", Buffer.concat([
    encodeDiscordFrame({ type: DiscordFrameType.BOT_META, ...txIds, payload: txStatus() }),
    encodeDiscordFrame({ type: DiscordFrameType.ADAPTER_STATE, ...txIds, payload: txStatus({ txEnabled: true }) }),
  ]));
  ingest.startTx("TX_RETURN01");
  engine.processBlock();
  ingest.writeTxBlock();
  assert.equal(ingest.txSnapshot(Date.now(), "TX_RETURN01").active, true);

  socket.emit("close");

  const snapshot = ingest.txSnapshot(Date.now(), "TX_RETURN01");
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.peak, 0);
  assert.equal(ingest.snapshot().bots[0].txEnabled, false);
  assert.equal(ingest.snapshot().bots[0].voiceState, "ipc-disconnected");
});

test("Discord voice disconnect keeps Core TX stopped after the Bot becomes ready again", () => {
  const engine = AudioEngine.createDemo(1);
  const socket = new FakeAdapterSocket();
  const ingest = new DiscordIngestServer(engine, "test-only");
  (ingest as unknown as { accept(socket: Socket): void }).accept(socket as unknown as Socket);
  const sendStatus = (voiceState: string, txEnabled: boolean) => socket.emit("data", encodeDiscordFrame({
    type: DiscordFrameType.ADAPTER_STATE,
    ...txIds,
    payload: txStatus({ voiceState, txEnabled }),
  }));
  socket.emit("data", encodeDiscordFrame({ type: DiscordFrameType.BOT_META, ...txIds, payload: txStatus() }));
  sendStatus("ready", false);
  ingest.startTx("TX_RETURN01");
  assert.equal(ingest.txSnapshot(Date.now(), "TX_RETURN01").state, "SENDING");

  sendStatus("ready", false);
  assert.equal(ingest.txSnapshot(Date.now(), "TX_RETURN01").state, "SENDING", "an old ready PING cannot cancel a new START");
  sendStatus("disconnected", false);
  assert.equal(ingest.txSnapshot(Date.now(), "TX_RETURN01").state, "NOT_READY");
  assert.equal(ingest.txSnapshot(Date.now(), "TX_RETURN01").active, false);
  sendStatus("ready", false);
  assert.equal(ingest.txSnapshot(Date.now(), "TX_RETURN01").state, "READY");
  assert.equal(ingest.txSnapshot(Date.now(), "TX_RETURN01").active, false);
});

test("Emergency Mute stops TX stems and resets a backpressured IPC queue", () => {
  const engine = AudioEngine.createDemo(1);
  const socket = new FakeAdapterSocket();
  const ingest = new DiscordIngestServer(engine, "test-only");
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...txIds, payload: txStatus() }, socket as unknown as Socket);
  ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...txIds, payload: txStatus() }, socket as unknown as Socket);
  const control = new ControlPlane(engine, undefined, ingest);
  assert.equal(control.execute({ type: "START_TX", confirmed: true }).ok, true);
  engine.processBlock();
  ingest.writeTxBlock();
  socket.writableLength = 128 * 1024;

  assert.equal(control.execute({ type: "EMERGENCY_MUTE", active: true }).ok, true);
  assert.equal(ingest.txSnapshot().active, false);
  assert.equal(socket.resetCount, 1, "transport reset discards TCP-queued TX_PCM instead of appending STOP behind it");
  const writes = socket.writes.length;
  ingest.writeTxBlock();
  assert.equal(socket.writes.length, writes, "TX cannot emit another block after emergency stop");
  assert.equal(control.execute({ type: "START_TX", confirmed: true }).ok, false, "TX requires explicit recovery and cannot restart under Emergency Mute");
});

test("TX Bot Pool assignment targets an observed VC and is structurally locked ON AIR", () => {
  const engine = AudioEngine.createDemo(1);
  const socket = new FakeAdapterSocket();
  const ingest = new DiscordIngestServer(engine, "test-only");
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...txIds, payload: txStatus() }, socket as unknown as Socket);
  ingest.ingest({
    type: DiscordFrameType.VOICE_CHANNELS,
    ...txIds,
    payload: Buffer.from(JSON.stringify([{ id: "100000000000000199", name: "TEAM 07" }])),
  }, socket as unknown as Socket);
  const control = new ControlPlane(engine, undefined, ingest);
  assert.equal(control.execute({ type: "ASSIGN_TX_VOICE_CHANNEL", profileId: "TX_RETURN01", voiceChannelId: "100000000000000199" }).ok, true);
  const assignment = decodeDiscordFrame(socket.writes.at(-1)!);
  assert.ok((assignment.flags ?? 0) & DiscordTxFlags.ASSIGN_VOICE_CHANNEL);
  assert.equal(assignment.voiceChannelId, "100000000000000199");

  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  const locked = control.execute({ type: "ASSIGN_TX_VOICE_CHANNEL", profileId: "TX_RETURN01", voiceChannelId: "100000000000000199", confirmed: true });
  assert.equal(locked.ok, false);
  assert.match(locked.error ?? "", /locked while ON AIR/);
});

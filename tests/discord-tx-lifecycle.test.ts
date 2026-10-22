import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { AudioPlayerError, AudioPlayerStatus, VoiceConnectionStatus } from "@discordjs/voice";
import { ChannelType, Events } from "discord.js";
import type { EventEmitter } from "node:events";
import { DiscordFrameType, DiscordTxFlags } from "../packages/discord-ipc/src/index.ts";
import { parseBotRackConfig } from "../services/discord-adapter/src/bot-config.ts";
import { DiscordBotConnection } from "../services/discord-adapter/src/bot-connection.ts";
import type { DiscordIpcClient } from "../services/discord-adapter/src/ipc-client.ts";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";
import type { Socket } from "node:net";

const ids = { botId: "900000000000001234", guildId: "100000000000001234", voiceChannelId: "100000000000001235" };
const start = { type: DiscordFrameType.TX_CONTROL, flags: DiscordTxFlags.START, ...ids };

function fixture() {
  const statuses: Array<Record<string, unknown>> = [];
  const ipc = { send(frame: { type: number; payload?: Buffer }) {
    if (frame.type === DiscordFrameType.ADAPTER_STATE) statuses.push(JSON.parse(frame.payload!.toString()));
  } } as unknown as DiscordIpcClient;
  const profile = parseBotRackConfig({ bots: [{ id: "BOT01", role: "DUPLEX", tokenEnv: "TEST_TOKEN", guildId: ids.guildId, voiceChannelId: ids.voiceChannelId }] }, { TEST_TOKEN: "test-only" })[0];
  const bot = new DiscordBotConnection(profile, ipc, new Set());
  bot.botId = ids.botId;
  bot.gatewayState = bot.voiceState = "ready";
  return { bot, statuses };
}

function resource(bot: DiscordBotConnection) {
  const state = bot.player.state;
  assert.notEqual(state.status, AudioPlayerStatus.Idle);
  if (state.status === AudioPlayerStatus.Idle) throw new Error("Missing TX resource");
  return state.resource;
}

test("live TX survives missing frames and resumes PCM without reconnecting", (t) => {
  const { bot } = fixture();
  t.after(() => bot.close());
  bot.ingest(start);
  const current = resource(bot);
  current.playStream.emit("readable");
  assert.equal(bot.player.state.status, AudioPlayerStatus.Playing);
  const player = bot.player as unknown as { _stepPrepare(): void };
  const nativeRead = current.read.bind(current);
  // Preserve the real trailing-silence countdown if the player tries to stop.
  const read = t.mock.method(current, "read", () => current.silenceRemaining === -1 ? null : nativeRead());
  // Deterministically simulate 800 ms of unavailable input, past the default
  // five-frame cutoff. No Discord connection, timers or physical audio needed.
  for (let i = 0; i < 40; i++) player._stepPrepare();
  assert.equal(bot.player.state.status, AudioPlayerStatus.Playing);
  assert.equal(resource(bot), current);
  assert.equal(current.playStream.destroyed, false);
  bot.ingest({ type: DiscordFrameType.TX_PCM, ...ids, payload: Buffer.alloc(960 * 4) });
  // Supply the encoded packet synchronously so the player's background timer
  // cannot consume it before this assertion.
  read.mock.mockImplementation(() => Buffer.from([0xf8, 0xff, 0xfe]));
  player._stepPrepare();
  assert.equal(bot.txEnabled, true);
  assert.equal(bot.voiceState, "ready");
  assert.equal(bot.txFrames, 1);
  assert.equal((bot.player.state as { missedFrames?: number }).missedFrames, 0);
});

test("TX error stops only TX, reports it, and requires explicit restart", async (t) => {
  const { bot, statuses } = fixture();
  t.after(() => bot.close());
  t.mock.method(console, "error", () => undefined);
  bot.sourceGenerations.set("700000000000001234", 1);
  bot.ingest(start);
  const old = resource(bot);
  old.playStream.emit("error", new Error("Premature close"));
  await nextTurn();
  assert.equal(bot.txEnabled, false);
  assert.equal(bot.voiceState, "ready");
  assert.equal(bot.gatewayState, "ready");
  assert.equal(bot.sourceGenerations.size, 1);
  assert.equal(statuses.at(-1)?.txEnabled, false);
  assert.equal(statuses.at(-1)?.txFailed, true);
  assert.match(String(statuses.at(-1)?.message), /TX stopped/);
  bot.ingest({ type: DiscordFrameType.TX_PCM, ...ids, payload: Buffer.alloc(1920) });
  assert.equal(bot.txFrames, 0);
  bot.ingest(start);
  const replacement = resource(bot);
  assert.notEqual(replacement, old);
  // Teardown errors belonging to an old resource cannot stop its replacement.
  bot.player.emit("error", new AudioPlayerError(new Error("late error"), old));
  await nextTurn();
  assert.equal(bot.txEnabled, true);
  assert.equal(resource(bot), replacement);
  assert.equal(bot.message, null);
});

test("STOP, IPC loss, and close discard TX without poisoning RX or restarting", async (t) => {
  const { bot } = fixture();
  t.after(() => bot.close());
  bot.ingest(start);
  bot.ingest({ type: DiscordFrameType.TX_PCM, ...ids, payload: Buffer.alloc(1920) });
  bot.ingest({ type: DiscordFrameType.TX_CONTROL, ...ids });
  await nextTurn();
  assert.equal(bot.txEnabled, false);
  assert.equal(bot.voiceState, "ready");
  assert.equal(bot.message, null);
  bot.ingest(start);
  bot.stopTxImmediately();
  await nextTurn();
  assert.equal(bot.txEnabled, false);
  assert.equal(bot.voiceState, "ready");
  bot.ingest(start);
  await bot.close();
  bot.ingest(start);
  await nextTurn();
  assert.equal(bot.txEnabled, false);
  assert.equal(bot.voiceState, "disconnected");
});


test("TX startup failure and unexpected end fail closed without faulting RX", async (t) => {
  const { bot, statuses } = fixture();
  t.after(() => bot.close());
  t.mock.method(console, "error", () => undefined);
  const play = t.mock.method(bot.player, "play", () => { throw new Error("encoder unavailable"); });
  bot.ingest(start);
  assert.equal(bot.txEnabled, false);
  assert.equal(bot.voiceState, "ready");
  assert.equal(statuses.at(-1)?.txEnabled, false);
  assert.match(String(statuses.at(-1)?.message), /tx-start-failed/);
  play.mock.restore();
  bot.ingest(start);
  resource(bot).playStream.emit("readable");
  bot.player.stop(true);
  await nextTurn();
  assert.equal(bot.txEnabled, false);
  assert.equal(bot.voiceState, "ready");
  assert.match(String(statuses.at(-1)?.message), /tx-ended/);
});

test("gateway reconnect and faults stop Adapter TX consistently with Core, without auto-resume", (t) => {
  const { bot, statuses } = fixture();
  const events = bot.client as EventEmitter;
  t.after(() => bot.close());
  t.mock.method(console, "error", () => undefined);
  for (const event of [Events.ShardReconnecting, Events.ShardDisconnect]) {
    bot.ingest(start);
    const old = resource(bot);
    events.emit(event);
    assert.equal(bot.txEnabled, false);
    assert.equal(old.playStream.destroyed, true);
    assert.equal(statuses.at(-1)?.txEnabled, false);
    events.emit(Events.ShardResume);
    assert.equal(bot.gatewayState, "ready");
    assert.equal(bot.txEnabled, false);
  }
  bot.ingest(start);
  bot.client.emit(Events.Error, new Error("gateway failed"));
  assert.equal(bot.gatewayState, "fault");
  assert.equal(bot.txEnabled, false);
});

test("voice connecting and signalling stop TX before reporting state and never auto-resume", async (t) => {
  const { bot, statuses } = fixture();
  t.after(() => bot.close());
  t.mock.method(console, "log", () => undefined);
  const guild = {
    id: ids.guildId, name: "test-only",
    channels: { cache: new Map(), async fetch() { return this.cache; } }, voiceStates: { cache: new Map() },
    voiceAdapterCreator: () => ({ sendPayload: () => true, destroy() {} }),
  };
  guild.channels.cache.set(ids.voiceChannelId, {
    id: ids.voiceChannelId, guildId: ids.guildId, name: "test-only", guild,
    type: ChannelType.GuildVoice, members: new Map(), isVoiceBased: () => true,
  });
  bot.client.guilds.cache.set(ids.guildId, guild as never);
  t.mock.method(bot.client.channels, "fetch", async () => guild.channels.cache.get(ids.voiceChannelId) as never);
  // The fake gateway never supplies server/session details: no Discord network.
  const joining = (bot as unknown as { joinConfiguredChannel(): Promise<void> }).joinConfiguredChannel();
  await nextTurn();
  assert.ok(bot.connection);
  const events = bot.connection as EventEmitter;
  events.emit(VoiceConnectionStatus.Ready);
  await joining;
  for (const state of [VoiceConnectionStatus.Connecting, VoiceConnectionStatus.Signalling]) {
    bot.ingest(start);
    const old = resource(bot);
    events.emit(state);
    assert.equal(bot.txEnabled, false);
    assert.equal(bot.voiceState, state);
    assert.equal(old.playStream.destroyed, true);
    assert.equal(statuses.at(-1)?.txEnabled, false);
    events.emit(VoiceConnectionStatus.Ready);
    assert.equal(bot.voiceState, "ready");
    assert.equal(bot.txEnabled, false);
  }
});

test("Core stops PCM on Adapter TX failure but retains RX and allows explicit START", () => {
  const ingest = new DiscordIngestServer(AudioEngine.createDemo(1), "test-only");
  const writes: Uint8Array[] = [];
  const socket = { writable: true, destroyed: false, writableLength: 0, write(data: Uint8Array) { writes.push(data); return true; } } as unknown as Socket;
  const status = (enabled: boolean, failed = false) => Buffer.from(JSON.stringify({ profileId: "BOT01", role: "DUPLEX", gatewayState: "ready", voiceState: "ready", txEnabled: enabled, txFailed: failed }));
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload: status(false) }, socket);
  ingest.startTx("BOT01");
  ingest.ingest({ type: DiscordFrameType.PING, ...ids, payload: status(false) }, socket);
  assert.equal(ingest.txSnapshot().active, true, "an old idle heartbeat cannot cancel pending START");
  ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...ids, payload: status(false) }, socket);
  assert.equal(ingest.txSnapshot().active, true, "old idle state cannot cancel pending START either");
  ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...ids, payload: status(true) }, socket);
  ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...ids, payload: status(false) }, socket);
  assert.equal(ingest.snapshot().bots[0].health, "READY");
  assert.equal(ingest.txSnapshot().active, false);
  const count = writes.length;
  ingest.writeTxBlock();
  assert.equal(writes.length, count);
  ingest.startTx("BOT01");
  assert.equal(ingest.txSnapshot().active, true);
  // A startup failure can report false without an intervening true status.
  ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...ids, payload: status(false, true) }, socket);
  assert.equal(ingest.txSnapshot().active, false);
});

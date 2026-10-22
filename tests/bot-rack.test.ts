import assert from "node:assert/strict";
import test from "node:test";
import { DiscordFrameType } from "../packages/discord-ipc/src/index.ts";
import { parseBotRackConfig } from "../services/discord-adapter/src/bot-config.ts";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";

function rackEntries(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `RX${String(index + 1).padStart(2, "0")}`,
    label: `RX TEAM ${String(index + 1).padStart(2, "0")}`,
    role: "RX",
    tokenEnv: `DISCORD_TOKEN_${index + 1}`,
    guildId: "100000000000000001",
    voiceChannelId: String(100000000000000101n + BigInt(index)),
  }));
}

function identity(index: number) {
  return {
    botId: String(200000000000000001n + BigInt(index)),
    guildId: "100000000000000001",
    voiceChannelId: String(100000000000000101n + BigInt(index)),
  };
}

function status(index: number, overrides: Record<string, unknown> = {}) {
  return Buffer.from(JSON.stringify({
    profileId: `RX${String(index + 1).padStart(2, "0")}`,
    label: `RX TEAM ${String(index + 1).padStart(2, "0")}`,
    role: "RX",
    gatewayState: "ready",
    voiceState: "ready",
    voiceChannelName: `TEAM ${String(index + 1).padStart(2, "0")}`,
    wsPingMs: 42 + index,
    udpPingMs: 18 + index,
    reconnectCount: 0,
    ...overrides,
  }));
}

test("Bot Rack accepts exactly 24 explicit token references", () => {
  const environment: NodeJS.ProcessEnv = {};
  for (let index = 0; index < 24; index += 1) environment[`DISCORD_TOKEN_${index + 1}`] = `secret-${index + 1}`;
  const profiles = parseBotRackConfig({ bots: rackEntries(24) }, environment);
  assert.equal(profiles.length, 24);
  assert.equal(profiles[0].profileId, "RX01");
  assert.equal(profiles[23].voiceChannelId, "100000000000000124");
});

test("Bot Rack rejects a 25th connection and duplicate targets", () => {
  const environment: NodeJS.ProcessEnv = {};
  for (let index = 0; index < 25; index += 1) environment[`DISCORD_TOKEN_${index + 1}`] = "secret";
  assert.throws(() => parseBotRackConfig({ bots: rackEntries(25) }, environment), /at most 24 total bots/);
  const duplicate = rackEntries(2);
  duplicate[1].tokenEnv = duplicate[0].tokenEnv;
  duplicate[1].voiceChannelId = duplicate[0].voiceChannelId;
  assert.throws(() => parseBotRackConfig({ bots: duplicate }, environment), /duplicate Bot token/);
});

test("Core monitors 20 independent VC bots and dynamic users", () => {
  const engine = new AudioEngine(48_000, 480, 64);
  const ingest = new DiscordIngestServer(engine, "test-only");
  for (let index = 0; index < 20; index += 1) {
    const ids = identity(index);
    ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload: status(index) });
    ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...ids, payload: status(index) });
    ingest.ingest({ type: DiscordFrameType.PING, ...ids, payload: status(index) });
    ingest.ingest({
      type: DiscordFrameType.USER_META,
      ...ids,
      userId: String(300000000000000001n + BigInt(index)),
      payload: Buffer.from(`Guest ${index + 1}`),
    });
  }
  const snapshot = ingest.snapshot();
  assert.equal(snapshot.configuredBots, 20);
  assert.equal(snapshot.readyBots, 20);
  assert.equal(snapshot.bots[0].profileId, "RX01");
  assert.equal(snapshot.bots[19].profileId, "RX20");
  assert.equal(snapshot.sources.length, 20);
  assert.equal(new Set(snapshot.sources.map((source) => source.voiceChannelId)).size, 20);
  assert.equal(engine.channels.size, 20);
});

test("20 VC heartbeat soak stays bounded and stale detection is explicit", () => {
  const engine = new AudioEngine(48_000, 480, 2);
  const ingest = new DiscordIngestServer(engine, "test-only");
  for (let cycle = 0; cycle < 720; cycle += 1) {
    for (let index = 0; index < 20; index += 1) {
      ingest.ingest({ type: DiscordFrameType.PING, ...identity(index), payload: status(index) });
    }
  }
  const current = ingest.snapshot();
  assert.equal(current.bots.length, 20);
  assert.equal(current.readyBots, 20);
  assert.equal(current.packets, 0);
  const stale = ingest.snapshot(Date.now() + 16_000);
  assert.equal(stale.staleBots, 20);
  assert.ok(stale.bots.every((bot) => bot.health === "STALE"));
});

test("same-target reconnect is surfaced without changing bot or VC identity", () => {
  const engine = new AudioEngine(48_000, 480, 2);
  const ingest = new DiscordIngestServer(engine, "test-only");
  const ids = identity(0);
  ingest.ingest({
    type: DiscordFrameType.PING,
    ...ids,
    payload: status(0, { voiceState: "reconnecting", reconnectCount: 3, message: "same VC reconnect" }),
  });
  const bot = ingest.snapshot().bots[0];
  assert.equal(bot.health, "RECONNECTING");
  assert.equal(bot.reconnectCount, 3);
  assert.equal(bot.botId, ids.botId);
  assert.equal(bot.voiceChannelId, ids.voiceChannelId);
});

test("pre-login Bot Rack placeholder is replaced by the authenticated bot identity", () => {
  const engine = new AudioEngine(48_000, 480, 2);
  const ingest = new DiscordIngestServer(engine, "test-only");
  const ids = identity(0);
  ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...ids, botId: "0", payload: status(0, { gatewayState: "connecting", voiceState: "idle" }) });
  assert.equal(ingest.snapshot().bots.length, 1);
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload: status(0) });
  const snapshot = ingest.snapshot();
  assert.equal(snapshot.bots.length, 1);
  assert.equal(snapshot.bots[0].botId, ids.botId);
  assert.equal(snapshot.bots[0].profileId, "RX01");
  assert.equal(engine.buses.size, 1);
});

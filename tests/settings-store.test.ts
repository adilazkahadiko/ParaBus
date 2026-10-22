import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsStore } from "../services/router-core-sim/src/settings-store.ts";
import type { BotRole } from "../packages/shared-types/src/index.ts";
import { parseBotRackConfig } from "../services/discord-adapter/src/bot-config.ts";

function fixture(): { root: string; store: SettingsStore } {
  const root = mkdtempSync(join(tmpdir(), "dbr-settings-"));
  writeFileSync(join(root, ".env"), "KEEP_VALUE=yes\nDISCORD_BOT_TOKEN_RX01=existing.secret-token\n");
  writeFileSync(join(root, "discord-bots.json"), JSON.stringify({ bots: [{
    id: "RX01", label: "RX TEAM 01", role: "RX", tokenEnv: "DISCORD_BOT_TOKEN_RX01",
    guildId: "100000000000000001", voiceChannelId: "100000000000000101", enabled: true,
  }] }));
  return { root, store: new SettingsStore(root, {}) };
}

test("first run ignores example bots and LAN opt-in round-trips without altering tokens", t => {
  const root = mkdtempSync(join(tmpdir(), "parabus-empty-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "discord-bots.example.json"), JSON.stringify({ bots: [{ id: "RX01", label: "RX TEAM 01" }] }));
  writeFileSync(join(root, ".env"), "PRIVATE_TOKEN=do-not-change\n");
  const store = new SettingsStore(root, {});
  assert.deepEqual(store.snapshot().bots, []);
  assert.equal(store.snapshot().operator.lanAccess, false);
  assert.equal(store.save({ bots: [], operator: { lanAccess: true } }).operator.lanAccess, true);
  assert.match(readFileSync(store.environmentPath, "utf8"), /^DBR_LAN_ACCESS=1$/m);
  assert.equal(store.save({ bots: [] }).operator.lanAccess, true, "older clients cannot silently turn LAN access off");
  assert.equal(store.save({ bots: [], operator: { lanAccess: false } }).operator.lanAccess, false);
  assert.match(readFileSync(store.environmentPath, "utf8"), /^PRIVATE_TOKEN=do-not-change$/m);
  assert.throws(() => store.save({ bots: [], operator: { lanAccess: "yes" } }), /LAN/);
});

test("APEX Bot capacity agrees between Settings and Adapter, including DUPLEX counting and atomic rejection", (t) => {
  const { root, store } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configuration = (roles: BotRole[]) => {
    const bots = roles.map((role, index) => ({
      id: `BOT${index}`, label: `Bot ${index}`, role, enabled: true,
      tokenEnv: `TOKEN_${index}`, token: `test-secret-${index}`,
      guildId: "100000000000000001", voiceChannelId: String(100000000000000101n + BigInt(index)),
    }));
    const environment = Object.fromEntries(bots.map((bot) => [bot.tokenEnv, bot.token]));
    return { bots, environment };
  };
  for (const roles of [
    Array<BotRole>(24).fill("RX"),
    [...Array<BotRole>(22).fill("TX"), "RX", "RX"] as BotRole[],
    [...Array<BotRole>(22).fill("DUPLEX"), "SPARE", "SPARE"] as BotRole[],
  ]) {
    const { bots, environment } = configuration(roles);
    const snapshot = store.save({ bots });
    assert.equal(snapshot.bots.length, 24);
    assert.deepEqual(snapshot.limits, { rx: 24, tx: 22, total: 24 });
    const saved = JSON.parse(readFileSync(store.rackPath, "utf8"));
    assert.equal(parseBotRackConfig(saved, environment).length, 24);
  }
  const beforeRack = readFileSync(store.rackPath, "utf8");
  const beforeEnv = readFileSync(store.environmentPath, "utf8");
  for (const roles of [
    Array<BotRole>(25).fill("RX"),
    Array<BotRole>(23).fill("TX"),
    [...Array<BotRole>(22).fill("TX"), "DUPLEX", "RX"] as BotRole[],
    [...Array<BotRole>(23).fill("DUPLEX"), "RX"] as BotRole[],
  ]) {
    const { bots, environment } = configuration(roles);
    assert.throws(() => store.save({ bots }), /最大(?:24|22)/);
    assert.throws(() => parseBotRackConfig({ bots }, environment), /at most (?:24 total|22 TX\/DUPLEX) bots/);
    assert.equal(readFileSync(store.rackPath, "utf8"), beforeRack);
    assert.equal(readFileSync(store.environmentPath, "utf8"), beforeEnv);
  }
});

test("Settings snapshot exposes only token configured state", () => {
  const { root, store } = fixture();
  try {
    const snapshot = store.snapshot();
    assert.equal(snapshot.bots[0].tokenConfigured, true);
    assert.equal(JSON.stringify(snapshot).includes("existing.secret-token"), false);
    assert.deepEqual(snapshot.operator, { port: 4173, lanAccess: false });
    assert.deepEqual(snapshot.tablet, { enabled: false, port: 4174 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TX destination settings round-trip and duplicate or invalid slots are rejected by both backends", (t) => {
  const { root, store } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bot = { id: "TX1", label: "Team 1", role: "TX", tokenEnv: "TX1_TOKEN", token: "test-secret", guildId: "100000000000000001", voiceChannelId: "100000000000000101", txDestination: "TEAM_01" };
  assert.equal(store.save({ bots: [bot] }).bots[0].txDestination, "TEAM_01");
  assert.equal(parseBotRackConfig({ bots: [bot] }, { TX1_TOKEN: "test-secret" })[0].txDestination, "TEAM_01");
  const before = readFileSync(store.rackPath, "utf8");
  const duplicate = { ...bot, id: "TX2", tokenEnv: "TX2_TOKEN", token: "other-secret" };
  assert.throws(() => store.save({ bots: [bot, duplicate] }), /送信先区分が重複/);
  assert.throws(() => parseBotRackConfig({ bots: [bot, duplicate] }, { TX1_TOKEN: "test-secret", TX2_TOKEN: "other-secret" }), /duplicate TX destination/);
  assert.throws(() => store.save({ bots: [{ ...bot, txDestination: "TEAM_21" }] }), /送信先区分が不正/);
  assert.throws(() => parseBotRackConfig({ bots: [{ ...bot, txDestination: "TEAM_21" }] }, { TX1_TOKEN: "test-secret" }), /invalid txDestination/);
  assert.equal(readFileSync(store.rackPath, "utf8"), before);
});

test("Settings saves Tablet LAN enablement without storing a pairing secret", () => {
  const { root, store } = fixture();
  try {
    const bots = store.snapshot().bots.map((bot) => ({ ...bot, token: "" }));
    const snapshot = store.save({ bots, operator: { port: 4191 }, tablet: { enabled: true, port: 4310 } });
    assert.deepEqual(snapshot.operator, { port: 4191, lanAccess: false });
    assert.deepEqual(snapshot.tablet, { enabled: true, port: 4310 });
    const environment = readFileSync(join(root, ".env"), "utf8");
    assert.match(environment, /PORT=4191/);
    assert.match(environment, /TABLET_CONTROL_ENABLED=1/);
    assert.match(environment, /TABLET_CONTROL_PORT=4310/);
    assert.doesNotMatch(environment, /PAIR|SESSION/);
    assert.throws(() => store.save({ bots, operator: { port: 80 }, tablet: { enabled: false, port: 4310 } }), /Application Port/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Settings save preserves an empty existing token and writes a new token only to .env", () => {
  const { root, store } = fixture();
  try {
    const snapshot = store.save({ bots: [
      {
        id: "RX01", label: "Interview RX", role: "RX", tokenEnv: "DISCORD_BOT_TOKEN_RX01", token: "",
        guildId: "100000000000000001", voiceChannelId: "100000000000000101", enabled: true,
      },
      {
        id: "TX_GAME01", label: "Game Return", role: "TX", txSubtype: "GAME", txAudioMode: "STEREO",
        tokenEnv: "DISCORD_BOT_TOKEN_TX_GAME01", token: "new.secret-token",
        guildId: "100000000000000001", voiceChannelId: "100000000000000101", enabled: true,
      },
    ] });
    assert.equal(snapshot.bots.every((bot) => bot.tokenConfigured), true);
    const rack = readFileSync(join(root, "discord-bots.json"), "utf8");
    const environment = readFileSync(join(root, ".env"), "utf8");
    assert.equal(rack.includes("new.secret-token"), false);
    assert.match(environment, /KEEP_VALUE=yes/);
    assert.match(environment, /DISCORD_BOT_TOKEN_RX01=existing\.secret-token/);
    assert.match(environment, /DISCORD_BOT_TOKEN_TX_GAME01=new\.secret-token/);
    assert.match(environment, /DISCORD_BOT_RACK_FILE=discord-bots\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Settings save rejects enabled bots without token or valid Discord IDs", () => {
  const { root, store } = fixture();
  try {
    assert.throws(() => store.save({ bots: [{
      id: "RX02", label: "RX 02", role: "RX", tokenEnv: "DISCORD_BOT_TOKEN_RX02", token: "",
      guildId: "bad", voiceChannelId: "100000000000000102", enabled: true,
    }] }), /Guild ID/);
    assert.throws(() => store.save({ bots: [{
      id: "RX02", label: "RX 02", role: "RX", tokenEnv: "DISCORD_BOT_TOKEN_RX02", token: "",
      guildId: "100000000000000001", voiceChannelId: "100000000000000102", enabled: true,
    }] }), /Bot Token/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Settings accepts one DUPLEX Bot and rejects reusing its token in another profile", () => {
  const { root, store } = fixture();
  try {
    const duplex = {
      id: "RX01", label: "Studio Duplex", role: "DUPLEX", txSubtype: "GAME", txAudioMode: "STEREO",
      tokenEnv: "DISCORD_BOT_TOKEN_RX01", token: "",
      guildId: "100000000000000001", voiceChannelId: "100000000000000101", enabled: true,
    };
    const snapshot = store.save({ bots: [duplex] });
    assert.equal(snapshot.bots[0].role, "DUPLEX");
    assert.equal(snapshot.bots[0].txSubtype, "GAME");
    assert.equal(snapshot.bots[0].txAudioMode, "STEREO");

    assert.throws(() => store.save({ bots: [duplex, {
      ...duplex,
      id: "TX_GAME01",
      label: "Duplicate Bot",
      role: "TX",
      tokenEnv: "DISCORD_BOT_TOKEN_TX_GAME01",
      token: "existing.secret-token",
    }] }), /同じBot Token/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Settings snapshot migrates legacy single Bot values without exposing its token", () => {
  const root = mkdtempSync(join(tmpdir(), "dbr-settings-legacy-"));
  try {
    writeFileSync(join(root, ".env"), "DISCORD_BOT_TOKEN=legacy.secret-token\nDISCORD_GUILD_ID=100000000000000001\nDISCORD_VOICE_CHANNEL_ID=100000000000000101\n");
    writeFileSync(join(root, "discord-bots.example.json"), JSON.stringify({ bots: [] }));
    const snapshot = new SettingsStore(root, {}).snapshot();
    assert.equal(snapshot.bots[0].tokenEnv, "DISCORD_BOT_TOKEN");
    assert.equal(snapshot.bots[0].tokenConfigured, true);
    assert.equal(snapshot.bots[0].guildId, "100000000000000001");
    assert.equal(JSON.stringify(snapshot).includes("legacy.secret-token"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

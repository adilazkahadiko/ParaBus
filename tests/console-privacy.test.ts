import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createServer, createConnection } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { maskDiscordIds } from "../packages/process-lifecycle/src/console-privacy.ts";
import { DiscordBotConnection } from "../services/discord-adapter/src/bot-connection.ts";
import { DiscordBotRack } from "../services/discord-adapter/src/bot-rack.ts";
import { DiscordIpcClient } from "../services/discord-adapter/src/ipc-client.ts";
import { DiscordFrameType, encodeDiscordFrame } from "../packages/discord-ipc/src/index.ts";
import { DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";
import { DiscordShadowComparator } from "../services/router-core-sim/src/discord-shadow.ts";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { PARTICIPANT_STALE } from "../services/router-core-sim/src/participant-data.ts";
import { UserProfileStore } from "../services/router-core-sim/src/user-profile-store.ts";
import { SceneStore } from "../services/router-core-sim/src/scene-store.ts";
import { SettingsStore } from "../services/router-core-sim/src/settings-store.ts";

const person = "8".repeat(14) + "2468", name = "Fixture participant";
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(predicate(), true);
};
async function capture(action: (lines: string[]) => Promise<void>) {
  const lines: string[] = [], original = { log: console.log, warn: console.warn, error: console.error };
  const collect = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.log = collect; console.warn = collect; console.error = collect;
  try { await action(lines); } finally { Object.assign(console, original); }
  assert.equal(lines.some(line => line.includes(person) || line.includes(name)), false);
  return lines;
}
function root(t: test.TestContext) {
  const base = resolve("target/participant-review-20261122"); mkdirSync(base, { recursive: true });
  const path = mkdtempSync(join(base, "fixture-"));
  assert.ok(path.startsWith(base)); t.after(() => rmSync(path, { recursive: true, force: true })); return path;
}
const endpoint = (directory: string) => process.platform === "win32" ? `\\\\.\\pipe\\console-fixture-${randomUUID()}` : join(directory, "ipc.sock");

test("console masking preserves only four final digits for every valid Discord ID length", () => {
  for (const length of [17, 18, 19, 20]) {
    const id = "8".repeat(length - 4) + "2468";
    assert.equal(maskDiscordIds(`participant=${id}`) === "participant=…2468", true);
    assert.equal(maskDiscordIds(`discord-user:g:v:${id}`) === "discord-user:g:v:…2468", true);
  }
  assert.equal(maskDiscordIds("9".repeat(21)) === "9".repeat(21), true);
});

test("receive retries and gateway/TX errors log neither full participant IDs nor raw names", async () => {
  const lines = await capture(async () => {
    const connection = new DiscordBotConnection({ profileId: person, label: "Fixture bot", role: "RX", txSubtype: null, txAudioMode: null,
      tokenEnv: "DISCORD_BOT_TOKEN_FIXTURE", token: "", guildId: "1".repeat(18), voiceChannelId: "2".repeat(18) }, { send() {} } as never, new Set());
    const stream = new PassThrough();
    connection.connection = { receiver: { subscribe: () => stream }, destroy() {} } as never;
    connection.sourceGenerations.set(person, 1);
    try {
      (connection as any).subscribeUser(person);
      stream.emit("error", new Error(`${name} ${person}`));
      (connection as any).fail("gateway-error", new Error(`${name} ${person}`));
      connection.txEnabled = true;
      (connection as any).failTx("tx-stream-failed", new Error(`${name} ${person}`));
      assert.equal(connection.message?.includes("TX stopped"), true);
    } finally { await connection.close(); stream.destroy(); }
  });
  assert.equal(lines.some(line => line.includes("Opus receive stream failed for …2468") && line.includes("retrying in 200ms")), true);
  assert.equal(lines.some(line => line.includes("Discord connection failed")), true);
});

test("rack control and resync callbacks do not print credential or participant-bearing exceptions", async () => {
  await capture(async lines => {
    const rack = new DiscordBotRack({} as DiscordIpcClient, new Set(), { loadProfiles: () => { throw new Error(`${name} ${person}`); } });
    rack.ingest({ type: DiscordFrameType.BOT_CONTROL, payload: Buffer.from(JSON.stringify({ action: "CONNECT", profileId: "FIXTURE" })) });
    await until(() => lines.some(line => line.startsWith("Discord Bot control failed")));
    rack.bots.set("FIXTURE", { profile: { token: "" }, resync() { throw new Error(`${name} ${person}`); }, async close() {} } as never);
    rack.resync(); await rack.close();
  });
});

test("adapter IPC hook and receive failures use fixed console diagnostics", async t => {
  const path = endpoint(root(t));
  const server = createServer(socket => { socket.write(encodeDiscordFrame({ type: DiscordFrameType.BOT_META })); });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    await capture(async lines => {
      const client = new DiscordIpcClient(path);
      client.onConnected(() => { throw new Error(`${name} ${person}`); });
      client.onFrame(() => { throw new Error(`${name} ${person}`); });
      client.onDisconnected(() => { throw new Error(`${name} ${person}`); });
      try { client.start(); await until(() => lines.some(line => line.includes("fail-closed hook failed"))); }
      finally { client.close(); }
    });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("core IPC stream failures do not forward arbitrary error details to console", async t => {
  const ingest = new DiscordIngestServer(new AudioEngine(48000, 480, 2), endpoint(root(t)), null, null);
  ingest.ingest = () => { throw new Error(`${name} ${person}`); };
  await capture(async lines => {
    await ingest.start();
    const socket = createConnection(ingest.endpoint);
    try {
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      socket.write(encodeDiscordFrame({ type: DiscordFrameType.BOT_META }));
      await until(() => lines.includes("Invalid Discord IPC stream"));
    } finally { socket.destroy(); await ingest.close(); }
  });
});

test("Rust shadow stderr and malformed projection text stay out of console output", async t => {
  const path = join(root(t), "shadow-fixture.cjs");
  writeFileSync(path, "process.stderr.write('Fixture participant '+ '8'.repeat(14)+'2468'); process.exitCode=1;");
  await capture(async lines => {
    const shadow = new DiscordShadowComparator({ enabled: true, command: process.execPath, args: [path] });
    try { shadow.start(); await until(() => lines.some(line => line.includes("metadata comparison unavailable"))); }
    finally { shadow.close(); }
  });
});

test("participant guidance is usable with a connected Bot and documents old tray logs", () => {
  assert.equal(PARTICIPANT_STALE.includes("録音の保存完了") && PARTICIPANT_STALE.includes("その人がVCにいない"), true);
  for (const file of ["OPERATOR_PRIVACY.ja.md", "manual.html", "BETA.txt", "WINDOWS_BETA.txt"]) {
    const text = readFileSync(resolve("docs", file), "utf8");
    assert.equal(/stale|Botを接続せず/i.test(text), false);
    assert.equal(text.includes("Botが接続中でも削除できます"), true);
  }
  assert.equal(readFileSync(resolve("docs/OPERATOR_PRIVACY.ja.md"), "utf8").includes("beta.8より前の版のrouter.logには、参加者のIDが全桁で残っている場合があります。"), true);
});

test("malformed saved JSON cannot disclose participant data through an uncaught startup error", t => {
  const directory = root(t);
  for (const [file, load] of [
    ["user-profiles.json", () => new UserProfileStore(directory)],
    ["scenes.json", () => new SceneStore(directory)],
    ["discord-bots.json", () => new SettingsStore(directory, {}).snapshot()],
  ] as const) {
    writeFileSync(join(directory, file), `${name} ${person}`);
    let rejected = false;
    try { load(); } catch (error) {
      rejected = error instanceof Error && !error.message.includes(name) && !error.message.includes(person) && !error.stack?.includes(person) && !("cause" in error);
    }
    assert.equal(rejected, true);
  }
});

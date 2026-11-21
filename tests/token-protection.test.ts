import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { parseEnv } from "node:util";
import test from "node:test";
import { AdapterTokenCache, createTokenProtection, PROTECTED_TOKEN_PREFIX, runTokenHelper, TOKEN_PROTECTION_WARNING, TOKEN_REENTRY_MESSAGE, redactBotTokenError, type TokenProtection } from "../services/discord-adapter/src/token-protection.ts";
import { loadBotRackProfiles } from "../services/discord-adapter/src/bot-config.ts";
import { DiscordBotRack } from "../services/discord-adapter/src/bot-rack.ts";
import { DiscordFrameType } from "../packages/discord-ipc/src/index.ts";
import type { DiscordIpcClient } from "../services/discord-adapter/src/ipc-client.ts";
import { SettingsStore } from "../services/router-core-sim/src/settings-store.ts";
import { protectSettingsLocations } from "../services/router-core-sim/src/private-files.ts";
import { OperationalLog } from "../services/router-core-sim/src/operational-log.ts";
import { sanitizeOperatorMessage, operatorFacingSnapshot } from "../services/router-core-sim/src/operator-sanitize.ts";
import { createSupportBundle, supportDiagnostics } from "../services/router-core-sim/src/support-bundle.ts";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";
import { withoutBotTokens, consumeBotTokens } from "../packages/process-lifecycle/src/index.ts";
import type { RouterSnapshot, RuntimeInfoSnapshot } from "../packages/shared-types/src/index.ts";

// Deliberately invalid Discord identity, with the three-part shape only. Never
// put credential operands in assertions: a failed assertion must not print them.
const dummy = () => [Buffer.from("ParaBus-invalid-identity").toString("base64url"), randomBytes(5).toString("base64url"), randomBytes(24).toString("base64url")].join(".");
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "dpapi-fixture-"));
  assert.ok(resolve(root).startsWith(resolve("target") + (process.platform === "win32" ? "\\" : "/")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function memoryProtection(): TokenProtection {
  const memory = new Map<string, string>();
  return {
    async protect(values) { return values.map(value => { const encoded = PROTECTED_TOKEN_PREFIX + randomBytes(48).toString("base64"); memory.set(encoded, value); return encoded; }); },
    async unprotect(values) { return values.map(value => memory.get(value) ?? null); },
  };
}
const bot = (id: string, token?: string) => ({ id, label: id, role: "RX", tokenEnv: `DISCORD_BOT_TOKEN_${id}`, token,
  guildId: "1".repeat(18), voiceChannelId: "2".repeat(18), enabled: true });

test("Windows CurrentUser DPAPI batches twenty credentials and round-trips without plaintext in ciphertext", { skip: process.platform !== "win32" }, async () => {
  const values = Array.from({ length: 20 }, dummy), calls: number[] = [];
  const protection = createTokenProtection("win32", async request => { calls.push(request.values.length); return runTokenHelper(request); });
  const encrypted = await protection.protect(values);
  assert.ok(encrypted.every((value, index) => value?.startsWith(PROTECTED_TOKEN_PREFIX) && !value.includes(values[index]) && !Buffer.from(value.slice(PROTECTED_TOKEN_PREFIX.length), "base64").includes(Buffer.from(values[index]))));
  const restored = await protection.unprotect(encrypted as string[]);
  assert.equal(restored.every((value, index) => value === values[index]), true);
  assert.deepEqual(calls, [20, 20]);
});

test("helper stdin carries JSON while arguments and environment carry no credential or ciphertext", async () => {
  const values = [dummy(), PROTECTED_TOKEN_PREFIX + randomBytes(48).toString("base64")];
  for (const operation of ["protect", "unprotect"] as const) {
    let received = false;
    const start = ((executable: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      assert.ok(executable.endsWith("powershell.exe"));
      const metadata = JSON.stringify({ args, env: options.env });
      assert.equal(values.some(value => metadata.includes(value)), false);
      assert.deepEqual(Object.keys(options.env).sort(), ["PATH", "SystemRoot"]);
      assert.ok(args.includes("-EncodedCommand"));
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; } });
      let input = "";
      child.stdin.on("data", chunk => { input += chunk.toString(); });
      child.stdin.on("finish", () => {
        const request = JSON.parse(input);
        received = request.operation === operation && request.values.every((value: string, index: number) => value === values[index]);
        child.stdout.write(JSON.stringify({ results: values.map(() => ({ ok: false })) }));
        queueMicrotask(() => child.emit("close", 0));
      });
      return child;
    }) as unknown as Parameters<typeof runTokenHelper>[1];
    await runTokenHelper({ operation, values }, start); assert.equal(received, true);
  }
});

test("helper spawn and protocol failures expose only fixed errors and never credential-bearing causes", async () => {
  const value = dummy();
  const start = (() => { throw new Error(value); }) as unknown as Parameters<typeof runTokenHelper>[1];
  try { await runTokenHelper({ operation: "protect", values: [value] }, start); assert.fail("expected fixed error"); }
  catch (error) { assert.equal(error instanceof Error && !JSON.stringify(error).includes(value) && !error.message.includes(value) && !("cause" in error), true); }
  const broken = createTokenProtection("win32", async () => { throw new Error(value); });
  assert.equal((await broken.protect([value]))[0] === null, true);
  assert.equal((await createTokenProtection("win32", async () => ({ results: [] })).protect([value]))[0] === null, true);
});

test("Windows corrupted protected data fails with no plaintext result", { skip: process.platform !== "win32" }, async () => {
  const value = PROTECTED_TOKEN_PREFIX + randomBytes(48).toString("base64");
  assert.equal((await createTokenProtection().unprotect([value]))[0] === null, true);
});

test("helper timeout terminates only its helper and returns a fixed error", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let killed = false;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { killed = true; return true; } });
  const start = (() => child) as unknown as Parameters<typeof runTokenHelper>[1];
  const result = runTokenHelper({ operation: "protect", values: [dummy()] }, start);
  t.mock.timers.tick(15_000);
  let failed = false; try { await result; } catch (error) { failed = error instanceof Error && error.message === "Bot Tokenの保護処理に失敗しました"; }
  assert.equal(failed && killed, true);
});

test("migration preserves CRLF, comments, ordering, export, quotes and duplicate assignments without staging plaintext", { skip: process.platform !== "win32" }, async t => {
  const root = fixture(t), values = Array.from({ length: 3 }, dummy), envPath = join(root, ".env");
  const original = `# keep heading\r\nKEEP_VALUE=yes # untouched\r\n  export DISCORD_BOT_TOKEN_A = "${values[0]}" # first\r\nDISCORD_BOT_TOKEN_A='${values[1]}'\r\nDISCORD_BOT_TOKEN_B=${values[2]}  # second\r\n# keep tail\r\n`;
  writeFileSync(envPath, original);
  const store = new SettingsStore(root, {}, () => assert.fail("unexpected warning"));
  await store.migrateTokens();
  const migrated = readFileSync(envPath, "utf8");
  assert.equal(values.some(value => migrated.includes(value)), false);
  const normalize = (text: string) => text.replace(/dpapi:v1:[A-Za-z0-9+/=]+/g, "[VALUE]");
  let expected = original; for (const value of values) expected = expected.split(value).join("[VALUE]");
  assert.equal(normalize(migrated) === expected, true);
  assert.deepEqual(readdirSync(root), [".env"]);
  await store.migrateTokens(); assert.equal(readFileSync(envPath, "utf8") === migrated, true);
});

test("migration and saves share a queue and the latest settings survive overlapping work", async t => {
  const root = fixture(t), before = dummy(), after = dummy(), memory = memoryProtection();
  let release!: () => void, active = 0, maximum = 0, first = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const protection: TokenProtection = { ...memory, async protect(values) {
    maximum = Math.max(maximum, ++active); if (first) { first = false; await gate; }
    const result = await memory.protect(values); active--; return result;
  } };
  writeFileSync(join(root, ".env"), `# retain\nDISCORD_BOT_TOKEN_A=${before}\n`);
  const store = new SettingsStore(root, {}, () => assert.fail("unexpected warning"), protection);
  const migration = store.migrateTokens(), saving = store.save({ bots: [bot("A", after)] });
  let finished = false; void store.flush().then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false); release();
  await Promise.all([migration, saving, store.flush()]);
  const stored = parseEnv(readFileSync(store.environmentPath, "utf8")).DISCORD_BOT_TOKEN_A!;
  assert.equal((await memory.unprotect([stored]))[0] === after, true); assert.equal(maximum, 1);
  assert.equal(readFileSync(store.environmentPath, "utf8").startsWith("# retain\n"), true);
  assert.equal(readdirSync(root).some(name => name.endsWith(".tmp")), false);
});

test("encryption failure saves plaintext with a fixed warning and a persistent public warning without secrets", async t => {
  const root = fixture(t), value = dummy(), warnings: string[] = [];
  const unavailable: TokenProtection = { async protect(values) { return values.map(() => null); }, async unprotect(values) { return values.map(() => null); } };
  const store = new SettingsStore(root, {}, message => warnings.push(message), unavailable);
  const snapshot = await store.save({ bots: [bot("A", value)] });
  assert.equal(parseEnv(readFileSync(store.environmentPath, "utf8")).DISCORD_BOT_TOKEN_A === value, true);
  assert.equal(warnings.length === 1 && warnings[0] === TOKEN_PROTECTION_WARNING, true);
  if (process.platform === "win32") assert.ok(snapshot.tokenProtectionWarning);
  assert.equal(JSON.stringify({ snapshot, warnings }).includes(value), false);
  await store.migrateTokens(); assert.equal(warnings.length, 2);
  assert.equal(readdirSync(root).some(name => name.endsWith(".tmp")), false);
});

test("duplicate validation compares plaintext only during save, including distinct ciphertexts of one credential", async t => {
  const root = fixture(t), value = dummy(), protection = memoryProtection();
  const encoded = await protection.protect([value, value]);
  assert.equal(encoded[0] !== encoded[1], true);
  writeFileSync(join(root, ".env"), `DISCORD_BOT_TOKEN_A=${encoded[0]}\nDISCORD_BOT_TOKEN_B=${encoded[1]}\n`);
  const store = new SettingsStore(root, {}, () => {}, protection);
  for (const entries of [[bot("A"), bot("B")], [bot("A"), bot("B", value)]]) {
    let rejected = false;
    try { await store.save({ bots: entries }); } catch (error) {
      rejected = error instanceof Error && /同じBot Token/.test(error.message) && !error.message.includes(value) && !encoded.some(cipher => error.message.includes(cipher!));
    }
    assert.equal(rejected, true);
  }
  assert.equal(store.snapshot().bots.length, 0);
  assert.equal(readFileSync(store.environmentPath, "utf8").includes(value), false);
});

test("adapter isolates unreadable bots, batches and caches credentials, and never connects the affected bot", async t => {
  const root = fixture(t), value = dummy(), memory = memoryProtection();
  const good = (await memory.protect([value]))[0]!, bad = PROTECTED_TOKEN_PREFIX + randomBytes(48).toString("base64");
  const environment = { DISCORD_BOT_TOKEN_A: bad, DISCORD_BOT_TOKEN_B: good }, calls: number[] = [];
  const protection: TokenProtection = { ...memory, async unprotect(values) { calls.push(values.length); return memory.unprotect(values); } };
  const configPath = join(root, "discord-bots.json"); writeFileSync(configPath, JSON.stringify({ bots: [bot("A"), bot("B")] }));
  const cache = new AdapterTokenCache();
  const load = () => loadBotRackProfiles(environment, configPath, protection, cache);
  const [profiles] = await Promise.all([load(), load()]);
  assert.deepEqual(calls, [2]); assert.equal(profiles[0].tokenError === TOKEN_REENTRY_MESSAGE, true);
  assert.equal(profiles[0].token === "", true); assert.equal(profiles[1].token === value, true);
  const ingest = new DiscordIngestServer(new AudioEngine(48000, 480, 2), "fixture", null, null);
  const frames: unknown[] = [], started: string[] = [];
  const ipc = { send(frame: Parameters<DiscordIpcClient["send"]>[0]) { frames.push(frame); ingest.ingest(frame); return true; } } as unknown as DiscordIpcClient;
  const rack = new DiscordBotRack(ipc, new Set(), { loadProfiles: load, createConnection(profile) {
    return { profile, async start() { started.push(profile.profileId); }, async close() {}, async disconnect() {}, ingest() {}, resync() {} };
  } });
  await rack.connect("A"); await rack.connect("B"); await rack.close();
  assert.deepEqual(started, ["B"]);
  const snapshot = { channels: [], alerts: [], discord: ingest.snapshot() } as unknown as RouterSnapshot;
  assert.equal(operatorFacingSnapshot(snapshot).discord!.bots[0].message === TOKEN_REENTRY_MESSAGE, true);
  assert.equal([value, good, bad].some(secret => JSON.stringify({ frames, snapshot }).includes(secret)), false);
  assert.equal(Object.values(process.env).some(entry => entry === value || entry === good || entry === bad), false);
});

test("multiple unreadable profiles sharing a VC keep separate status notifications", async () => {
  const ingest = new DiscordIngestServer(new AudioEngine(48000, 480, 2), "fixture", null, null);
  const rack = new DiscordBotRack({ send(frame: Parameters<DiscordIpcClient["send"]>[0]) { ingest.ingest(frame); return true; } } as unknown as DiscordIpcClient,
    new Set(), { loadProfiles: () => ["A", "B"].map(id => ({ profileId: id, label: id, role: "RX", txSubtype: null, txAudioMode: null,
      tokenEnv: `DISCORD_BOT_TOKEN_${id}`, token: "", tokenError: TOKEN_REENTRY_MESSAGE, guildId: "1".repeat(18), voiceChannelId: "2".repeat(18) })) });
  await rack.connect("A"); await rack.connect("B"); await rack.close();
  assert.deepEqual(ingest.snapshot().bots.map(entry => entry.profileId), ["A", "B"]);
});

test("a failed reconnect updates the previous Bot status instead of hiding the re-entry notice", async () => {
  const ingest = new DiscordIngestServer(new AudioEngine(48000, 480, 2), "fixture", null, null);
  const identity = { guildId: "1".repeat(18), voiceChannelId: "2".repeat(18) };
  ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, botId: "3".repeat(18), ...identity,
    payload: Buffer.from(JSON.stringify({ profileId: "A", role: "RX", gatewayState: "disconnected", voiceState: "disconnected" })) });
  ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, botId: "0", ...identity,
    payload: Buffer.from(JSON.stringify({ profileId: "A", role: "RX", gatewayState: "token-reentry-required", voiceState: "disconnected", message: TOKEN_REENTRY_MESSAGE })) });
  const bots = ingest.snapshot().bots;
  assert.equal(bots.length === 1 && bots[0].message === TOKEN_REENTRY_MESSAGE && bots[0].gatewayState === "token-reentry-required", true);
});

test("errors, operational logs, snapshots and Support Bundles omit credentials and ciphertext", async t => {
  const root = fixture(t), value = dummy(), encoded = (await memoryProtection().protect([value]))[0]!;
  const text = redactBotTokenError(new Error(value + " " + encoded), value);
  assert.equal([value, encoded].some(secret => text.includes(secret)), false);
  assert.equal([value, encoded].some(secret => sanitizeOperatorMessage(value + " " + encoded).includes(secret)), false);
  writeFileSync(join(root, ".env"), `DISCORD_BOT_TOKEN_A=${encoded}\n`);
  const log = new OperationalLog(root);
  log.append({ level: "WARNING", at: new Date().toISOString(), message: text }); await log.close();
  const logText = readdirSync(join(root, "logs")).map(file => readFileSync(join(root, "logs", file), "utf8")).join("");
  assert.equal([value, encoded].some(secret => logText.includes(secret)), false);
  const snapshot = { channels: [], alerts: [], discord: { bots: [] } } as unknown as RouterSnapshot;
  const bundle = await createSupportBundle({ settingsRoot: root, projectRoot: root, runtimeInfo: { startedAt: new Date().toISOString(), buildCommit: null, pcRole: "NONE" } as unknown as RuntimeInfoSnapshot, diagnostics: supportDiagnostics(snapshot) });
  const archive = readFileSync(bundle.path);
  assert.equal([value, encoded].some(secret => archive.includes(Buffer.from(secret))), false);
});

test("environment forwarding removes plaintext and ciphertext without changing unrelated settings", () => {
  const plain = dummy(), encrypted = PROTECTED_TOKEN_PREFIX + randomBytes(48).toString("base64");
  const environment = { DISCORD_BOT_TOKEN: plain, DISCORD_BOT_TOKEN_A: encrypted, PATH: "fixture", DBR_LAUNCHER_PID: "123" };
  const filtered = withoutBotTokens(environment);
  assert.equal(Object.values(filtered).some(value => value === plain || value === encrypted), false);
  const input = consumeBotTokens(environment);
  assert.equal(input.DISCORD_BOT_TOKEN === plain && input.DISCORD_BOT_TOKEN_A === encrypted, true);
  assert.deepEqual(Object.keys(environment).sort(), ["DBR_LAUNCHER_PID", "PATH"]);
  assert.equal(environment.PATH === "fixture" && environment.DBR_LAUNCHER_PID === "123", true);
});

test("launcher stdin hands credentials to memory while the real child environment remains credential-free", async t => {
  const root = fixture(t), value = dummy(), script = join(root, "stdin-fixture.mjs");
  const lifecycle = new URL("../packages/process-lifecycle/src/index.ts", import.meta.url).href;
  writeFileSync(script, `import { readLauncherTokenInput } from ${JSON.stringify(lifecycle)};
const tokens = await readLauncherTokenInput();
const value = Object.values(tokens)[0];
console.log(JSON.stringify({ count: Object.keys(tokens).length, received: typeof value === 'string' && value.split('.').length === 3, environmentClean: !Object.keys(process.env).some(key => /^DISCORD_BOT_TOKEN/i.test(key)) }));`);
  const env = { SystemRoot: process.env.SystemRoot, DBR_LAUNCHER_MANAGED: "1" };
  assert.equal(JSON.stringify({ script, env }).includes(value), false);
  const child = spawn(process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let output = ""; child.stdout.on("data", chunk => { output += chunk.toString(); }); child.stderr.resume();
  const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", () => reject(new Error("Fixture could not start"))); });
  child.stdin.end(JSON.stringify({ tokens: { DISCORD_BOT_TOKEN_A: value } }));
  assert.equal(await closed, 0);
  assert.equal(output.includes(value), false);
  assert.deepEqual(JSON.parse(output), { count: 1, received: true, environmentClean: true });
});

test("non-Windows development keeps plaintext and cannot use a Windows protected credential", async () => {
  const value = dummy(), protection = createTokenProtection("linux");
  assert.equal((await protection.protect([value]))[0] === value, true);
  assert.equal((await protection.unprotect([PROTECTED_TOKEN_PREFIX + randomBytes(48).toString("base64")]))[0] === null, true);
});

test("startup ACL repair and background migration can overlap without losing the credential", { skip: process.platform !== "win32" }, async t => {
  const root = fixture(t), value = dummy(), warnings: string[] = [];
  writeFileSync(join(root, ".env"), `DISCORD_BOT_TOKEN_A=${value}\n`);
  const store = new SettingsStore(root, {}, message => warnings.push(message));
  await Promise.all([store.migrateTokens(), protectSettingsLocations(root, join(root, "recordings"), message => warnings.push(message))]);
  const encoded = parseEnv(readFileSync(store.environmentPath, "utf8")).DISCORD_BOT_TOKEN_A!;
  assert.equal(encoded.startsWith(PROTECTED_TOKEN_PREFIX), true);
  assert.equal((await createTokenProtection().unprotect([encoded]))[0] === value, true);
  assert.equal(warnings.length, 0);
  assert.deepEqual(readdirSync(root).sort(), [".env", "logs", "recordings", "support"]);
});

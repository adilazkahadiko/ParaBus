// Run only against a fresh disposable extraction. Never repackage this directory.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";

assert.equal(process.platform, "win32");
assert.equal(process.argv.length, 4, "Usage: node scripts/windows-release-smoke.ts <fresh-extracted-app-under-target> <result.json>");
const root = resolve(process.argv[2]), resultPath = resolve(process.argv[3]);
assert.ok(root.startsWith(resolve("target") + sep), "Smoke app must be a disposable extraction under target");
for (const path of [".env", "discord-bots.json", "logs", "recordings"]) assert.ok(!existsSync(join(root, path)), "Use a fresh unused extraction");
const build = JSON.parse(readFileSync(join(root, "release-build-info.json"), "utf8"));
const settings = mkdtempSync(join(resolve("target"), "windows-smoke-settings-"));
copyFileSync(join(root, ".env.example"), join(root, ".env"));
const probe = createServer();
await new Promise<void>(r => probe.listen(0, "127.0.0.1", r));
const port = (probe.address() as { port: number }).port;
await new Promise<void>(r => probe.close(() => r()));
const base = `http://127.0.0.1:${port}`;
const escapedRoot = root.replaceAll("'", "''");
const processes = (): { ProcessId: number; Name: string }[] => JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command",
  `$p = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.ExecutablePath -like '${escapedRoot}\\*' -or ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*${escapedRoot}*router-tray.ps1*')) } | Select-Object ProcessId,Name); ConvertTo-Json -InputObject $p -Compress`,
], { encoding: "utf8", windowsHide: true }));
async function until(check: () => Promise<boolean> | boolean, message: string) {
  const end = Date.now() + 90_000;
  while (!await check()) { if (Date.now() > end) throw new Error(message); await new Promise(r => setTimeout(r, 200)); }
}
async function shutdown() {
  const html = await (await fetch(base, { signal: AbortSignal.timeout(2000) })).text();
  const nonce = html.match(/name="dbr-session-nonce" content="([A-Za-z0-9_-]{43})"/)?.[1]; assert.ok(nonce);
  return fetch(base + "/api/shutdown", { method: "POST", headers: { origin: base, "content-type": "application/json", "x-dbr-session-nonce": nonce }, body: '{"confirmed":true}', signal: AbortSignal.timeout(5000) });
}
spawn(join(root, "ParaBus.exe"), [], { cwd: root, windowsHide: true, stdio: "ignore", env: {
  ...process.env, PORT: String(port), OPEN_BROWSER: "0", DBR_SETTINGS_ROOT: settings, RECORDER_FOLDER: join(settings, "recordings"),
  DBR_OPERATOR_ORIGIN: base, DBR_LAN_ACCESS: "0", DISCORD_IPC_ENDPOINT: `\\\\.\\pipe\\parabus-release-smoke-${process.pid}`,
  DISCORD_BOT_TOKEN: "", DISCORD_GUILD_ID: "", DISCORD_VOICE_CHANNEL_ID: "", DISCORD_BOT_RACK_JSON: "", DISCORD_BOT_RACK_FILE: "", ROUTER_CORE_OWNERSHIP: "typescript",
} });
let snapshot: any;
try {
  await until(async () => { try { snapshot = await (await fetch(base + "/api/state", { signal: AbortSignal.timeout(1000) })).json(); return snapshot.discord.connectedAdapters === 1; } catch { return false; } }, "EXE startup timed out");
  assert.equal(snapshot.runtimeInfo.buildCommit, build.buildCommit);
  assert.equal(snapshot.discord.configuredBots, 0, "API must explicitly confirm zero configured bots");
  assert.equal(snapshot.discord.readyBots, 0);
  assert.equal(processes().filter(p => p.Name === "node.exe").length, 3);
  const response = await shutdown(); assert.equal(response.status, 202);
  await until(() => processes().length === 0, "Processes remained after normal shutdown");
  const result = { exeLaunch: true, buildCommit: build.buildCommit, releaseVersion: build.releaseVersion, configuredBots: snapshot.discord.configuredBots, readyBots: snapshot.discord.readyBots, nodeProcesses: 3, shutdownStatus: response.status, remainingProcesses: 0 };
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
} finally {
  if (processes().length) {
    try { await shutdown(); await until(() => processes().length === 0, "Smoke cleanup timed out"); }
    catch { for (const p of processes()) { try { execFileSync("taskkill.exe", ["/PID", String(p.ProcessId), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {} } }
  }
}

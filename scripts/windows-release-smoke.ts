// Run only against a fresh disposable extraction. Never repackage this directory.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";
import { windowsPowerShell } from "./archive-tool.ts";
import { assertExpectedBuild, assertSmokeSnapshot, smokeEnvironment, smokeProcessQuery } from "./windows-release-smoke-support.ts";

assert.equal(process.platform, "win32");
assert.equal(process.argv.length, 5, "Usage: node scripts/windows-release-smoke.ts <fresh-extracted-app-under-target> <result.json> <expected-full-commit>");
const root = resolve(process.argv[2]), resultPath = resolve(process.argv[3]);
const expectedCommit = process.argv[4];
assert.ok(root.startsWith(resolve("target") + sep), "Smoke app must be a disposable extraction under target");
for (const path of [".env", "discord-bots.json", "logs", "recordings"]) assert.ok(!existsSync(join(root, path)), "Use a fresh unused extraction");
const build = JSON.parse(readFileSync(join(root, "release-build-info.json"), "utf8"));
assertExpectedBuild(build, expectedCommit);
const existingTray = execFileSync(windowsPowerShell(), ["-NoProfile", "-Command", "try { $m = [Threading.Mutex]::OpenExisting('DiscordBroadcastRouterTray'); $m.Dispose(); [Console]::Write('1') } catch [Threading.WaitHandleCannotBeOpenedException] { [Console]::Write('0') }"], { encoding: "utf8", windowsHide: true }).trim();
assert.equal(existingTray, "0", "Another ParaBus tray is running; finish the active session before this disposable smoke test");
const settings = mkdtempSync(join(resolve("target"), "windows-smoke-settings-"));
const probe = createServer();
await new Promise<void>(r => probe.listen(0, "127.0.0.1", r));
const port = (probe.address() as { port: number }).port;
await new Promise<void>(r => probe.close(() => r()));
const base = `http://127.0.0.1:${port}`;
// Never read a possibly customized example environment or inherited bot rack.
writeFileSync(join(root, ".env"), `PORT=${port}\n`);
const rack = join(settings, "discord-bots.json"); writeFileSync(rack, '{"bots":[]}\n');
const processes = (): { ProcessId: number; Name: string }[] => JSON.parse(execFileSync(windowsPowerShell(), ["-NoProfile", "-Command", smokeProcessQuery(root)], { encoding: "utf8", windowsHide: true }));
async function until(check: () => Promise<boolean> | boolean, message: string) {
  const end = Date.now() + 90_000;
  while (!await check()) { if (Date.now() > end) throw new Error(message); await new Promise(r => setTimeout(r, 200)); }
}
async function shutdown() {
  const html = await (await fetch(base, { signal: AbortSignal.timeout(2000) })).text();
  const nonce = html.match(/name="dbr-session-nonce" content="([A-Za-z0-9_-]{43})"/)?.[1]; assert.ok(nonce);
  return fetch(base + "/api/shutdown", { method: "POST", headers: { origin: base, "content-type": "application/json", "x-dbr-session-nonce": nonce }, body: '{"confirmed":true}', signal: AbortSignal.timeout(5000) });
}
const launcher = spawn(join(root, "ParaBus.exe"), [], { cwd: root, windowsHide: true, stdio: "ignore", env: smokeEnvironment(process.env, {
  root: settings, port, base, rack, pipe: `\\\\.\\pipe\\parabus-release-smoke-${process.pid}`,
}) });
let launchError: Error | undefined; launcher.once("error", error => launchError = error);
let snapshot: any;
try {
  await until(async () => { if (launchError) throw launchError; try { snapshot = await (await fetch(base + "/api/state", { signal: AbortSignal.timeout(1000) })).json(); return snapshot.discord.connectedAdapters === 1; } catch { return false; } }, "EXE startup timed out");
  assertSmokeSnapshot(snapshot, expectedCommit);
  assert.equal(processes().filter(p => p.Name === "node.exe").length, 3);
  const response = await shutdown(); assert.equal(response.status, 202);
  await until(() => processes().length === 0, "Processes remained after normal shutdown");
  const result = { exeLaunch: true, expectedCommit, buildCommit: snapshot.runtimeInfo.buildCommit, releaseVersion: build.releaseVersion, configuredBots: snapshot.discord.configuredBots, readyBots: snapshot.discord.readyBots, nodeProcesses: 3, shutdownStatus: response.status, remainingProcesses: 0 };
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
} finally {
  if (processes().length) {
    try { await shutdown(); await until(() => processes().length === 0, "Smoke cleanup timed out"); }
    catch { for (const p of processes()) { try { execFileSync("taskkill.exe", ["/PID", String(p.ProcessId), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {} } }
  }
}

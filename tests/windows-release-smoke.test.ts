import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { windowsPowerShell } from "../scripts/archive-tool.ts";
import { assertExpectedBuild, assertSmokeSnapshot, smokeEnvironment, smokeProcessQuery } from "../scripts/windows-release-smoke-support.ts";

const commit = "a".repeat(40);
test("smoke requires an independent expected commit and explicit zero bot counts", () => {
  assertExpectedBuild({ buildCommit: commit }, commit);
  assert.throws(() => assertExpectedBuild({ buildCommit: "b".repeat(40) }, commit), /independently supplied/);
  assert.throws(() => assertExpectedBuild({ buildCommit: "main" }, "main"), /full commit SHA/);
  const state = { runtimeInfo: { buildCommit: commit }, discord: { configuredBots: 0, readyBots: 0 } };
  assertSmokeSnapshot(state, commit);
  assert.throws(() => assertSmokeSnapshot({ ...state, discord: { configuredBots: 1, readyBots: 0 } }, commit), /zero configured bots/);
  assert.throws(() => assertSmokeSnapshot({ ...state, discord: {} }, commit), /zero configured bots/);
});

test("all inherited Discord settings and Node injection options are removed before launch", () => {
  const parent = { PATH: "kept", SystemRoot: "C:\\Windows", DISCORD_BOT_TOKEN_RX01: "test-only", discord_bot_rack_json: "test-only", DBR_SETTINGS_ROOT: "old", NODE_OPTIONS: "old", NODE_PATH: "old" };
  const env = smokeEnvironment(parent, { root: "C:\\test", port: 12345, base: "http://127.0.0.1:12345", pipe: "test-pipe", rack: "C:\\test\\discord-bots.json" });
  assert.deepEqual(Object.keys(env).filter(k => /^DISCORD_/i.test(k)).sort(), ["DISCORD_BOT_RACK_FILE", "DISCORD_IPC_ENDPOINT"]);
  assert.equal(env.DISCORD_BOT_RACK_FILE, "C:\\test\\discord-bots.json"); assert.equal(env.PATH, "kept");
  assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.DBR_SETTINGS_ROOT, "C:\\test"); assert.equal(parent.DBR_SETTINGS_ROOT, "old");
});

test("process matching handles brackets, quotes and case while excluding adjacent folders", { skip: process.platform !== "win32" }, () => {
  const root = "C:\\test [one]\\owner's smoke", literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  const row = (id: number, name: string, exe: string, command = "") => `[pscustomobject]@{ProcessId=${id};Name=${literal(name)};ExecutablePath=${literal(exe)};CommandLine=${literal(command)}}`;
  const setup = "$samples = @(" + [
    row(100001, "node.exe", root.toUpperCase() + "\\runtime\\node.exe"),
    row(100002, "node.exe", root + "-other\\runtime\\node.exe"),
    row(100003, "powershell.exe", "C:\\Windows\\powershell.exe", `-File "${root}\\scripts\\router-tray.ps1"`),
    row(100004, "powershell.exe", "C:\\Windows\\powershell.exe", "-File C:\\unrelated\\scripts\\router-tray.ps1"),
    row(100005, "node.exe", "C:\\test o\\owner's smoke\\runtime\\node.exe"),
  ].join(",") + "); ";
  const query = smokeProcessQuery(root).replace("Get-CimInstance Win32_Process", "$samples");
  const result = JSON.parse(execFileSync(windowsPowerShell(), ["-NoProfile", "-Command", setup + query], { encoding: "utf8", windowsHide: true }));
  assert.deepEqual(result.map((p: any) => p.ProcessId), [100001, 100003]);
});

test("CLI rejects the wrong expected build before creating settings or launching an EXE", { skip: process.platform !== "win32" }, t => {
  const target = resolve("target"); mkdirSync(target, { recursive: true });
  const root = mkdtempSync(join(target, "smoke-preflight-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "release-build-info.json"), JSON.stringify({ buildCommit: commit }));
  const resultPath = join(root, "result.json");
  const result = spawnSync(process.execPath, ["scripts/windows-release-smoke.ts", root, resultPath, "b".repeat(40)], { encoding: "utf8", windowsHide: true });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /independently supplied expected commit/);
  assert.equal(existsSync(join(root, ".env")), false); assert.equal(existsSync(resultPath), false);
});

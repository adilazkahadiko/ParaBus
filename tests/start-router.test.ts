import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const tray = readFileSync(new URL("../scripts/router-tray.ps1", import.meta.url), "utf8");

test("launcher rejects vulnerable Node 22 patches and accepts the security release boundary", () => {
  const source = readFileSync(new URL("../scripts/start-router.ts", import.meta.url), "utf8");
  const guard = source.slice(source.indexOf("const [nodeMajor"), source.indexOf("function loadEnvironmentFile"));
  for (const [version, accepted] of [
    ["22.18.0", false], ["22.23.2", false], ["22.23.3", false],
    ["22.23.4", true], ["22.23.5", true], ["22.24.0", true], ["23.0.0", false], ["24.22.1", false],
  ] as const) {
    let rejected = false;
    runInNewContext(guard, {
      process: { versions: { node: version }, exit: () => { rejected = true; } },
      console: { error() {} },
    });
    assert.equal(!rejected, accepted, version);
  }
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(pkg.engines.node, ">=22.23.4 <23");
  assert.equal(lock.packages[""].engines.node, pkg.engines.node);
  assert.equal(readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim(), "22.23.4");
});

test("launcher gives Core and Adapter a 16-worker pool unless explicitly configured", () => {
  const source = readFileSync(new URL("../scripts/start-router.ts", import.meta.url), "utf8");
  const start = source.indexOf("function startService(");
  const fn = source.slice(start, source.indexOf("\n}", start) + 2);
  for (const configured of [undefined, "8", "32"]) {
    const options: any[] = [];
    const context: any = { process: { execPath: "node", pid: 123, cwd: () => "/test", env: configured ? { UV_THREADPOOL_SIZE: configured } : {} },
      children: new Set(), spawn: (_exe: string, _args: string[], option: any) => { options.push(option); return { once() {} }; }, stopAll() {}, console };
    runInNewContext(stripTypeScriptTypes(fn), context);
    context.startService("core.ts"); context.startService("adapter.ts");
    for (const option of options) assert.equal(option.env.UV_THREADPOOL_SIZE, configured ?? "16");
  }
});

test("launchers wait up to 60 seconds while stopping immediately when Core exits", async () => {
  const launcher = readFileSync(new URL("../scripts/start-router.ts", import.meta.url), "utf8");
  const start = launcher.indexOf("async function waitForCore(");
  const source = launcher.slice(start, launcher.indexOf("\n}", start) + 2);
  let elapsed = 0;
  let readyAt = 15_000;
  let exitAt = Infinity;
  const context: any = {
    stopping: false, browserUrl: "http://127.0.0.1:4173",
    fetch: async () => ({ ok: elapsed >= readyAt }),
    setTimeout: (callback: () => void, delay: number) => {
      elapsed += delay;
      if (elapsed >= exitAt) context.stopping = true;
      callback();
    },
  };
  runInNewContext(stripTypeScriptTypes(source), context);
  assert.equal(await context.waitForCore(), true);
  assert.equal(elapsed, 15_000, "Defender-delayed readiness beyond 10 seconds succeeds");
  elapsed = 0; readyAt = Infinity;
  assert.equal(await context.waitForCore(), false);
  assert.equal(elapsed, 60_000);
  elapsed = 0; exitAt = 500;
  assert.equal(await context.waitForCore(), false);
  assert.equal(elapsed, 500, "Core exit does not wait for the 60-second timeout");
  assert.match(launcher, /core\.once\("exit",[\s\S]*?stopAll\(code \?\? 1\)/);
  assert.match(tray, /\$attempt -lt 240[\s\S]*?if \(\$script:RouterProcess\.HasExited\) \{ break \}[\s\S]*?Start-Sleep -Milliseconds 250/);
});

test("ParaBus display branding preserves launch, auth and settings identifiers", () => {
  for (const path of [
    "services/router-core-sim/public/index.html",
    "services/router-core-sim/tablet-public/index.html",
    "docs/manual.html",
  ]) {
    const html = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(html, /<title>ParaBus/);
    assert.doesNotMatch(html, /Discord Broadcast Router|Minimal MIX|Minimal operator views|>DBR<|DBR本体/);
  }
  assert.match(tray, /DrawString\("PB"/);
  assert.match(tray, /Tray\.Text = "ParaBus -/);
  assert.match(tray, /ShowBalloonTip\(4000, \("ParaBus - " \+ \$Title\)/);
  assert.match(tray, /"DiscordBroadcastRouterTray"/, "the existing single-instance mutex is retained");
  assert.match(tray, /"discord-bots\.json"/);
  assert.match(tray, /"\.env"/);
  assert.doesNotMatch(tray, /Discord Broadcast Router|DBR本体|DrawString\("DBR"/);
  const launcher = readFileSync(new URL("../scripts/start-router.ts", import.meta.url), "utf8");
  assert.match(launcher, /DBR_LAUNCHER_MANAGED: "1"/);
  const ui = readFileSync(new URL("../services/router-core-sim/public/app.js", import.meta.url), "utf8");
  assert.match(ui, /meta\[name="dbr-session-nonce"\]/);
  assert.match(ui, /fetch\("\/api\/restart"/);
  assert.match(ui, /ParaBus本体を再起動しますか/);
  assert.doesNotMatch(ui, /DBR本体/);
});

test("app launcher rejects unsupported Node versions before starting services", () => {
  const result = spawnSync(process.execPath, [
    "--eval",
    "Object.defineProperty(process.versions, 'node', { value: '24.15.0' }); await import('./scripts/start-router.ts')",
  ], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node\.js 22\.23\.4以上23未満が必要です（現在: v24\.15\.0）/);
});

test("Windows tray selects supported Node 22 and guards restart", () => {
  assert.match(tray, /Get-Command node\.exe -All/);
  assert.match(tray, /\[version\]\$version -ge \[version\]'22\.23\.4'/);
  assert.match(tray, /\[version\]\$version -lt \[version\]'23\.0\.0'/);
  assert.match(tray, /EnvironmentVariables\["PATH"\].*NodeExecutable/);
  assert.match(tray, /node\.exe scripts\/audio-native-check\.ts.*&& node\.exe scripts\/opus-native-check\.ts/);
  assert.match(tray, /if \(-not \(Test-DependenciesReady\)\)/);
  assert.doesNotMatch(tray, /npm\.cmd ci|Install-DependenciesIfNeeded/);
  assert.match(tray, /node\.exe scripts\/start-router\.ts/);
  assert.match(tray, /state\.state -eq "ON_AIR"/);
  assert.match(tray, /state\.recorder\.state -ne "IDLE"/);
  assert.match(tray, /MessageBox.*ParaBus本体を再起動しますか/);
  assert.match(tray, /\?view=setup/);
});

test("Windows app launches a single hidden STA tray and uses graceful local shutdown", () => {
  const rust = readFileSync(new URL("../crates/parabus-launcher/src/main.rs", import.meta.url), "utf8");
  const build = readFileSync(new URL("../scripts/build-windows-launcher.ps1", import.meta.url), "utf8");
  const ci = readFileSync(new URL("../.github/workflows/test-packages.yml", import.meta.url), "utf8");
  assert.match(rust, /windows_subsystem = "windows"/);
  assert.match(rust, /current_exe\(\)/); assert.match(rust, /router-tray\.ps1/);
  assert.match(rust, /"-STA"/); assert.match(rust, /"Hidden"/); assert.match(rust, /creation_flags\(0x08000000\)/);
  assert.match(tray, /if \(-not \$createdNew\) \{\s*Start-Process \$script:UiUrl/);
  assert.match(tray, /\/api\/shutdown/); assert.match(tray, /x-dbr-session-nonce/);
  assert.doesNotMatch(tray, /taskkill/);
  assert.match(tray, /RouterProcess\.ExitCode -eq 0\) \{ Exit-Router/);
  assert.match(tray, /DBR_TRAY_PID/);
  assert.match(build, /rc\.exe \/nologo/); assert.match(build, /cargo\.exe rustc --locked/);
  assert.match(ci, /cp target\/release\/ParaBus\.exe/);
});

test("app entry guidance and About credits are included without permanent operator-screen branding", () => {
  const ui = readFileSync(new URL("../services/router-core-sim/public/index.html", import.meta.url), "utf8");
  const manual = readFileSync(new URL("../docs/manual.html", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const ci = readFileSync(new URL("../.github/workflows/test-packages.yml", import.meta.url), "utf8");
  for (const source of [ui, manual, readme, ci]) {
    assert.match(source, /ParaBus — Developed by Adil Azka/);
    assert.match(source, /Built with Codex and Claude Code/);
  }
  assert.match(ui, /<details[^>]*><summary>About ParaBus<\/summary><p>ParaBus — Developed by Adil Azka/);
  for (const source of [manual, readme, ci]) {
    assert.match(source, /ParaBus\.app/); assert.match(source, /このまま開く/);
    assert.match(source, /ParaBus\.exe/); assert.match(source, /SmartScreen/);
  }
});

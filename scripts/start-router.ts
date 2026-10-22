import { existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

const [nodeMajor, nodeMinor, nodePatch] = process.versions.node.split(".").map(Number);
if (nodeMajor !== 22 || nodeMinor < 23 || (nodeMinor === 23 && nodePatch < 4)) {
  console.error(`\nNode.js 22.23.4以上23未満が必要です（現在: v${process.versions.node}）。修正版のNode.js 22で起動し直してください。\n`);
  process.exit(1);
}

function loadEnvironmentFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

loadEnvironmentFile(resolve(".env"));

const rackConfigured = Boolean(process.env.DISCORD_BOT_RACK_FILE?.trim() || process.env.DISCORD_BOT_RACK_JSON?.trim() || existsSync(resolve("discord-bots.json")));
const discordSettings = ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_VOICE_CHANNEL_ID"] as const;
const configured = discordSettings.filter((name) => Boolean(process.env[name]?.trim()));
if (!rackConfigured && configured.length > 0 && configured.length < discordSettings.length) {
  const missing = discordSettings.filter((name) => !process.env[name]?.trim());
  console.error(`\n設定が不足しています。.env の次の項目を入力してください:\n${missing.join("\n")}\n`);
  process.exit(1);
}

const discordEnabled = rackConfigured || configured.length === discordSettings.length;
const port = Number(process.env.PORT ?? 4173);
const browserUrl = `http://127.0.0.1:${port}`;
const RESTART_EXIT_CODE = 75;
const children = new Set<ChildProcess>();
let stopping = false;
let restarting = false;
let adapter: ChildProcess | null = null;
let core: ChildProcess | null = null;

function startService(path: string): ChildProcess {
  const child = spawn(process.execPath, [path], {
    cwd: process.cwd(),
    env: { ...process.env, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? "16", DBR_LAUNCHER_MANAGED: "1", DBR_LAUNCHER_PID: String(process.pid) },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.once("error", () => { console.error("ParaBusの子プロセスを起動できませんでした"); stopAll(1); });
  return child;
}

function stopAll(exitCode = 0): void {
  if (stopping) return;
  stopping = true;
  void (async () => {
    await stopService(core);
    await stopService(adapter);
    for (const child of children) await stopService(child);
    process.exit(exitCode);
  })();
}

// Install before startup awaits, so closing the app during first launch also stops children.
process.once("SIGINT", () => stopAll(0));
process.once("SIGTERM", () => stopAll(0));
process.once("SIGHUP", () => stopAll(0));
const ownerPid = Number(process.env.DBR_TRAY_PID ?? process.env.DBR_APP_PID);
if (Number.isSafeInteger(ownerPid) && ownerPid > 1) setInterval(() => {
  if (process.env.DBR_APP_PID && process.ppid !== ownerPid) { stopAll(0); return; }
  try { process.kill(ownerPid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") stopAll(0);
  }
}, 500).unref();

async function waitForCore(): Promise<boolean> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (stopping) return false;
    try {
      const response = await fetch(`${browserUrl}/api/state`);
      if (response.ok && !stopping) return true;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  return false;
}

function openBrowser(): void {
  if (process.env.OPEN_BROWSER === "0") return;
  if (process.platform === "win32") {
    const opener = spawn("cmd.exe", ["/c", "start", "", browserUrl], { detached: true, stdio: "ignore" });
    opener.unref();
  } else if (process.platform === "darwin") {
    spawn("open", [browserUrl], { detached: true, stdio: "ignore" }).unref();
  }
}

function stopService(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve();
  return new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    if (child.connected) child.send({ type: "dbr-shutdown" }, error => { if (error) child.kill("SIGTERM"); });
    else child.kill("SIGTERM");
  });
}

function startAdapter(): void {
  adapter = startService("services/discord-adapter/src/index.ts");
  adapter.once("exit", (code) => {
    if (!stopping && !restarting) console.error(`Discord接続が終了しました（終了コード: ${code ?? "不明"}）`);
  });
}

function startCore(): ChildProcess {
  const core = startService("services/router-core-sim/src/server.ts");
  core.once("exit", (code) => {
    if (stopping) return;
    if (code === RESTART_EXIT_CODE) {
      void restartServices();
      return;
    }
    if (code !== 0) console.error(`Router Core が終了しました（終了コード: ${code ?? "不明"}）`);
    stopAll(code ?? 1);
  });
  return core;
}

async function restartServices(): Promise<void> {
  if (stopping || restarting) return;
  restarting = true;
  console.log("\nParaBus本体を安全に再起動しています…");
  await stopService(adapter);
  adapter = null;
  if (stopping) return;
  core = startCore();
  if (await waitForCore()) {
    startAdapter();
    restarting = false;
    console.log("ParaBus本体を再起動しました。Audio I/Oは手動で開いてください。\n");
    return;
  }
  console.error("ParaBus本体の再起動を確認できませんでした。");
  stopAll(1);
}

console.log("\nParaBus を起動しています…");
console.log(discordEnabled ? `Discord受信: 有効（${rackConfigured ? "Bot Rack" : "RX01"}）` : "Discord受信: 未設定（無音で起動）");

core = startCore();

if (await waitForCore()) {
  startAdapter();
  openBrowser();
  console.log(`\n起動しました: ${browserUrl}`);
  console.log("終了するには操作画面の SETUP → ParaBus を終了を押してください。\n");
} else {
  console.error(`Router Core の起動を確認できませんでした。ポート${port}が使用中でないか確認してください。`);
  stopAll(1);
}

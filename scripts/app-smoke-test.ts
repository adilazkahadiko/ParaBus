import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function until(check: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(description);
    await new Promise(r => setTimeout(r, 100));
  }
}

/** CI invokes the shipped Mac entry script, not a replacement Node launcher. */
export async function smokeApp(root: string, stop: "api" | "SIGTERM" | "SIGHUP" | "SIGKILL" = "api"): Promise<void> {
  const settings = await mkdtemp(join(tmpdir(), "parabus-app-smoke-"));
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(r => probe.close(() => r()));
  const base = `http://127.0.0.1:${port}`;
  const windows = process.platform === "win32";
  if (windows) {
    const exe = await readFile(join(root, "ParaBus.exe"));
    const pe = exe.readUInt32LE(0x3c);
    assert.equal(exe.toString("ascii", pe, pe + 4), "PE\0\0");
    assert.equal(exe.readUInt16LE(pe + 24 + 68), 2, "launcher must use Windows GUI subsystem, not console");
  } else {
    const app = join(root, "ParaBus.app/Contents");
    assert.ok((await stat(join(app, "MacOS/ParaBus"))).mode & 0o111);
    assert.match(await readFile(join(app, "Info.plist"), "utf8"), /<key>CFBundleExecutable<\/key><string>ParaBus<\/string>/);
    if (process.platform === "darwin") execFileSync("plutil", ["-lint", join(app, "Info.plist")]);
  }
  const executable = windows ? join(root, "runtime/node.exe") : join(root, "ParaBus.app/Contents/MacOS/ParaBus");
  const child = spawn(executable, windows ? ["scripts/start-router.ts"] : [], { cwd: root, windowsHide: true, stdio: "ignore", env: {
    ...process.env, PORT: String(port), OPEN_BROWSER: "0", DBR_SETTINGS_ROOT: settings, RECORDER_FOLDER: join(settings, "recordings"),
    DBR_OPERATOR_ORIGIN: base, DBR_LAN_ACCESS: "0", DISCORD_IPC_ENDPOINT: windows ? `\\\\.\\pipe\\parabus-smoke-${process.pid}-${port}` : join(settings, "discord.sock"),
    DISCORD_BOT_TOKEN: "", DISCORD_GUILD_ID: "", DISCORD_VOICE_CHANNEL_ID: "", DISCORD_BOT_RACK_JSON: "", DISCORD_BOT_RACK_FILE: "", ROUTER_CORE_OWNERSHIP: "typescript",
  } });
  let spawnError: Error | null = null;
  child.once("error", error => spawnError = error);
  const descendants = new Set<number>();
  try {
    await until(async () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("App exited before Core and Adapter were ready; inspect logs/router.log");
      try { return (await (await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(1000) })).json() as any).discord.connectedAdapters === 1; } catch { return false; }
    }, "app did not start Core and Adapter");
    if (!windows) {
      const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
      descendants.add(child.pid!);
      for (let pass = 0; pass < 4; pass++) for (const [pid, parent] of rows) if (descendants.has(parent)) descendants.add(pid);
      assert.ok(descendants.size >= 4, "shell + Node launcher + Core + Adapter are all running");
    }
    if (stop === "api") {
      const html = await (await fetch(base)).text();
      const nonce = html.match(/name="dbr-session-nonce" content="([A-Za-z0-9_-]{43})"/)![1];
      const response = await fetch(`${base}/api/shutdown`, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-dbr-session-nonce": nonce }, body: '{"confirmed":true}' });
      assert.equal(response.status, 202);
    } else child.kill(stop);
    await until(() => child.exitCode !== null || child.signalCode !== null, "launcher did not exit");
    if (stop === "SIGKILL") assert.equal(child.signalCode, "SIGKILL");
    else assert.equal(child.exitCode, 0);
    await until(async () => (await Promise.all([...descendants].map(async pid => {
      try {
        process.kill(pid, 0);
        // Linux containers may not reap adopted zombies immediately; they are
        // terminated processes, not surviving app services or audio handles.
        return process.platform === "linux" && (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1].startsWith("Z");
      } catch { return true; }
    }))).every(Boolean), "an app child survived shutdown");
    await assert.rejects(() => fetch(`${base}/api/state`));
    console.log(`App smoke passed: ${stop}, Core/Adapter/launcher closed`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await until(() => child.exitCode !== null || child.signalCode !== null, "smoke cleanup"); }
    await rm(settings, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/app-smoke-test.ts <package-directory>");
  await smokeApp(resolve(process.argv[2]));
}

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

async function waitFor(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(message);
}

async function exited(pid: number) {
  try { return (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1].startsWith("Z"); }
  catch { return true; }
}

for (const force of [false, true]) test(`real Core and Adapter exit when launcher ${force ? "is killed" : "receives local UI shutdown"}`, { skip: process.platform !== "linux" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "parabus-lifecycle-"));
  for (const name of ["scripts", "services"]) await symlink(resolve(name), join(root, name), "dir");
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(r => probe.close(() => r()));
  const base = `http://127.0.0.1:${port}`;
  const launcher = spawn(process.execPath, ["scripts/start-router.ts"], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(port), OPEN_BROWSER: "0", DBR_SETTINGS_ROOT: root,
      DISCORD_IPC_ENDPOINT: join(root, "discord.sock"), RECORDER_FOLDER: join(root, "recordings"), DBR_LAN_ACCESS: "0", DBR_OPERATOR_ORIGIN: base,
      DISCORD_BOT_TOKEN: "", DISCORD_GUILD_ID: "", DISCORD_VOICE_CHANNEL_ID: "", DISCORD_BOT_RACK_JSON: "", DISCORD_BOT_RACK_FILE: "", ROUTER_CORE_OWNERSHIP: "typescript" },
  });
  let output = "", pids: number[] = [];
  launcher.stdout!.on("data", chunk => output += chunk); launcher.stderr!.on("data", chunk => output += chunk);
  t.after(async () => {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGTERM");
    for (const pid of pids) if (!await exited(pid)) try { process.kill(pid, "SIGTERM"); } catch {}
    await waitFor(async () => (launcher.exitCode !== null || launcher.signalCode !== null) && (await Promise.all(pids.map(exited))).every(Boolean), "test cleanup");
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(() => output.includes("Discord Bot Rack:"), "services did not start");
  pids = execFileSync("ps", ["-o", "pid=", "--ppid", String(launcher.pid)], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
  assert.equal(pids.length, 2, "track the actual Core and Adapter, not substitute fixtures");
  if (force) launcher.kill("SIGKILL");
  else {
    const html = await (await fetch(base)).text();
    const nonce = html.match(/name="dbr-session-nonce" content="([A-Za-z0-9_-]{43})"/)![1];
    const response = await fetch(`${base}/api/shutdown`, { method: "POST", headers: { origin: base, "x-dbr-session-nonce": nonce, "content-type": "application/json" }, body: '{"confirmed":true}' });
    assert.equal(response.status, 202);
  }
  await waitFor(async () => (launcher.exitCode !== null || launcher.signalCode !== null) && (await Promise.all(pids.map(exited))).every(Boolean), "Core/Adapter outlived the launcher");
  if (!force) assert.equal(launcher.exitCode, 0);
  await assert.rejects(() => fetch(`${base}/api/state`));
});

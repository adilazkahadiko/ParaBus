import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";

for (const action of ["shutdown", "restart"] as const) test(`${action} runs the real session reset before server exit`, async t => {
  const root = await mkdtemp(join(tmpdir(), "parabus-session-shutdown-"));
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(done => probe.close(() => done()));
  const base = `http://127.0.0.1:${port}`;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DISCORD_|DBR_|ROUTER_|RECORDER_)/i.test(key)));
  const child = spawn(process.execPath, ["--experimental-test-module-mocks", "tests/helpers/server-with-approved-participants.ts"], {
    cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    env: { ...inherited, PORT: String(port), DBR_OPERATOR_ORIGIN: base, DBR_SETTINGS_ROOT: root, DBR_LAN_ACCESS: "0", DBR_LAUNCHER_PID: String(process.pid), DBR_LAUNCHER_MANAGED: "1", RECORDER_FOLDER: join(root, "recordings"), DISCORD_IPC_ENDPOINT: process.platform === "win32" ? `\\\\.\\pipe\\approval-shutdown-${process.pid}-${port}` : join(root, "discord.sock") },
  });
  let output = "";
  child.stdout!.on("data", data => output += data); child.stderr!.on("data", data => output += data);
  const exited = new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("exit", code => done(code)); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  let state: any;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { const response = await fetch(base + "/api/state", { signal: AbortSignal.timeout(500) }); if (response.ok) { state = await response.json(); break; } } catch {}
    assert.equal(child.exitCode, null, output);
    await new Promise(done => setTimeout(done, 25));
  }
  assert.ok(state, output);
  assert.equal(state.userSessions.length, 2);
  assert.ok(state.userSessions.every((session: any) => session.sessionApproval === "APPROVED"));
  const html = await (await fetch(base)).text();
  const nonce = html.match(/name="dbr-session-nonce" content="([A-Za-z0-9_-]{43})"/)![1];
  const response = await fetch(`${base}/api/${action}`, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-dbr-session-nonce": nonce }, body: '{"confirmed":true}' });
  assert.equal(response.status, 202);
  assert.equal(await exited, action === "restart" ? 75 : 0, output);
  const proof = JSON.parse(await readFile(join(root, "session-shutdown-proof.json"), "utf8"));
  assert.equal(proof.reset, 1);
  assert.ok(proof.before.every((session: any) => session.sessionApproval === "APPROVED"));
  assert.equal(proof.after.find((session: any) => session.discordUserId === "910000000000000001").sessionApproval, "PENDING");
  assert.equal(proof.after.find((session: any) => session.discordUserId === "910000000000000001").gate, false);
  assert.equal(proof.after.find((session: any) => session.discordUserId === "910000000000000002").sessionApproval, "APPROVED");
  assert.equal(proof.after.find((session: any) => session.discordUserId === "910000000000000002").gate, true);
});

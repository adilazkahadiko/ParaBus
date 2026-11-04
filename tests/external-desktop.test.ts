import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExternalDeviceStore } from "../services/router-core-sim/src/external-device-store.ts";
import { availablePort, testRoot } from "./helpers/external-control-fixture.ts";

test("real desktop management requires nonce, Origin and local source, survives restart and keeps Bundle allowlisted", async t => {
  const root = testRoot(), port = await availablePort(), externalPort = await availablePort(), origin = `http://127.0.0.1:${port}`;
  const config = new ExternalDeviceStore(root); config.setPort(externalPort);
  // No Bot configuration is loaded and the startup helper mocks all native enumeration/streams.
  writeFileSync(join(root, "discord-bots.json"), "[]");
  let output = "", child: ChildProcess;
  const start = async (lan = false) => {
    if (lan) writeFileSync(join(root, ".env"), "DBR_LAN_ACCESS=1\n");
    child = spawn(process.execPath, ["--experimental-test-module-mocks", "tests/helpers/server-without-rust.ts"], {
      cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
        PORT: String(port), HOST: "127.0.0.1", DBR_OPERATOR_ORIGIN: origin, DBR_SETTINGS_ROOT: root,
        DBR_DEMO_CHANNELS: "0", ROUTER_CORE_OWNERSHIP: "typescript", DISCORD_IPC_ENDPOINT: process.platform === "win32" ? `\\\\.\\pipe\\external-desktop-${randomUUID()}` : join(root, "ipc.sock"),
        RECORDER_FOLDER: join(root, "recordings"), DISCORD_BOT_TOKEN: "", DISCORD_BOT_RACK_JSON: "[]", DISCORD_BOT_RACK_FILE: join(root, "discord-bots.json") } });
    child.stdout!.on("data", chunk => { output += chunk.toString(); }); child.stderr!.on("data", chunk => { output += chunk.toString(); });
    await until(async () => { try { return (await fetch(origin + "/api/state")).status === 200; } catch { return false; } });
    const html = await (await fetch(origin)).text(); return html.match(/name="dbr-session-nonce" content="([A-Za-z0-9_-]+)"/)![1];
  };
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM"); await until(() => child.exitCode !== null || child.signalCode !== null);
  };
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await until(() => child.exitCode !== null || child.signalCode !== null); } });
  let nonce = await start();
  const manage = (payload: unknown, custom: Record<string, string> = {}) => fetch(origin + "/api/external-control", { method: "POST", headers: {
    "content-type": "application/json", origin, "x-dbr-session-nonce": nonce, ...custom }, body: JSON.stringify(payload) });
  assert.equal((await manage({ action: "register", name: "Rejected" }, { "x-dbr-session-nonce": "wrong" })).status, 403);
  assert.equal((await manage({ action: "register", name: "Rejected" }, { origin: "null" })).status, 403);
  assert.equal((await fetch(origin + "/api/external-control")).status, 403);
  const registered = await (await manage({ action: "register", name: "Local private device", readDisplayNames: false })).json() as any;
  assert.equal(registered.ok, true); const { token, deviceId } = registered.data;
  const stored = new ExternalDeviceStore(root), hash = JSON.parse(readFileSync(stored.path, "utf8")).devices[0].tokenHash;
  const headers = { authorization: `Bearer ${token}` }, base = `http://127.0.0.1:${externalPort}/external/v1`;
  const external = async (path: string) => { const response = await fetch(base + path, { headers }); return { status: response.status, body: await response.json() as any }; };
  assert.equal((await external("/info")).body.code, "DISABLED");
  assert.equal((await manage({ action: "enable" })).status, 200); assert.equal((await external("/info")).status, 200);
  const info = (await external("/info")).body; const instanceId = info.instanceId;
  assert.equal((await fetch(base + "/info", { headers: { authorization: `Bearer ${nonce}` } })).status, 401);
  assert.equal((await manage({ action: "status" }, { "x-dbr-session-nonce": token })).status, 403);
  assert.equal((await manage({ action: "permissions", deviceId, readDisplayNames: true, allowedTierBOperations: ["recording.start"] })).status, 400);
  const status = await (await manage({ action: "status" })).json() as any; assert.equal(status.data.activeDeviceCount, 1); assert.equal(status.data.deviceCount, 1);
  assert.equal(JSON.stringify(status).includes(token), false); assert.equal(JSON.stringify(status).includes(hash), false);
  const action = await fetch(base + "/actions", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ requestId: randomUUID(), instanceId, operation: "emergency.set", args: { active: true } }) }); assert.equal(action.status, 200);
  const desktop = await (await fetch(origin + "/api/state")).text(); for (const sensitive of [token, hash, deviceId, "Local private device"]) assert.equal(desktop.includes(sensitive), false);
  const bundleResponse = await fetch(origin + "/api/support-bundle", { method: "POST", headers: { origin, "x-dbr-session-nonce": nonce, "content-type": "application/json" }, body: "{}" });
  assert.equal(bundleResponse.status, 200); const bundle = await bundleResponse.json() as any; const bytes = readFileSync(bundle.path);
  for (const sensitive of [token, hash, deviceId, "Local private device", "External control action", "external-control.json"]) assert.equal(bytes.includes(Buffer.from(sensitive)), false);
  assert.equal(bytes.includes(Buffer.from('"deviceCount": 1')), true); assert.equal(bytes.includes(Buffer.from('"enabled": true')), true);
  assert.equal((await manage({ action: "stop" })).status, 200); assert.equal((await external("/info")).status, 503); await stop();
  nonce = await start(true); assert.equal((await external("/info")).body.code, "DISABLED");
  assert.equal((await manage({ action: "enable" })).status, 200); assert.notEqual((await external("/info")).body.instanceId, instanceId);
  const lan = Object.values(networkInterfaces()).flatMap(v => v ?? []).find(v => v.family === "IPv4" && !v.internal)?.address;
  if (lan) {
    await assert.rejects(fetch(`http://${lan}:${externalPort}/external/v1/info`, { headers, signal: AbortSignal.timeout(1000) }));
    const response = await fetch(`http://${lan}:${port}/api/external-control`, { method: "POST", headers: { origin, "x-dbr-session-nonce": nonce, "content-type": "application/json" }, body: '{"action":"stop"}' }); assert.equal(response.status, 400);
  }
  assert.equal((await manage({ action: "reissue", deviceId })).status, 200); assert.equal((await external("/info")).status, 401);
  await stop();
  const log = readdirSync(join(root, "logs")).filter(name => name.endsWith(".jsonl")).map(name => readFileSync(join(root, "logs", name), "utf8")).join("");
  assert.match(log, /External control action operation=emergency.set tier=A result=SUCCESS/);
  for (const sensitive of [token, hash, deviceId, "Local private device"]) { assert.equal(log.includes(sensitive), false); assert.equal(output.includes(sensitive), false); }
});

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error("Desktop fixture timed out"); await new Promise(resolve => setTimeout(resolve, 25)); }
}

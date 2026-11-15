import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ExternalDeviceStore } from "../services/router-core-sim/src/external-device-store.ts";
import { availablePort, testRoot } from "./helpers/external-control-fixture.ts";
import { clientFrame, connectWs } from "./helpers/external-ws.ts";

test("real desktop WS receives external changes without periodic sends and coalesces fader bursts", async t => {
  const root = testRoot(), port = await availablePort(), externalPort = await availablePort();
  const origin = `http://127.0.0.1:${port}`, base = `http://127.0.0.1:${externalPort}/external/v1`;
  const store = new ExternalDeviceStore(root); store.setPort(externalPort); const device = store.register("Test controller");
  writeFileSync(join(root, "discord-bots.json"), "[]");
  const child = spawn(process.execPath, ["--experimental-test-module-mocks", "tests/helpers/server-without-periodic-state.ts"], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      PORT: String(port), HOST: "127.0.0.1", DBR_OPERATOR_ORIGIN: origin, DBR_SETTINGS_ROOT: root,
      DBR_DEMO_CHANNELS: "1", ROUTER_CORE_OWNERSHIP: "typescript", DISCORD_IPC_ENDPOINT: process.platform === "win32" ? `\\\\.\\pipe\\external-broadcast-${randomUUID()}` : join(root, "ipc.sock"),
      RECORDER_FOLDER: join(root, "recordings"), DISCORD_BOT_TOKEN: "", DISCORD_BOT_RACK_JSON: "[]", DISCORD_BOT_RACK_FILE: join(root, "discord-bots.json") }
  });
  let output = ""; child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.on("data", chunk => { output += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await until(() => child.exitCode !== null || child.signalCode !== null); } });
  await until(async () => { if (child.exitCode !== null) throw Error(output); try { return (await fetch(origin)).ok; } catch { return false; } });
  const html = await (await fetch(origin)).text(), nonce = html.match(/name="dbr-session-nonce" content="([A-Za-z0-9_-]+)"/)![1];
  assert.equal((await fetch(origin + "/api/external-control", { method: "POST", headers: { origin, "x-dbr-session-nonce": nonce, "content-type": "application/json" }, body: '{"action":"enable"}' })).status, 200);
  const headers = { authorization: `Bearer ${device.token}`, "content-type": "application/json" };
  const initial = (await (await fetch(base + "/state", { headers })).json() as any).data;
  const busId = initial.buses[0].busId as string;
  const ws = await connectWs(port, undefined, `Origin: ${origin}\r\n`, `/ws?nonce=${nonce}`); t.after(() => ws.socket.destroy());
  assert.equal(ws.status, 101); assert.equal((await ws.next()).type, "state");
  const action = async (deltaDb: number) => {
    const result = await fetch(base + "/actions", { method: "POST", headers, body: JSON.stringify({
      requestId: randomUUID(), instanceId: initial.instanceId, operation: "bus.fader.adjust", args: { busId, deltaDb }
    }) }); assert.equal(result.status, 200);
  };
  await action(-1);
  const first = await ws.next(); assert.equal(first.type, "state"); assert.equal(first.payload.buses.find((b: any) => b.id === busId).masterDb, -1);
  const before = ws.received.length;
  await Promise.all(Array.from({ length: 10 }, () => action(-1)));
  let latest: any;
  do { latest = await ws.next(); } while (latest.payload.buses.find((b: any) => b.id === busId).masterDb !== -11);
  const states = ws.received.slice(before).filter(m => m.type === "state");
  assert.ok(states.length > 0 && states.length < 10, `Expected coalescing, got ${states.length} snapshots`);
  // Desktop commands retain their existing immediate result + state delivery.
  ws.socket.write(clientFrame(JSON.stringify({ type: "command", payload: { type: "SET_BUS_MUTE", busId, mute: true } })));
  assert.equal((await ws.next()).type, "command-result");
  const local = await ws.next(); assert.equal(local.type, "state"); assert.equal(local.payload.buses.find((b: any) => b.id === busId).mute, true);
});

async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 15000;
  while (!await predicate()) { if (Date.now() > end) throw Error("Desktop broadcast fixture timed out"); await new Promise(resolve => setTimeout(resolve, 25)); }
}

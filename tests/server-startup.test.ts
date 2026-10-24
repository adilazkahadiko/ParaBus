import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RouterSnapshot } from "../packages/shared-types/src/index.ts";

test("server starts silent by default and creates synthetic sources only with an explicit demo flag", async () => {
  const silent = await startServerSnapshot();
  assert.equal(silent.channels.length, 0);
  assert.equal(silent.buses.length, 0, "production startup has no demo VC Bus");
  assert.ok(silent.runtimeInfo);
  assert.ok(Number.isFinite(Date.parse(silent.runtimeInfo.startedAt)));

  const tx = await startServerSnapshot({ DISCORD_BOT_RACK_JSON: JSON.stringify({ bots: [{ id: "TX01", role: "TX" }, { id: "RX01", role: "RX", enabled: false }] }) });
  assert.equal(tx.runtimeInfo?.pcRole, "TX", "startup identity follows the Adapter configuration source rather than example settings");

  const legacyTwo = await startServerSnapshot({ CHANNELS: "2" });
  assert.equal(legacyTwo.channels.length, 0, "legacy CHANNELS=2 cannot create synthetic sources");

  const legacySixtyFour = await startServerSnapshot({ CHANNELS: "64" });
  assert.equal(legacySixtyFour.channels.length, 0, "legacy CHANNELS=64 cannot create synthetic sources");

  const production = await startServerSnapshot({
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_GUILD_ID: "100000000000000001",
    DISCORD_VOICE_CHANNEL_ID: "100000000000000101",
  });
  assert.equal(production.channels.length, 0, "production Discord configuration never enables synthetic sources");
  assert.equal(production.runtimeInfo?.pcRole, "RX");

  const demo = await startServerSnapshot({ DBR_DEMO_CHANNELS: "2" });
  assert.equal(demo.channels.length, 2);
  assert.equal(demo.buses.length, 1);
  assert.equal(demo.channels.every((channel) => channel.kind === "TestTone"), true);

  const explicitDemoOverridesLegacy = await startServerSnapshot({ CHANNELS: "64", DBR_DEMO_CHANNELS: "2" });
  assert.equal(explicitDemoOverridesLegacy.channels.length, 2);

  await assert.rejects(
    startServerSnapshot({ DBR_DEMO_CHANNELS: "invalid" }),
    /DBR_DEMO_CHANNELS must be an integer from 0 to 80/,
  );
});

for (const surface of ["desktop"]) {
  for (const malformed of ["HTTP Host", "WebSocket URL"]) test(`${surface} rejects malformed ${malformed} without stopping Core audio`, async () => {
    const upgrade = malformed.startsWith("WebSocket"), badCookie = malformed === "WebSocket cookie";
    const tabletPort = await availablePort();
    await startServerSnapshot({ TABLET_CONTROL_ENABLED: "1", TABLET_CONTROL_PORT: String(tabletPort) }, async (port, child) => {
      const before = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json() as RouterSnapshot;
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = connect(surface === "desktop" ? port : tabletPort, "127.0.0.1");
        let data = "";
        socket.setTimeout(2000, () => socket.destroy(new Error("malformed request did not finish")));
        socket.on("data", chunk => { data += chunk.toString(); });
        socket.on("error", reject);
        socket.on("close", () => resolve(data));
        const host = badCookie ? `127.0.0.1:${tabletPort}` : "[";
        socket.on("connect", () => socket.write(`GET ${badCookie ? "/ws" : upgrade ? "http://[" : "/api/state"} HTTP/1.1\r\nHost: ${host}\r\nConnection: ${upgrade ? "Upgrade" : "close"}\r\n${upgrade ? "Upgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n" : ""}${badCookie ? `Origin: http://${host}\r\nCookie: dbr_tablet_session=%ZZ\r\n` : ""}\r\n`));
      });
      assert.match(reply, /^HTTP\/1\.1 4\d\d/, "only the bad request should be rejected");
      assert.equal(child.exitCode, null);
      await new Promise(resolve => setTimeout(resolve, 40));
      const after = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json() as RouterSnapshot;
      assert.ok(after.audioRuntimeTiming!.current.processBlocks > before.audioRuntimeTiming!.current.processBlocks, "audio blocks continue");
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/tablet/admin`)).status, 404, "Prototype Tablet administration is not provided");
    });
  });
}

test("legacy Tablet enable settings cannot start the deferred listener", async () => {
  const tabletPort = await availablePort();
  await startServerSnapshot({ TABLET_CONTROL_ENABLED: "1", TABLET_CONTROL_PORT: String(tabletPort) }, async (port) => {
    assert.notEqual(port, tabletPort);
    await assert.rejects(fetch(`http://127.0.0.1:${tabletPort}/api/state`, { signal: AbortSignal.timeout(1000) }));
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/tablet/admin`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 200);
  });
});

async function startServerSnapshot(overrides: NodeJS.ProcessEnv = {}, check?: (port: number, child: ChildProcess) => Promise<void>): Promise<RouterSnapshot> {
  const port = await availablePort();
  const root = mkdtempSync(join(tmpdir(), "dbr-server-default-"));
  const ipc = process.platform === "win32"
    ? String.raw`\\.\pipe\dbr-test-${process.pid}-${randomUUID()}`
    : join(root, "discord.sock");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DBR_OPERATOR_ORIGIN: `http://127.0.0.1:${port}`,
    DBR_SETTINGS_ROOT: root,
    DISCORD_IPC_ENDPOINT: ipc,
    RECORDER_FOLDER: join(root, "recordings"),
    TABLET_CONTROL_ENABLED: "0",
    ROUTER_CORE_OWNERSHIP: "typescript",
    ...overrides,
  };
  if (overrides.CHANNELS === undefined) delete env.CHANNELS;
  if (overrides.DBR_DEMO_CHANNELS === undefined) delete env.DBR_DEMO_CHANNELS;
  const child = spawn(process.execPath, ["--experimental-test-module-mocks", "tests/helpers/server-without-rust.ts"], {
    cwd: new URL("..", import.meta.url),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let snapshot: RouterSnapshot | undefined;
  child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
  try {
    await waitUntil(() => output.includes("ParaBus Phase 10 listening on http://") || child.exitCode !== null, () => `server did not start:\n${output}`);
    if (child.exitCode !== null) throw new Error(`server did not start:\n${output}`);
    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(response.status, 200);
    snapshot = await response.json() as RouterSnapshot;
    if (check) {
      await check(port, child);
    }
    return snapshot;
  } finally {
    await stopChild(child);
    try {
      if (snapshot) {
        const name = readdirSync(join(root, "logs")).find((entry) => entry.startsWith("operational-"))!;
        const firstEvent = JSON.parse(readFileSync(join(root, "logs", name), "utf8").split("\n")[0]);
        assert.match(firstEvent.message, /^ParaBus startup:/);
        assert.deepEqual(firstEvent.runtimeInfo, snapshot.runtimeInfo, "the log session header matches UI diagnostics");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitUntil(predicate: () => boolean, error: () => string): Promise<void> {
  // Parallel Node test workers can delay the mocked server bootstrap on Windows.
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(error());
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, 2_000);
    timeout.unref();
  });
  child.kill("SIGTERM");
  await Promise.race([exited, deadline]);
  if (timeout) clearTimeout(timeout);
  if (child.exitCode === null) child.kill("SIGKILL");
}

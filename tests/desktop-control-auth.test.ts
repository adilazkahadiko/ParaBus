import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir, networkInterfaces } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DesktopControlAuthError,
  assertDesktopControlAuthorized,
  createDesktopSessionNonce,
  injectDesktopSessionNonce,
  resolveOperatorOrigin,
  resolveDesktopAccess,
  isLocalDesktopAddress,
  injectDesktopAccess,
} from "../services/router-core-sim/src/desktop-control-auth.ts";

test("desktop control auth requires one exact Origin and process nonce", () => {
  const nonce = createDesktopSessionNonce();
  const origin = resolveOperatorOrigin("127.0.0.1", 4173);
  assert.equal(nonce.length, 43);
  assert.equal(origin, "http://127.0.0.1:4173");
  assert.doesNotThrow(() => assertDesktopControlAuthorized({ origin, "x-dbr-session-nonce": nonce }, origin, nonce));
  assert.throws(() => assertDesktopControlAuthorized({ origin }, origin, nonce), DesktopControlAuthError);
  assert.throws(() => assertDesktopControlAuthorized({ origin, "x-dbr-session-nonce": "wrong" }, origin, nonce), DesktopControlAuthError);
  assert.throws(() => assertDesktopControlAuthorized({ origin: "https://attacker.invalid", "x-dbr-session-nonce": nonce }, origin, nonce), DesktopControlAuthError);
  assert.equal(resolveOperatorOrigin("0.0.0.0", 4173), "http://127.0.0.1:4173");
  assert.equal(resolveOperatorOrigin("0.0.0.0", 4173, "https://operator.example"), "https://operator.example");
  assert.throws(() => resolveOperatorOrigin("127.0.0.1", 4173, "https://operator.example/path"));
  assert.match(injectDesktopSessionNonce("<html><head></head></html>", nonce), new RegExp(`content="${nonce}"`));
});

test("desktop LAN opt-in uses only startup IPv4 origins and preserves the nonce requirement", () => {
  const interfaces = { eth0: [
    { family: "IPv4", internal: false, address: "192.0.2.10" },
    { family: "IPv4", internal: true, address: "127.0.0.1" },
    { family: "IPv6", internal: false, address: "2001:db8::1" },
  ], eth1: [{ family: "IPv4", internal: false, address: "192.0.2.10" }] } as unknown as ReturnType<typeof networkInterfaces>;
  const nonce = createDesktopSessionNonce();
  const off = resolveDesktopAccess(4173, undefined, false, interfaces);
  assert.equal(off.host, "127.0.0.1"); assert.deepEqual(off.allowedOrigins, ["http://127.0.0.1:4173"]);
  assert.throws(() => assertDesktopControlAuthorized({ origin: "http://192.0.2.10:4173", "x-dbr-session-nonce": nonce }, off.allowedOrigins, nonce), DesktopControlAuthError);
  const on = resolveDesktopAccess(4173, "https://operator.example", true, interfaces);
  assert.equal(on.host, "0.0.0.0"); assert.deepEqual(on.urls, ["http://192.0.2.10:4173"]);
  for (const origin of ["http://127.0.0.1:4173", "http://localhost:4173", "http://192.0.2.10:4173", "https://operator.example"]) {
    assert.doesNotThrow(() => assertDesktopControlAuthorized({ origin, "x-dbr-session-nonce": nonce }, on.allowedOrigins, nonce));
    assert.throws(() => assertDesktopControlAuthorized({ origin }, on.allowedOrigins, nonce), DesktopControlAuthError);
  }
  for (const origin of ["http://evil.example", "http://192.0.2.10:4174", "http://[2001:db8::1]:4173", "null"]) {
    assert.throws(() => assertDesktopControlAuthorized({ origin, "x-dbr-session-nonce": nonce }, on.allowedOrigins, nonce), DesktopControlAuthError);
  }
  assert.equal(isLocalDesktopAddress("127.0.0.1"), true); assert.equal(isLocalDesktopAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLocalDesktopAddress("192.0.2.10"), false);
  const html = injectDesktopAccess("<head></head>", { lanEnabled: true, urls: ["</script><script>bad</script>"], localSettingsAvailable: false });
  assert.equal((html.match(/<script/g) ?? []).length, 1, "bootstrap JSON cannot escape its data script");
  assert.match(html, /"localSettingsAvailable":false/);
});

test("LAN desktop commands work over HTTP/WS while every local-only API still rejects non-loopback sockets", async t => {
  const lanIp = Object.values(networkInterfaces()).flatMap(entries => entries ?? []).find(entry => entry.family === "IPv4" && !entry.internal)?.address;
  assert.ok(lanIp, "integration test needs a real non-loopback IPv4 interface");
  const port = await availablePort(), origin = `http://127.0.0.1:${port}`, lanOrigin = `http://${lanIp}:${port}`;
  const root = mkdtempSync(join(tmpdir(), "dbr-desktop-lan-"));
  // Exercise .env startup discovery rather than relying solely on the launcher environment.
  writeFileSync(join(root, ".env"), "DBR_LAN_ACCESS=1\n");
  const child = spawn(process.execPath, ["--experimental-test-module-mocks", "tests/helpers/server-without-rust.ts"], {
    cwd: new URL("..", import.meta.url), env: { ...process.env, PORT: String(port), DBR_OPERATOR_ORIGIN: origin, DBR_SETTINGS_ROOT: root,
      DBR_LAN_ACCESS: "0", DBR_LAUNCHER_MANAGED: "0", DISCORD_IPC_ENDPOINT: process.platform === "win32" ? String.raw`\\.\pipe\dbr-lan-${process.pid}-${randomUUID()}` : join(root, "discord.sock"), RECORDER_FOLDER: join(root, "recordings") }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout?.on("data", chunk => output += chunk); child.stderr?.on("data", chunk => output += chunk);
  t.after(async () => { await stopChild(child); rmSync(root, { recursive: true, force: true }); });
  await waitUntil(() => output.includes("listening on"), () => output);
  const remoteHtml = await (await fetch(lanOrigin)).text(), localHtml = await (await fetch(origin)).text();
  assert.match(remoteHtml, /"localSettingsAvailable":false/); assert.match(localHtml, /"localSettingsAvailable":true/);
  assert.match(remoteHtml, /"lanEnabled":true/); assert.ok(output.includes(`LAN公開中: ${lanOrigin}`));
  const nonce = remoteHtml.match(/name="dbr-session-nonce" content="([A-Za-z0-9_-]{43})"/)![1];
  assert.equal((await postCommand(lanOrigin, nonce, lanOrigin, { type: "EMERGENCY_MUTE", active: true })).status, 200);
  assert.equal((await (await fetch(origin + "/api/state")).json() as { emergencyMuted: boolean }).emergencyMuted, true);
  const result = await websocketCommand(port, lanOrigin, nonce, { type: "SET_STATE", state: "SETUP" }, lanIp);
  assert.equal(result.ok, true);
  assert.equal((await postCommand(lanOrigin, nonce, "http://evil.example", { type: "EMERGENCY_MUTE", active: true })).status, 403);
  assert.equal((await postCommand(lanOrigin, undefined, lanOrigin, { type: "EMERGENCY_MUTE", active: true })).status, 403);
  assert.match(await websocketHandshake(port, "http://evil.example", nonce, lanIp), /^HTTP\/1\.1 403 /);
  const headers = { origin: lanOrigin, "content-type": "application/json", "x-dbr-session-nonce": nonce };
  for (const path of ["/api/settings", "/api/tablet/admin", "/api/rust/wasapi"]) assert.equal((await fetch(lanOrigin + path)).status, 400, path);
  for (const path of ["/api/settings", "/api/restart", "/api/shutdown", "/api/support-bundle", "/api/support-bundle/open-directory", "/api/rust/wasapi/select", "/api/rust/wasapi/preflight", "/api/rust/wasapi/start", "/api/rust/wasapi/stop", "/api/rust/wasapi/clear"]) {
    assert.equal((await fetch(lanOrigin + path, { method: "POST", headers, body: '{"confirmed":true}' })).status, 400, path);
  }
  assert.equal((await fetch(origin + "/api/settings")).status, 200, "loopback settings retain their original behavior");
});

test("desktop HTTP and WebSocket command surfaces reject unauthorized browser clients", async (t) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const root = mkdtempSync(join(tmpdir(), "dbr-desktop-auth-"));
  const ipc = process.platform === "win32"
    ? String.raw`\\.\pipe\dbr-test-${process.pid}-${randomUUID()}`
    : join(root, "discord.sock");
  const child = spawn(process.execPath, ["--experimental-test-module-mocks", "tests/helpers/server-without-rust.ts"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      HOST: "0.0.0.0", // HOST alone must not expose the desktop without the opt-in.
      DBR_LAN_ACCESS: undefined,
      PORT: String(port),
      DBR_OPERATOR_ORIGIN: origin,
      DBR_SETTINGS_ROOT: root,
      DBR_LAUNCHER_MANAGED: "0",
      DISCORD_IPC_ENDPOINT: ipc,
      RECORDER_FOLDER: join(root, "recordings"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    await stopChild(child);
    rmSync(root, { recursive: true, force: true });
  });
  await waitUntil(() => output.includes("listening on"), () => `server did not start:\n${output}`);

  const html = await (await fetch(origin)).text();
  const legacy = await fetch(`${origin}/index.html?view=settings`, { redirect: "manual" });
  assert.equal(legacy.status, 302);
  assert.equal(legacy.headers.get("location"), "/");
  assert.equal(legacy.headers.get("cache-control"), "no-store");
  const redirected = await (await fetch(`${origin}/index.html`)).text();
  assert.match(redirected, /src="\/app\.js"/);
  assert.match(redirected, /href="\/styles\.css"/);
  assert.doesNotMatch(redirected, /(?:src|href)="\/minimal\./);
  for (const removed of ["minimal", "minimal/", "minimal.html", "minimal.js", "minimal.css"]) {
    const response = await fetch(`${origin}/${removed}`);
    assert.equal(response.status, 404, `${removed} is no longer served`);
  }
  for (const [asset, mime] of [["app.js", "javascript"], ["styles.css", "css"]]) {
    const response = await fetch(`${origin}/${asset}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, new RegExp(mime));
  }
  const nonce = html.match(/<meta name="dbr-session-nonce" content="([A-Za-z0-9_-]{43})"/i)?.[1];
  assert.ok(nonce, "bootstrap HTML contains the process-lifetime nonce");
  assert.match(html, /"lanEnabled":false/);
  const lanIp = Object.values(networkInterfaces()).flatMap(entries => entries ?? []).find(entry => entry.family === "IPv4" && !entry.internal)?.address;
  if (lanIp) {
    await assert.rejects(() => fetch(`http://${lanIp}:${port}/api/state`), "default server is not reachable on LAN interfaces");
    assert.equal((await postCommand(origin, nonce, `http://${lanIp}:${port}`, { type: "EMERGENCY_MUTE", active: true })).status, 403);
  }

  const authorized = await postCommand(origin, nonce, origin, { type: "EMERGENCY_MUTE", active: true, confirmed: true });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).ok, true);

  const firstEmergency = await (await fetch(`${origin}/api/state`)).json() as { emergencyEpoch: number };
  assert.equal((await postCommand(origin, nonce, origin, { type: "SELECT_OUTPUT_DEVICE", deviceId: "mock-64" })).status, 200);
  assert.equal((await postCommand(origin, nonce, origin, { type: "SET_STATE", state: "READY" })).status, 200);
  assert.equal((await postCommand(origin, nonce, origin, { type: "EMERGENCY_MUTE", active: false, confirmed: true, expectedEmergencyEpoch: firstEmergency.emergencyEpoch })).status, 200);
  assert.equal((await postCommand(origin, nonce, origin, { type: "EMERGENCY_MUTE", active: true })).status, 200);
  assert.equal((await postCommand(origin, nonce, origin, { type: "SET_STATE", state: "SETUP" })).status, 200);
  assert.equal((await postCommand(origin, nonce, origin, { type: "SELECT_OUTPUT_DEVICE", deviceId: "mock-64" })).status, 200);
  assert.equal((await postCommand(origin, nonce, origin, { type: "SET_STATE", state: "READY" })).status, 200);
  const delayedClear = await postCommand(origin, nonce, origin, { type: "EMERGENCY_MUTE", active: false, confirmed: true, expectedEmergencyEpoch: firstEmergency.emergencyEpoch });
  assert.equal(delayedClear.status, 409);
  assert.equal(((await delayedClear.json()) as { code?: string }).code, "STALE_STATE");
  const delayedWsClear = await websocketCommand(port, origin, nonce, { type: "EMERGENCY_MUTE", active: false, confirmed: true, expectedEmergencyEpoch: firstEmergency.emergencyEpoch });
  assert.equal(delayedWsClear.code, "STALE_STATE", "authenticated WebSocket commands use the same Core CAS guard");

  assert.equal((await postCommand(origin, undefined, origin, { type: "EMERGENCY_MUTE", active: false, confirmed: true })).status, 403);
  assert.equal((await postCommand(origin, "wrong-nonce", origin, { type: "SET_PARTICIPANT_APPROVAL", channelId: "synthetic:1", approved: true })).status, 403);
  assert.equal((await postCommand(origin, nonce, "https://attacker.invalid", { type: "SET_PARTICIPANT_APPROVAL", channelId: "synthetic:1", approved: false })).status, 403);
  assert.equal((await postCommand(origin, undefined, origin, { type: "SET_RECEIVER_OWNER", guildId: "1", voiceChannelId: "2", profileId: "RX02", confirmed: true })).status, 403);

  assert.equal((await postRestart(origin, undefined, origin, true)).status, 403);
  assert.equal((await postRestart(origin, nonce, origin, false)).status, 400);
  assert.equal((await postCommand(origin, nonce, origin, { type: "SET_STATE", state: "ON_AIR", confirmed: true })).status, 200);
  assert.equal((await fetch(`${origin}/api/support-bundle`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await fetch(`${origin}/api/support-bundle/open-directory`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" })).status, 403, "unauthorized callers cannot open OS folders");
  const supportHeaders = { origin, "content-type": "application/json", "x-dbr-session-nonce": nonce };
  assert.equal((await fetch(`${origin}/api/support-bundle`, { method: "POST", headers: supportHeaders, body: '{"days":0}' })).status, 400);
  const bundles = await Promise.all([1, 2].map(() => fetch(`${origin}/api/support-bundle`, { method: "POST", headers: supportHeaders, body: '{"days":7}' })));
  assert.deepEqual(bundles.map((response) => response.status).sort(), [200, 409], "only one export runs at a time");
  const bundle = await bundles.find((response) => response.status === 200)!.json() as { ok: boolean; path: string; directory: string; fileName: string };
  assert.equal(bundle.ok, true);
  assert.equal(bundle.directory, join(root, "support"));
  assert.equal(bundle.path, join(bundle.directory, bundle.fileName));
  const afterBundle = await (await fetch(`${origin}/api/state`)).json() as { state: string; emergencyMuted: boolean };
  assert.equal(afterBundle.state, "ON_AIR");
  assert.equal(afterBundle.emergencyMuted, true, "export never changes emergency mute or audio/TX state");
  const lockedRestart = await postRestart(origin, nonce, origin, true);
  assert.equal(lockedRestart.status, 409);
  assert.match(await lockedRestart.text(), /設定ロック中/);
  const shutdownHeaders = { origin, "content-type": "application/json", "x-dbr-session-nonce": nonce };
  const shutdown = (body = '{"confirmed":true}', headers = shutdownHeaders) => fetch(`${origin}/api/shutdown`, { method: "POST", headers, body });
  assert.equal((await shutdown()).status, 409, "ON_AIR refuses shutdown");
  assert.equal((await shutdown('{}')).status, 400, "shutdown needs explicit confirmation");
  assert.equal((await shutdown('{"confirmed":true}', { ...shutdownHeaders, "x-dbr-session-nonce": "wrong" })).status, 403);
  assert.equal((await postCommand(origin, nonce, origin, { type: "SET_STATE", state: "SETUP", confirmed: true })).status, 200);
  const unmanagedRestart = await postRestart(origin, nonce, origin, true);
  assert.equal(unmanagedRestart.status, 409);
  assert.match(await unmanagedRestart.text(), /Node 22ランチャー/);
  assert.equal((await postCommand(origin, nonce, origin, { type: "START_RECORDING", matrixOutput: 0, includeUsers: false, includeBuses: false, selection: { outputs: [0], busIds: [], channelIds: [] }, confirmed: true })).status, 200);
  assert.equal((await shutdown()).status, 409, "recording refuses shutdown");
  assert.equal((await postCommand(origin, nonce, origin, { type: "STOP_RECORDING", confirmed: true })).status, 200);
  await waitUntil(async () => ((await (await fetch(`${origin}/api/state`)).json()) as any).recorder.state === "IDLE", () => "recorder did not flush");

  const state = await (await fetch(`${origin}/api/state`)).json() as { emergencyMuted: boolean; alerts: Array<{ message: string }> };
  assert.equal(state.emergencyMuted, true, "unauthorized Emergency clear never reaches the Control Plane");
  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, new RegExp(nonce));
  assert.doesNotMatch(serialized, /wrong-nonce|attacker\.invalid/);
  assert.ok(state.alerts.some((entry) => entry.message === "Unauthorized Desktop HTTP/WS command attempt rejected"));

  assert.match(await websocketHandshake(port, origin, nonce), /^HTTP\/1\.1 101 /);
  assert.match(await websocketHandshake(port, origin, nonce), /^HTTP\/1\.1 101 /, "an authenticated desktop reconnect succeeds");
  assert.match(await websocketHandshake(port, "https://attacker.invalid", nonce), /^HTTP\/1\.1 403 /);
  assert.match(await websocketHandshake(port, origin), /^HTTP\/1\.1 403 /);
  assert.match(await websocketHandshake(port, origin, "wrong-nonce"), /^HTTP\/1\.1 403 /);
  assert.doesNotMatch(output, new RegExp(nonce));
  assert.doesNotMatch(output, /wrong-nonce|attacker\.invalid/);
  assert.equal((await shutdown()).status, 202, "loopback shutdown succeeds even for a standalone Core");
  await waitUntil(() => child.exitCode === 0, () => "Core failed to exit gracefully");
});

async function postCommand(base: string, nonce: string | undefined, origin: string, command: unknown): Promise<Response> {
  const headers: Record<string, string> = { origin, "content-type": "application/json" };
  if (nonce !== undefined) headers["x-dbr-session-nonce"] = nonce;
  return fetch(`${base}/api/command`, { method: "POST", headers, body: JSON.stringify(command) });
}

async function postRestart(base: string, nonce: string | undefined, origin: string, confirmed: boolean): Promise<Response> {
  const headers: Record<string, string> = { origin, "content-type": "application/json" };
  if (nonce !== undefined) headers["x-dbr-session-nonce"] = nonce;
  return fetch(`${base}/api/restart`, { method: "POST", headers, body: JSON.stringify({ confirmed }) });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function websocketHandshake(port: number, origin: string, nonce?: string, host = "127.0.0.1"): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = createConnection(port, host);
    const timer = setTimeout(() => { client.destroy(); reject(new Error("WebSocket handshake timed out")); }, 2_000);
    client.once("error", (error) => { clearTimeout(timer); reject(error); });
    client.once("connect", () => {
      const path = nonce === undefined ? "/ws" : `/ws?nonce=${encodeURIComponent(nonce)}`;
      client.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Origin: ${origin}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: ZGJyLXRlc3Qta2V5LTEyMw==\r\n\r\n",
      );
    });
    client.once("data", (chunk) => {
      clearTimeout(timer);
      client.destroy();
      resolve(chunk.toString("latin1"));
    });
  });
}

async function websocketCommand(port: number, origin: string, nonce: string, command: unknown, host = "127.0.0.1"): Promise<{ ok: boolean; code?: string }> {
  return new Promise((resolve, reject) => {
    const client = createConnection(port, host);
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => { client.destroy(); reject(new Error("WebSocket command timed out")); }, 3_000);
    const finish = (error?: Error, value?: { ok: boolean; code?: string }) => {
      clearTimeout(timer);
      client.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    client.once("error", (error) => finish(error));
    client.once("connect", () => {
      client.write(
        `GET /ws?nonce=${encodeURIComponent(nonce)} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Origin: ${origin}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: ZGJyLWNvbW1hbmQta2V5\r\n\r\n",
      );
    });
    client.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const header = buffer.subarray(0, headerEnd).toString("latin1");
        if (!header.startsWith("HTTP/1.1 101 ")) return finish(new Error(`upgrade failed: ${header.split("\r\n")[0]}`));
        buffer = buffer.subarray(headerEnd + 4);
        upgraded = true;
        client.write(encodeClientWebSocketFrame(JSON.stringify({ type: "command", payload: command })));
      }
      while (buffer.length >= 2) {
        const lengthCode = buffer[1] & 0x7f;
        let headerLength = 2;
        let length = lengthCode;
        if (lengthCode === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          headerLength = 4;
        } else if (lengthCode === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          headerLength = 10;
        }
        if (buffer.length < headerLength + length) return;
        const payload = buffer.subarray(headerLength, headerLength + length).toString("utf8");
        buffer = buffer.subarray(headerLength + length);
        const message = JSON.parse(payload) as { type: string; payload: { ok: boolean; code?: string } };
        if (message.type === "command-result") return finish(undefined, message.payload);
      }
    });
  });
}

function encodeClientWebSocketFrame(message: string): Buffer {
  const payload = Buffer.from(message);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0xfe, payload.length >> 8, payload.length & 0xff]);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, failure: () => string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(failure());
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { Socket } from "node:net";
import { watchLauncher } from "../../../packages/process-lifecycle/src/index.ts";
import type { Duplex } from "node:stream";
import type { CommandResult, ControlCommand } from "../../../packages/shared-types/src/index.ts";
import { AudioEngine } from "./audio-engine.ts";
import { ControlPlane } from "./control-plane.ts";
import { DiscordIngestServer } from "./discord-ingest.ts";
import { DiscordShadowComparator } from "./discord-shadow.ts";
import { ProgramAudioShadow } from "./program-audio-shadow.ts";
import { AudioOutputManager } from "./audio-output.ts";
import { AudioSchedulerTiming, audioTimingSummary } from "./audio-timing.ts";
import { AudioRuntimeTiming } from "./audio-runtime-timing.ts";
import { broadcastWebSocket, MAX_WEBSOCKET_PENDING_BYTES } from "./snapshot-delivery.ts";
import { AudioInputManager, inputTimingSummary } from "./audio-input.ts";
import { AsioDuplexStream } from "./asio-duplex.ts";
import { SettingsStore } from "./settings-store.ts";
import { UserProfileStore } from "./user-profile-store.ts";
import { UserSessionRegistry } from "./user-session-registry.ts";
import { ReceiverOwnershipStore } from "./receiver-ownership-store.ts";
import { RecorderManager } from "./recorder.ts";
import { SystemMonitor } from "./system-monitor.ts";
import { resolveCoreOwnership } from "./core-ownership.ts";
import { deriveOperatorHealth } from "./operator-health.ts";
import { operatorFacingSnapshot, safeOperatorSummary, sanitizeOperatorMessage } from "./operator-sanitize.ts";
import { OperationalHealthTracker, OperationalLog } from "./operational-log.ts";
import { localAudioFaultDetail } from "./audio-fault-diagnostics.ts";
import { SceneStore } from "./scene-store.ts";
import { runtimeInfo } from "./runtime-info.ts";
import { createSupportBundle, openSupportDirectory, supportDiagnostics } from "./support-bundle.ts";
import { loadBotRackConfig, loadBotRackEnvironment } from "../../discord-adapter/src/bot-config.ts";
import {
  DesktopControlAuthError,
  DesktopAuthFailureLog,
  assertDesktopControlAuthorized,
  assertDesktopStateAuthorized,
  createDesktopSessionNonce,
  injectDesktopSessionNonce,
  injectDesktopAccess,
  isLocalDesktopAddress,
  resolveDesktopAccess,
  desktopAllowedHosts,
  isDesktopHostAllowed,
} from "./desktop-control-auth.ts";
import {
  createProductionRustManagement,
  RustManagementUnavailableError,
} from "./rust-management.ts";

const startedAt = new Date();
const projectDirectory = join(import.meta.dirname, "../../..");
const settingsRoot = process.env.DBR_SETTINGS_ROOT ? resolve(process.env.DBR_SETTINGS_ROOT) : projectDirectory;
const startupEnvironment = loadBotRackEnvironment(process.env, join(settingsRoot, ".env"));
const port = Number(process.env.PORT ?? 4173);
const desktopAccess = resolveDesktopAccess(port, process.env.DBR_OPERATOR_ORIGIN ?? startupEnvironment.DBR_OPERATOR_ORIGIN, startupEnvironment.DBR_LAN_ACCESS === "1");
const host = desktopAccess.host;
const operatorOrigin = desktopAccess.origin;
const allowedHosts = desktopAllowedHosts(port, desktopAccess);
const frameProtectionHeaders = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
};
const frameProtectionHeaderLines = Object.entries(frameProtectionHeaders).map(([name, value]) => `${name}: ${value}\r\n`).join("");
const desktopSessionNonce = createDesktopSessionNonce();
const publicDirectory = join(import.meta.dirname, "../public");
const manualFile = join(import.meta.dirname, "../../../docs/manual.html");
const documentationDirectory = join(import.meta.dirname, "../../../docs");
const documentationFiles = new Set(["CHECKLIST.md", "DISCORD_RX.md"]);
const documentationRoutes = new Map([
  ["/checklist", "CHECKLIST.md"],
  ["/startup-guide", "DISCORD_RX.md"],
]);
const RESTART_EXIT_CODE = 75;
const coreOwnership = resolveCoreOwnership();
const rustManagement = createProductionRustManagement(coreOwnership);
const syntheticSourceCount = Number(process.env.DBR_DEMO_CHANNELS ?? 0);
if (!Number.isInteger(syntheticSourceCount) || syntheticSourceCount < 0 || syntheticSourceCount > 80) {
  throw new Error("DBR_DEMO_CHANNELS must be an integer from 0 to 80");
}
const engine = syntheticSourceCount > 0 ? AudioEngine.createDemo(syntheticSourceCount) : new AudioEngine();
const programAudioShadow = new ProgramAudioShadow({
  enabled: coreOwnership.discordMetadataShadowEnabled,
  channels: engine.outputChannelCount,
});
const asioDuplex = new AsioDuplexStream();
const outputManager = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, undefined, undefined, rustManagement, undefined, asioDuplex);
const audioSchedulerTiming = new AudioSchedulerTiming();
const audioRuntimeTiming = new AudioRuntimeTiming();
const cueOutputManager = new AudioOutputManager(engine.sampleRate, engine.blockSize, 2, undefined, undefined, rustManagement);
const inputManager = new AudioInputManager(engine, undefined, undefined, rustManagement, undefined, asioDuplex);
const recorder = new RecorderManager(engine, process.env.RECORDER_FOLDER ? resolve(process.env.RECORDER_FOLDER) : join(projectDirectory, "recordings"));
const settingsStore = new SettingsStore(settingsRoot);
const userProfileStore = new UserProfileStore(settingsRoot);
const userSessions = new UserSessionRegistry(userProfileStore);
const receiverOwnershipStore = new ReceiverOwnershipStore(settingsRoot);
const operationalLog = new OperationalLog(settingsRoot);
const sceneStore = new SceneStore(settingsRoot);
const operationalHealth = new OperationalHealthTracker();
const startupSettings = settingsStore.snapshot();
let startupBotConfig: unknown = [];
try {
  startupBotConfig = loadBotRackConfig(loadBotRackEnvironment(process.env, settingsStore.environmentPath), settingsStore.rackPath);
} catch {
  // Keep SETUP available when an incomplete/invalid Bot configuration needs repair.
}
const startupInfo = runtimeInfo(projectDirectory, startupBotConfig, startedAt);
operationalLog.append({
  level: "INFO", at: startupInfo.startedAt,
  message: `ParaBus startup: commit=${startupInfo.buildCommit?.slice(0, 12) ?? "unknown"} PC=${startupInfo.pcRole} started=${startupInfo.startedAt}`,
  runtimeInfo: startupInfo,
});
const discordIngest = new DiscordIngestServer(
  engine,
  undefined,
  new DiscordShadowComparator({ enabled: coreOwnership.discordMetadataShadowEnabled }),
  undefined,
  userSessions,
  receiverOwnershipStore,
);
const control = new ControlPlane(engine, outputManager, discordIngest, inputManager, recorder, userSessions, (event) => operationalLog.append(event), cueOutputManager);
const storedScenes = sceneStore.snapshot();
for (const scene of storedScenes.scenes) control.scenes.set(scene.id, scene);
control.currentSceneId = storedScenes.currentSceneId;
discordIngest.setReceiverEventHandler((level, message) => control.recordExternalEvent(level, message));
const systemMonitor = new SystemMonitor();
let supportBundleBusy = false;
function executeExternalControlCommand(command: ControlCommand): CommandResult {
  if (command?.type === "DEVICE_LOST" || command?.type === "INPUT_DEVICE_LOST") {
    return { ok: false, revision: control.revision, error: "Internal command is unavailable" };
  }
  return executeControlCommand(command);
}

function executeControlCommand(command: ControlCommand): CommandResult {
  if (
    command.type === "SET_STATE"
    && command.state !== "SETUP"
    && rustManagement.snapshot().wasapi.streamStarted
  ) {
    return {
      ok: false,
      revision: control.snapshot().revision,
      error: "SETUPを終了する前にRust WASAPI silent streamを停止してください",
    };
  }
  const result = control.execute(command);
  if (result.ok) {
    void rustManagement.shadowControlCommand(command, {
      state: control.state,
      emergencyMuted: control.engine.emergencyMuted,
      monitorSourceId: control.engine.monitorSourceId,
    });
  }
  if (result.ok && (command.type === "SAVE_SCENE" || command.type === "RECALL_SCENE" || command.type === "DELETE_SCENE")) {
    sceneStore.save([...control.scenes.values()], control.currentSceneId);
  }
  return result;
}
const desktopSnapshot = (includeHistory = true) => {
  const snapshot = operatorFacingSnapshot({
    ...control.snapshot(includeHistory),
    userProfiles: userProfileStore.snapshot(),
    userSessions: userSessions.snapshot(),
    discord: discordIngest.snapshot(Date.now(), includeHistory),
    system: systemMonitor.snapshot(),
    runtimeInfo: startupInfo,
    audioTiming: audioSchedulerTiming.snapshot(),
    audioRuntimeTiming: audioRuntimeTiming.snapshot(),
    coreOwnership: coreOwnership.snapshot,
    programAudioShadow: programAudioShadow.snapshot(),
    rustManagement: rustManagement.snapshot(),
  });
  return { ...snapshot, operatorHealth: deriveOperatorHealth(snapshot) };
};
outputManager.onFault = (deviceId, message, diagnostic) => {
  executeControlCommand({ type: "DEVICE_LOST", deviceId, fault: { ...diagnostic, reason: localAudioFaultDetail(message) } });
};
cueOutputManager.onFault = () => {
  control.recordExternalEvent("WARNING", "Cue output disconnected; Main output remains active");
};
inputManager.onFault = (deviceId, message, diagnostic) => {
  executeControlCommand({ type: "INPUT_DEVICE_LOST", deviceId, fault: { ...diagnostic, reason: localAudioFaultDetail(message) } });
};
const websocketClients = new Set<Duplex>();
const websocketBuffers = new WeakMap<Duplex, Buffer>();
// Tablet Control is a retained prototype, not a supported runtime feature.
// Do not instantiate its listener, including when legacy settings enable it.

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function writeJson(response: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

const desktopAuthFailures = new DesktopAuthFailureLog(message => control.recordExternalEvent("WARNING", message));
const desktopAuthLogTimer = setInterval(() => desktopAuthFailures.flush(), 60_000);
desktopAuthLogTimer.unref();

function requireDesktopControlRequest(request: IncomingMessage, suppliedNonce?: string | null): void {
  try {
    assertDesktopControlAuthorized(request.headers, desktopAccess.allowedOrigins, desktopSessionNonce, suppliedNonce);
  } catch (error) {
    desktopAuthFailures.reject();
    throw error;
  }
}

function requireLocalSettingsRequest(request: IncomingMessage): void {
  if (!isLocalDesktopAddress(request.socket.remoteAddress)) {
    throw new Error("設定ページはこのPCからのみ利用できます");
  }
}

function requireDesktopStateRequest(request: IncomingMessage): void {
  try {
    assertDesktopStateAuthorized(request.headers, request.socket.remoteAddress, desktopSessionNonce);
  } catch (error) {
    desktopAuthFailures.reject();
    throw error;
  }
}

function requireRustManagementSetup(): void {
  if (control.state !== "SETUP") {
    throw new RustManagementUnavailableError("Rust WASAPI管理はSETUP中だけ変更できます");
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function serveStatic(pathname: string, response: ServerResponse, request: IncomingMessage): void {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const file = join(publicDirectory, safePath);
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
    if (requested === "index.html") {
      const html = injectDesktopSessionNonce(readFileSync(file, "utf8"), desktopSessionNonce);
      const payload = Buffer.from(injectDesktopAccess(html, { lanEnabled: desktopAccess.lanEnabled, urls: desktopAccess.urls, localSettingsAvailable: isLocalDesktopAddress(request.socket.remoteAddress) }), "utf8");
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": payload.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(payload);
      return;
    }
    response.writeHead(200, {
      "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
      "content-length": stat.size,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function serveManual(response: ServerResponse): void {
  try {
    const stat = statSync(manualFile);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": stat.size,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    createReadStream(manualFile).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Manual not found");
  }
}

function serveDocumentation(filename: string, response: ServerResponse): void {
  if (!documentationFiles.has(filename)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Document not found");
    return;
  }
  const file = join(documentationDirectory, filename);
  try {
    const stat = statSync(file);
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": stat.size,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Document not found");
  }
}

async function handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  for (const [name, value] of Object.entries(frameProtectionHeaders)) response.setHeader(name, value);
  try {
    if (!isDesktopHostAllowed(request.headers, allowedHosts)) {
      writeJson(response, 403, { ok: false, error: "Forbidden" });
      return;
    }
    if (request.headers.expect) {
      if (request.headers.expect.toLowerCase() !== "100-continue") {
        response.writeHead(417);
        response.end();
        return;
      }
      response.writeContinue();
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/index.html") {
      response.writeHead(302, { location: "/", "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/session/check") {
      requireDesktopControlRequest(request);
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      requireDesktopStateRequest(request);
      writeJson(response, 200, desktopSnapshot());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/settings") {
      requireLocalSettingsRequest(request);
      writeJson(response, 200, settingsStore.snapshot());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/support-bundle") {
      requireLocalSettingsRequest(request);
      requireDesktopControlRequest(request);
      const payload = await readJson(request) as { days?: unknown };
      if (payload?.days !== undefined && (typeof payload.days !== "number" || !Number.isInteger(payload.days) || payload.days < 1 || payload.days > 30)) {
        return writeJson(response, 400, { ok: false, error: "ログ日数は1〜30日を指定してください" });
      }
      if (supportBundleBusy) return writeJson(response, 409, { ok: false, error: "Support Bundleを作成中です" });
      supportBundleBusy = true;
      try {
        const result = await createSupportBundle({
          settingsRoot, projectRoot: projectDirectory, runtimeInfo: startupInfo,
          diagnostics: supportDiagnostics({ ...control.snapshot(), discord: discordIngest.snapshot(), system: systemMonitor.snapshot(), audioTiming: audioSchedulerTiming.snapshot(), audioRuntimeTiming: audioRuntimeTiming.snapshot() }),
          days: payload?.days as number | undefined,
        });
        writeJson(response, 200, { ok: true, ...result });
      } finally { supportBundleBusy = false; }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/support-bundle/open-directory") {
      requireLocalSettingsRequest(request);
      requireDesktopControlRequest(request);
      await openSupportDirectory(settingsRoot);
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/tablet/admin") {
      requireLocalSettingsRequest(request);
      writeJson(response, 404, { error: "Tablet Control is unavailable pending redesign" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/rust/wasapi") {
      requireLocalSettingsRequest(request);
      const inventory = await rustManagement.listWasapiEndpoints();
      writeJson(response, 200, { ok: true, inventory, management: rustManagement.snapshot() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/rust/wasapi/select") {
      requireLocalSettingsRequest(request);
      requireDesktopControlRequest(request);
      requireRustManagementSetup();
      const payload = await readJson(request) as { endpointId?: unknown };
      const result = await rustManagement.selectWasapiEndpoint(
        typeof payload?.endpointId === "string" ? payload.endpointId : "",
      );
      writeJson(response, 200, { ok: true, result, management: rustManagement.snapshot() });
      broadcastState();
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/rust/wasapi/clear") {
      requireLocalSettingsRequest(request);
      requireDesktopControlRequest(request);
      requireRustManagementSetup();
      const result = await rustManagement.clearWasapiEndpoint();
      writeJson(response, 200, { ok: true, result, management: rustManagement.snapshot() });
      broadcastState();
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/rust/wasapi/preflight") {
      requireLocalSettingsRequest(request);
      requireDesktopControlRequest(request);
      requireRustManagementSetup();
      const result = await rustManagement.preflightWasapiEndpoint();
      writeJson(response, 200, { ok: true, result, management: rustManagement.snapshot() });
      broadcastState();
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/rust/wasapi/start") {
      requireLocalSettingsRequest(request);
      requireDesktopControlRequest(request);
      requireRustManagementSetup();
      const payload = await readJson(request) as { confirmed?: unknown };
      if (payload?.confirmed !== true) {
        throw new RustManagementUnavailableError("WASAPI silent stream開始には確認が必要です");
      }
      const result = await rustManagement.startWasapiStream();
      writeJson(response, 200, { ok: true, result, management: rustManagement.snapshot() });
      broadcastState();
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/rust/wasapi/stop") {
      requireLocalSettingsRequest(request);
      requireDesktopControlRequest(request);
      const result = await rustManagement.stopWasapiStream();
      writeJson(response, 200, { ok: true, result, management: rustManagement.snapshot() });
      broadcastState();
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/settings") {
      requireLocalSettingsRequest(request);
      requireDesktopControlRequest(request);
      const controlState = control.snapshot().state;
      if (controlState === "ON_AIR" || controlState === "FAULT") return writeJson(response, 409, { error: "SETUP changes are locked while ON AIR or FAULT" });
      const snapshot = settingsStore.save(await readJson(request));
      writeJson(response, 200, { ok: true, settings: snapshot, message: "設定を保存しました。PortとLAN公開の変更は再起動後に反映されます。" });
      return;
    }
    if (request.method === "POST" && (url.pathname === "/api/restart" || url.pathname === "/api/shutdown")) {
      const restarting = url.pathname === "/api/restart";
      const action = restarting ? "再起動" : "終了";
      requireLocalSettingsRequest(request);
      requireDesktopControlRequest(request);
      const payload = await readJson(request) as { confirmed?: unknown };
      if (payload?.confirmed !== true) return writeJson(response, 400, { ok: false, error: `${action}には確認が必要です` });
      if (control.state === "ON_AIR") return writeJson(response, 409, { ok: false, error: `設定ロック中は${action}できません` });
      if (control.state === "FAULT") return writeJson(response, 409, { ok: false, error: "先に障害を確認してください" });
      if (recorder.snapshot().state !== "IDLE") return writeJson(response, 409, { ok: false, error: `録音処理中は${action}できません` });
      if (restarting && process.env.DBR_LAUNCHER_MANAGED !== "1") return writeJson(response, 409, { ok: false, error: "Node 22ランチャーから起動されていません" });
      executeControlCommand({ type: "EMERGENCY_MUTE", active: true });
      control.recordExternalEvent("WARNING", `ParaBus ${restarting ? "restart" : "shutdown"} requested from local SETUP`);
      writeJson(response, 202, { ok: true, message: `ParaBus本体を${action}します` });
      setTimeout(() => shutdown(restarting ? RESTART_EXIT_CODE : 0), 50).unref();
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/command") {
      requireDesktopControlRequest(request);
      const result = executeExternalControlCommand((await readJson(request)) as ControlCommand);
      writeJson(response, result.ok ? 200 : 409, result);
      broadcastState();
      return;
    }
    if (request.method === "GET" && url.pathname === "/manual") {
      serveManual(response);
      return;
    }
    if (request.method === "GET" && documentationFiles.has(url.pathname.slice(1))) {
      serveDocumentation(url.pathname.slice(1), response);
      return;
    }
    if (request.method === "GET" && documentationRoutes.has(url.pathname)) {
      serveDocumentation(documentationRoutes.get(url.pathname)!, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "public, max-age=86400" });
      response.end();
      return;
    }
    if (request.method === "GET") {
      serveStatic(url.pathname, response, request);
      return;
    }
    response.writeHead(405, { allow: "GET, POST" });
    response.end();
  } catch (error) {
    const status = error instanceof DesktopControlAuthError ? 403 : error instanceof RustManagementUnavailableError ? 409 : 400;
    const summary = error instanceof RustManagementUnavailableError ? safeOperatorSummary("audio-output") : safeOperatorSummary("control");
    writeJson(response, status, { ok: false, error: summary });
  }
}

// Handle missing Host and Expect requests here too, keeping the Host check and response headers consistent.
const server = createServer({ requireHostHeader: false }, handleHttpRequest);
server.on("checkContinue", handleHttpRequest);
server.on("checkExpectation", handleHttpRequest);

server.on("clientError", (_error, socket) => {
  if (socket.writable) rejectHttpSocket(socket, 400);
});

server.on("upgrade", (request, socket) => {
  if (!isDesktopHostAllowed(request.headers, allowedHosts)) {
    rejectHttpSocket(socket, 403);
    return;
  }
  let url: URL;
  try {
    url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  } catch {
    rejectHttpSocket(socket, 400);
    return;
  }
  if (url.pathname !== "/ws" || !request.headers["sec-websocket-key"]) {
    socket.destroy();
    return;
  }
  try {
    requireDesktopControlRequest(request, url.searchParams.get("nonce"));
  } catch {
    rejectHttpSocket(socket, 403);
    return;
  }
  const accept = createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` + frameProtectionHeaderLines + "\r\n",
  );
  websocketClients.add(socket);
  websocketBuffers.set(socket, Buffer.alloc(0));
  socket.on("close", () => websocketClients.delete(socket));
  socket.on("error", () => websocketClients.delete(socket));
  socket.on("data", (data) => handleWebSocketData(socket, data));
  broadcastWebSocket([socket], () => ({ type: "state", payload: desktopSnapshot() }));
});

function rejectHttpSocket(socket: Duplex, status: 400 | 403): void {
  const reason = status === 403 ? "Forbidden" : "Bad Request";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n${frameProtectionHeaderLines}\r\n`);
}

function handleWebSocketData(socket: Duplex, data: Buffer): void {
  try {
    let frame = Buffer.concat([websocketBuffers.get(socket) ?? Buffer.alloc(0), data]);
    while (frame.length >= 2) {
      let length = frame[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (frame.length < 4) break;
        length = frame.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (frame.length < 10) break;
        const bigLength = frame.readBigUInt64BE(offset);
        if (bigLength > 64n * 1024n) throw new Error("frame too large");
        length = Number(bigLength);
        offset += 8;
      }
      const masked = (frame[1] & 0x80) !== 0;
      if (!masked) throw new Error("client frames must be masked");
      const frameLength = offset + 4 + length;
      if (frame.length < frameLength) break;
      handleWebSocketFrame(socket, frame.subarray(0, frameLength), offset, length);
      frame = frame.subarray(frameLength);
    }
    websocketBuffers.set(socket, Buffer.from(frame));
  } catch {
    websocketBuffers.set(socket, Buffer.alloc(0));
    broadcastWebSocket([socket], () => ({ type: "error", payload: safeOperatorSummary("control") }));
  }
}

function handleWebSocketFrame(socket: Duplex, frame: Buffer, offset: number, length: number): void {
  try {
    const opcode = frame[0] & 0x0f;
    if (opcode === 0x8) {
      socket.end();
      return;
    }
    if (opcode === 0x9) {
      if (socket.writableLength + 2 <= MAX_WEBSOCKET_PENDING_BYTES) socket.write(Buffer.from([0x8a, 0x00]));
      return;
    }
    if (opcode !== 0x1) return;
    const mask = frame.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) payload[index] = frame[offset + index] ^ mask[index % 4];
    const message = JSON.parse(payload.toString("utf8"));
    if (message.type === "command") {
      const result = executeExternalControlCommand(message.payload as ControlCommand);
      broadcastWebSocket([socket], () => ({ type: "command-result", payload: result }));
      broadcastState();
    }
  } catch {
    broadcastWebSocket([socket], () => ({ type: "error", payload: safeOperatorSummary("control") }));
  }
}

function broadcastState(includeHistory = false): void {
  broadcastWebSocket(websocketClients, () => ({ type: "state", payload: desktopSnapshot(includeHistory) }));
}

const blockIntervalMs = (engine.blockSize / engine.sampleRate) * 1000;
const MAX_AUDIO_CATCH_UP_BLOCKS = 12;
let nextAudioBlockAt = performance.now() + blockIntervalMs;

function processAudioBlock(): void {
  engine.processBlock();
  audioRuntimeTiming.recordBlock(engine.lastBlockDurationMs);
  programAudioShadow.capture(engine.outputs);
  recorder.captureBlock();
  discordIngest.writeTxBlock();
  outputManager.writeBlock(engine.outputs);
  if (cueOutputManager.physicalReady()) {
    try {
      const source = engine.monitorSourceBlock();
      cueOutputManager.writeBlock(source ? [source, source] : [cueSilence, cueSilence]);
    } catch {
      cueOutputManager.failClosed("Cue output writer failed");
      control.recordExternalEvent("WARNING", "Cue output disconnected; Main output remains active");
    }
  }
}

const cueSilence = new Float32Array(engine.blockSize);

asioDuplex.onOutputReady = processAudioBlock;

function scheduleAudioBlock(): void {
  const now = performance.now();
  let processed = 0;
  // ASIO owns the sample clock; a wall-clock producer eventually runs ahead or behind real hardware.
  if (asioDuplex.outputClockActive()) {
    nextAudioBlockAt = now + blockIntervalMs;
  } else {
    const latenessMs = now - nextAudioBlockAt;
    while (now >= nextAudioBlockAt && processed < MAX_AUDIO_CATCH_UP_BLOCKS) {
      processAudioBlock();
      nextAudioBlockAt += blockIntervalMs;
      processed += 1;
    }
    // A long event-loop stall must not create an unbounded burst. The input and
    // RX rings keep only recent audio, so resynchronizing here preserves the
    // low-latency policy instead of replaying stale blocks.
    if (processed === MAX_AUDIO_CATCH_UP_BLOCKS && now >= nextAudioBlockAt) {
      nextAudioBlockAt = now + blockIntervalMs;
    }
    audioSchedulerTiming.record(latenessMs, processed, now);
  }
  const delayMs = Math.max(0, nextAudioBlockAt - performance.now());
  setTimeout(scheduleAudioBlock, delayMs).unref();
}

scheduleAudioBlock();

setInterval(() => broadcastWebSocket(websocketClients, () => ({ type: "meters", payload: control.meterSnapshot() })), 50).unref();
// Full diagnostic histories and configuration are delivered at most once/sec
// periodically, and remain available on demand via GET /api/state and Support.
setInterval(() => broadcastState(true), 1_000).unref();
setInterval(() => void rustManagement.refreshSnapshot(), 1_000).unref();
setInterval(() => {
  const snapshot = { ...control.snapshot(false), discord: discordIngest.snapshot(Date.now(), false) };
  for (const event of operationalHealth.observe(snapshot)) control.recordExternalEvent(event.level, event.message);
}, 1_000).unref();

let summaryRxUnderruns = 0, summaryRxOverflows = 0, summaryCatchupCalls = 0;
setInterval(() => {
  const rx = discordIngest.rxTimingTotals();
  const scheduler = audioSchedulerTiming.snapshot();
  control.recordExternalEvent("INFO", audioTimingSummary(outputManager.snapshot().writeTiming, cueOutputManager.snapshot().writeTiming, scheduler,
    rx.underruns - summaryRxUnderruns, rx.overflows - summaryRxOverflows, scheduler.catchupCalls - summaryCatchupCalls, audioRuntimeTiming.finishWindow()));
  summaryRxUnderruns = rx.underruns; summaryRxOverflows = rx.overflows; summaryCatchupCalls = scheduler.catchupCalls;
  const inputSummary = inputTimingSummary(inputManager.snapshot());
  if (inputSummary) control.recordExternalEvent("INFO", inputSummary);
}, 60_000).unref();

programAudioShadow.start();
await Promise.all([discordIngest.start(), rustManagement.start()]);
if (rustManagement.isAvailable()) {
  try {
    await rustManagement.refreshEndpoints();
  } catch {
    // Physical PortAudio selection remains unavailable and fail closed until inventory recovers.
  }
}
server.listen(port, host, () => {
  console.log(`ParaBus Phase 10 listening on http://${host}:${port}`);
  console.log(`Core ownership: ${coreOwnership.snapshot.effectiveOwner} (${coreOwnership.snapshot.requestedMode})`);
  console.log(`${engine.channels.size} synthetic RX channels, ${engine.outputs.length} outputs, ${engine.sampleRate} Hz`);
  console.log(`Discord Opus IPC listening on ${discordIngest.endpoint}`);
  if (desktopAccess.lanEnabled) {
    const warning = "LAN公開中（認証なし）: 同じLANの誰でも操作できます。共有LANでは使わないでください。";
    console.log(warning); control.recordExternalEvent("WARNING", warning);
    for (const url of desktopAccess.urls) { console.log(`LAN公開中: ${url}`); control.recordExternalEvent("INFO", `LAN公開中: ${url}`); }
  }
});

let shuttingDown = false;
function shutdown(exitCode = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(desktopAuthLogTimer);
  desktopAuthFailures.flush(true);
  control.endParticipantSession();
  userProfileStore.flush();
  for (const socket of websocketClients) socket.destroy();
  outputManager.stop();
  cueOutputManager.stop();
  audioRuntimeTiming.close();
  inputManager.stop();
  programAudioShadow.close();
  const cleanup = Promise.all([
    rustManagement.close(),
    discordIngest.close(),
    recorder.close(),
  ]);
  server.close(() => void cleanup.finally(async () => {
    await operationalLog.close();
    process.exit(exitCode);
  }));
  server.closeAllConnections();
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
process.on("SIGHUP", () => shutdown());
watchLauncher(() => shutdown());

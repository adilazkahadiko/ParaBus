import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import type { Duplex } from "node:stream";
import type { CommandResult, ControlCommand, RouterSnapshot } from "../../../packages/shared-types/src/index.ts";
import { safeOperatorError, safeOperatorSummary, sanitizeOperatorMessage } from "./operator-sanitize.ts";
import { broadcastWebSocket, MAX_WEBSOCKET_PENDING_BYTES } from "./snapshot-delivery.ts";

export type TabletSnapshotSource = Pick<RouterSnapshot, "revision" | "state" | "emergencyMuted" | "monitorSourceId" | "sampleRate" | "uptimeSeconds" | "callbackLoad" | "xruns" | "topologyMutationFaults" | "recorder" | "alerts"> & {
  channels: Pick<RouterSnapshot["channels"][number], "id" | "label" | "kind" | "faderDb" | "mute" | "meter" | "vcSends">[];
  buses: Pick<RouterSnapshot["buses"][number], "id" | "label" | "masterDb" | "mute" | "limiterEnabled" | "limiterGainReductionDb" | "meter" | "inputMeter" | "participantCount">[];
  scenes: Pick<RouterSnapshot["scenes"][number], "id" | "name" | "createdAt">[];
  discord?: Pick<NonNullable<RouterSnapshot["discord"]>, "adapterState" | "connectedAdapters" | "configuredBots" | "readyBots" | "staleBots" | "reconnectingBots" | "txStems"> & {
    bots: Pick<NonNullable<RouterSnapshot["discord"]>["bots"][number], "label" | "role" | "voiceChannelName" | "health" | "wsPingMs" | "udpPingMs" | "reconnectCount" | "lastAudioAgoMs" | "message">[];
  };
};

const SESSION_COOKIE = "dbr_tablet_session";
const MAX_REQUEST_BYTES = 16 * 1024;
const OPERATOR_COMMANDS = new Set<ControlCommand["type"]>([
  "SET_CHANNEL_FADER",
  "SET_CHANNEL_MUTE",
  "SET_VC_SEND",
  "SET_BUS_MASTER",
  "SET_BUS_MUTE",
  "SET_PFL",
  "RESET_LOUDNESS",
  "EMERGENCY_MUTE",
  "PREVIEW_SCENE",
  "RECALL_SCENE",
]);

interface TabletControlServerOptions {
  enabled: boolean;
  port: number;
  host?: string;
  publicDirectory?: string;
  pairingCode?: string;
  snapshot: () => TabletSnapshotSource;
  execute: (command: ControlCommand) => CommandResult;
  onStateChanged?: () => void;
}

interface PairAttempt {
  failures: number;
  resetAt: number;
}

export interface TabletAdminSnapshot {
  enabled: boolean;
  running: boolean;
  role: "OPERATOR";
  port: number;
  pairingCode: string | null;
  urls: string[];
  connectedClients: number;
  error: string | null;
}

function writeJson(response: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BYTES) throw new Error("リクエストが大きすぎます");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(request: IncomingMessage, name: string): string | null {
  for (const item of (request.headers.cookie ?? "").split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(item.slice(separator + 1).trim());
  }
  return null;
}

function requireSameOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin;
  const expected = `http://${request.headers.host}`;
  if (!origin || origin !== expected) throw new Error("Tablet画面と同じ接続元から操作してください");
}

function allowedOperatorCommand(command: unknown): command is ControlCommand {
  if (!command || typeof command !== "object" || typeof (command as { type?: unknown }).type !== "string") return false;
  const candidate = command as ControlCommand;
  if (!OPERATOR_COMMANDS.has(candidate.type)) return false;
  if (candidate.type === "EMERGENCY_MUTE" && candidate.active !== true) return false;
  if (candidate.type === "RECALL_SCENE" && candidate.confirmed !== true) return false;
  return true;
}

export class TabletProjection {
  readonly #channelIds = new Map<string, string>();
  readonly #busIds = new Map<string, string>();
  readonly #sceneIds = new Map<string, string>();
  #nextChannelId = 1;
  #nextBusId = 1;
  #nextSceneId = 1;

  snapshot(snapshot: TabletSnapshotSource): Record<string, unknown> {
    for (const channel of snapshot.channels) this.opaque(this.#channelIds, channel.id, "tablet-channel", "#nextChannelId");
    for (const bus of snapshot.buses) this.opaque(this.#busIds, bus.id, "tablet-bus", "#nextBusId");
    for (const scene of snapshot.scenes) this.opaque(this.#sceneIds, scene.id, "tablet-scene", "#nextSceneId");
    return projectTabletSnapshot(snapshot, this);
  }

  channelId(internalId: string): string {
    return this.#channelIds.get(internalId) ?? "";
  }

  busId(internalId: string): string {
    return this.#busIds.get(internalId) ?? "";
  }

  sceneId(internalId: string): string {
    return this.#sceneIds.get(internalId) ?? "";
  }

  sourceId(internalId: string | null): string | null {
    if (internalId === null) return null;
    return this.#channelIds.get(internalId) ?? this.#busIds.get(internalId) ?? null;
  }

  resolve(command: ControlCommand): ControlCommand | null {
    switch (command.type) {
      case "SET_CHANNEL_FADER":
      case "SET_CHANNEL_MUTE": {
        const channelId = this.internal(this.#channelIds, command.channelId);
        return channelId ? { ...command, channelId } : null;
      }
      case "SET_VC_SEND": {
        const channelId = this.internal(this.#channelIds, command.channelId);
        const busId = this.internal(this.#busIds, command.busId);
        return channelId && busId ? { ...command, channelId, busId } : null;
      }
      case "SET_BUS_MASTER":
      case "SET_BUS_MUTE":
      case "RESET_LOUDNESS": {
        const busId = this.internal(this.#busIds, command.busId);
        return busId ? { ...command, busId } : null;
      }
      case "SET_PFL": {
        if (command.sourceId === null) return command;
        const sourceId = this.internal(this.#channelIds, command.sourceId) ?? this.internal(this.#busIds, command.sourceId);
        return sourceId ? { ...command, sourceId } : null;
      }
      case "PREVIEW_SCENE":
      case "RECALL_SCENE": {
        const sceneId = this.internal(this.#sceneIds, command.sceneId);
        return sceneId ? { ...command, sceneId } : null;
      }
      case "EMERGENCY_MUTE":
        return command;
      default:
        return null;
    }
  }

  private opaque(map: Map<string, string>, internalId: string, prefix: string, counter: "#nextChannelId" | "#nextBusId" | "#nextSceneId"): string {
    const existing = map.get(internalId);
    if (existing) return existing;
    const next = counter === "#nextChannelId" ? this.#nextChannelId++ : counter === "#nextBusId" ? this.#nextBusId++ : this.#nextSceneId++;
    const opaqueId = `${prefix}-${next}`;
    map.set(internalId, opaqueId);
    return opaqueId;
  }

  private internal(map: Map<string, string>, opaqueId: string): string | null {
    for (const [internalId, candidate] of map) if (candidate === opaqueId) return internalId;
    return null;
  }
}

const defaultTabletProjection = new TabletProjection();

export function tabletSnapshot(snapshot: RouterSnapshot): Record<string, unknown> {
  return defaultTabletProjection.snapshot(snapshot);
}

function projectTabletSnapshot(snapshot: TabletSnapshotSource, projection: TabletProjection): Record<string, unknown> {
  const discord = snapshot.discord;
  const recorder = snapshot.recorder;
  return {
    revision: snapshot.revision,
    state: snapshot.state,
    emergencyMuted: snapshot.emergencyMuted,
    monitorSourceId: projection.sourceId(snapshot.monitorSourceId),
    sampleRate: snapshot.sampleRate,
    uptimeSeconds: snapshot.uptimeSeconds,
    callbackLoad: snapshot.callbackLoad,
    xruns: snapshot.xruns,
    topologyMutationFaults: snapshot.topologyMutationFaults,
    channels: snapshot.channels.map((channel) => ({
      id: projection.channelId(channel.id),
      label: sanitizeOperatorMessage(channel.label, "Participant"),
      kind: channel.kind,
      faderDb: channel.faderDb,
      mute: channel.mute,
      meter: channel.meter,
      vcSends: Object.fromEntries(Object.entries(channel.vcSends).flatMap(([busId, send]) => {
        const opaqueBusId = projection.busId(busId);
        return opaqueBusId ? [[opaqueBusId, send]] : [];
      })),
    })),
    buses: snapshot.buses.map((bus) => ({
      id: projection.busId(bus.id),
      label: sanitizeOperatorMessage(bus.label, "BUS"),
      masterDb: bus.masterDb,
      mute: bus.mute,
      limiterEnabled: bus.limiterEnabled,
      limiterGainReductionDb: bus.limiterGainReductionDb,
      meter: bus.meter,
      inputMeter: bus.inputMeter,
      participantCount: bus.participantCount,
    })),
    recorder: recorder ? {
      state: recorder.state,
      format: recorder.format,
      sampleRate: recorder.sampleRate,
      startedAt: recorder.startedAt,
      durationSeconds: recorder.durationSeconds,
      queuedBlocks: recorder.queuedBlocks,
      maxQueuedBlocks: recorder.maxQueuedBlocks,
      droppedBlocks: recorder.droppedBlocks,
      freeBytes: recorder.freeBytes,
      totalBytes: recorder.totalBytes,
      message: recorder.message ? safeOperatorSummary("recorder") : null,
      errorCode: recorder.message ? safeOperatorError("recorder").code : null,
      tracks: recorder.tracks.map((track) => ({ kind: track.kind, label: sanitizeOperatorMessage(track.label, "Track"), dataBytes: track.dataBytes })),
    } : null,
    discord: discord ? {
      adapterState: discord.adapterState,
      connectedAdapters: discord.connectedAdapters,
      configuredBots: discord.configuredBots,
      readyBots: discord.readyBots,
      staleBots: discord.staleBots,
      reconnectingBots: discord.reconnectingBots,
      txStems: discord.txStems.map((stem) => ({
        state: stem.state,
        active: stem.active,
        label: sanitizeOperatorMessage(stem.label ?? "TX Return", "TX Return"),
        voiceChannelName: sanitizeOperatorMessage(stem.voiceChannelName ?? "VC", "VC"),
        subtype: stem.subtype,
        framesSent: stem.framesSent,
        droppedFrames: stem.droppedFrames,
        peak: stem.peak,
        lastFrameAgoMs: stem.lastFrameAgoMs,
      })),
      bots: discord.bots.map((bot) => ({
        label: sanitizeOperatorMessage(bot.label, "Discord Bot"),
        role: bot.role,
        voiceChannelName: sanitizeOperatorMessage(bot.voiceChannelName ?? "VC", "VC"),
        health: bot.health,
        wsPingMs: bot.wsPingMs,
        udpPingMs: bot.udpPingMs,
        reconnectCount: bot.reconnectCount,
        lastAudioAgoMs: bot.lastAudioAgoMs,
        message: bot.message ? safeOperatorSummary("discord") : null,
        errorCode: bot.message ? safeOperatorError("discord").code : null,
      })),
    } : null,
    scenes: snapshot.scenes.map((scene) => ({ id: projection.sceneId(scene.id), name: sanitizeOperatorMessage(scene.name, "Scene"), createdAt: scene.createdAt })),
    alertSummary: {
      warning: snapshot.alerts.filter((alert) => alert.level === "WARNING").length,
      critical: snapshot.alerts.filter((alert) => alert.level === "CRITICAL").length,
    },
  };
}

function tabletCommandResult(result: CommandResult): Record<string, unknown> {
  return {
    ok: result.ok,
    revision: result.revision,
    ...(result.error ? { error: sanitizeOperatorMessage(result.error) } : {}),
    ...(result.code ? { code: result.code } : {}),
    ...(result.confirmationRequired ? { confirmationRequired: true } : {}),
  };
}

export class TabletControlServer {
  readonly options: TabletControlServerOptions;
  readonly pairingCode: string;
  readonly sessions = new Map<string, number>();
  readonly attempts = new Map<string, PairAttempt>();
  readonly websocketClients = new Set<Duplex>();
  readonly websocketBuffers = new WeakMap<Duplex, Buffer>();
  readonly projection = new TabletProjection();
  server: Server | null = null;
  running = false;
  actualPort: number;
  error: string | null = null;

  constructor(options: TabletControlServerOptions) {
    this.options = options;
    this.pairingCode = options.pairingCode ?? String(randomInt(0, 100_000_000)).padStart(8, "0");
    this.actualPort = options.port;
  }

  async start(): Promise<void> {
    if (!this.options.enabled || this.running) return;
    this.server = createServer((request, response) => void this.handleRequest(request, response));
    this.server.on("upgrade", (request, socket) => this.handleUpgrade(request, socket));
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.options.port, this.options.host ?? "0.0.0.0", () => resolve());
      });
      const address = this.server.address();
      if (address && typeof address === "object") this.actualPort = address.port;
      this.running = true;
      this.error = null;
    } catch (error) {
      this.error = safeOperatorSummary("tablet");
      this.server = null;
      throw error;
    }
  }

  async close(): Promise<void> {
    for (const socket of this.websocketClients) socket.end();
    this.websocketClients.clear();
    this.sessions.clear();
    const server = this.server;
    this.server = null;
    this.running = false;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  adminSnapshot(): TabletAdminSnapshot {
    const addresses = new Set<string>();
    if (this.running) {
      for (const entries of Object.values(networkInterfaces())) {
        for (const entry of entries ?? []) {
          if (entry.family === "IPv4" && !entry.internal) addresses.add(`http://${entry.address}:${this.actualPort}`);
        }
      }
    }
    return {
      enabled: this.options.enabled,
      running: this.running,
      role: "OPERATOR",
      port: this.actualPort,
      pairingCode: this.running ? this.pairingCode : null,
      urls: [...addresses],
      connectedClients: this.websocketClients.size,
      error: this.error,
    };
  }

  broadcast(kind: "state" | "meters" = "state"): void {
    if (!this.running) return;
    broadcastWebSocket(this.websocketClients, () => ({ type: kind, payload: this.projection.snapshot(this.options.snapshot()) }));
  }

  private authenticated(request: IncomingMessage): boolean {
    const session = cookieValue(request, SESSION_COOKIE);
    if (session === null) return false;
    const expiresAt = this.sessions.get(session);
    if (!expiresAt || expiresAt <= Date.now()) {
      this.sessions.delete(session);
      return false;
    }
    return true;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "POST" && url.pathname === "/api/pair") {
        requireSameOrigin(request);
        await this.pair(request, response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        if (!this.authenticated(request)) return writeJson(response, 401, { ok: false, error: "ペアリングが必要です" });
        writeJson(response, 200, this.projection.snapshot(this.options.snapshot()));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/command") {
        requireSameOrigin(request);
        if (!this.authenticated(request)) return writeJson(response, 401, { ok: false, error: "ペアリングが必要です" });
        const command = await readJson(request);
        if (!allowedOperatorCommand(command)) return writeJson(response, 403, { ok: false, error: "Tabletでは許可されていない操作です" });
        const resolved = this.projection.resolve(command);
        if (!resolved) return writeJson(response, 409, { ok: false, error: "操作対象が更新されました。画面を再読み込みしてください" });
        const result = this.options.execute(resolved);
        this.options.onStateChanged?.();
        this.broadcast("state");
        writeJson(response, result.ok ? 200 : 409, tabletCommandResult(result));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/logout") {
        requireSameOrigin(request);
        const session = cookieValue(request, SESSION_COOKIE);
        if (session) this.sessions.delete(session);
        writeJson(response, 200, { ok: true }, { "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
        return;
      }
      if (request.method === "GET") {
        this.serveStatic(url.pathname, response);
        return;
      }
      response.writeHead(405, { allow: "GET, POST" });
      response.end();
    } catch (error) {
      writeJson(response, 400, { ok: false, error: safeOperatorSummary("tablet") });
    }
  }

  private async pair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const key = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const current = this.attempts.get(key);
    if (current && current.resetAt > now && current.failures >= 5) {
      writeJson(response, 429, { ok: false, error: "入力回数が多すぎます。5分後に再試行してください" });
      return;
    }
    const body = await readJson(request) as { code?: unknown };
    const code = typeof body.code === "string" ? body.code.replace(/\D/g, "") : "";
    if (!sameText(code, this.pairingCode)) {
      const failures = current && current.resetAt > now ? current.failures + 1 : 1;
      this.attempts.set(key, { failures, resetAt: now + 5 * 60_000 });
      writeJson(response, 401, { ok: false, error: "ペアリングコードが違います" });
      return;
    }
    this.attempts.delete(key);
    const session = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 12 * 60 * 60_000;
    for (const [token, expiry] of this.sessions) if (expiry <= Date.now()) this.sessions.delete(token);
    while (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value!);
    this.sessions.set(session, expiresAt);
    writeJson(response, 200, { ok: true, role: "OPERATOR" }, {
      "set-cookie": `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
    });
  }

  private serveStatic(pathname: string, response: ServerResponse): void {
    const requested = pathname === "/" ? "index.html" : pathname.slice(1);
    const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
    const file = join(this.options.publicDirectory ?? join(import.meta.dirname, "../tablet-public"), safe);
    try {
      const stat = statSync(file);
      if (!stat.isFile()) throw new Error("not a file");
      const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
      response.writeHead(200, {
        "content-type": types[extname(file)] ?? "application/octet-stream",
        "content-length": stat.size,
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self' ws:",
        "referrer-policy": "no-referrer",
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex): void {
    const expectedOrigin = `http://${request.headers.host}`;
    let authorized: boolean;
    try {
      new URL(request.url ?? "/", expectedOrigin);
      authorized = request.url === "/ws" && request.headers.origin === expectedOrigin && Boolean(request.headers["sec-websocket-key"]) && this.authenticated(request);
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (!authorized) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.end();
      return;
    }
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    this.websocketClients.add(socket);
    this.websocketBuffers.set(socket, Buffer.alloc(0));
    socket.on("close", () => this.websocketClients.delete(socket));
    socket.on("error", () => this.websocketClients.delete(socket));
    socket.on("data", (data) => this.handleWebSocketData(socket, data));
    broadcastWebSocket([socket], () => ({ type: "state", payload: this.projection.snapshot(this.options.snapshot()) }));
  }

  private handleWebSocketData(socket: Duplex, data: Buffer): void {
    try {
      let input = Buffer.concat([this.websocketBuffers.get(socket) ?? Buffer.alloc(0), data]);
      while (input.length >= 2) {
        let length = input[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (input.length < 4) break;
          length = input.readUInt16BE(offset);
          offset += 2;
        } else if (length === 127) {
          if (input.length < 10) break;
          const big = input.readBigUInt64BE(offset);
          if (big > BigInt(MAX_REQUEST_BYTES)) throw new Error("frame too large");
          length = Number(big);
          offset += 8;
        }
        if ((input[1] & 0x80) === 0) throw new Error("client frames must be masked");
        const frameLength = offset + 4 + length;
        if (input.length < frameLength) break;
        this.handleWebSocketFrame(socket, input.subarray(0, frameLength), offset, length);
        input = input.subarray(frameLength);
      }
      this.websocketBuffers.set(socket, Buffer.from(input));
    } catch {
      broadcastWebSocket([socket], () => ({ type: "error", payload: safeOperatorSummary("tablet") }));
    }
  }

  private handleWebSocketFrame(socket: Duplex, frame: Buffer, offset: number, length: number): void {
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
    const body = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) body[index] = frame[offset + index] ^ mask[index % 4];
    try {
      const message = JSON.parse(body.toString("utf8")) as { type?: unknown; payload?: unknown };
      if (message.type !== "command" || !allowedOperatorCommand(message.payload)) {
        broadcastWebSocket([socket], () => ({ type: "command-result", payload: { ok: false, error: "Tabletでは許可されていない操作です" } }));
        return;
      }
      const resolved = this.projection.resolve(message.payload);
      if (!resolved) {
        broadcastWebSocket([socket], () => ({ type: "command-result", payload: { ok: false, error: "操作対象が更新されました。画面を再読み込みしてください" } }));
        return;
      }
      const result = this.options.execute(resolved);
      this.options.onStateChanged?.();
      broadcastWebSocket([socket], () => ({ type: "command-result", payload: tabletCommandResult(result) }));
      this.broadcast("state");
    } catch {
      broadcastWebSocket([socket], () => ({ type: "error", payload: safeOperatorSummary("tablet") }));
    }
  }
}

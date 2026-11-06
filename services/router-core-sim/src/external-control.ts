import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import type { CommandResult, ControlCommand, DiscordIngestSnapshot } from "../../../packages/shared-types/src/index.ts";
import type { ControlPlane } from "./control-plane.ts";
import { ExternalDeviceStore, type ExternalDevice } from "./external-device-store.ts";
import { ExternalState } from "./external-state.ts";
import { Bucket, COMMAND_POLICIES, ExternalError, LIMITS, OPERATIONS, TIER_B_OPERATIONS, boolean, canonical, dependencyKey as dep, classifyCommand, fail, fields, finite, object, revision, strictJson, textId, uuid, type RecordValue } from "./external-protocol.ts";
import { encodeWebSocketFrame } from "./snapshot-delivery.ts";
import { acceptWebSocket, closeWebSocket, controlFrame, websocketReceiver } from "./websocket.ts";

type Reply = { status: number; body: unknown; retryAfterSeconds?: number };
type Cached = { at: number; payload: string; reply: Reply; operation: string; tier: string };
type Arm = { id: string; at: number; operation: string; args: RecordValue; keys: string[]; dependencies: string };
type PreparedB = { command: ControlCommand; keys: string[]; summary: unknown; increaseDb?: number; data: () => unknown; noop?: boolean };
interface DeviceRuntime {
  normal: Bucket; safety: Bucket; reads: Bucket; db: Map<string, Bucket>;
  cache: Map<string, Cached>; lastHttp: number; limited: number; lastLog: number;
  generation: number;
  arm?: Arm;
  deniedArms: Map<string, { operation: string; at: number }>;
}
interface Peer { socket: Duplex; device: ExternalDevice; revision: number; pongAt: number; pingAt: number; closing: boolean }
export interface ExternalOptions {
  control: ControlPlane; ingest: () => DiscordIngestSnapshot; store: ExternalDeviceStore;
  execute: (command: ControlCommand) => CommandResult; version: string; now?: () => number;
  txIdentities?: () => readonly object[];
  configuredTx?: readonly { profileId: string; destination: string | null }[];
  log: (message: string) => void;
}

export class ExternalControlServer {
  readonly store: ExternalDeviceStore;
  readonly state: ExternalState;
  readonly server = createServer({ requireHostHeader: false }, (request, response) => { void this.http(request, response); });
  readonly port: number;
  readonly options: ExternalOptions;
  readonly now: () => number;
  available = false;
  #devices = new Map<string, DeviceRuntime>();
  #peers = new Set<Peer>();
  #normal: Bucket; #safety: Bucket; #unauthorized: Bucket;
  #authLogged = false; #authSuppressed = 0; #authAt = 0;
  #stopGeneration = 0;
  #observing = true;
  #logTier = "A";
  #timer?: ReturnType<typeof setInterval>;
  constructor(options: ExternalOptions) {
    this.options = options; this.store = options.store; this.port = this.store.port;
    this.now = options.now ?? (() => performance.now());
    this.state = new ExternalState(options.control, options.ingest, options.txIdentities, options.configuredTx);
    this.#normal = new Bucket(100, 100, this.now()); this.#safety = new Bucket(20, 20, this.now()); this.#unauthorized = new Bucket(10, 20, this.now());
    this.server.requestTimeout = 5000; this.server.headersTimeout = 5000; this.server.maxHeadersCount = 64;
    this.server.on("checkContinue", (req, res) => { void this.http(req, res); });
    this.server.on("checkExpectation", (req, res) => { void this.http(req, res); });
    this.server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
    this.server.on("clientError", (_error, socket) => { if (socket.writable) this.socketReply(socket, this.errorReply(new ExternalError("INVALID"))); });
    this.server.on("error", () => { this.available = false; this.options.log("External control listener unavailable"); });
  }
  async start() {
    await new Promise<void>(resolve => {
      this.server.once("error", () => resolve());
      this.server.listen(this.port, "127.0.0.1", () => { this.available = true; resolve(); });
    });
    this.#timer = setInterval(() => this.tick(), 100); this.#timer.unref();
    if (!this.store.available) this.options.log("External control registration unavailable");
  }
  async close() {
    this.#stopGeneration++;
    for (const runtime of this.#devices.values()) runtime.arm = undefined;
    if (this.#timer) clearInterval(this.#timer);
    this.flushLogs(true);
    for (const peer of this.#peers) peer.socket.destroy(); this.#peers.clear();
    await new Promise<void>(resolve => this.server.close(() => resolve())); this.server.closeAllConnections();
  }
  managementSnapshot() {
    const now = this.now(), active = this.store.list().filter(d => !d.revoked && ([...this.#peers].some(p => !p.closing && p.device.deviceId === d.deviceId)
      || now - (this.#devices.get(d.deviceId)?.lastHttp ?? -Infinity) < 30000));
    return { ...this.store.summary(), stopSaveFailed: this.store.stopSaveFailed, state: this.options.control.state, available: this.available && this.store.available, port: this.store.port, activePort: this.port,
      url: `http://127.0.0.1:${this.port}/external/v1`, activeDeviceCount: active.length, activeDeviceNames: active.map(d => d.name), devices: this.store.list() };
  }
  /** Called only by nonce/Origin/local-protected desktop management routes. Synchronous with action commits. */
  manage(value: unknown): unknown {
    const input = object(value), action = input.action;
    if (action === "status") { fields(input, ["action"]); return this.managementSnapshot(); }
    if (action === "stop") {
      fields(input, ["action"]); this.#stopGeneration++;
      this.#observing = false;
      for (const runtime of this.#devices.values()) { runtime.arm = undefined; runtime.deniedArms.clear(); }
      try { this.store.setEnabled(false); }
      finally { for (const peer of this.#peers) {
        this.send(peer, { type: "error", payload: new ExternalError("DISABLED").body() }); this.closePeer(peer, 4003);
      } }
      this.options.log("External control disabled"); return {};
    }
    if (this.options.control.state !== "SETUP") fail("LOCKED");
    if (action === "enable") { fields(input, ["action"]); this.store.setEnabled(true); this.options.log("External control enabled"); return {}; }
    if (action === "port") { fields(input, ["action", "port"]); this.store.setPort(input.port); return {}; }
    if (action === "register") { fields(input, ["action", "name"], ["readDisplayNames"]); return this.store.register(input.name, input.readDisplayNames ?? false); }
    if (action === "delete") {
      fields(input, ["action", "deviceId"]); const result = this.store.delete(input.deviceId);
      this.#devices.delete(input.deviceId as string); return result;
    }
    if (action === "revoke" || action === "reissue" || action === "permissions") {
      fields(input, ["action", "deviceId", ...(action === "permissions" ? ["readDisplayNames"] : [])], action === "permissions" ? ["allowedTierBOperations"] : []);
      const result = this.store.change(input.deviceId, action, input.readDisplayNames, input.allowedTierBOperations);
      const runtime = this.#devices.get(input.deviceId as string);
      if (runtime?.arm && action === "permissions") runtime.deniedArms.set(runtime.arm.id, { operation: runtime.arm.operation, at: runtime.arm.at });
      for (const peer of this.#peers) if (peer.device.deviceId === input.deviceId) this.closePeer(peer, 4001);
      if (runtime) { runtime.generation++; runtime.arm = undefined; }
      return result;
    }
    return fail("INVALID");
  }
  private boundary(request: IncomingMessage) {
    const headers = request.rawHeaders.filter((_v, index) => index % 2 === 0).map(h => h.toLowerCase());
    if (request.socket.remoteFamily !== "IPv4" || request.socket.remoteAddress !== "127.0.0.1"
      || headers.filter(h => h === "host").length !== 1 || request.headers.host !== `127.0.0.1:${this.port}`
      || headers.some(h => h === "forwarded" || h.startsWith("x-forwarded-"))) fail("HOST_FORBIDDEN");
    if (headers.includes("origin") || headers.includes("sec-fetch-site") || request.method === "OPTIONS") fail("ORIGIN_FORBIDDEN");
  }
  private authenticate(request: IncomingMessage): ExternalDevice {
    const count = request.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === "authorization").length;
    const auth = request.headers.authorization;
    const device = count === 1 && typeof auth === "string" && /^Bearer [A-Za-z0-9_-]{43}$/.test(auth) ? this.store.authenticate(auth.slice(7)) : undefined;
    if (!device) {
      this.authFailure();
      if (!this.#unauthorized.ready(this.now())) fail("RATE_LIMITED");
      this.#unauthorized.spend(); fail("UNAUTHORIZED");
    }
    if (!this.store.enabled) fail("DISABLED");
    return device;
  }
  private runtime(device: ExternalDevice) {
    let runtime = this.#devices.get(device.deviceId);
    if (!runtime) {
      const now = this.now(); runtime = { normal: new Bucket(20, 20, now), safety: new Bucket(5, 5, now), reads: new Bucket(10, 10, now),
        db: new Map(), cache: new Map(), deniedArms: new Map(), lastHttp: -Infinity, limited: 0, lastLog: now, generation: 0 }; this.#devices.set(device.deviceId, runtime);
    }
    return runtime;
  }
  private rate(runtime: DeviceRuntime, kind: "read" | "normal" | "safe") {
    const now = this.now();
    if (kind === "read") { if (runtime.reads.ready(now)) { runtime.reads.spend(); return; } }
    else if (runtime.normal.ready(now) && this.#normal.ready(now)) { runtime.normal.spend(); this.#normal.spend(); return; }
    else if (kind === "safe" && runtime.safety.ready(now) && this.#safety.ready(now)) { runtime.safety.spend(); this.#safety.spend(); return; }
    runtime.limited++; fail("RATE_LIMITED");
  }
  private async http(request: IncomingMessage, response: ServerResponse) {
    let reply: Reply;
    try {
      this.boundary(request); let device = this.authenticate(request);
      let runtime = this.runtime(device); runtime.lastHttp = this.now();
      if (request.method === "GET") {
        this.rate(runtime, "read"); this.observe();
        if (request.url === "/external/v1/info") reply = this.success(undefined, this.info(device));
        else if (request.url === "/external/v1/state") reply = this.success(undefined, this.state.project(device, this.store.enabled));
        else fail("INVALID");
      } else if (request.method === "POST" && ["/external/v1/actions", "/external/v1/arm", "/external/v1/execute"].includes(request.url ?? "")) {
        const generation = this.#stopGeneration, authorityGeneration = runtime.generation;
        let body: unknown;
        try { body = await this.readBody(request, response); }
        catch (error) { this.rate(runtime, "normal"); throw error; }
        // Body I/O yields. Recheck stop/revocation/permissions at the synchronous commit boundary.
        device = this.authenticate(request); runtime = this.runtime(device); runtime.lastHttp = this.now();
        if (generation !== this.#stopGeneration) fail("DISABLED");
        if (runtime.generation !== authorityGeneration) fail("TIER_FORBIDDEN");
        const safe = request.url === "/external/v1/actions" && body && typeof body === "object" && !Array.isArray(body) ? this.safeDirection(body as RecordValue) : false;
        this.rate(runtime, safe ? "safe" : "normal");
        reply = this.action(device, runtime, body, request.url!.split("/").at(-1) as "actions" | "arm" | "execute");
      } else { this.rate(runtime, "read"); fail("INVALID"); }
    } catch (error) { reply = this.errorReply(error); }
    this.writeReply(response, reply);
  }
  private safeDirection(body: RecordValue) {
    const args = body.args as RecordValue | undefined;
    return body.operation === "tx.stop" || body.operation === "tx.clear" || body.operation === "emergency.set" && args?.active === true
      || body.operation === "settings.lock.set" && args?.locked === true;
  }
  private async readBody(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "") || request.headers["content-encoding"] !== undefined) fail("INVALID", 415);
    const declared = request.headers["content-length"];
    if (declared && Number(declared) > LIMITS.maxBodyBytes) { request.resume(); fail("INVALID", 413); }
    if (request.headers.expect !== undefined) {
      if (request.headers.expect.toLowerCase() !== "100-continue") fail("INVALID");
      response.writeContinue();
    }
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []; let size = 0, exceeded = false;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > LIMITS.maxBodyBytes) { if (!exceeded) { exceeded = true; chunks.length = 0; reject(new ExternalError("INVALID", 413)); } }
        else if (!exceeded) chunks.push(chunk);
      });
      request.once("end", () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
      request.once("error", () => reject(new ExternalError("INVALID")));
      request.once("aborted", () => reject(new ExternalError("INVALID")));
    });
    try { return strictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return fail("INVALID"); }
  }
  private action(device: ExternalDevice, runtime: DeviceRuntime, value: unknown, path: "actions" | "arm" | "execute"): Reply {
    const body = object(value);
    const requestId = uuid(body.requestId), instanceId = uuid(body.instanceId);
    const operation = path === "execute" ? (runtime.arm && runtime.arm.id === body.armId ? runtime.arm.operation
      : typeof body.armId === "string" ? runtime.deniedArms.get(body.armId)?.operation ?? "UNKNOWN" : "UNKNOWN")
      : typeof body.operation === "string" ? body.operation : "UNKNOWN";
    const known = (OPERATIONS as readonly string[]).includes(operation) || TIER_B_OPERATIONS.includes(operation);
    const internal = Object.hasOwn(COMMAND_POLICIES, operation);
    const now = this.now(), payload = canonical({ path, body: { ...body, requestId, instanceId } });
    for (const [key, item] of runtime.cache) if (now - item.at >= 60000) runtime.cache.delete(key);
    const cached = runtime.cache.get(requestId);
    if (cached) {
      if (cached.payload !== payload) return this.errorReply(new ExternalError("INVALID"));
      if (cached.tier === "B" && !device.allowedTierBOperations.includes(cached.operation)) {
        const reply = this.errorReply(new ExternalError("TIER_FORBIDDEN"));
        this.logAction(device, cached.operation, path, reply, requestId, true, "B"); return reply;
      }
      this.logAction(device, cached.operation, path, cached.reply, requestId, true, cached.tier); return cached.reply;
    }
    if (runtime.cache.size >= 2048) {
      runtime.limited++;
      const nextExpiry = Math.min(...[...runtime.cache.values()].map(entry => entry.at + 60000));
      return this.errorReply(new ExternalError("RATE_LIMITED", 429, undefined, Math.max(1, Math.ceil((nextExpiry - now) / 1000))));
    }
    let reply: Reply;
    this.#logTier = !known ? "C" : ["bus.limiter.set", "bus.compressor.set", "scene.recall", "recording.start", "recording.stop"].includes(operation) || path === "execute" ? "B" : "A";
    try {
      if (path === "execute") {
        fields(body, ["requestId", "instanceId", "armId"]); textId(body.armId, 64);
        if (instanceId !== this.state.instanceId) fail("STALE_REVISION");
        const arm = runtime.arm;
        if (!arm || arm.id !== body.armId || now - arm.at >= 60000) {
          const denied = runtime.deniedArms.get(body.armId as string);
          if (denied && now - denied.at < 60000 && !device.allowedTierBOperations.includes(denied.operation)) fail("TIER_FORBIDDEN");
          fail("ARM_INVALID");
        }
        runtime.arm = undefined; // Consume before all timing/dependency/safety failures.
        if (!device.allowedTierBOperations.includes(arm.operation)) fail("TIER_FORBIDDEN");
        if (now - arm.at < 1000) fail("ARM_TOO_EARLY");
        if (now - arm.at >= 5000) fail("ARM_EXPIRED");
        this.observe();
        if (this.state.dependencies(arm.keys) !== arm.dependencies) fail("STALE_REVISION");
        reply = this.success(requestId, this.perform(arm.operation, arm.args, runtime, device, "execute", arm));
      } else {
        fields(body, ["requestId", "instanceId", "operation", "args"], ["expectedRevision"]);
        if (body.expectedRevision !== undefined) revision(body.expectedRevision);
        textId(body.operation, 80); object(body.args);
        if (!known) fail(internal ? "TIER_FORBIDDEN" : "INVALID");
        if (instanceId !== this.state.instanceId) fail("STALE_REVISION");
        this.observe();
        reply = this.success(requestId, this.perform(operation, object(body.args), runtime, device, path === "arm" ? "arm" : "action"));
      }
    } catch (error) { reply = this.errorReply(error); }
    runtime.cache.set(requestId, { at: now, payload, reply, operation, tier: this.#logTier });
    this.logAction(device, operation, path, reply, requestId, false, this.#logTier); return reply;
  }
  private perform(operation: string, args: RecordValue, runtime: DeviceRuntime, device: ExternalDevice, phase: "action" | "arm" | "execute", arm?: Arm): unknown {
    const control = this.options.control, engine = control.engine;
    if (operation.startsWith("scene.") || operation.startsWith("recording.")) return fail("TIER_FORBIDDEN");
    if (["bus.limiter.set", "bus.compressor.set"].includes(operation) || operation === "emergency.set" && args.active === false
      || operation === "settings.lock.set" && args.locked === false) {
      this.#logTier = "B";
      if (!device.allowedTierBOperations.includes(operation)) fail("TIER_FORBIDDEN");
      return this.handleB(operation, args, runtime, device, phase, this.prepareB(operation, args, phase === "action"), arm);
    }
    const [family, kind, mode] = operation.split(".");
    if (kind === "fader" || kind === "mute") {
      const selectors = family === "channel" ? ["target"] : family === "bus" ? ["busId"] : family === "send" ? ["target", "busId"] : ["profileId"];
      const key = kind === "fader" ? mode === "adjust" ? "deltaDb" : "db" : mode === "toggle" ? "expectedMute" : "mute";
      fields(args, [...selectors, key]);
      const value = kind === "fader" ? finite(args[key], key === "db" ? -90 : -Number.MAX_VALUE, key === "db" ? 12 : Number.MAX_VALUE) : boolean(args[key]);
      if (key === "deltaDb" && value === 0) fail("INVALID");
      const channel = selectors.includes("target") ? this.state.resolveTarget(args.target) : undefined;
      const busId = selectors.includes("busId") ? textId(args.busId) : undefined;
      const bus = busId ? engine.buses.get(busId) ?? fail("NOT_FOUND") : undefined;
      const send = family === "send" ? channel!.vcSends.get(busId!) ?? fail("NOT_FOUND") : undefined;
      if (send && bus!.groupSourceIds !== null) fail("INVALID");
      const profileId = family === "tx" ? this.profileId(args.profileId) : undefined;
      if (profileId && !control.txController?.setTxMaster) fail("UNAVAILABLE");
      const bot = profileId ? this.state.project({ readDisplayNames: false, allowedTierBOperations: [] }, true).tx.bots.find(b => b.profileId === profileId) ?? fail("NOT_FOUND") : undefined;
      if (bot?.state === "NO_BOT") fail("UNAVAILABLE");
      const current = family === "channel" ? kind === "fader" ? channel!.faderDb : channel!.mute
        : family === "bus" ? kind === "fader" ? bus!.masterDb : bus!.mute
          : family === "send" ? kind === "fader" ? send!.gainDb : send!.mute : bot!.masterDb;
      let next: number | boolean, increase = 0;
      if (kind === "fader") {
        next = mode === "adjust" ? Math.min(12, Math.max(-90, (current as number) + (value as number))) : value as number;
        increase = Math.max(0, next - Math.max(current as number, -40));
        if (increase > 6 && mode === "adjust") fail("INVALID");
      } else {
        if (mode === "toggle" && current !== value) throw new ExternalError("STALE_REVISION", undefined, { mute: current as boolean });
        next = mode === "toggle" ? !current : value;
      }
      const command: ControlCommand = family === "channel" ? kind === "fader" ? { type: "SET_CHANNEL_FADER", channelId: channel!.id, db: next as number } : { type: "SET_CHANNEL_MUTE", channelId: channel!.id, mute: next as boolean }
        : family === "bus" ? kind === "fader" ? { type: "SET_BUS_MASTER", busId: busId!, db: next as number } : { type: "SET_BUS_MUTE", busId: busId!, mute: next as boolean }
          : family === "send" ? { type: "SET_VC_SEND", channelId: channel!.id, busId: busId!, ...(kind === "fader" ? { db: next as number } : { mute: next as boolean }) }
            : { type: "SET_TX_MASTER", profileId: profileId!, db: next as number };
      if (increase > 6) {
        this.#logTier = "B";
        const keys = family === "channel" ? [dep("channel", channel!.id), dep("channel", channel!.id, "fader")]
          : family === "bus" ? [dep("bus", busId!), dep("bus", busId!, "fader")]
          : family === "send" ? [dep("channel", channel!.id), dep("bus", busId!), dep("send", channel!.id, busId!), dep("send", channel!.id, busId!, "fader")]
          : [dep("tx", profileId!), dep("tx", profileId!, "fader")];
        return this.handleB(operation, args, runtime, device, phase, { command, keys, increaseDb: increase,
          summary: { target: channel ? { kind: "user", discordUserId: channel.discordUserId } : busId ? { busId } : { profileId },
            ...(family === "send" ? { busId } : {}), currentDb: current, targetDb: next, increaseDb: increase }, data: () => ({ value: next }) }, arm);
      }
      // A saved B must never be silently downgraded after its fader changed.
      if (phase === "execute") fail("STALE_REVISION");
      if (phase === "arm") fail("INVALID");
      let bucket: Bucket | undefined;
      if (increase > 0) {
        const id = canonical([family, channel?.id, busId, profileId]); bucket = runtime.db.get(id);
        if (!bucket) { bucket = new Bucket(20, 10, this.now()); runtime.db.set(id, bucket); }
        if (!bucket.ready(this.now(), increase)) { runtime.limited++; fail("RATE_LIMITED"); }
      }
      if (current !== next) { this.commit(command, increase, mode === "adjust"); bucket?.spend(increase); }
      return { value: next };
    }
    if (phase === "arm") fail("INVALID");
    if (operation === "pfl.set") {
      fields(args, ["source"]); let sourceId: string | null = null; let source: unknown = null;
      if (args.source !== null) {
        const s = object(args.source);
        if (s.kind === "channel") {
          fields(s, ["kind", "target"]); const channel = this.state.resolveTarget(s.target); sourceId = channel.id;
          source = { kind: "channel", target: { kind: "user", discordUserId: channel.discordUserId } };
        } else if (s.kind === "bus") {
          fields(s, ["kind", "busId"]); sourceId = textId(s.busId); if (!engine.buses.has(sourceId)) fail("NOT_FOUND"); source = { kind: "bus", busId: sourceId };
        } else fail("INVALID");
      }
      this.commit({ type: "SET_PFL", sourceId }); return { source };
    }
    if (operation === "loudness.reset") {
      fields(args, ["busId"]); const busId = textId(args.busId); if (!engine.buses.has(busId)) fail("NOT_FOUND");
      this.commit({ type: "RESET_LOUDNESS", busId }); return {};
    }
    if (operation === "emergency.set") {
      fields(args, ["active"], ["expectedEmergencyEpoch"]); const active = boolean(args.active);
      if (!active) { if (args.expectedEmergencyEpoch !== undefined) revision(args.expectedEmergencyEpoch); fail("TIER_FORBIDDEN"); }
      fields(args, ["active"]); this.commit({ type: "EMERGENCY_MUTE", active: true });
      return { value: true, emergencyEpoch: control.emergencyEpoch };
    }
    if (operation === "settings.lock.set") {
      fields(args, ["locked"]); if (!boolean(args.locked)) fail("TIER_FORBIDDEN");
      if (control.state === "FAULT") fail("LOCKED");
      if (control.state !== "ON_AIR") this.commit({ type: "SET_STATE", state: "ON_AIR", confirmed: true }); return { value: true };
    }
    if (operation === "tx.start" || operation === "tx.stop") {
      fields(args, ["profileId"]); const profileId = this.profileId(args.profileId);
      const bot = this.state.project({ readDisplayNames: false, allowedTierBOperations: [] }, true).tx.bots.find(b => b.profileId === profileId) ?? fail("NOT_FOUND");
      if (bot.state === "NO_BOT") fail("UNAVAILABLE");
      if (operation === "tx.start" && (engine.emergencyMuted || control.state === "FAULT")) fail("LOCKED");
      if (!control.txController) fail("UNAVAILABLE");
      this.commit({ type: operation === "tx.start" ? "START_TX" : "STOP_TX", profileId, confirmed: true }); return this.txResult();
    }
    if (operation === "tx.clear") {
      fields(args, []); if (!control.txController?.clearAllTx) fail("UNAVAILABLE"); this.commit({ type: "CLEAR_ALL" }); return this.txResult();
    }
    if (operation === "tx.targets.set" || operation === "tx.take") {
      fields(args, ["expectedTargetsRevision", ...(operation === "tx.targets.set" ? ["selection"] : [])]);
      const expected = revision(args.expectedTargetsRevision);
      if (expected !== this.state.targetsRevision) fail("STALE_REVISION");
      const tx = this.state.project({ readDisplayNames: false, allowedTierBOperations: [] }, true).tx;
      if (operation === "tx.take") {
        if (!tx.armedProfileIds.length) fail("INVALID");
        if (engine.emergencyMuted || control.state === "FAULT") fail("LOCKED");
        if (!control.txController?.startArmed) fail("UNAVAILABLE");
        this.commit({ type: "START_ARMED", expectedRevision: this.state.internalTargetsRevision(), confirmed: true }); return this.txResult();
      }
      const selection = object(args.selection); let ids: string[]; let selectionKind: ExternalState["selectionKind"];
      if (selection.kind === "profiles") {
        fields(selection, ["kind", "profileIds"]); ids = this.uniqueArray(selection.profileIds).map(id => this.profileId(id)); selectionKind = "profiles";
        if (ids.some(id => !tx.bots.some(b => b.profileId === id))) fail("NOT_FOUND");
      } else if (selection.kind === "destinations" || selection.kind === "allTeams") {
        fields(selection, ["kind", ...(selection.kind === "destinations" ? ["destinations"] : [])]);
        selectionKind = selection.kind;
        const destinations = selection.kind === "destinations" ? this.uniqueArray(selection.destinations).map(d => {
          if (typeof d !== "string" || !/^(?:TEAM_(?:0[1-9]|1[0-9]|20)|INTERVIEW|SPARE)$/.test(d)) return fail("INVALID"); return d;
        }) : [...new Set(tx.bots.map(b => b.destination).filter((d): d is string => typeof d === "string" && /^TEAM_(?:0[1-9]|1[0-9]|20)$/.test(d)))];
        if (selection.kind === "allTeams" && !destinations.length) fail("NOT_FOUND");
        ids = destinations.map(d => { const matches = tx.bots.filter(b => b.destination === d); if (matches.length !== 1) fail("NOT_FOUND"); return matches[0].profileId; });
      } else return fail("INVALID");
      if (!control.txController?.setTxTargets) fail("UNAVAILABLE");
      if (ids.some(id => tx.bots.find(b => b.profileId === id)?.state === "NO_BOT")) fail("UNAVAILABLE");
      this.commit({ type: "SET_TX_TARGETS", ids: ids.sort(), expectedRevision: this.state.internalTargetsRevision() }); this.state.selected(selectionKind); return this.txResult();
    }
    return fail("INVALID");
  }
  private uniqueArray(value: unknown): unknown[] {
    if (!Array.isArray(value) || value.length > 22 || new Set(value).size !== value.length) return fail("INVALID"); return value;
  }
  private prepareB(operation: string, args: RecordValue, confirmationOnly = false): PreparedB {
    const control = this.options.control;
    if (operation === "emergency.set") {
      fields(args, ["active", "expectedEmergencyEpoch"]); boolean(args.active); const epoch = finite(args.expectedEmergencyEpoch, 0, Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(epoch)) fail("INVALID");
      return { command: { type: "EMERGENCY_MUTE", active: false, expectedEmergencyEpoch: epoch }, keys: ["emergency"],
        summary: { active: false, expectedEmergencyEpoch: epoch }, data: () => ({ value: false, emergencyEpoch: control.emergencyEpoch }) };
    }
    if (operation === "settings.lock.set") {
      fields(args, ["locked"]); boolean(args.locked);
      return { command: { type: "SET_STATE", state: "SETUP" }, keys: ["lock"], summary: { locked: false },
        noop: control.state === "SETUP", data: () => ({ value: false }) };
    }
    const limiter = operation === "bus.limiter.set";
    const ranges: Record<string, [number, number]> = { thresholdDb: [-60, 0], ratio: [1, 20], attackMs: [0.1, 200], releaseMs: [10, 2000], makeupDb: [-12, 24] };
    fields(args, limiter ? ["busId", "enabled"] : ["busId"], limiter ? [] : ["enabled", ...Object.keys(ranges)]);
    const busId = textId(args.busId), parameters: Record<string, number | boolean> = {};
    for (const key of Object.keys(args).filter(k => k !== "busId")) parameters[key] = key === "enabled" ? boolean(args[key]) : finite(args[key], ...ranges[key]);
    if (!Object.keys(parameters).length) fail("INVALID");
    if (confirmationOnly) fail("CONFIRMATION_REQUIRED");
    const bus = control.engine.buses.get(busId) ?? fail("NOT_FOUND");
    return { command: limiter ? { type: "SET_LIMITER", busId, enabled: parameters.enabled as boolean }
      : { type: "SET_BUS_COMPRESSOR", busId, ...parameters },
      keys: [dep("bus", busId!), ...(limiter ? [dep("bus", busId, "limiter")] : Object.keys(parameters).map(k => dep("bus", busId, "compressor", k)))],
      summary: { busId, ...parameters }, data: () => ({ value: limiter ? bus.limiter.enabled : {
        enabled: bus.compressorEnabled, thresholdDb: bus.compressor.thresholdDb, ratio: bus.compressor.ratio,
        attackMs: bus.compressor.attackMs, releaseMs: bus.compressor.releaseMs, makeupDb: bus.compressor.makeupDb } }) };
  }
  private checkBSafety(command: ControlCommand) {
    const control = this.options.control;
    if (command.type === "EMERGENCY_MUTE" && !command.active) {
      if (command.expectedEmergencyEpoch !== control.emergencyEpoch) fail("STALE_REVISION");
      if (control.state !== "READY" || control.outputManager && control.outputManager.snapshot().state !== "READY"
        || control.inputManager?.snapshot().state === "FAULT") fail("LOCKED");
    }
    if (command.type === "SET_STATE" && !["ON_AIR", "SETUP"].includes(control.state)) fail("LOCKED");
    if (command.type === "SET_LIMITER" && (control.state === "ON_AIR" || !command.enabled && control.state !== "SETUP")) fail("LOCKED");
    if (command.type === "SET_TX_MASTER" && control.state === "FAULT") fail("LOCKED");
  }
  private handleB(operation: string, args: RecordValue, runtime: DeviceRuntime, device: ExternalDevice,
    phase: "action" | "arm" | "execute", prepared: PreparedB, arm?: Arm) {
    if (!device.allowedTierBOperations.includes(operation)) fail("TIER_FORBIDDEN");
    if (phase === "action") fail("CONFIRMATION_REQUIRED");
    this.checkBSafety(prepared.command);
    if (classifyCommand(prepared.command, { state: this.options.control.state, increaseDb: prepared.increaseDb }) !== "B") fail("TIER_FORBIDDEN");
    const dependencies = this.state.dependencies(prepared.keys);
    if (phase === "arm") {
      const id = randomBytes(32).toString("base64url");
      runtime.arm = { id, at: this.now(), operation, args: structuredClone(args), keys: prepared.keys, dependencies };
      return { armId: id, operation, tier: "B", summary: prepared.summary, minimumHoldMs: 1000, expiresInMs: 5000 };
    }
    if (!arm || arm.dependencies !== dependencies) fail("STALE_REVISION");
    // The synchronous commit boundary: authority, timing, dependency and safety checks have all passed.
    if (!prepared.noop) {
      const command = prepared.command;
      this.commit(command.type === "EMERGENCY_MUTE" || command.type === "SET_STATE" ? { ...command, confirmed: true } : command,
        prepared.increaseDb, false, "B");
    }
    return prepared.data();
  }
  private profileId(value: unknown) { const id = textId(value, 32); return /^[A-Za-z0-9_-]+$/.test(id) ? id : fail("INVALID"); }
  private txResult() { this.state.observe(); return { targetsRevision: this.state.targetsRevision }; }
  private commit(command: ControlCommand, increaseDb?: number, adjust = false, tier: "A" | "B" = "A") {
    if (classifyCommand(command, { state: this.options.control.state, increaseDb, adjust }) !== tier) fail("TIER_FORBIDDEN");
    let result: CommandResult;
    try { result = this.options.execute(command); } finally { this.observe(); }
    if (!result.ok) {
      if (result.code === "STALE_STATE") fail("STALE_REVISION");
      if (result.code) fail(result.code);
      if (result.confirmationRequired) fail("CONFIRMATION_REQUIRED");
      // All accepted commands are fully confirmed here. Remaining control-plane rejections are safety gates.
      fail("LOCKED");
    }
  }
  private success(requestId: string | undefined, data: unknown): Reply {
    this.observe();
    return { status: 200, body: { ok: true, ...(requestId ? { requestId } : {}), instanceId: this.state.instanceId, revision: this.state.revision, data } };
  }
  private info(device: ExternalDevice) {
    return { apiVersion: "1.0", paraBusVersion: this.options.version,
      features: ["state.ws", "fader.relative", "fader.absolute", "participants.slot", "participants.user", "tx.targets", "confirmation.arm-execute"],
      operations: [...OPERATIONS, "bus.limiter.set", "bus.compressor.set"].map(name => ({ name,
        tiers: name === "bus.limiter.set" || name === "bus.compressor.set" ? ["B"]
          : name.endsWith(".fader.set") || name === "emergency.set" || name === "settings.lock.set" ? ["A", "B"] : ["A"] })), limits: LIMITS,
      permissions: { allowedTierBOperations: [...device.allowedTierBOperations], readDisplayNames: device.readDisplayNames } };
  }
  private errorReply(error: unknown): Reply {
    const safe = error instanceof ExternalError ? error : new ExternalError("INTERNAL"); return { status: safe.status, body: safe.body(), retryAfterSeconds: safe.retryAfterSeconds };
  }
  private responseHeaders(reply: Reply) {
    return { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      ...(reply.status === 401 ? { "www-authenticate": "Bearer" } : {}), ...(reply.status === 429 ? { "retry-after": String(reply.retryAfterSeconds ?? 1) } : {}) };
  }
  private writeReply(response: ServerResponse, reply: Reply) {
    if (response.destroyed) return;
    const payload = JSON.stringify(reply.body); response.writeHead(reply.status, { ...this.responseHeaders(reply), "content-length": Buffer.byteLength(payload) }); response.end(payload);
  }
  private socketReply(socket: Duplex, reply: Reply) {
    const payload = JSON.stringify(reply.body), headers = { ...this.responseHeaders(reply), "content-length": Buffer.byteLength(payload), connection: "close" };
    socket.end(`HTTP/1.1 ${reply.status} ${STATUS_CODES[reply.status]}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n${payload}`);
  }
  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => {});
    try {
      this.boundary(request); const device = this.authenticate(request), runtime = this.runtime(device); this.rate(runtime, "read");
      if (request.url !== "/external/v1/ws" || request.headers["sec-websocket-protocol"] !== undefined) fail("INVALID");
      if (this.#peers.size >= 16 || [...this.#peers].filter(p => p.device.deviceId === device.deviceId).length >= 2) { runtime.limited++; fail("RATE_LIMITED"); }
      if (!acceptWebSocket(request, socket, "Cache-Control: no-store\r\n")) fail("INVALID");
      const peer: Peer = { socket, device, revision: 0, pongAt: this.now(), pingAt: this.now(), closing: false }; this.#peers.add(peer);
      const receive = websocketReceiver(16384, (opcode, payload) => {
        if (peer.closing) return;
        if (opcode === 8) { this.closePeer(peer, 1000); return; }
        if (opcode === 9) { if (socket.writableLength < LIMITS.maxWsPendingBytes) socket.write(controlFrame(10, payload)); else this.closePeer(peer, 1013); return; }
        if (opcode === 10) { peer.pongAt = this.now(); return; }
        // State-only v1 stage 1 has no inbound commands/subscriptions.
        let requestId: string | null = null;
        try { requestId = uuid(object(strictJson(new TextDecoder("utf-8", { fatal: true }).decode(payload))).requestId); } catch {}
        try { this.rate(runtime, "read"); this.send(peer, { type: "result", requestId, payload: new ExternalError("INVALID").body() }); }
        catch (error) { this.send(peer, { type: "result", requestId, payload: (error as ExternalError).body() }); }
      });
      socket.on("data", (data: Buffer) => {
        try { receive(data); }
        catch (error) { this.send(peer, { type: "error", payload: new ExternalError("INVALID", error instanceof RangeError ? 413 : 400).body() }); this.closePeer(peer, error instanceof RangeError ? 1009 : 1002); }
      });
      const disconnected = () => {
        this.#peers.delete(peer);
        if (!peer.closing) { peer.closing = true; runtime.arm = undefined; }
      };
      socket.on("close", disconnected); socket.on("error", disconnected);
      socket.on("end", () => { disconnected(); socket.destroy(); });
      this.observe(); this.sendState(peer); if (head.length) socket.emit("data", head);
    } catch (error) { this.socketReply(socket, this.errorReply(error)); }
  }
  private closePeer(peer: Peer, code: number) { if (!peer.closing) { peer.closing = true; const runtime = this.#devices.get(peer.device.deviceId); if (runtime) runtime.arm = undefined; closeWebSocket(peer.socket, code); } }
  private send(peer: Peer, message: unknown) {
    if (peer.closing || peer.socket.destroyed) return;
    const frame = encodeWebSocketFrame(JSON.stringify(message));
    if (peer.socket.writableLength + frame.length > LIMITS.maxWsPendingBytes) { this.closePeer(peer, 1013); return; }
    peer.socket.write(frame);
  }
  private sendState(peer: Peer) {
    this.send(peer, { type: "state", payload: this.state.project(peer.device, this.store.enabled) }); peer.revision = this.state.revision;
  }
  tick() {
    this.observe(); const now = this.now(); this.flushLogs();
    for (const runtime of this.#devices.values()) {
      if (runtime.arm && now - runtime.arm.at >= 60000) runtime.arm = undefined;
      for (const [id, denied] of runtime.deniedArms) if (now - denied.at >= 60000) runtime.deniedArms.delete(id);
    }
    for (const peer of this.#peers) {
      if (peer.closing) continue;
      if (now - peer.pongAt >= 45000) { this.closePeer(peer, 1001); continue; }
      if (now - peer.pingAt >= 15000) {
        if (peer.socket.writableLength >= LIMITS.maxWsPendingBytes) { this.closePeer(peer, 1013); continue; }
        peer.socket.write(controlFrame(9)); peer.pingAt = now;
      }
      if (peer.revision !== this.state.revision) this.sendState(peer);
    }
  }
  /** Called after local/ingest mutations too; idle launches do not build projections every 100ms. */
  observe() {
    const active = this.store.enabled && ([...this.#peers].some(p => !p.closing)
      || [...this.#devices.values()].some(d => this.now() - d.lastHttp < 30000));
    if (!active) { this.#observing = false; return; }
    if (!this.#observing) { this.#observing = true; this.state.resume(); }
    else this.state.observe();
  }
  private authFailure() {
    this.flushLogs();
    if (!this.#authLogged) { this.options.log("External control authentication rejected"); this.#authLogged = true; this.#authAt = this.now(); }
    else this.#authSuppressed++;
  }
  private flushLogs(force = false) {
    const now = this.now();
    if (this.#authLogged && (force || now - this.#authAt >= 60000)) {
      if (this.#authSuppressed) this.options.log(`External control authentication suppressed=${this.#authSuppressed}`);
      this.#authAt = now; this.#authSuppressed = 0;
    }
    for (const runtime of this.#devices.values()) if (force || now - runtime.lastLog >= 60000) {
      if (runtime.limited) this.options.log(`External control rate limited suppressed=${runtime.limited}`);
      runtime.limited = 0; runtime.lastLog = now;
    }
  }
  private logAction(device: ExternalDevice, operation: string, phase: string, reply: Reply, requestId: string, deduplicated: boolean, tier: string) {
    const known = (OPERATIONS as readonly string[]).includes(operation) || TIER_B_OPERATIONS.includes(operation);
    const result = reply.status === 200 ? "SUCCESS" : (reply.body as { code: string }).code;
    if (result === "RATE_LIMITED") return;
    this.options.log(`External control action operation=${known ? operation : "UNKNOWN"} tier=${tier} result=${result} phase=${phase === "actions" ? "action" : phase} deviceId=${device.deviceId} requestId=${requestId} deduplicated=${deduplicated}`);
  }
}

import { createServer, type Server, type Socket } from "node:net";
import { MAX_DISCORD_RX_CHANNELS, MAX_RX_CHANNELS, type BotRole, type DiscordBotHealth, type DiscordIngestSnapshot, type DiscordRxIpcSnapshot, type DiscordTxSnapshot, type LogLevel, type ReceiverOwnershipSnapshot, type TxAudioMode, type TxSubtype } from "../../../packages/shared-types/src/index.ts";
import {
  DiscordFrameDecoder,
  DiscordFrameType,
  DiscordTxFlags,
  defaultDiscordIpcEndpoint,
  encodeDiscordFrame,
  type DiscordBotControlAction,
  type DiscordBotControlPayload,
  type DiscordIpcFrame,
} from "../../../packages/discord-ipc/src/index.ts";
import { AudioChannel, AudioEngine, VcBus } from "./audio-engine.ts";
import { DiscordPcmSource } from "./discord-pcm-source.ts";
import type { DiscordShadowComparator } from "./discord-shadow.ts";
import { openNativeOpusDecoderGate, type OpusDecoder, type OpusDecoderFactory } from "./opus-decoder.ts";
import type { UserSessionRegistry } from "./user-session-registry.ts";
import type { ReceiverOwnershipStore } from "./receiver-ownership-store.ts";
import { StaleSafetyStateError } from "./stale-state.ts";
import { isTxDestination } from "../../../packages/shared-types/src/index.ts";
import { sanitizeOperatorMessage } from "./operator-sanitize.ts";

const BOT_STALE_MS = 15_000;
const MAX_TRACKED_BOTS = 32;
const DISCORD_RX_BUFFER_BLOCKS = 12;
const TX_IPC_FLUSH_THRESHOLD_BYTES = 256 * 1024;

interface DiscordSourceRuntime {
  decoder: OpusDecoder;
  source: DiscordPcmSource;
  botId: string;
  guildId: string;
  voiceChannelId: string;
  userId: string;
  sourceGeneration: number;
  receiverGeneration: number;
  packets: number;
  decodedSamples: number;
  decodeErrors: number;
  lastPacketAt: number;
  lastSequence: number | null;
  sequenceGaps: number;
  rxTiming: NonNullable<DiscordIngestSnapshot["sources"][number]["rxTiming"]>;
}

interface DiscordBotRuntime {
  txDestination: string | null;
  key: string;
  profileId: string;
  label: string;
  role: BotRole;
  txSubtype: TxSubtype | null;
  txAudioMode: TxAudioMode | null;
  botId: string;
  guildId: string;
  guildName: string | null;
  voiceChannelId: string;
  voiceChannelName: string | null;
  gatewayState: string;
  voiceState: string;
  wsPingMs: number | null;
  udpPingMs: number | null;
  reconnectCount: number;
  lastAudioAt: number | null;
  txEnabled: boolean;
  txFrames: number;
  txDroppedFrames: number;
  lastTxFrameAt: number | null;
  lastHeartbeatAt: number;
  lastStateAt: number;
  message: string | null;
}

interface AdapterStatusPayload {
  txDestination?: unknown;
  profileId?: unknown;
  label?: unknown;
  role?: unknown;
  txSubtype?: unknown;
  txAudioMode?: unknown;
  gatewayState?: unknown;
  voiceState?: unknown;
  guildName?: unknown;
  voiceChannelName?: unknown;
  wsPingMs?: unknown;
  udpPingMs?: unknown;
  reconnectCount?: unknown;
  lastAudioAt?: unknown;
  txEnabled?: unknown;
  txFailed?: unknown;
  txFrames?: unknown;
  txDroppedFrames?: unknown;
  lastTxFrameAt?: unknown;
  message?: unknown;
  rxIpc?: unknown;
}

interface TxStemRuntime {
  masterDb: number;
  gain: number;
  sourceOutput: number;
  sourceInputChannelId?: string | null;
  sourceInputRightChannelId?: string;
  sequence: number;
  framesSent: number;
  droppedFrames: number;
  lastFrameAt: number;
  peak: number;
  pcm: Buffer;
}

export function discordSourceId(frame: Pick<DiscordIpcFrame, "guildId" | "voiceChannelId" | "userId">): string {
  return `discord-user:${frame.guildId ?? "0"}:${frame.voiceChannelId ?? "0"}:${frame.userId ?? "0"}`;
}

export function discordVoiceBusId(frame: Pick<DiscordIpcFrame, "guildId" | "voiceChannelId">): string {
  return `discord-vc:${frame.guildId ?? "0"}:${frame.voiceChannelId ?? "0"}`;
}

function botKey(frame: DiscordIpcFrame): string {
  return `${frame.botId ?? "0"}:${frame.guildId ?? "0"}:${frame.voiceChannelId ?? "0"}`;
}

function receiverKey(guildId: string, voiceChannelId: string): string {
  return `${guildId}:${voiceChannelId}`;
}

function isRxCapable(role: BotRole): role is "RX" | "DUPLEX" | "SPARE" {
  return role !== "TX";
}

function decodeJson(payload: Uint8Array | undefined): unknown {
  return JSON.parse(Buffer.from(payload ?? []).toString("utf8"));
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isForwardU32(value: number, previous: number): boolean {
  const delta = (value - previous) >>> 0;
  return delta !== 0 && delta < 0x8000_0000;
}

export class DiscordIngestServer {
  readonly engine: AudioEngine;
  readonly endpoint: string;
  readonly shadow: DiscordShadowComparator | null;
  readonly userSessions: UserSessionRegistry | null;
  readonly receiverStore: ReceiverOwnershipStore | null;
  readonly runtimes = new Map<string, DiscordSourceRuntime>();
  readonly bots = new Map<string, DiscordBotRuntime>();
  #server: Server | null = null;
  #sockets = new Set<Socket>();
  #socketBots = new WeakMap<Socket, Set<string>>();
  #socketSources = new Map<Socket, Map<string, number>>();
  #sourceSockets = new Map<string, Socket>();
  #botSockets = new Map<string, Socket>();
  #txBotIds = new Set<string>();
  #adapterState = "waiting";
  #packets = 0;
  #bytes = 0;
  #decodeErrors = 0;
  #retiredRxUnderruns = 0;
  #retiredRxInSpeechUnderruns = 0;
  #retiredRxOverflows = 0;
  #rejectedOpus: Record<string, number> = {};
  #ipcBatches = { count: 0, maxOpusFrames: 0, maxBytes: 0, maxProcessingMs: 0 };
  #currentBatch: { opusFrames: number; bytes: number; startedAt: number } | null = null;
  #adapterRxIpc = new WeakMap<Socket, DiscordRxIpcSnapshot>();
  #decoderFactory: OpusDecoderFactory | null;
  #decoderState: "READY" | "UNAVAILABLE";
  #availableVoiceChannels = new Map<string, { guildId: string; id: string; name: string }>();
  #txStems = new Map<string, TxStemRuntime>();
  #armed = new Set<string>();
  #live = new Set<string>();
  #txTargetsRevision = 1;

  get txTargetsRevision(): number { return this.#txTargetsRevision; }
  #receiverOwners = new Map<string, string>();
  #receiverGenerations = new Map<string, number>();
  #capacityRejectedSources = new Set<string>();
  #profileAuthority = new Map<string, { socket: Socket; botKey: string }>();
  #profileClaims = new Map<string, Map<Socket, string>>();
  #profileConflicts = new Set<string>();
  #unavailableOwnerWarnings = new Set<string>();
  #receiverEventHandler: (level: LogLevel, message: string) => void = () => {};

  constructor(
    engine: AudioEngine,
    endpoint = process.env.DISCORD_IPC_ENDPOINT ?? defaultDiscordIpcEndpoint(),
    shadow: DiscordShadowComparator | null = null,
    decoderFactory?: OpusDecoderFactory | null,
    userSessions: UserSessionRegistry | null = null,
    receiverStore: ReceiverOwnershipStore | null = null,
  ) {
    this.engine = engine;
    this.endpoint = endpoint;
    this.shadow = shadow;
    this.userSessions = userSessions;
    this.receiverStore = receiverStore;
    const gate = decoderFactory === undefined ? openNativeOpusDecoderGate() : {
      state: decoderFactory ? "READY" as const : "UNAVAILABLE" as const,
      factory: decoderFactory,
      reason: decoderFactory ? null : "native Opus decoder unavailable",
    };
    this.#decoderFactory = gate.factory;
    this.#decoderState = gate.state;
  }

  start(): Promise<void> {
    if (this.#server) return Promise.resolve();
    this.#server = createServer((socket) => this.accept(socket));
    return new Promise((resolve, reject) => {
      const server = this.#server!;
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(this.endpoint, () => {
        server.off("error", onError);
        server.on("error", (error) => console.error("Discord IPC server error:", sanitizeOperatorMessage(error)));
        this.shadow?.start();
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    const listenerClosed = server
      ? new Promise<void>((resolve) => server.close(() => resolve()))
      : Promise.resolve();
    this.shadow?.close();
    for (const socket of this.#sockets) socket.destroy();
    for (const id of [...this.runtimes.keys()]) this.disposeSource(id);
    this.bots.clear();
    this.#botSockets.clear();
    this.#txBotIds.clear();
    this.#txStems.clear();
    if (this.#armed.size) { this.#armed.clear(); this.#txTargetsRevision++; }
    this.clearLiveTx();
    this.#receiverOwners.clear();
    this.#receiverGenerations.clear();
    this.#capacityRejectedSources.clear();
    this.#profileAuthority.clear();
    this.#profileClaims.clear();
    this.#profileConflicts.clear();
    this.#unavailableOwnerWarnings.clear();
    await listenerClosed;
  }

  ingest(frame: DiscordIpcFrame, socket?: Socket): void {
    const now = Date.now();
    if (socket && frame.botId && frame.botId !== "0") {
      if (frame.type === DiscordFrameType.BOT_META) {
        if (!this.claimBotSocket(frame, socket)) return;
      }
      else if (this.#botSockets.get(botKey(frame)) !== socket) {
        if (frame.type === DiscordFrameType.OPUS) this.rejectOpus("socketAuthority");
        return;
      }
    }

    if (frame.type === DiscordFrameType.BOT_META) {
      const bot = this.ensureBot(frame, now);
      try {
        this.applyStatus(bot, decodeJson(frame.payload) as AdapterStatusPayload, now, false);
        if (socket && isRxCapable(bot.role)) this.registerProfileAuthority(bot, socket);
        if (isRxCapable(bot.role)) this.ensureVoiceBus(frame, bot.voiceChannelName);
        this.reconcileReceiverOwner(bot.guildId, bot.voiceChannelId);
        this.handleOwnerAvailability(bot, now);
      } catch {
        this.#decodeErrors += 1;
      }
      return;
    }
    if (frame.type === DiscordFrameType.ADAPTER_STATE || frame.type === DiscordFrameType.PING) {
      const text = Buffer.from(frame.payload ?? []).toString("utf8");
      try {
        const payload = JSON.parse(text) as AdapterStatusPayload;
        const bot = this.ensureBot(frame, now);
        // ADAPTER_STATE is a fresh authenticated liveness signal too. Keeping an
        // older PING timestamp here makes a newly READY reconnect look STALE
        // until the next heartbeat, so its one-shot USER_META replay is lost.
        this.applyStatus(bot, payload, now, true);
        if (socket) this.applyRxIpcStatus(socket, payload.rxIpc);
        if (isRxCapable(bot.role)) this.ensureVoiceBus(frame, bot.voiceChannelName);
        this.reconcileReceiverOwner(bot.guildId, bot.voiceChannelId);
        this.handleOwnerAvailability(bot, now);
        this.#adapterState = bot.voiceState === "ready" ? "voice-ready" : bot.voiceState;
      } catch {
        if (frame.type === DiscordFrameType.ADAPTER_STATE) {
          this.#adapterState = text || "connected";
          if (frame.botId && frame.botId !== "0") {
            const bot = this.ensureBot(frame, now);
            bot.voiceState = this.#adapterState.replace(/^voice-/, "");
            if (bot.voiceState !== "ready") this.clearTxStem(bot);
            bot.lastStateAt = now;
          }
        } else {
          this.#decodeErrors += 1;
        }
      }
      return;
    }
    if (frame.type === DiscordFrameType.VOICE_CHANNELS) {
      try {
        const decoded = decodeJson(frame.payload);
        if (!Array.isArray(decoded)) throw new Error("voice channel list must be an array");
        for (const item of decoded) {
          if (!item || typeof item.id !== "string" || typeof item.name !== "string") continue;
          const guildId = frame.guildId ?? "0";
          this.#availableVoiceChannels.set(`${guildId}:${item.id}`, { guildId, id: item.id, name: item.name.slice(0, 100) });
        }
      } catch {
        this.#decodeErrors += 1;
      }
      return;
    }
    const id = discordSourceId(frame);
    if (frame.type === DiscordFrameType.USER_META) {
      if (this.#txBotIds.has(frame.userId ?? "0")) return;
      const senderBot = this.ensureBot(frame, now);
      this.reconcileReceiverOwner(senderBot.guildId, senderBot.voiceChannelId);
      if (!this.isActiveReceiver(senderBot)) return;
      const generation = frame.sourceGeneration ?? 0;
      const existing = this.runtimes.get(id);
      const currentReceiverGeneration = this.currentReceiverGeneration(senderBot.guildId, senderBot.voiceChannelId);
      if (existing && existing.receiverGeneration !== currentReceiverGeneration) this.disposeSource(id, existing.sourceGeneration);
      if (existing && existing.sourceGeneration !== generation) {
        // A legacy (zero) frame must never replace a generation-aware membership.
        if (generation === 0) return;
        if (!isForwardU32(generation, existing.sourceGeneration)) return;
        this.disposeSource(id, existing.sourceGeneration);
      }
      const label = Buffer.from(frame.payload ?? []).toString("utf8").trim().slice(0, 80);
      const source = this.ensureSource(frame, generation, socket, label);
      if (!source) return;
      const channel = source.channel;
      if (label && !this.userSessions) channel.label = label;
      return;
    }
    if (frame.type === DiscordFrameType.USER_LEFT) {
      this.#capacityRejectedSources.delete(id);
      const senderBot = this.ensureBot(frame, now);
      if (!this.isActiveReceiver(senderBot)) return;
      this.disposeSource(id, frame.sourceGeneration ?? 0);
      return;
    }
    if (frame.type !== DiscordFrameType.OPUS) return;

    const senderBot = this.ensureBot(frame, now);
    if (!this.isActiveReceiver(senderBot)) {
      const reason = !isRxCapable(senderBot.role) ? "receiverRole"
        : this.#receiverOwners.get(receiverKey(senderBot.guildId, senderBot.voiceChannelId)) !== senderBot.profileId ? "receiverOwner"
          : !this.isAuthoritativeReceiver(senderBot) ? "receiverAuthority" : `health:${this.botHealth(senderBot, now)}`;
      this.rejectOpus(reason);
      return;
    }
    if (this.#txBotIds.has(frame.userId ?? "0")) {
      this.rejectOpus("txBot");
      return;
    }

    const framePayload = frame.payload ?? new Uint8Array();
    const payload = Buffer.isBuffer(framePayload)
      ? framePayload
      : Buffer.from(framePayload.buffer, framePayload.byteOffset, framePayload.byteLength);
    this.#packets += 1;
    this.#bytes += payload.length;
    const runtime = this.runtimes.get(id);
    const generation = frame.sourceGeneration ?? 0;
    // Only USER_META establishes a membership. OPUS after leave, old OPUS, and
    // a mixed/ordering-mismatched adapter are deliberately dropped.
    if (!runtime || runtime.sourceGeneration !== generation || runtime.receiverGeneration !== this.currentReceiverGeneration(senderBot.guildId, senderBot.voiceChannelId)) {
      this.rejectOpus(!runtime ? "membershipMissing" : runtime.sourceGeneration !== generation ? "sourceGeneration" : "receiverGeneration");
      return;
    }
    if (socket) this.trackSocketSource(socket, id, generation);
    const bot = senderBot;
    bot.lastAudioAt = now;
    const sequence = frame.sequence ?? 0;
    if (runtime.lastSequence !== null) {
      const expected = (runtime.lastSequence + 1) >>> 0;
      if (sequence !== expected) {
        if (!isForwardU32(sequence, runtime.lastSequence)) {
          this.rejectOpus("sequenceReordered");
          return;
        }
        runtime.sequenceGaps += (sequence - expected) >>> 0;
      }
    }
    runtime.lastSequence = sequence;
    runtime.packets += 1;
    const packetGapMs = runtime.lastPacketAt === 0 ? 0 : Math.max(0, now - runtime.lastPacketAt);
    runtime.rxTiming.maxPacketGapMs = Math.max(runtime.rxTiming.maxPacketGapMs, packetGapMs);
    runtime.lastPacketAt = now;
    const packetReceivedAt = performance.now();
    runtime.source.timing?.observePacket(packetReceivedAt, runtime.source.queuedSamples);
    runtime.source.timing?.packet(packetReceivedAt);
    try {
      const pcm = runtime.decoder.decode(payload);
      const queuedBefore = runtime.source.queuedSamples;
      const droppedBefore = runtime.source.droppedSamples;
      const incomingSamples = runtime.source.pushInt16Le(pcm, packetReceivedAt);
      runtime.source.timing?.observeQueued(runtime.source.queuedSamples);
      runtime.decodedSamples += incomingSamples;
      runtime.rxTiming.maxQueuedMilliseconds = Math.max(runtime.rxTiming.maxQueuedMilliseconds, runtime.source.queuedSamples / this.engine.sampleRate * 1000);
      const droppedSamples = runtime.source.droppedSamples - droppedBefore;
      if (droppedSamples > 0) {
        runtime.rxTiming.overflowEvents += 1;
        runtime.rxTiming.lastOverflow = {
          at: new Date(now).toISOString(),
          queuedBeforeMilliseconds: queuedBefore / this.engine.sampleRate * 1000,
          incomingSamples, droppedSamples, packetGapMs,
          batchOpusFrames: this.#currentBatch?.opusFrames ?? 0,
          batchBytes: this.#currentBatch?.bytes ?? 0,
          batchElapsedMs: this.#currentBatch ? performance.now() - this.#currentBatch.startedAt : 0,
        };
      }
    } catch {
      runtime.decodeErrors += 1;
      this.#decodeErrors += 1;
    }
  }

  tabletSnapshot(now = Date.now()) {
    const bots = [...this.bots.values()].sort((a, b) => a.profileId.localeCompare(b.profileId, "ja")).map(bot => ({
      label: bot.label, role: bot.role, voiceChannelName: bot.voiceChannelName, health: this.botHealth(bot, now),
      wsPingMs: bot.wsPingMs, udpPingMs: bot.udpPingMs, reconnectCount: bot.reconnectCount,
      lastAudioAgoMs: bot.lastAudioAt === null ? null : Math.max(0, now - bot.lastAudioAt), message: bot.message,
    }));
    return {
      adapterState: this.#sockets.size === 0 ? "disconnected" : this.#adapterState, connectedAdapters: this.#sockets.size,
      configuredBots: bots.length, readyBots: bots.filter(bot => bot.health === "READY").length,
      staleBots: bots.filter(bot => bot.health === "STALE").length, reconnectingBots: bots.filter(bot => bot.health === "RECONNECTING").length,
      bots, txStems: this.txSnapshots(now),
    };
  }

  snapshot(now = Date.now(), includeHistory = true): DiscordIngestSnapshot {
    const bots = [...this.bots.values()].map((bot) => {
      const health = this.botHealth(bot, now);
      const heartbeatBasis = bot.lastHeartbeatAt || bot.lastStateAt;
      return {
        key: bot.key,
        profileId: bot.profileId,
        label: bot.label,
        role: bot.role,
        txSubtype: bot.txSubtype,
        txAudioMode: bot.txAudioMode,
        botId: bot.botId,
        guildId: bot.guildId,
        guildName: bot.guildName,
        voiceChannelId: bot.voiceChannelId,
        voiceChannelName: bot.voiceChannelName,
        gatewayState: bot.gatewayState,
        voiceState: bot.voiceState,
        health,
        wsPingMs: bot.wsPingMs,
        udpPingMs: bot.udpPingMs,
        reconnectCount: bot.reconnectCount,
        lastAudioAgoMs: bot.lastAudioAt === null ? null : Math.max(0, now - bot.lastAudioAt),
        txEnabled: bot.txEnabled,
        txFrames: bot.txFrames,
        txDroppedFrames: bot.txDroppedFrames,
        lastTxFrameAgoMs: bot.lastTxFrameAt === null ? null : Math.max(0, now - bot.lastTxFrameAt),
        lastHeartbeatAgoMs: heartbeatBasis === 0 ? null : Math.max(0, now - heartbeatBasis),
        message: bot.message,
      };
    }).sort((a, b) => a.profileId.localeCompare(b.profileId, "ja"));
    return {
      endpoint: this.endpoint,
      connectedAdapters: this.#sockets.size,
      adapterState: this.#sockets.size === 0 ? "disconnected" : this.#adapterState,
      configuredBots: bots.length,
      readyBots: bots.filter((bot) => bot.health === "READY").length,
      staleBots: bots.filter((bot) => bot.health === "STALE").length,
      reconnectingBots: bots.filter((bot) => bot.health === "RECONNECTING").length,
      packets: this.#packets,
      bytes: this.#bytes,
      decodeErrors: this.#decodeErrors,
      decoderState: this.#decoderState,
      rxDiagnostics: {
        inSpeechUnderruns: this.#retiredRxInSpeechUnderruns + [...this.runtimes.values()].reduce((sum, runtime) => sum + (runtime.source.timing?.inSpeechUnderruns ?? 0), 0),
        rejectedOpus: { ...this.#rejectedOpus },
        ipcBatches: { ...this.#ipcBatches },
        adapterIpc: [...this.#sockets].flatMap((socket) => {
          const stats = this.#adapterRxIpc.get(socket);
          return stats ? [{ ...stats }] : [];
        }),
      },
      ...(this.shadow ? { shadow: this.shadow.snapshot() } : {}),
      tx: this.txSnapshot(now),
      txStems: this.txSnapshots(now),
      txTargets: { armed: [...this.#armed], live: [...this.#live], allTeams: this.teamTxIds() },
      txTargetsRevision: this.#txTargetsRevision,
      bots,
      receiverOwnership: this.receiverOwnershipSnapshot(now),
      availableVoiceChannels: [...this.#availableVoiceChannels.values()].map((channel) => ({ ...channel })),
      sources: [...this.runtimes.entries()].map(([channelId, runtime]) => ({
        channelId,
        botId: runtime.botId,
        guildId: runtime.guildId,
        voiceChannelId: runtime.voiceChannelId,
        userId: runtime.userId,
        packets: runtime.packets,
        decodedSamples: runtime.decodedSamples,
        decodeErrors: runtime.decodeErrors,
        sequenceGaps: runtime.sequenceGaps,
        queuedMilliseconds: (runtime.source.queuedSamples / this.engine.sampleRate) * 1000,
        droppedSamples: runtime.source.droppedSamples,
        lastPacketAgoMs: runtime.lastPacketAt === 0 ? null : Math.max(0, now - runtime.lastPacketAt),
        playout: runtime.source.playoutSnapshot(),
        rxTiming: { ...runtime.rxTiming, ...(includeHistory ? runtime.source.timing?.snapshot() : { underruns: runtime.source.timing?.underruns, overflowsAfterUnderrun: runtime.source.timing?.overflowsAfterUnderrun,
          silenceBlocksDropped: runtime.source.timing?.silenceBlocksDropped, compressedSamples: runtime.source.timing?.compressedSamples,
          inSpeechUnderruns: runtime.source.timing?.inSpeechUnderruns }), lastOverflow: runtime.rxTiming.lastOverflow ? { ...runtime.rxTiming.lastOverflow } : null },
      })),
    };
  }

  rxTimingTotals(): { underruns: number; overflows: number } {
    let underruns = this.#retiredRxUnderruns, overflows = this.#retiredRxOverflows;
    for (const runtime of this.runtimes.values()) { underruns += runtime.source.timing?.underruns ?? 0; overflows += runtime.rxTiming.overflowEvents; }
    return { underruns, overflows };
  }

  setReceiverEventHandler(handler: (level: LogLevel, message: string) => void): void {
    this.#receiverEventHandler = handler;
  }

  setReceiverOwner(guildId: string, voiceChannelId: string, profileId: string, options: { recoveryOnly?: boolean; expectedCurrentOwner: string | null; expectedReceiverGeneration: number }): { previousProfileId: string | null; profileId: string; voiceChannelName: string; previousGeneration: number; generation: number } {
    const key = receiverKey(guildId, voiceChannelId);
    const previousProfileId = this.#receiverOwners.get(key) ?? null;
    const previousGeneration = this.currentReceiverGeneration(guildId, voiceChannelId);
    if (options.expectedCurrentOwner !== previousProfileId || options.expectedReceiverGeneration !== previousGeneration) {
      throw new StaleSafetyStateError(
        "receiver-owner",
        { owner: options.expectedCurrentOwner, receiverGeneration: options.expectedReceiverGeneration },
        { owner: previousProfileId, receiverGeneration: previousGeneration },
      );
    }
    const claims = this.#profileClaims.get(profileId);
    let conflictCleared = false;
    if (this.#profileConflicts.has(profileId)) {
      if (options.recoveryOnly || claims?.size !== 1) throw new Error(`${profileId} has duplicate receiver authority; reconnect or resolve the conflict before switching`);
      const [socket, authorityKey] = claims.entries().next().value as [Socket, string];
      this.#profileAuthority.set(profileId, { socket, botKey: authorityKey });
      this.#profileConflicts.delete(profileId);
      conflictCleared = true;
      this.#receiverEventHandler("WARNING", `Receiver authority conflict cleared: ${profileId}`);
    }
    const authority = this.#profileAuthority.get(profileId);
    const candidate = [...this.bots.values()].find((bot) => bot.guildId === guildId && bot.voiceChannelId === voiceChannelId && bot.profileId === profileId && (!authority || authority.botKey === bot.key));
    if (!candidate || !isRxCapable(candidate.role)) throw new Error("Receiver候補が対象VCに存在しません");
    if (this.botHealth(candidate, Date.now()) !== "READY") throw new Error(`${candidate.profileId}はReceiver切替可能な状態ではありません`);
    if (options.recoveryOnly) {
      const current = [...this.bots.values()].find((bot) => bot.guildId === guildId && bot.voiceChannelId === voiceChannelId && bot.profileId === previousProfileId);
      if (current && this.isActiveReceiver(current)) throw new Error("Active RX Owner is healthy; receiver switch is locked while ON AIR");
      this.disposeVoiceChannelSources(guildId, voiceChannelId);
    }
    if (previousProfileId === profileId && !conflictCleared) {
      this.receiverStore?.set(guildId, voiceChannelId, profileId);
      return { previousProfileId, profileId, voiceChannelName: candidate.voiceChannelName ?? voiceChannelId, previousGeneration, generation: previousGeneration };
    }
    this.#receiverOwners.delete(key);
    this.disposeVoiceChannelSources(guildId, voiceChannelId);
    const generation = this.advanceReceiverGeneration(guildId, voiceChannelId);
    this.receiverStore?.set(guildId, voiceChannelId, profileId);
    this.#receiverOwners.set(key, profileId);
    this.#unavailableOwnerWarnings.delete(key);
    const voiceChannelName = candidate.voiceChannelName ?? voiceChannelId;
    this.#receiverEventHandler("WARNING", `${options.recoveryOnly ? "ON AIR recovery switch" : "Receiver switched"}: ${voiceChannelName} · ${previousProfileId ?? "UNSELECTED"} → ${profileId}; receiver generation ${previousGeneration} → ${generation}`);
    if (this.#sockets.size > 0) this.sendBotControl("CONNECT", profileId);
    return { previousProfileId, profileId, voiceChannelName, previousGeneration, generation };
  }

  receiverOwnershipSnapshot(now = Date.now()): ReceiverOwnershipSnapshot[] {
    const groups = new Map<string, { guildId: string; voiceChannelId: string; bots: DiscordBotRuntime[] }>();
    for (const bot of this.bots.values()) {
      if (!isRxCapable(bot.role)) continue;
      const key = receiverKey(bot.guildId, bot.voiceChannelId);
      if (!groups.has(key)) groups.set(key, { guildId: bot.guildId, voiceChannelId: bot.voiceChannelId, bots: [] });
    }
    for (const entry of this.receiverStore?.snapshot() ?? []) {
      const key = receiverKey(entry.guildId, entry.voiceChannelId);
      if (!groups.has(key)) groups.set(key, { guildId: entry.guildId, voiceChannelId: entry.voiceChannelId, bots: [] });
    }
    for (const bot of this.bots.values()) groups.get(receiverKey(bot.guildId, bot.voiceChannelId))?.bots.push(bot);
    return [...groups.values()].map((group) => {
      this.reconcileReceiverOwner(group.guildId, group.voiceChannelId);
      const key = receiverKey(group.guildId, group.voiceChannelId);
      const ownerProfileId = this.#receiverOwners.get(key) ?? null;
      const owner = group.bots.find((bot) => bot.profileId === ownerProfileId && this.isAuthoritativeReceiver(bot))
        ?? group.bots.find((bot) => bot.profileId === ownerProfileId);
      if (owner) this.handleOwnerAvailability(owner, now);
      const ownerConflict = Boolean(ownerProfileId && this.#profileConflicts.has(ownerProfileId));
      const ownerReady = Boolean(owner && this.isAuthoritativeReceiver(owner) && this.botHealth(owner, now) === "READY");
      const receivers = group.bots.filter((bot) => isRxCapable(bot.role)).map((bot) => {
        const health = this.botHealth(bot, now);
        return {
          profileId: bot.profileId,
          label: bot.label,
          role: bot.role as "RX" | "DUPLEX" | "SPARE",
          health,
          state: this.#profileConflicts.has(bot.profileId) ? "CONFLICT" as const
            : bot.profileId === ownerProfileId ? ownerReady ? "ACTIVE" as const : "DISCONNECTED" as const
            : health === "READY" ? "STANDBY" as const : "DISCONNECTED" as const,
        };
      }).sort((a, b) => a.profileId.localeCompare(b.profileId));
      const transmitters = group.bots.filter((bot) => bot.role === "TX" || bot.role === "DUPLEX").map((bot) => ({
        profileId: bot.profileId,
        label: bot.label,
        role: bot.role as "TX" | "DUPLEX",
        health: this.botHealth(bot, now),
      })).sort((a, b) => a.profileId.localeCompare(b.profileId));
      return {
        guildId: group.guildId,
        voiceChannelId: group.voiceChannelId,
        voiceChannelName: group.bots.find((bot) => bot.voiceChannelName)?.voiceChannelName ?? null,
        ownerProfileId,
        generation: this.currentReceiverGeneration(group.guildId, group.voiceChannelId),
        status: ownerConflict ? "CONFLICT" as const : !ownerProfileId ? "UNSELECTED" as const : ownerReady ? "ACTIVE" as const : "DISCONNECTED" as const,
        receivers,
        transmitters,
      };
    }).sort((a, b) => a.voiceChannelId.localeCompare(b.voiceChannelId));
  }

  txSnapshots(now = Date.now()): DiscordTxSnapshot[] {
    return this.txBots().map((bot) => this.txSnapshotForBot(bot, now));
  }

  txMeters() {
    return this.txSnapshots().map(({ profileId, active, state, peak, masterDb }) => ({ profileId, active, state, peak, masterDb }));
  }

  txSnapshot(now = Date.now(), profileId?: string): DiscordTxSnapshot {
    const bot = this.txBot(profileId);
    if (bot) return this.txSnapshotForBot(bot, now);
    return {
      state: "NO_BOT",
      active: false,
      sourceOutput: Math.min(63, this.engine.outputChannelCount - 1),
      profileId: null,
      label: null,
      botId: null,
      guildId: null,
      voiceChannelId: null,
      voiceChannelName: null,
      subtype: null,
      audioMode: null,
      framesSent: 0,
      droppedFrames: 0,
      peak: 0,
      lastFrameAgoMs: null,
    };
  }

  connectBot(profileId: string): void {
    const id = this.validateProfileId(profileId);
    this.sendBotControl("CONNECT", id);
    const bot = this.botByProfileId(id);
    if (bot) {
      bot.gatewayState = "connecting";
      bot.voiceState = "idle";
      bot.message = "operator requested connection";
      bot.lastStateAt = Date.now();
    }
  }

  disconnectBot(profileId: string): void {
    const id = this.validateProfileId(profileId);
    this.stopTx(id);
    this.sendBotControl("DISCONNECT", id);
    const bot = this.botByProfileId(id);
    if (bot) {
      bot.gatewayState = "disconnecting";
      bot.voiceState = "disconnecting";
      bot.message = "operator requested disconnect";
      bot.lastStateAt = Date.now();
    }
  }

  setTxSource(output: number, profileId?: string): void {
    const bot = this.requireTxBot(profileId);
    const stem = this.txStem(bot);
    if (this.#live.has(bot.profileId)) throw new Error(`${bot.profileId}は送信中です。先にTXを停止してください`);
    if (!Number.isInteger(output) || output < 0 || output >= this.engine.outputs.length) {
      throw new RangeError(`TX source output must be 0..${this.engine.outputs.length - 1}`);
    }
    if (bot.txAudioMode === "STEREO" && output + 1 >= this.engine.outputs.length) {
      throw new RangeError("Stereo TX requires two adjacent output channels");
    }
    stem.sourceOutput = output;
    delete stem.sourceInputChannelId;
    delete stem.sourceInputRightChannelId;
  }

  setTxMaster(db: number, profileId: string): void {
    if (!Number.isFinite(db) || db < -90 || db > 12) throw new RangeError("TX level must be -90..12 dB");
    const stem = this.txStem(this.requireTxBot(profileId));
    stem.masterDb = db;
    stem.gain = db <= -90 ? 0 : 10 ** (db / 20);
  }

  setTxInput(channelId: string | null, profileId: string): void {
    const bot = this.requireTxBot(profileId);
    if (this.#live.has(bot.profileId)) throw new Error("Stop TX before changing its input");
    if (channelId !== null && this.engine.channels.get(channelId)?.kind !== "LocalMonoInput") {
      throw new Error("TX input must be an existing local input channel");
    }
    const inputNumber = channelId?.match(/^local-input:(\d+)$/)?.[1];
    const rightId = inputNumber ? `local-input:${Number(inputNumber) + 1}` : undefined;
    if (channelId !== null && bot.txAudioMode === "STEREO" && (!rightId || this.engine.channels.get(rightId)?.kind !== "LocalMonoInput")) {
      throw new Error("Stereo TX requires two adjacent local input channels");
    }
    const stem = this.txStem(bot);
    stem.sourceInputChannelId = channelId;
    stem.sourceInputRightChannelId = channelId !== null && bot.txAudioMode === "STEREO" ? rightId : undefined;
  }

  assignTxVoiceChannel(profileId: string, voiceChannelId: string): void {
    const bot = this.requireTxBot(profileId);
    if (this.#live.has(bot.profileId)) throw new Error(`${bot.profileId}は送信中です。停止してからVCを変更してください`);
    const target = this.#availableVoiceChannels.get(`${bot.guildId}:${voiceChannelId}`);
    if (!target) throw new Error("割り当て先VCがBot Rackから観測されていません");
    const socket = this.#botSockets.get(bot.key);
    if (!socket?.writable || socket.destroyed) throw new Error("TX BotのAdapter IPCが接続されていません");
    this.clearTxStem(bot);
    socket.write(encodeDiscordFrame({
      type: DiscordFrameType.TX_CONTROL,
      flags: DiscordTxFlags.ASSIGN_VOICE_CHANNEL,
      botId: bot.botId,
      guildId: bot.guildId,
      voiceChannelId,
    }));
    bot.voiceState = "connecting";
    bot.voiceChannelName = target.name;
    bot.message = `moving to ${target.name}`;
  }

  startTx(profileId?: string): void {
    const bot = this.requireTxBot(profileId);
    const input = this.txStem(bot).sourceInputChannelId;
    if (input === null || (input !== undefined && this.engine.channels.get(input)?.kind !== "LocalMonoInput")) {
      throw new Error("TX input is not assigned or unavailable");
    }
    if (input !== undefined && bot.txAudioMode === "STEREO" && this.engine.channels.get(this.txStem(bot).sourceInputRightChannelId ?? "")?.kind !== "LocalMonoInput") {
      throw new Error("Stereo TX right input is unavailable; assign the input pair again");
    }
    const socket = this.requireTxReady(bot);
    socket.write(encodeDiscordFrame({
      type: DiscordFrameType.TX_CONTROL,
      flags: DiscordTxFlags.START | (bot.txAudioMode === "STEREO" ? DiscordTxFlags.STEREO : 0),
      botId: bot.botId,
      guildId: bot.guildId,
      voiceChannelId: bot.voiceChannelId,
    }));
    const changed = !this.#armed.has(bot.profileId) || !this.#live.has(bot.profileId);
    this.#armed.add(bot.profileId);
    this.#live.add(bot.profileId);
    if (changed) this.#txTargetsRevision++;
  }

  setTxTargets(ids: string[]): void {
    // Validate every target before replacing the operator selection.
    const validated = ids.map((id) => this.validateProfileId(id));
    if (validated.length > 22 || new Set(validated).size !== validated.length) throw new Error("TX targets must contain at most 22 unique profiles");
    for (const id of validated) this.requireTxBot(id);
    if (this.#armed.size !== validated.length || validated.some((id) => !this.#armed.has(id))) {
      this.#armed = new Set(validated);
      this.#txTargetsRevision++;
    }
  }

  private teamTxIds(): string[] {
    return this.txBots().filter((bot) => bot.txDestination?.startsWith("TEAM_")).map((bot) => bot.profileId);
  }

  isAllTeamsArmed(): boolean {
    const teams = this.teamTxIds();
    return teams.length > 0 && teams.every((id) => this.#armed.has(id));
  }

  requiresTxStartConfirmation(): boolean {
    return this.#armed.size >= 2 || this.isAllTeamsArmed();
  }

  startArmed(confirmed = false): void {
    if (this.requiresTxStartConfirmation() && !confirmed) throw new Error("Multi-destination / ALL TEAMS TX requires confirmation");
    const targets = [...this.#armed].map((id) => this.requireTxBot(id));
    if (!targets.length) { this.clearAllTx(); return; }
    for (const bot of targets) this.requireTxReady(bot);
    try {
      for (const id of [...this.#live]) if (!this.#armed.has(id)) this.stopTx(id);
      for (const bot of targets) this.startTx(bot.profileId);
    } catch (error) {
      // A failed group START must not leave a partially live broadcast.
      this.stopAllTx();
      this.emergencyStopAndFlushTx("TX group START failed; restart requires operator action");
      throw error;
    }
  }

  clearAllTx(): void {
    const congested = new Set<Socket>();
    for (const bot of this.txBots()) {
      const socket = this.#botSockets.get(bot.key);
      if (socket && socket.writableLength > TX_IPC_FLUSH_THRESHOLD_BYTES) congested.add(socket);
    }
    if (this.#armed.size) { this.#armed.clear(); this.#txTargetsRevision++; }
    this.stopAllTx();
    // Ordinary STOP preserves IPC/RX. Discard a materially delayed PCM queue.
    for (const socket of congested) this.flushTxSocket(socket);
    this.clearLiveTx();
  }

  private requireTxReady(bot: DiscordBotRuntime): Socket {
    if (this.engine.emergencyMuted) throw new Error("Discord TX cannot start while Emergency Mute is active");
    if (this.botHealth(bot, Date.now()) !== "READY") throw new Error(`${bot.profileId}がDiscord Voiceへ接続できていません`);
    const socket = this.#botSockets.get(bot.key);
    if (!socket?.writable || socket.destroyed) throw new Error(`${bot.profileId}のAdapter IPCが接続されていません`);
    return socket;
  }

  private clearTxStem(bot: DiscordBotRuntime): void {
    if (this.#live.delete(bot.profileId)) this.#txTargetsRevision++;
    bot.txEnabled = false;
    const stem = this.#txStems.get(bot.profileId);
    if (stem) { stem.peak = 0; stem.pcm.fill(0); }
  }

  private clearLiveTx(): void {
    if (this.#live.size) { this.#live.clear(); this.#txTargetsRevision++; }
  }

  stopTx(profileId?: string): void {
    const bot = this.commandTxBot(profileId);
    if (!bot) return;
    this.clearTxStem(bot);
    const socket = this.#botSockets.get(bot.key);
    if (socket?.writable && !socket.destroyed) {
      socket.write(encodeDiscordFrame({
        type: DiscordFrameType.TX_CONTROL,
        botId: bot.botId,
        guildId: bot.guildId,
        voiceChannelId: bot.voiceChannelId,
      }));
    }
  }

  stopAllTx(): void {
    for (const bot of this.txBots()) {
      try { this.stopTx(bot.profileId); }
      catch {
        const socket = this.#botSockets.get(bot.key);
        if (socket && !socket.destroyed) {
          this.flushTxSocket(socket);
        }
      }
    }
    this.clearLiveTx();
  }

  /**
   * Emergency path: stop every stem, scrub reusable PCM, and reset the IPC
   * transport so queued TX_PCM cannot reach an Adapter after the stop request.
   * The Adapter treats the disconnect as fail-closed and destroys PassThrough.
   */
  emergencyStopAndFlushTx(message = "Emergency mute latched; TX restart requires operator action"): void {
    const sockets = new Set<Socket>();
    for (const bot of this.txBots()) {
      this.clearTxStem(bot);
      bot.message = message;
      const socket = this.#botSockets.get(bot.key);
      if (socket && !socket.destroyed) sockets.add(socket);
    }
    for (const socket of sockets) {
      this.flushTxSocket(socket);
    }
  }

  private flushTxSocket(socket: Socket): void {
    if (socket.destroyed) return;
    try {
      if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
      else socket.destroy();
    } catch {
      try { socket.destroy(); } catch {}
    }
  }

  writeTxBlock(): void {
    if (this.engine.emergencyMuted) {
      if (this.#live.size) this.emergencyStopAndFlushTx();
      return;
    }
    const now = Date.now();
    for (const bot of this.txBots()) {
      const stem = this.txStem(bot);
      if (!this.#live.has(bot.profileId)) continue;
      if (this.botHealth(bot, now) !== "READY") { this.clearTxStem(bot); continue; }
      const socket = this.#botSockets.get(bot.key);
      if (!socket?.writable || socket.destroyed) { this.clearTxStem(bot); continue; }
      if (socket.writableLength > TX_IPC_FLUSH_THRESHOLD_BYTES) {
        stem.droppedFrames += 1;
        continue;
      }
      const directInput = stem.sourceInputChannelId !== undefined;
      const channel = stem.sourceInputChannelId ? this.engine.channels.get(stem.sourceInputChannelId) : undefined;
      const rightInput = stem.sourceInputRightChannelId ? this.engine.channels.get(stem.sourceInputRightChannelId) : undefined;
      // Missing/replaced inputs fail closed: never fall back to a Matrix output.
      if (directInput && channel?.kind !== "LocalMonoInput") { this.stopTx(bot.profileId); continue; }
      if (directInput && bot.txAudioMode === "STEREO" && rightInput?.kind !== "LocalMonoInput") { this.stopTx(bot.profileId); continue; }
      const left = directInput ? channel!.post : this.engine.outputs[stem.sourceOutput];
      const right = bot.txAudioMode !== "STEREO" ? left : directInput ? rightInput!.post : this.engine.outputs[stem.sourceOutput + 1];
      if (!left || !right) {
        stem.droppedFrames += 1;
        continue;
      }
      let peak = 0;
      for (let index = 0; index < left.length; index += 1) {
        const leftSample = Math.max(-1, Math.min(1, left[index] * stem.gain));
        const rightSample = Math.max(-1, Math.min(1, right[index] * stem.gain));
        peak = Math.max(peak, Math.abs(leftSample), Math.abs(rightSample));
        stem.pcm.writeInt16LE(Math.round(leftSample * 32767), index * 4);
        stem.pcm.writeInt16LE(Math.round(rightSample * 32767), index * 4 + 2);
      }
      stem.sequence = (stem.sequence + 1) >>> 0;
      socket.write(encodeDiscordFrame({
        type: DiscordFrameType.TX_PCM,
        flags: DiscordTxFlags.STEREO,
        sequence: stem.sequence,
        rtpTimestamp: (stem.sequence * this.engine.blockSize) >>> 0,
        botId: bot.botId,
        guildId: bot.guildId,
        voiceChannelId: bot.voiceChannelId,
        payload: stem.pcm,
      }));
      stem.framesSent += 1;
      stem.lastFrameAt = now;
      stem.peak = peak;
    }
  }

  private txSnapshotForBot(bot: DiscordBotRuntime, now: number): DiscordTxSnapshot {
    const stem = this.txStem(bot);
    const socket = this.#botSockets.get(bot.key);
    const ready = Boolean(socket?.writable && !socket.destroyed && this.botHealth(bot, now) === "READY");
    const state = bot.gatewayState === "fault" || bot.voiceState === "fault" ? "FAULT"
      : this.#live.has(bot.profileId) && ready && !this.engine.emergencyMuted ? "SENDING"
        : ready ? "READY" : "NOT_READY";
    return {
      state,
      active: this.#live.has(bot.profileId),
      destination: bot.txDestination,
      sourceOutput: stem.sourceOutput,
      masterDb: stem.masterDb,
      sourceInputChannelId: stem.sourceInputChannelId,
      sourceInputRightChannelId: bot.txAudioMode === "STEREO" ? stem.sourceInputRightChannelId : undefined,
      profileId: bot.profileId,
      label: bot.label,
      botId: bot.botId,
      guildId: bot.guildId,
      voiceChannelId: bot.voiceChannelId,
      voiceChannelName: bot.voiceChannelName,
      subtype: bot.txSubtype,
      audioMode: bot.txAudioMode,
      framesSent: stem.framesSent,
      droppedFrames: stem.droppedFrames,
      peak: stem.peak,
      lastFrameAgoMs: stem.lastFrameAt === 0 ? null : Math.max(0, now - stem.lastFrameAt),
    };
  }

  private txStem(bot: DiscordBotRuntime): TxStemRuntime {
    let stem = this.#txStems.get(bot.profileId);
    if (stem) return stem;
    const preferred = bot.txSubtype === "GAME" ? 56
      : bot.txSubtype === "CASTER" ? 58
        : bot.txSubtype === "COMMENTARY" ? 59
          : bot.txSubtype === "IFB" ? 60 : 63;
    const maximum = Math.max(0, this.engine.outputChannelCount - (bot.txAudioMode === "STEREO" ? 2 : 1));
    stem = {
      masterDb: 0,
      gain: 1,
      sourceOutput: Math.min(preferred, maximum),
      sequence: 0,
      framesSent: 0,
      droppedFrames: 0,
      lastFrameAt: 0,
      peak: 0,
      pcm: Buffer.alloc(this.engine.blockSize * 4),
    };
    this.#txStems.set(bot.profileId, stem);
    return stem;
  }

  private txBots(): DiscordBotRuntime[] {
    const order: Record<TxSubtype, number> = { GAME: 0, CASTER: 1, COMMENTARY: 2, IFB: 3, CUSTOM: 4 };
    return [...this.bots.values()].filter((bot) => bot.role === "TX" || bot.role === "DUPLEX")
      .sort((a, b) => (order[a.txSubtype ?? "CUSTOM"] - order[b.txSubtype ?? "CUSTOM"]) || a.profileId.localeCompare(b.profileId));
  }

  private txBot(profileId?: string): DiscordBotRuntime | undefined {
    const bots = this.txBots();
    return profileId ? bots.find((bot) => bot.profileId === profileId) : bots[0];
  }

  private commandTxBot(profileId?: string): DiscordBotRuntime | undefined {
    const bots = this.txBots();
    if (!profileId && bots.length > 1) throw new Error("複数のTX BotがあるためprofileIdを指定してください");
    if (profileId && bots.filter((bot) => bot.profileId === profileId).length > 1) throw new Error("TX profile identity conflict");
    return profileId ? bots.find((bot) => bot.profileId === profileId) : bots[0];
  }

  private requireTxBot(profileId?: string): DiscordBotRuntime {
    const bot = this.commandTxBot(profileId);
    if (!bot) throw new Error(profileId ? `TX Bot ${profileId}が設定されていません` : "TX Botが設定されていません");
    return bot;
  }

  private botByProfileId(profileId: string): DiscordBotRuntime | undefined {
    return [...this.bots.values()].find((bot) => bot.profileId === profileId);
  }

  private validateProfileId(profileId: string): string {
    const id = profileId.trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error("Discord Bot profile IDが不正です");
    return id;
  }

  private sendBotControl(action: DiscordBotControlAction, profileId: string): void {
    const socket = [...this.#sockets].find((candidate) => candidate.writable && !candidate.destroyed);
    if (!socket) throw new Error("Discord Adapter IPCが接続されていません");
    const payload: DiscordBotControlPayload = { action, profileId };
    socket.write(encodeDiscordFrame({
      type: DiscordFrameType.BOT_CONTROL,
      payload: Buffer.from(JSON.stringify(payload), "utf8"),
    }));
  }

  private accept(socket: Socket): void {
    const decoder = new DiscordFrameDecoder();
    this.#sockets.add(socket);
    this.#socketBots.set(socket, new Set());
    this.#socketSources.set(socket, new Map());
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      const startedAt = performance.now();
      try {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        const frames = decoder.push(bytes);
        const opusFrames = frames.reduce((count, frame) => count + Number(frame.type === DiscordFrameType.OPUS), 0);
        this.#currentBatch = { opusFrames, bytes: bytes.length, startedAt };
        this.#ipcBatches.count += 1;
        this.#ipcBatches.maxOpusFrames = Math.max(this.#ipcBatches.maxOpusFrames, opusFrames);
        this.#ipcBatches.maxBytes = Math.max(this.#ipcBatches.maxBytes, bytes.length);
        for (const frame of frames) {
          this.shadow?.mirror(frame);
          this.ingest(frame, socket);
        }
      } catch (error) {
        console.error("Invalid Discord IPC stream:", sanitizeOperatorMessage(error));
        socket.destroy();
      } finally {
        this.#ipcBatches.maxProcessingMs = Math.max(this.#ipcBatches.maxProcessingMs, performance.now() - startedAt);
        this.#currentBatch = null;
      }
    });
    const closed = () => {
      if (!this.#sockets.delete(socket)) return;
      const now = Date.now();
      for (const [id, generation] of this.#socketSources.get(socket) ?? []) {
        if (this.#sourceSockets.get(id) === socket) this.disposeSource(id, generation);
      }
      this.#socketSources.delete(socket);
      for (const key of this.#socketBots.get(socket) ?? []) {
        if (this.#botSockets.get(key) !== socket) continue;
        this.#botSockets.delete(key);
        const bot = this.bots.get(key);
        if (bot) {
          this.clearTxStem(bot);
          bot.voiceState = "ipc-disconnected";
          bot.lastStateAt = now;
          bot.message = "Discord Adapter IPC disconnected";
          this.handleOwnerAvailability(bot, now, true);
        }
      }
      this.releaseSocketAuthorities(socket);
    };
    socket.on("close", closed);
    socket.on("error", closed);
  }

  private ensureBot(frame: DiscordIpcFrame, now: number): DiscordBotRuntime {
    const key = botKey(frame);
    let bot = this.bots.get(key);
    if (bot) return bot;
    if (frame.botId && frame.botId !== "0") {
      bot = [...this.bots.values()].find((candidate) => candidate.botId === frame.botId && candidate.guildId === (frame.guildId ?? "0"));
      if (bot) {
        const previousKey = bot.key;
        this.clearTxStem(bot);
        this.bots.delete(previousKey);
        this.#botSockets.delete(previousKey);
        bot.key = key;
        bot.guildId = frame.guildId ?? "0";
        bot.voiceChannelId = frame.voiceChannelId ?? "0";
        this.bots.set(key, bot);
        return bot;
      }
    }
    if (this.bots.size >= MAX_TRACKED_BOTS) throw new Error(`too many Discord bots (maximum ${MAX_TRACKED_BOTS})`);
    bot = {
      txDestination: null,
      key,
      profileId: `BOT-${frame.botId ?? "0"}`,
      label: `Discord Bot ${frame.botId ?? "0"}`,
      role: "RX",
      txSubtype: null,
      txAudioMode: null,
      botId: frame.botId ?? "0",
      guildId: frame.guildId ?? "0",
      guildName: null,
      voiceChannelId: frame.voiceChannelId ?? "0",
      voiceChannelName: null,
      gatewayState: "unknown",
      voiceState: "unknown",
      wsPingMs: null,
      udpPingMs: null,
      reconnectCount: 0,
      lastAudioAt: null,
      txEnabled: false,
      txFrames: 0,
      txDroppedFrames: 0,
      lastTxFrameAt: null,
      lastHeartbeatAt: 0,
      lastStateAt: now,
      message: null,
    };
    this.bots.set(key, bot);
    return bot;
  }

  private applyStatus(bot: DiscordBotRuntime, payload: AdapterStatusPayload, now: number, heartbeat: boolean): void {
    if (typeof payload.profileId === "string" && payload.profileId.trim()) {
      const nextId = payload.profileId.trim().slice(0, 32);
      if (nextId !== bot.profileId) this.clearTxStem(bot);
      bot.profileId = nextId;
    }
    for (const [key, candidate] of this.bots) {
      if (candidate !== bot && candidate.botId === "0" && candidate.profileId === bot.profileId) {
        this.bots.delete(key);
        const placeholderBusId = `discord-vc:${candidate.guildId}:${candidate.voiceChannelId}`;
        if (this.engine.buses.get(placeholderBusId)?.autoCreated) this.engine.removeBus(placeholderBusId);
      }
    }
    if (typeof payload.label === "string" && payload.label.trim()) bot.label = payload.label.trim().slice(0, 80);
    if (payload.role === "RX" || payload.role === "TX" || payload.role === "DUPLEX" || payload.role === "SPARE") bot.role = payload.role;
    if (["GAME", "CASTER", "COMMENTARY", "IFB", "CUSTOM"].includes(String(payload.txSubtype))) bot.txSubtype = payload.txSubtype as TxSubtype;
    if (payload.txAudioMode === "MONO" || payload.txAudioMode === "STEREO") bot.txAudioMode = payload.txAudioMode;
    if (payload.txDestination === null || isTxDestination(payload.txDestination)) {
      if (payload.txDestination !== bot.txDestination) this.clearTxStem(bot);
      bot.txDestination = payload.txDestination as string | null;
    }
    if (this.txBots().some((candidate) => candidate !== bot && candidate.profileId === bot.profileId)) this.clearTxStem(bot);
    if ((bot.role === "TX" || bot.role === "DUPLEX") && bot.botId !== "0") this.#txBotIds.add(bot.botId);
    if (typeof payload.gatewayState === "string") bot.gatewayState = payload.gatewayState.slice(0, 32);
    if (typeof payload.voiceState === "string") {
      bot.voiceState = payload.voiceState.slice(0, 32);
      if (bot.voiceState !== "ready") this.clearTxStem(bot);
    }
    if (bot.gatewayState !== "ready" || (bot.role !== "TX" && bot.role !== "DUPLEX")) this.clearTxStem(bot);
    if (typeof payload.guildName === "string") bot.guildName = payload.guildName.slice(0, 100);
    if (typeof payload.voiceChannelName === "string") bot.voiceChannelName = payload.voiceChannelName.slice(0, 100);
    bot.wsPingMs = finiteOrNull(payload.wsPingMs);
    bot.udpPingMs = finiteOrNull(payload.udpPingMs);
    if (typeof payload.reconnectCount === "number" && Number.isSafeInteger(payload.reconnectCount) && payload.reconnectCount >= 0) bot.reconnectCount = payload.reconnectCount;
    if (typeof payload.lastAudioAt === "number" && Number.isFinite(payload.lastAudioAt) && payload.lastAudioAt > 0) bot.lastAudioAt = payload.lastAudioAt;
    if (typeof payload.txEnabled === "boolean") {
      // Old idle status cannot cancel a pending START; an explicit TX failure can.
      if (!payload.txEnabled && (bot.txEnabled || payload.txFailed === true)) this.clearTxStem(bot);
      bot.txEnabled = payload.txEnabled;
    }
    if (typeof payload.txFrames === "number" && Number.isSafeInteger(payload.txFrames) && payload.txFrames >= 0) bot.txFrames = payload.txFrames;
    if (typeof payload.txDroppedFrames === "number" && Number.isSafeInteger(payload.txDroppedFrames) && payload.txDroppedFrames >= 0) bot.txDroppedFrames = payload.txDroppedFrames;
    if (typeof payload.lastTxFrameAt === "number" && Number.isFinite(payload.lastTxFrameAt) && payload.lastTxFrameAt > 0) bot.lastTxFrameAt = payload.lastTxFrameAt;
    bot.message = typeof payload.message === "string" && payload.message ? payload.message.slice(0, 200) : null;
    bot.lastStateAt = now;
    if (heartbeat) bot.lastHeartbeatAt = now;
  }

  private botHealth(bot: DiscordBotRuntime, now: number): DiscordBotHealth {
    if (isRxCapable(bot.role) && this.#profileConflicts.has(bot.profileId)) return "FAULT";
    if (bot.gatewayState === "disconnected" && bot.voiceState === "disconnected") return "DISCONNECTED";
    const heartbeatBasis = bot.lastHeartbeatAt || bot.lastStateAt;
    if (heartbeatBasis > 0 && now - heartbeatBasis > BOT_STALE_MS) return "STALE";
    if (bot.gatewayState === "fault" || bot.voiceState === "fault") return "FAULT";
    if (bot.gatewayState === "ready" && bot.voiceState === "ready") return "READY";
    if (bot.gatewayState === "reconnecting" || ["reconnecting", "signalling"].includes(bot.voiceState)) return "RECONNECTING";
    if (["starting", "connecting", "idle", "unknown"].includes(bot.gatewayState) || ["connecting", "idle", "unknown"].includes(bot.voiceState)) return "CONNECTING";
    return "DISCONNECTED";
  }

  private isActiveReceiver(bot: DiscordBotRuntime): boolean {
    if (!isRxCapable(bot.role)) return false;
    if (this.#receiverOwners.get(receiverKey(bot.guildId, bot.voiceChannelId)) !== bot.profileId) return false;
    if (!this.isAuthoritativeReceiver(bot)) return false;
    return this.botHealth(bot, Date.now()) === "READY";
  }

  private rejectOpus(reason: string): void {
    this.#rejectedOpus[reason] = (this.#rejectedOpus[reason] ?? 0) + 1;
  }

  private applyRxIpcStatus(socket: Socket, value: unknown): void {
    if (!value || typeof value !== "object") return;
    const candidate = value as Record<string, unknown>;
    const stats: DiscordRxIpcSnapshot = { opusDroppedFrames: 0, backpressureWrites: 0, writableBytes: 0, maxWritableBytes: 0 };
    for (const key of Object.keys(stats) as Array<keyof DiscordRxIpcSnapshot>) {
      const counter = candidate[key];
      if (typeof counter !== "number" || !Number.isSafeInteger(counter) || counter < 0) return;
      stats[key] = counter;
    }
    this.#adapterRxIpc.set(socket, stats);
  }

  private isAuthoritativeReceiver(bot: DiscordBotRuntime): boolean {
    if (this.#profileConflicts.has(bot.profileId)) return false;
    const claims = this.#profileClaims.get(bot.profileId);
    if (!claims) return true; // In-process fixtures have no transport socket.
    const authority = this.#profileAuthority.get(bot.profileId);
    return Boolean(authority && authority.botKey === bot.key && claims.get(authority.socket) === bot.key && this.#botSockets.get(bot.key) === authority.socket);
  }

  private registerProfileAuthority(bot: DiscordBotRuntime, socket: Socket): void {
    for (const [claimedProfileId, claims] of this.#profileClaims) {
      if (claimedProfileId === bot.profileId || claims.get(socket) !== bot.key) continue;
      claims.delete(socket);
      if (claims.size === 0) this.#profileClaims.delete(claimedProfileId);
      if (this.#profileAuthority.get(claimedProfileId)?.socket === socket) this.#profileAuthority.delete(claimedProfileId);
    }
    let claims = this.#profileClaims.get(bot.profileId);
    const freshAfterConflict = !claims && this.#profileConflicts.has(bot.profileId);
    if (!claims) {
      claims = new Map();
      this.#profileClaims.set(bot.profileId, claims);
    }
    claims.set(socket, bot.key);
    if (freshAfterConflict) {
      this.#profileConflicts.delete(bot.profileId);
      this.#receiverEventHandler("WARNING", `Receiver authority conflict cleared after fresh reconnect: ${bot.profileId}`);
    }
    if (claims.size === 1 && !this.#profileConflicts.has(bot.profileId)) {
      this.#profileAuthority.set(bot.profileId, { socket, botKey: bot.key });
      return;
    }
    this.#profileAuthority.delete(bot.profileId);
    if (this.#profileConflicts.has(bot.profileId)) return;
    this.#profileConflicts.add(bot.profileId);
    const affected = new Set<string>();
    for (const candidate of this.bots.values()) {
      if (candidate.profileId !== bot.profileId || !isRxCapable(candidate.role)) continue;
      const key = receiverKey(candidate.guildId, candidate.voiceChannelId);
      if (affected.has(key)) continue;
      affected.add(key);
      this.disposeVoiceChannelSources(candidate.guildId, candidate.voiceChannelId);
      this.advanceReceiverGeneration(candidate.guildId, candidate.voiceChannelId);
    }
    this.#receiverEventHandler("CRITICAL", `Duplicate receiver authority: ${bot.profileId}; RX fail closed`);
  }

  private releaseSocketAuthorities(socket: Socket): void {
    for (const [profileId, claims] of this.#profileClaims) {
      claims.delete(socket);
      if (claims.size === 0) this.#profileClaims.delete(profileId);
      const authority = this.#profileAuthority.get(profileId);
      if (authority?.socket === socket) this.#profileAuthority.delete(profileId);
      if (claims.size === 1 && !this.#profileConflicts.has(profileId)) {
        const [remainingSocket, botKey] = claims.entries().next().value as [Socket, string];
        this.#profileAuthority.set(profileId, { socket: remainingSocket, botKey });
      }
    }
  }

  private currentReceiverGeneration(guildId: string, voiceChannelId: string): number {
    return this.#receiverGenerations.get(receiverKey(guildId, voiceChannelId)) ?? 0;
  }

  private advanceReceiverGeneration(guildId: string, voiceChannelId: string): number {
    const key = receiverKey(guildId, voiceChannelId);
    const generation = ((this.#receiverGenerations.get(key) ?? 0) + 1) >>> 0 || 1;
    this.#receiverGenerations.set(key, generation);
    return generation;
  }

  private reconcileReceiverOwner(guildId: string, voiceChannelId: string): void {
    const key = receiverKey(guildId, voiceChannelId);
    const configured = this.receiverStore?.get(guildId, voiceChannelId) ?? null;
    const candidates = [...this.bots.values()].filter((bot) => bot.guildId === guildId && bot.voiceChannelId === voiceChannelId && isRxCapable(bot.role));
    const primaryProfiles = [...new Set(candidates.filter((bot) => bot.role !== "SPARE").map((bot) => bot.profileId))];
    const candidateProfiles = [...new Set(candidates.map((bot) => bot.profileId))];
    const next = configured ?? (primaryProfiles.length === 1 ? primaryProfiles[0] : primaryProfiles.length === 0 && candidateProfiles.length === 1 ? candidateProfiles[0] : null);
    const previous = this.#receiverOwners.get(key) ?? null;
    if (previous === next) return;
    this.#receiverOwners.delete(key);
    this.disposeVoiceChannelSources(guildId, voiceChannelId);
    this.advanceReceiverGeneration(guildId, voiceChannelId);
    if (next) this.#receiverOwners.set(key, next);
    this.#unavailableOwnerWarnings.delete(key);
  }

  private handleOwnerAvailability(bot: DiscordBotRuntime, now: number, forceDisconnected = false): void {
    const key = receiverKey(bot.guildId, bot.voiceChannelId);
    if (this.#receiverOwners.get(key) !== bot.profileId) return;
    const health = forceDisconnected ? "DISCONNECTED" : this.botHealth(bot, now);
    if (health === "READY") {
      this.#unavailableOwnerWarnings.delete(key);
      return;
    }
    if (health !== "DISCONNECTED" && health !== "FAULT" && health !== "STALE") return;
    this.disposeVoiceChannelSources(bot.guildId, bot.voiceChannelId);
    if (this.#unavailableOwnerWarnings.has(key)) return;
    this.#unavailableOwnerWarnings.add(key);
    const candidates = [...this.bots.values()]
      .filter((candidate) => candidate.guildId === bot.guildId && candidate.voiceChannelId === bot.voiceChannelId && candidate.profileId !== bot.profileId && isRxCapable(candidate.role) && this.botHealth(candidate, now) === "READY")
      .map((candidate) => candidate.profileId);
    const suffix = candidates.length ? `; standby available: ${candidates.join(", ")}` : "; no standby ready";
    this.#receiverEventHandler("WARNING", `${bot.label} receiver disconnected${suffix}`);
  }

  private disposeVoiceChannelSources(guildId: string, voiceChannelId: string): void {
    for (const [id, runtime] of [...this.runtimes]) {
      if (runtime.guildId === guildId && runtime.voiceChannelId === voiceChannelId) this.disposeSource(id, runtime.sourceGeneration);
    }
  }

  private ensureSource(frame: DiscordIpcFrame, sourceGeneration: number, socket?: Socket, displayName = ""): { channel: AudioChannel; runtime: DiscordSourceRuntime } | null {
    const id = discordSourceId(frame);
    let runtime = this.runtimes.get(id);
    let channel = this.engine.channels.get(id);
    if (!runtime) {
      if (this.runtimes.size >= MAX_DISCORD_RX_CHANNELS || this.engine.channels.size >= MAX_RX_CHANNELS) {
        if (!this.#capacityRejectedSources.has(id)) {
          this.#capacityRejectedSources.add(id);
          this.#receiverEventHandler("WARNING", `Discord receive capacity reached (${MAX_DISCORD_RX_CHANNELS}); additional participant audio ignored`);
        }
        return null;
      }
      this.#capacityRejectedSources.delete(id);
      const factory = this.#decoderFactory;
      if (!factory) {
        this.#decodeErrors += 1;
        return null;
      }
      let decoder: OpusDecoder;
      try {
        decoder = factory.create48kMono();
      } catch {
        this.#decodeErrors += 1;
        this.#decoderState = "UNAVAILABLE";
        this.#decoderFactory = null;
        return null;
      }
      const voiceBus = this.ensureVoiceBus(frame);
      // Bounded jitter playout and sender-clock correction are RX-only. The
      // physical output clock and local-input rings are deliberately unchanged.
      const capacity = this.engine.blockSize * DISCORD_RX_BUFFER_BLOCKS;
      const source = new DiscordPcmSource(capacity, this.engine.sampleRate, this.engine.blockSize);
      runtime = {
        decoder,
        source,
        botId: frame.botId ?? "0",
        guildId: frame.guildId ?? "0",
        voiceChannelId: frame.voiceChannelId ?? "0",
        userId: frame.userId ?? "0",
        sourceGeneration,
        receiverGeneration: this.currentReceiverGeneration(frame.guildId ?? "0", frame.voiceChannelId ?? "0"),
        packets: 0,
        decodedSamples: 0,
        decodeErrors: 0,
        lastPacketAt: 0,
        lastSequence: null,
        sequenceGaps: 0,
        rxTiming: { maxPacketGapMs: 0, maxQueuedMilliseconds: 0, overflowEvents: 0, lastOverflow: null },
      };
      this.runtimes.set(id, runtime);
    }
    const voiceBus = this.ensureVoiceBus(frame);
    if (!channel) {
      const discordUserId = frame.userId ?? "0";
      const prior = [...this.runtimes.entries()].find(([candidateId, candidate]) => candidateId !== id && candidate.userId === discordUserId);
      if (prior) this.disposeSource(prior[0], prior[1].sourceGeneration);
      channel = new AudioChannel(
        id,
        displayName || `Discord ${discordUserId}`,
        "DiscordUser",
        runtime.source,
        this.engine.blockSize,
        this.engine.sampleRate,
      );
      channel.vcSends.set(voiceBus.id, voiceBus.newParticipantSend());
      this.userSessions?.join(channel, discordUserId, frame.voiceChannelId ?? "0", displayName || channel.label);
      this.migrateLegacyVoiceBusSend(channel, frame, voiceBus.id);
      if (
        channel.directOutput &&
        channel.directOutput.output >= this.engine.outputChannelCount
      ) {
        channel.directOutput = undefined;
      }
      this.engine.addChannel(channel);
    } else if (this.userSessions) {
      this.userSessions.join(channel, frame.userId ?? "0", frame.voiceChannelId ?? "0", displayName || channel.label);
      this.migrateLegacyVoiceBusSend(channel, frame, voiceBus.id);
    }
    if (socket) this.trackSocketSource(socket, id, sourceGeneration);
    return { channel, runtime };
  }

  private trackSocketSource(socket: Socket, id: string, generation: number): void {
    const previous = this.#sourceSockets.get(id);
    if (previous && previous !== socket) this.#socketSources.get(previous)?.delete(id);
    const sources = this.#socketSources.get(socket) ?? new Map<string, number>();
    sources.set(id, generation);
    this.#socketSources.set(socket, sources);
    this.#sourceSockets.set(id, socket);
  }

  private migrateLegacyVoiceBusSend(channel: AudioChannel, frame: DiscordIpcFrame, canonicalBusId: string): void {
    const suffix = `:${frame.guildId ?? "0"}:${frame.voiceChannelId ?? "0"}`;
    const legacy = [...channel.vcSends].find(([busId]) => busId !== canonicalBusId && busId.startsWith("discord-vc:") && busId.endsWith(suffix));
    if (!legacy) return;
    channel.vcSends.set(canonicalBusId, { ...legacy[1] });
    for (const busId of [...channel.vcSends.keys()]) {
      if (busId !== canonicalBusId && busId.startsWith("discord-vc:") && busId.endsWith(suffix)) channel.vcSends.delete(busId);
    }
    this.userSessions?.captureChannel(channel);
  }

  private disposeSource(id: string, expectedGeneration?: number): boolean {
    const runtime = this.runtimes.get(id);
    if (!runtime || (expectedGeneration !== undefined && runtime.sourceGeneration !== expectedGeneration)) return false;
    const owner = this.#sourceSockets.get(id);
    const channel = this.engine.channels.get(id);
    try {
      runtime.decoder.dispose();
    } catch {
      this.#decodeErrors += 1;
    } finally {
      try {
        runtime.source.clear();
      } finally {
        if (channel) this.userSessions?.leave(channel);
        this.#retiredRxUnderruns += runtime.source.timing?.underruns ?? 0;
        this.#retiredRxInSpeechUnderruns += runtime.source.timing?.inSpeechUnderruns ?? 0;
        this.#retiredRxOverflows += runtime.rxTiming.overflowEvents;
        this.runtimes.delete(id);
        this.#sourceSockets.delete(id);
        owner && this.#socketSources.get(owner)?.delete(id);
        this.engine.removeChannel(id);
      }
    }
    return true;
  }

  /** Test-only bounded ownership projection; it contains no Discord identities. */
  ownershipTrackingCounts(): { sockets: number; sources: number } {
    let sources = 0;
    for (const entries of this.#socketSources.values()) sources += entries.size;
    return { sockets: this.#socketSources.size, sources };
  }

  private claimBotSocket(frame: DiscordIpcFrame, socket: Socket): boolean {
    const key = botKey(frame);
    const previous = this.#botSockets.get(key);
    if (previous === socket) return true;
    // A socket that already lost this Bot authority cannot reclaim it with a
    // delayed BOT_META; only a new socket may perform takeover.
    if (previous && this.#socketBots.get(socket)?.has(key)) return false;
    if (previous) {
      for (const [id, owner] of this.#sourceSockets) {
        const runtime = this.runtimes.get(id);
        if (owner === previous && runtime && runtime.botId === frame.botId && runtime.guildId === frame.guildId) this.disposeSource(id);
      }
      for (const [candidateKey, candidateSocket] of this.#botSockets) {
        const candidate = this.bots.get(candidateKey);
        if (candidateSocket === previous && candidate && candidate.botId === frame.botId && candidate.guildId === frame.guildId) {
          this.clearTxStem(candidate);
          this.#botSockets.delete(candidateKey);
        }
      }
    }
    const keys = this.#socketBots.get(socket) ?? new Set<string>();
    keys.add(key);
    this.#socketBots.set(socket, keys);
    this.#botSockets.set(key, socket);
    return true;
  }

  private ensureVoiceBus(frame: DiscordIpcFrame, label?: string | null): VcBus {
    const guildId = frame.guildId ?? "0";
    const voiceChannelId = frame.voiceChannelId ?? "0";
    const linked = [...this.engine.buses.values()].find((candidate) => candidate.linkedDiscordGuildId === guildId && candidate.linkedDiscordVoiceChannelId === voiceChannelId);
    const id = linked?.id ?? discordVoiceBusId(frame);
    let bus = linked ?? this.engine.buses.get(id);
    if (!bus) {
      const vcLabel = label?.trim() || `Discord VC ${frame.voiceChannelId ?? "0"}`;
      bus = new VcBus(id, vcLabel, this.engine.blockSize, this.engine.sampleRate);
      bus.autoCreated = true;
      bus.newParticipantPolicy = "SAFE";
      bus.defaultSendDb = -12;
      bus.linkedDiscordGuildId = guildId;
      bus.linkedDiscordVoiceChannelId = voiceChannelId;
      this.engine.addBus(bus);
    } else if (label?.trim() && bus.autoCreated) {
      bus.label = label.trim().slice(0, 80);
    }
    return bus;
  }
}

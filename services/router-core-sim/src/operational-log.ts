import { createWriteStream, mkdirSync, readdirSync, rmSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import type { LogLevel, RouterSnapshot, RuntimeInfoSnapshot } from "../../../packages/shared-types/src/index.ts";
import { sanitizeOperatorMessage } from "./operator-sanitize.ts";

export type OperationalEvent = RouterSnapshot["alerts"][number] & { runtimeInfo?: RuntimeInfoSnapshot };

const DAY_MS = 86_400_000;
const NETWORK_WARN_MS = 250;
const NETWORK_RECOVER_MS = 200;
const QUEUE_WARN_MS = 60;
const QUEUE_RECOVER_MS = 40;
const MAX_PENDING_LOG_BYTES = 1024 * 1024;

function dateKey(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

export class OperationalLog {
  readonly directory: string;
  readonly retentionDays: number;
  readonly now: () => Date;
  #writeWarningShown = false;
  #stream: WriteStream | null = null;
  #path = "";
  #streams = new Set<WriteStream>();
  #closed = false;
  #droppedEvents = 0;

  constructor(settingsRoot: string, retentionDays = 7, now: () => Date = () => new Date()) {
    this.directory = join(settingsRoot, "logs");
    this.retentionDays = Math.max(1, Math.floor(retentionDays));
    this.now = now;
    mkdirSync(this.directory, { recursive: true });
    this.prune();
  }

  append(event: OperationalEvent): void {
    if (this.#closed) return;
    const safe: OperationalEvent = {
      at: event.at,
      level: event.level,
      message: sanitizeOperatorMessage(event.message, "Operational event"),
      ...(event.runtimeInfo ? { runtimeInfo: { ...event.runtimeInfo } } : {}),
    };
    try {
      const line = `${JSON.stringify(safe)}\n`;
      const dropped = this.#droppedEvents ? `${JSON.stringify({ at: this.now().toISOString(), level: "WARNING", message: `Operational log queue recovered: ${this.#droppedEvents} events dropped` })}\n` : "";
      const pendingBytes = [...this.#streams].reduce((sum, stream) => sum + stream.writableLength, 0);
      if (pendingBytes + Buffer.byteLength(dropped) + Buffer.byteLength(line) > MAX_PENDING_LOG_BYTES) {
        this.#droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, this.#droppedEvents + 1);
        this.warnOnce();
        return;
      }
      const path = this.pathFor();
      if (!this.#stream || path !== this.#path) {
        this.#stream?.end();
        const stream = createWriteStream(path, { flags: "a", encoding: "utf8" });
        this.#stream = stream;
        this.#path = path;
        this.#streams.add(stream);
        stream.on("error", () => {
          if (this.#stream === stream) this.#stream = null;
          this.warnOnce();
        });
        stream.once("close", () => this.#streams.delete(stream));
      }
      if (dropped) {
        this.#stream.write(dropped);
        this.#droppedEvents = 0;
      }
      this.#stream.write(line);
    } catch {
      this.warnOnce();
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#streams].map((stream) => {
      const done = finished(stream, { cleanup: true }).catch(() => this.warnOnce());
      stream.end();
      return done;
    }));
  }

  private warnOnce(): void {
    if (!this.#writeWarningShown) console.error("Operational log write failed");
    this.#writeWarningShown = true;
  }

  pathFor(date = this.now()): string {
    return join(this.directory, `operational-${dateKey(date)}.jsonl`);
  }

  private prune(): void {
    const cutoff = dateKey(new Date(this.now().getTime() - (this.retentionDays - 1) * DAY_MS));
    for (const name of readdirSync(this.directory)) {
      const match = /^operational-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (match && match[1] < cutoff) rmSync(join(this.directory, name), { force: true });
    }
  }
}

type HealthEvent = { level: LogLevel; message: string };
type BotBaseline = { health: string; reconnectCount: number; txDroppedFrames: number; wsHigh: boolean; udpHigh: boolean };
type SourceBaseline = { decodeErrors: number; sequenceGaps: number; droppedSamples: number; queueHigh: boolean };

export class OperationalHealthTracker {
  #initialized = false;
  #adapterState = "";
  #bots = new Map<string, BotBaseline>();
  #sources = new Map<string, SourceBaseline>();
  #decodeErrors = 0;
  #outputDrops = 0;
  #xruns = 0;
  #recorderDrops = 0;
  #outputState = "";
  #inputState = "";
  #rxRejectedOpus: Record<string, number> = {};
  #rxIpcDrops = 0;
  #rxIpcBackpressureWrites = 0;

  observe(snapshot: RouterSnapshot): HealthEvent[] {
    const events: HealthEvent[] = [];
    const discord = snapshot.discord;
    if (!discord) return events;

    if (this.#initialized && discord.adapterState !== this.#adapterState) {
      events.push({ level: discord.adapterState === "READY" ? "INFO" : "WARNING", message: `Discord Adapter: ${this.#adapterState} → ${discord.adapterState}` });
    }

    const nextBots = new Map<string, BotBaseline>();
    for (const bot of discord.bots) {
      const previous = this.#bots.get(bot.key);
      const current = {
        health: bot.health,
        reconnectCount: bot.reconnectCount,
        txDroppedFrames: bot.txDroppedFrames,
        wsHigh: (bot.wsPingMs ?? 0) > NETWORK_WARN_MS,
        udpHigh: (bot.udpPingMs ?? 0) > NETWORK_WARN_MS,
      };
      nextBots.set(bot.key, current);
      if (!this.#initialized || !previous) continue;
      if (bot.health !== previous.health) events.push({ level: bot.health === "READY" ? "INFO" : "WARNING", message: `${bot.label}: ${previous.health} → ${bot.health}` });
      if (bot.reconnectCount > previous.reconnectCount) events.push({ level: "WARNING", message: `${bot.label}: Discord reconnect +${bot.reconnectCount - previous.reconnectCount}` });
      if (bot.txDroppedFrames > previous.txDroppedFrames) events.push({ level: "WARNING", message: `${bot.label}: TX dropped frames +${bot.txDroppedFrames - previous.txDroppedFrames}` });
      this.appendThresholdEvent(events, `${bot.label}: WebSocket ping`, previous.wsHigh, current.wsHigh, bot.wsPingMs);
      this.appendThresholdEvent(events, `${bot.label}: Voice UDP ping`, previous.udpHigh, current.udpHigh, bot.udpPingMs);
    }

    const labels = new Map(snapshot.channels.map((channel) => [channel.id, channel.label]));
    const nextSources = new Map<string, SourceBaseline>();
    for (const source of discord.sources) {
      const previous = this.#sources.get(source.channelId);
      const current = {
        decodeErrors: source.decodeErrors,
        sequenceGaps: source.sequenceGaps,
        droppedSamples: source.droppedSamples,
        queueHigh: source.queuedMilliseconds > QUEUE_WARN_MS,
      };
      nextSources.set(source.channelId, current);
      if (!this.#initialized || !previous) continue;
      const label = labels.get(source.channelId) ?? "Discord participant";
      this.appendCounterEvent(events, `${label}: decode errors`, previous.decodeErrors, current.decodeErrors);
      this.appendCounterEvent(events, `${label}: packet sequence gaps`, previous.sequenceGaps, current.sequenceGaps);
      this.appendCounterEvent(events, `${label}: audio samples dropped`, previous.droppedSamples, current.droppedSamples);
      const overflow = source.rxTiming?.lastOverflow;
      if (current.droppedSamples > previous.droppedSamples && overflow) {
        events.push({ level: "INFO", message: `${label.slice(0, 40)}: RX overflow ${overflow.at}; q=${overflow.queuedBeforeMilliseconds.toFixed(1)}ms in=${overflow.incomingSamples} drop=${overflow.droppedSamples} gap=${overflow.packetGapMs}ms batch=${overflow.batchOpusFrames} bytes=${overflow.batchBytes} elapsed=${overflow.batchElapsedMs.toFixed(1)}ms maxWork=${(discord.rxDiagnostics?.ipcBatches.maxProcessingMs ?? 0).toFixed(1)}ms` });
      }
      if (!previous.queueHigh && current.queueHigh) events.push({ level: "WARNING", message: `${label}: receive queue high (${source.queuedMilliseconds.toFixed(0)} ms)` });
      else if (previous.queueHigh && source.queuedMilliseconds <= QUEUE_RECOVER_MS) events.push({ level: "INFO", message: `${label}: receive queue recovered (${source.queuedMilliseconds.toFixed(0)} ms)` });
    }

    const rxDiagnostics = discord.rxDiagnostics;
    const ipcDrops = rxDiagnostics?.adapterIpc.reduce((sum, adapter) => sum + adapter.opusDroppedFrames, 0) ?? 0;
    const ipcBackpressureWrites = rxDiagnostics?.adapterIpc.reduce((sum, adapter) => sum + adapter.backpressureWrites, 0) ?? 0;
    if (this.#initialized && rxDiagnostics) {
      for (const [reason, count] of Object.entries(rxDiagnostics.rejectedOpus)) {
        this.appendCounterEvent(events, `Discord RX rejected (${reason})`, this.#rxRejectedOpus[reason] ?? 0, count);
      }
      this.appendCounterEvent(events, "Discord RX IPC Opus dropped", this.#rxIpcDrops, ipcDrops);
      this.appendCounterEvent(events, "Discord RX IPC backpressure writes (queued, not dropped)", this.#rxIpcBackpressureWrites, ipcBackpressureWrites);
    }

    if (this.#initialized) {
      this.appendCounterEvent(events, "Discord decode errors", this.#decodeErrors, discord.decodeErrors);
      this.appendCounterEvent(events, "Audio output backpressure drops", this.#outputDrops, snapshot.output?.backpressureDrops ?? 0);
      this.appendCounterEvent(events, "Audio engine xruns", this.#xruns, snapshot.xruns);
      this.appendCounterEvent(events, "Recorder dropped blocks", this.#recorderDrops, snapshot.recorder?.droppedBlocks ?? 0);
      if (snapshot.output && snapshot.output.state !== this.#outputState) events.push({ level: snapshot.output.state === "READY" ? "INFO" : "WARNING", message: `Audio output: ${this.#outputState} → ${snapshot.output.state}` });
      if (snapshot.input && snapshot.input.state !== this.#inputState) events.push({ level: snapshot.input.state === "READY" ? "INFO" : "WARNING", message: `Audio input: ${this.#inputState} → ${snapshot.input.state}` });
    }

    this.#initialized = true;
    this.#adapterState = discord.adapterState;
    this.#bots = nextBots;
    this.#sources = nextSources;
    this.#decodeErrors = discord.decodeErrors;
    this.#outputDrops = snapshot.output?.backpressureDrops ?? 0;
    this.#xruns = snapshot.xruns;
    this.#recorderDrops = snapshot.recorder?.droppedBlocks ?? 0;
    this.#outputState = snapshot.output?.state ?? "";
    this.#inputState = snapshot.input?.state ?? "";
    this.#rxRejectedOpus = { ...rxDiagnostics?.rejectedOpus };
    this.#rxIpcDrops = ipcDrops;
    this.#rxIpcBackpressureWrites = ipcBackpressureWrites;
    return events;
  }

  private appendCounterEvent(events: HealthEvent[], label: string, previous: number, current: number): void {
    if (current > previous) events.push({ level: "WARNING", message: `${label} +${current - previous}` });
  }

  private appendThresholdEvent(events: HealthEvent[], label: string, wasHigh: boolean, isHigh: boolean, value: number | null): void {
    if (!wasHigh && isHigh && value !== null) events.push({ level: "WARNING", message: `${label} high (${value.toFixed(0)} ms)` });
    else if (wasHigh && value !== null && value <= NETWORK_RECOVER_MS) events.push({ level: "INFO", message: `${label} recovered (${value.toFixed(0)} ms)` });
  }
}

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { open, statfs } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { MAX_OUTPUT_CHANNELS, MAX_RX_CHANNELS, MAX_VC_BUSES, type RecorderSelection, type RecorderSnapshot, type RecorderState, type RecorderTrackKind, type RecorderTrackSnapshot } from "../../../packages/shared-types/src/index.ts";
import type { AudioEngine } from "./audio-engine.ts";

interface RecorderTrack {
  kind: RecorderTrackKind;
  sourceId: string;
  label: string;
  fileName: string;
  source: () => Float32Array | undefined;
  writer: WavFloatWriter;
}

interface QueuedBlock {
  buffers: Buffer[];
}

export interface RecorderStartOptions {
  matrixOutput: number;
  includeUsers: boolean;
  includeBuses: boolean;
  selection?: RecorderSelection;
}

/** Shared by the command boundary and direct recorder callers, before creating files. */
export function isRecorderSelection(value: unknown): value is RecorderSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  const ids = (list: unknown, limit: number) => Array.isArray(list) && list.length <= limit
    && new Set(list).size === list.length && Array.from(list).every((id) => typeof id === "string" && id.length > 0 && id.length <= 256);
  return Array.isArray(selection.outputs) && selection.outputs.length <= MAX_OUTPUT_CHANNELS
    && new Set(selection.outputs).size === selection.outputs.length
    && Array.from(selection.outputs).every((output) => Number.isInteger(output) && output >= 0 && output < MAX_OUTPUT_CHANNELS)
    && ids(selection.busIds, MAX_VC_BUSES) && ids(selection.channelIds, MAX_RX_CHANNELS);
}

export interface RecorderManagerOptions {
  maxQueuedBlocks?: number;
  scheduleDrain?: (callback: () => void) => void;
}

function wavHeader(sampleRate: number, dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(Math.min(0xffffffff, 36 + dataBytes), 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // IEEE float
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(Math.min(0xffffffff, dataBytes), 40);
  return header;
}

class WavFloatWriter {
  readonly path: string;
  readonly sampleRate: number;
  readonly stream: WriteStream;
  dataBytes = 0;
  #finalized = false;

  constructor(path: string, sampleRate: number, onError: (error: Error) => void) {
    this.path = path;
    this.sampleRate = sampleRate;
    this.stream = createWriteStream(path, { flags: "w" });
    this.stream.on("error", onError);
    this.stream.write(wavHeader(sampleRate, 0));
  }

  async write(buffer: Buffer): Promise<void> {
    if (this.#finalized) return;
    await new Promise<void>((resolve, reject) => {
      this.stream.write(buffer, (error) => error ? reject(error) : resolve());
    });
    this.dataBytes += buffer.length;
  }

  async finalize(): Promise<void> {
    if (this.#finalized) return;
    this.#finalized = true;
    if (this.stream.errored) throw this.stream.errored;
    if (this.stream.destroyed && !this.stream.writableFinished) throw new Error("Recorder stream closed before finishing");
    const completion = finished(this.stream, { cleanup: true });
    this.stream.end();
    await completion;
    const handle = await open(this.path, "r+");
    try {
      await handle.write(wavHeader(this.sampleRate, this.dataBytes), 0, 44, 0);
    } finally {
      await handle.close();
    }
  }
}

function safeName(value: string): string {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}_.-]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "Track";
}

function timePrefix(date: Date): string {
  const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
  const [year, month, day, hour, minute, second] = parts.map((value, index) => index === 0 ? String(value) : String(value).padStart(2, "0"));
  return `${year}-${month}-${day}_${hour}-${minute}-${second}-${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function floatBlock(source: Float32Array | undefined, silence: Float32Array): Buffer {
  const samples = source ?? silence;
  return Buffer.from(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
}

export class RecorderManager {
  readonly engine: AudioEngine;
  readonly folder: string;
  readonly maxQueuedBlocks: number;
  readonly scheduleDrain: (callback: () => void) => void;
  state: RecorderState = "IDLE";
  matrixOutput = 63;
  includeUsers = false;
  includeBuses = false;
  selection?: RecorderSelection;
  startedAt: Date | null = null;
  stoppedAt: Date | null = null;
  droppedBlocks = 0;
  freeBytes: number | null = null;
  totalBytes: number | null = null;
  message: string | null = null;
  readonly tracks: RecorderTrack[] = [];
  readonly queue: QueuedBlock[] = [];
  readonly silence: Float32Array;
  #draining = false;
  #finishRequested = false;
  #finalizePromise: Promise<void> | null = null;
  #diskTimer: NodeJS.Timeout;

  constructor(engine: AudioEngine, folder: string, options: RecorderManagerOptions = {}) {
    this.engine = engine;
    this.folder = resolve(folder);
    this.maxQueuedBlocks = Math.max(10, Math.trunc(options.maxQueuedBlocks ?? 200));
    this.scheduleDrain = options.scheduleDrain ?? ((callback) => setImmediate(callback));
    this.silence = new Float32Array(engine.blockSize);
    void this.refreshDiskSpace();
    this.#diskTimer = setInterval(() => void this.refreshDiskSpace(), 5_000);
    this.#diskTimer.unref();
  }

  start(options: RecorderStartOptions): void {
    if (this.state === "RECORDING" || this.state === "STOPPING") throw new Error("Recorderはすでに動作中です");
    if (this.#finishRequested) throw new Error("Recorderの終了処理が完了するまで待ってください");
    if (!Number.isInteger(options.matrixOutput) || options.matrixOutput < 0 || options.matrixOutput >= this.engine.outputs.length) {
      throw new RangeError(`Matrix OUTは1〜${this.engine.outputs.length}で指定してください`);
    }
    const selection = options.selection === undefined ? {
      outputs: [options.matrixOutput],
      busIds: options.includeBuses ? [...this.engine.buses.keys()] : [],
      channelIds: options.includeUsers ? [...this.engine.channels.keys()] : [],
    } : options.selection;
    if (!isRecorderSelection(selection)) throw new Error("録音対象の指定が不正です");
    if (!selection.outputs.length && !selection.busIds.length && !selection.channelIds.length) throw new Error("録音対象を1つ以上選択してください");
    if (selection.outputs.some((output) => output >= this.engine.outputs.length)
      || selection.busIds.some((id) => !this.engine.buses.has(id))
      || selection.channelIds.some((id) => !this.engine.channels.has(id))) {
      throw new Error("録音対象が見つかりません。対象を選び直してください");
    }
    this.resetSession();
    this.selection = { outputs: [...selection.outputs], busIds: [...selection.busIds], channelIds: [...selection.channelIds] };
    this.matrixOutput = selection.outputs[0] ?? options.matrixOutput;
    this.includeUsers = selection.channelIds.length > 0;
    this.includeBuses = selection.busIds.length > 0;
    try {
      mkdirSync(this.folder, { recursive: true });
      void this.refreshDiskSpace();
      const prefix = timePrefix(new Date());
      for (const output of selection.outputs) {
        this.addTrack("MATRIX", `matrix-${output + 1}`, `Program OUT ${output + 1}`, () => this.engine.outputs[output], prefix);
      }
      for (const id of selection.busIds) {
        const bus = this.engine.buses.get(id)!;
        this.addTrack("VC_BUS", id, bus.label, () => this.engine.buses.get(id)?.preMaster, prefix);
      }
      for (const id of selection.channelIds) {
        const channel = this.engine.channels.get(id)!;
        const kind: RecorderTrackKind = channel.kind === "DiscordUser" ? "DISCORD_USER" : "LOCAL_INPUT";
        this.addTrack(kind, id, channel.label, () => this.engine.channels.get(id)?.processed, prefix);
      }
      this.startedAt = new Date();
      this.state = "RECORDING";
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  captureBlock(): void {
    if (this.state !== "RECORDING") return;
    if (this.tracks.some((track) => track.writer.dataBytes + ((this.queue.length + 1) * this.engine.blockSize * 4) > 0xffff_ff00)) {
      this.fail(new Error("WAVの4 GiB上限に達するため録音を停止しました。新しいSessionを開始してください"));
      return;
    }
    if (this.queue.length >= this.maxQueuedBlocks) {
      this.droppedBlocks += 1;
      this.fail(new Error(`Recorder Queueが${this.maxQueuedBlocks} blockを超えました。録音だけを停止しました`));
      return;
    }
    this.queue.push({ buffers: this.tracks.map((track) => floatBlock(this.engine.emergencyMuted ? this.silence : track.source(), this.silence)) });
    this.requestDrain();
  }

  /** Drops blocks not yet handed to the WAV writers; recording continues with post-emergency silence. */
  discardPendingAudio(): number {
    return this.queue.splice(0).length;
  }

  stop(): void {
    if (this.state !== "RECORDING") throw new Error("Recorderは録音中ではありません");
    this.state = "STOPPING";
    this.stoppedAt = new Date();
    this.#finishRequested = true;
    this.requestDrain();
  }

  snapshot(now = new Date()): RecorderSnapshot {
    const end = this.state === "RECORDING" ? now : this.stoppedAt ?? now;
    const durationSeconds = this.startedAt ? Math.max(0, (end.getTime() - this.startedAt.getTime()) / 1000) : 0;
    return {
      state: this.state,
      folder: this.folder,
      format: "WAV_FLOAT32",
      sampleRate: this.engine.sampleRate,
      startedAt: this.startedAt?.toISOString() ?? null,
      durationSeconds,
      matrixOutput: this.matrixOutput,
      includeUsers: this.includeUsers,
      includeBuses: this.includeBuses,
      selection: this.selection ? { outputs: [...this.selection.outputs], busIds: [...this.selection.busIds], channelIds: [...this.selection.channelIds] } : undefined,
      selectionSupported: true,
      queuedBlocks: this.queue.length,
      maxQueuedBlocks: this.maxQueuedBlocks,
      droppedBlocks: this.droppedBlocks,
      freeBytes: this.freeBytes,
      totalBytes: this.totalBytes,
      message: this.message,
      tracks: this.tracks.map((track): RecorderTrackSnapshot => ({
        kind: track.kind,
        sourceId: track.sourceId,
        label: track.label,
        fileName: track.fileName,
        dataBytes: track.writer.dataBytes,
      })),
    };
  }

  async waitForIdle(): Promise<void> {
    while (this.#draining || this.queue.length > 0 || (this.#finishRequested && !this.#finalizePromise)) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
    }
    await this.#finalizePromise;
  }

  async close(): Promise<void> {
    clearInterval(this.#diskTimer);
    if (this.state === "RECORDING") this.stop();
    await this.waitForIdle();
  }

  private addTrack(kind: RecorderTrackKind, sourceId: string, label: string, source: () => Float32Array | undefined, prefix: string): void {
    const fileName = `${prefix}_${kind}_${safeName(label)}_${safeName(sourceId)}.wav`;
    const writer = new WavFloatWriter(join(this.folder, fileName), this.engine.sampleRate, (error) => this.fail(error));
    this.tracks.push({ kind, sourceId, label, fileName: basename(fileName), source, writer });
  }

  private resetSession(): void {
    this.tracks.length = 0;
    this.queue.length = 0;
    this.droppedBlocks = 0;
    this.message = null;
    this.startedAt = null;
    this.stoppedAt = null;
    this.#finishRequested = false;
    this.#finalizePromise = null;
    this.state = "IDLE";
  }

  private requestDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    this.scheduleDrain(() => void this.drain());
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length) {
        const block = this.queue.shift()!;
        await Promise.all(this.tracks.map((track, index) => track.writer.write(block.buffers[index])));
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.#draining = false;
    }
    if (this.queue.length) {
      this.requestDrain();
      return;
    }
    if (this.#finishRequested && !this.#finalizePromise) {
      this.#finalizePromise = this.finalize();
      await this.#finalizePromise;
    }
  }

  private async finalize(): Promise<void> {
    try {
      // Do not allow restart while another track is still finalizing after one fails.
      const results = await Promise.allSettled(this.tracks.map((track) => track.writer.finalize()));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      if (this.state === "STOPPING") this.state = "IDLE";
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
      this.state = "FAULT";
    }
    this.#finishRequested = false;
    await this.refreshDiskSpace();
  }

  private fail(error: unknown): void {
    this.message = error instanceof Error ? error.message : String(error);
    this.state = "FAULT";
    this.stoppedAt ??= new Date();
    this.#finishRequested = true;
    this.requestDrain();
  }

  private async refreshDiskSpace(): Promise<void> {
    try {
      const stats = await statfs(this.folder);
      this.freeBytes = Number(stats.bavail) * Number(stats.bsize);
      this.totalBytes = Number(stats.blocks) * Number(stats.bsize);
    } catch {
      try {
        const stats = await statfs(resolve(this.folder, ".."));
        this.freeBytes = Number(stats.bavail) * Number(stats.bsize);
        this.totalBytes = Number(stats.blocks) * Number(stats.bsize);
      } catch {
        this.freeBytes = null;
        this.totalBytes = null;
      }
    }
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PROGRAM_AUDIO_FRAMES,
  PROGRAM_AUDIO_HEADER_BYTES,
  type ProgramAudioProjection,
  decodeProgramAudioFrame,
  encodeProgramAudioFrame,
  projectProgramAudioFrame,
} from "../../../packages/program-audio-ipc/src/index.ts";
import type { ProgramAudioShadowSnapshot } from "../../../packages/shared-types/src/index.ts";

const MAX_OUTPUT_BUFFER_BYTES = 64 * 1024;
const PROJECTION_FIELDS = ["sequence", "channels", "frames", "payloadBytes", "payloadHash", "peak"] as const;
const CHILD_ENVIRONMENT_ALLOWLIST = new Set(["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"]);

export interface ProgramAudioShadowOptions {
  enabled: boolean;
  channels: number;
  command?: string;
  args?: string[];
  maxBufferedFrames?: number;
  maxPendingFrames?: number;
  scheduleDrain?: (callback: () => void) => void;
}

function defaultShadowBinary(): string {
  if (process.env.ROUTER_CORE_PROGRAM_AUDIO_SHADOW_BIN) return process.env.ROUTER_CORE_PROGRAM_AUDIO_SHADOW_BIN;
  const executable = process.platform === "win32" ? "router-core-program-audio-shadow.exe" : "router-core-program-audio-shadow";
  return fileURLToPath(new URL(`../../../target/debug/${executable}`, import.meta.url));
}

function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) => (
    value !== undefined && CHILD_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase())
  )));
}

function isProjection(value: unknown): value is ProgramAudioProjection {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.sequence === "string"
    && typeof candidate.channels === "number"
    && typeof candidate.frames === "number"
    && typeof candidate.payloadBytes === "number"
    && typeof candidate.payloadHash === "string"
    && typeof candidate.peak === "number"
    && Number.isFinite(candidate.peak);
}

export class ProgramAudioShadow {
  readonly enabled: boolean;
  readonly channels: number;
  readonly maxBufferedFrames: number;
  readonly maxPendingFrames: number;
  readonly #options: ProgramAudioShadowOptions;
  readonly #slots: Array<{ bytes: Buffer; planar: Float32Array[] }>;
  readonly #slotSequences: Float64Array;
  readonly #scheduleDrain: (callback: () => void) => void;
  readonly #drainTask = () => this.drain();
  #child: ChildProcessWithoutNullStreams | null = null;
  #status: ProgramAudioShadowSnapshot["status"];
  #head = 0;
  #bufferedFrames = 0;
  #nextSequence = 1;
  #startingProbe = false;
  #drainScheduled = false;
  #backpressured = false;
  #closing = false;
  #pending: ProgramAudioProjection[] = [];
  #stdoutBuffer = "";
  #stderrBuffer = "";
  #capturedFrames = 0;
  #mirroredFrames = 0;
  #comparedFrames = 0;
  #mismatchFrames = 0;
  #droppedFrames = 0;
  #unexpectedFrames = 0;
  #processErrors = 0;
  #peak = 0;
  #lastMismatch: string | null = null;
  #lastError: string | null = null;

  constructor(options: ProgramAudioShadowOptions) {
    if (!Number.isInteger(options.channels) || options.channels < 1 || options.channels > 64) throw new RangeError("Program Audio shadow channels must be 1..64");
    this.#options = options;
    this.enabled = options.enabled;
    this.channels = options.channels;
    this.maxBufferedFrames = Math.max(1, Math.min(32, Math.trunc(options.maxBufferedFrames ?? 4)));
    this.maxPendingFrames = Math.max(1, Math.min(512, Math.trunc(options.maxPendingFrames ?? 16)));
    if (this.enabled) {
      const silence = Array.from({ length: this.channels }, () => new Float32Array(PROGRAM_AUDIO_FRAMES));
      this.#slots = Array.from({ length: this.maxBufferedFrames }, () => {
        const bytes = encodeProgramAudioFrame({ sequence: 0n, channels: this.channels, planar: silence });
        const planar = Array.from({ length: this.channels }, (_, channel) => new Float32Array(
          bytes.buffer,
          bytes.byteOffset + PROGRAM_AUDIO_HEADER_BYTES + channel * PROGRAM_AUDIO_FRAMES * 4,
          PROGRAM_AUDIO_FRAMES,
        ));
        return { bytes, planar };
      });
    } else {
      this.#slots = [];
    }
    this.#slotSequences = new Float64Array(this.maxBufferedFrames);
    this.#scheduleDrain = options.scheduleDrain ?? ((callback) => setImmediate(callback));
    this.#status = this.enabled ? "STOPPED" : "DISABLED";
  }

  start(): void {
    if (!this.enabled || this.#child) return;
    this.#closing = false;
    this.#startingProbe = false;
    this.#backpressured = false;
    this.#status = "STARTING";
    this.#stdoutBuffer = "";
    this.#stderrBuffer = "";
    const child = spawn(this.#options.command ?? defaultShadowBinary(), this.#options.args ?? [], {
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.once("spawn", () => {
      if (this.#child !== child) return;
      const bytes = Buffer.from(this.#slots[0].bytes);
      this.#pending.push(projectProgramAudioFrame(decodeProgramAudioFrame(bytes)));
      this.#startingProbe = true;
      try {
        this.#backpressured = !child.stdin.write(bytes, (error) => { if (error) this.fail(child, error); });
      } catch (error) {
        this.fail(child, error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdout.on("data", (chunk: string) => this.handleOutput(chunk));
    child.stderr.on("data", (chunk: string) => { this.#stderrBuffer = `${this.#stderrBuffer}${chunk}`.slice(-2_048); });
    child.stdin.on("error", (error) => this.fail(child, error));
    child.stdin.on("drain", () => {
      this.#backpressured = false;
      this.requestDrain();
    });
    child.once("error", (error) => this.fail(child, error));
    child.once("close", (code, signal) => {
      if (this.#child !== child) return;
      if (this.#closing) this.#status = "STOPPED";
      else this.fail(child, new Error(`Rust Program Audio shadow exited (${code ?? signal ?? "unknown"})`));
      this.#child = null;
    });
  }

  /** Hot path: bounded copies into preallocated slots only; encoding and IPC happen later. */
  capture(planar: readonly Float32Array[]): void {
    if (!this.enabled) return;
    if (this.#status === "STARTING") return;
    const sequence = this.#nextSequence;
    this.#nextSequence += 1;
    const child = this.#child;
    if (this.#status !== "READY" || !child?.stdin.writable || this.#pending.length >= this.maxPendingFrames || planar.length !== this.channels) {
      this.#droppedFrames += 1;
      return;
    }
    for (let channel = 0; channel < this.channels; channel += 1) {
      if (planar[channel].length !== PROGRAM_AUDIO_FRAMES) {
        this.#droppedFrames += 1;
        return;
      }
    }
    if (this.#bufferedFrames === this.maxBufferedFrames) {
      this.#head = (this.#head + 1) % this.maxBufferedFrames;
      this.#bufferedFrames -= 1;
      this.#droppedFrames += 1;
    }
    const tail = (this.#head + this.#bufferedFrames) % this.maxBufferedFrames;
    for (let channel = 0; channel < this.channels; channel += 1) this.#slots[tail].planar[channel].set(planar[channel]);
    this.#slotSequences[tail] = sequence;
    this.#bufferedFrames += 1;
    this.#capturedFrames += 1;
    if (!this.#backpressured) this.requestDrain();
  }

  snapshot(): ProgramAudioShadowSnapshot {
    return {
      enabled: this.enabled,
      status: this.#status,
      capturedFrames: this.#capturedFrames,
      mirroredFrames: this.#mirroredFrames,
      comparedFrames: this.#comparedFrames,
      matchedFrames: this.#comparedFrames - this.#mismatchFrames,
      mismatchFrames: this.#mismatchFrames,
      droppedFrames: this.#droppedFrames,
      pendingFrames: this.#pending.length,
      bufferedFrames: this.#bufferedFrames,
      unexpectedFrames: this.#unexpectedFrames,
      processErrors: this.#processErrors,
      peak: this.#peak,
      lastMismatch: this.#lastMismatch,
      lastError: this.#lastError,
    };
  }

  close(): void {
    this.#closing = true;
    const child = this.#child;
    this.#child = null;
    this.#pending = [];
    this.#bufferedFrames = 0;
    this.#backpressured = false;
    this.#startingProbe = false;
    if (child) {
      child.stdin.end();
      child.kill();
    }
    if (this.enabled) this.#status = "STOPPED";
  }

  private drain(): void {
    this.#drainScheduled = false;
    const child = this.#child;
    while (this.#bufferedFrames > 0 && child && this.#status === "READY" && child.stdin.writable && !this.#backpressured && this.#pending.length < this.maxPendingFrames) {
      const slot = this.#head;
      const sequence = BigInt(this.#slotSequences[slot]);
      const bytes = Buffer.from(this.#slots[slot].bytes);
      bytes.writeBigUInt64BE(sequence, 16);
      const expected = projectProgramAudioFrame({ sequence, channels: this.channels, payload: bytes.subarray(PROGRAM_AUDIO_HEADER_BYTES) });
      this.#head = (this.#head + 1) % this.maxBufferedFrames;
      this.#bufferedFrames -= 1;
      this.#pending.push(expected);
      this.#mirroredFrames += 1;
      try {
        this.#backpressured = !child.stdin.write(bytes, (error) => { if (error) this.fail(child, error); });
      } catch (error) {
        this.fail(child, error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
    if (this.#bufferedFrames > 0 && (!child || this.#status !== "READY" || !child.stdin.writable || this.#pending.length >= this.maxPendingFrames)) {
      this.#droppedFrames += this.#bufferedFrames;
      this.#bufferedFrames = 0;
    }
  }

  private requestDrain(): void {
    if (this.#drainScheduled || this.#bufferedFrames === 0) return;
    this.#drainScheduled = true;
    this.#scheduleDrain(this.#drainTask);
  }

  private handleOutput(chunk: string): void {
    if (this.#closing) return;
    this.#stdoutBuffer += chunk;
    if (Buffer.byteLength(this.#stdoutBuffer) > MAX_OUTPUT_BUFFER_BYTES) {
      const child = this.#child;
      if (child) this.fail(child, new Error("Rust Program Audio shadow output exceeded 64 KiB"));
      return;
    }
    for (;;) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let actual: unknown;
      try { actual = JSON.parse(line); } catch (error) {
        const child = this.#child;
        if (child) this.fail(child, new Error(`invalid Rust Program Audio shadow output: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (!isProjection(actual)) {
        const child = this.#child;
        if (child) this.fail(child, new Error("invalid Rust Program Audio shadow projection"));
        return;
      }
      this.compare(actual);
    }
  }

  private compare(actual: ProgramAudioProjection): void {
    const expected = this.#pending.shift();
    if (!expected) {
      this.#unexpectedFrames += 1;
      return;
    }
    this.#peak = actual.peak;
    const differences = PROJECTION_FIELDS.filter((field) => actual[field] !== expected[field]);
    if (this.#startingProbe) {
      this.#startingProbe = false;
      if (differences.length) {
        const child = this.#child;
        if (child) this.fail(child, new Error(`Rust Program Audio shadow startup mismatch: ${differences.join(", ")}`));
      } else {
        this.#status = "READY";
      }
      return;
    }
    this.#comparedFrames += 1;
    if (!differences.length) return;
    this.#mismatchFrames += 1;
    this.#lastMismatch = `frame ${expected.sequence}: ${differences.join(", ")} differ`;
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.#child !== child || this.#status === "FAULT") return;
    this.#status = "FAULT";
    this.#processErrors += 1;
    this.#lastError = `${error.message}${this.#stderrBuffer ? `: ${this.#stderrBuffer.trim()}` : ""}`.slice(0, 500);
    this.#droppedFrames += this.#pending.length + this.#bufferedFrames;
    this.#pending = [];
    this.#bufferedFrames = 0;
    this.#startingProbe = false;
    if (!child.killed) child.kill();
  }
}

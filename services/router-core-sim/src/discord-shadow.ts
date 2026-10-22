import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DiscordFrameType,
  encodeDiscordFrame,
  type DiscordIpcFrame,
} from "../../../packages/discord-ipc/src/index.ts";
import type { DiscordShadowSnapshot } from "../../../packages/shared-types/src/index.ts";

const MAX_OUTPUT_BUFFER_BYTES = 64 * 1024;
const DEFAULT_MAX_PENDING_FRAMES = 512;
const CHILD_ENVIRONMENT_ALLOWLIST = new Set(["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"]);
const PROJECTION_FIELDS = [
  "type",
  "flags",
  "sequence",
  "rtpTimestamp",
  "sourceGeneration",
  "botId",
  "guildId",
  "voiceChannelId",
  "userId",
  "payloadBytes",
  "payloadHash",
] as const;

export interface DiscordFrameProjection {
  type: number;
  flags: number;
  sequence: number;
  rtpTimestamp: number;
  sourceGeneration: number;
  botId: string;
  guildId: string;
  voiceChannelId: string;
  userId: string;
  payloadBytes: number;
  payloadHash: string;
}

export interface DiscordShadowComparatorOptions {
  enabled?: boolean;
  command?: string;
  args?: string[];
  maxPendingFrames?: number;
}

function defaultShadowBinary(): string {
  if (process.env.DISCORD_RUST_SHADOW_BIN) return process.env.DISCORD_RUST_SHADOW_BIN;
  const executable = process.platform === "win32" ? "router-core-discord-shadow.exe" : "router-core-discord-shadow";
  return fileURLToPath(new URL(`../../../target/debug/${executable}`, import.meta.url));
}

function shadowChildEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) => (
    value !== undefined && CHILD_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase())
  )));
}

function fnv1a64(payload: Uint8Array): string {
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (const byte of payload) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x0000_0100_0000_01b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function projectDiscordFrame(frame: DiscordIpcFrame): DiscordFrameProjection {
  const payload = frame.payload ?? new Uint8Array();
  return {
    type: frame.type,
    flags: frame.flags ?? 0,
    sequence: frame.sequence ?? 0,
    rtpTimestamp: frame.rtpTimestamp ?? 0,
    sourceGeneration: frame.sourceGeneration ?? 0,
    botId: frame.botId ?? "0",
    guildId: frame.guildId ?? "0",
    voiceChannelId: frame.voiceChannelId ?? "0",
    userId: frame.userId ?? "0",
    payloadBytes: payload.byteLength,
    payloadHash: fnv1a64(payload),
  };
}

function isProjection(value: unknown): value is DiscordFrameProjection {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return ["type", "flags", "sequence", "rtpTimestamp", "sourceGeneration", "payloadBytes"].every((field) => typeof candidate[field] === "number")
    && ["botId", "guildId", "voiceChannelId", "userId", "payloadHash"].every((field) => typeof candidate[field] === "string");
}

export class DiscordShadowComparator {
  readonly options: DiscordShadowComparatorOptions;
  readonly enabled: boolean;
  readonly maxPendingFrames: number;
  #child: ChildProcessWithoutNullStreams | null = null;
  #status: DiscordShadowSnapshot["status"];
  #pending: DiscordFrameProjection[] = [];
  #stdoutBuffer = "";
  #stderrBuffer = "";
  #backpressured = false;
  #closing = false;
  #mirroredFrames = 0;
  #comparedFrames = 0;
  #mismatchFrames = 0;
  #droppedFrames = 0;
  #unexpectedFrames = 0;
  #processErrors = 0;
  #lastMismatch: string | null = null;
  #lastError: string | null = null;

  constructor(options: DiscordShadowComparatorOptions = {}) {
    this.options = options;
    this.enabled = options.enabled ?? process.env.DISCORD_RUST_SHADOW === "1";
    const requestedMaxPending = options.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES;
    this.maxPendingFrames = Number.isFinite(requestedMaxPending)
      ? Math.max(1, Math.min(8_192, Math.trunc(requestedMaxPending)))
      : DEFAULT_MAX_PENDING_FRAMES;
    this.#status = this.enabled ? "STOPPED" : "DISABLED";
  }

  start(): void {
    if (!this.enabled || this.#child) return;
    this.#closing = false;
    this.#stdoutBuffer = "";
    this.#stderrBuffer = "";
    this.#backpressured = false;
    this.#status = "STARTING";
    const command = this.options.command ?? process.env.ROUTER_CORE_DISCORD_SHADOW_BIN ?? defaultShadowBinary();
    const child = spawn(command, this.options.args ?? [], {
      env: shadowChildEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.once("spawn", () => {
      if (this.#child === child) {
        this.#status = "READY";
        console.log("Rust Discord shadow ready: metadata comparison only");
      }
    });
    child.stdout.on("data", (chunk: string) => this.handleOutput(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.#stderrBuffer = `${this.#stderrBuffer}${chunk}`.slice(-2_048);
    });
    child.stdin.on("error", (error) => this.fail(child, error));
    child.stdin.on("drain", () => { this.#backpressured = false; });
    child.once("error", (error) => this.fail(child, error));
    child.once("close", (code, signal) => {
      if (this.#child !== child) return;
      if (this.#closing) this.#status = "STOPPED";
      else this.fail(child, new Error(`Rust Discord shadow exited (${code ?? signal ?? "unknown"})`));
      this.#child = null;
    });
  }

  mirror(frame: DiscordIpcFrame): void {
    if (!this.enabled || frame.type === DiscordFrameType.OPUS || frame.type === DiscordFrameType.TX_PCM) return;
    const child = this.#child;
    if (!child || !["STARTING", "READY"].includes(this.#status) || !child.stdin.writable || this.#backpressured || this.#pending.length >= this.maxPendingFrames) {
      this.#droppedFrames += 1;
      return;
    }
    const expected = projectDiscordFrame(frame);
    this.#pending.push(expected);
    this.#mirroredFrames += 1;
    try {
      this.#backpressured = !child.stdin.write(encodeDiscordFrame(frame), (error) => {
        if (error) this.fail(child, error);
      });
    } catch (error) {
      this.fail(child, error instanceof Error ? error : new Error(String(error)));
    }
  }

  snapshot(): DiscordShadowSnapshot {
    return {
      enabled: this.enabled,
      status: this.#status,
      mirroredFrames: this.#mirroredFrames,
      comparedFrames: this.#comparedFrames,
      matchedFrames: this.#comparedFrames - this.#mismatchFrames,
      mismatchFrames: this.#mismatchFrames,
      droppedFrames: this.#droppedFrames,
      pendingFrames: this.#pending.length,
      unexpectedFrames: this.#unexpectedFrames,
      processErrors: this.#processErrors,
      lastMismatch: this.#lastMismatch,
      lastError: this.#lastError,
    };
  }

  close(): void {
    this.#closing = true;
    const child = this.#child;
    this.#child = null;
    this.#pending = [];
    this.#backpressured = false;
    if (!child) {
      if (this.enabled) this.#status = "STOPPED";
      return;
    }
    child.stdin.end();
    child.kill();
    this.#status = "STOPPED";
  }

  private handleOutput(chunk: string): void {
    this.#stdoutBuffer += chunk;
    if (Buffer.byteLength(this.#stdoutBuffer) > MAX_OUTPUT_BUFFER_BYTES) {
      const child = this.#child;
      if (child) this.fail(child, new Error("Rust Discord shadow output exceeded 64 KiB"));
      return;
    }
    for (;;) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let actual: unknown;
      try {
        actual = JSON.parse(line);
      } catch (error) {
        const child = this.#child;
        if (child) this.fail(child, new Error(`invalid Rust Discord shadow output: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (!isProjection(actual)) {
        const child = this.#child;
        if (child) this.fail(child, new Error("invalid Rust Discord shadow projection"));
        return;
      }
      this.compare(actual);
    }
  }

  private compare(actual: DiscordFrameProjection): void {
    const expected = this.#pending.shift();
    if (!expected) {
      this.#unexpectedFrames += 1;
      return;
    }
    this.#comparedFrames += 1;
    const differences = PROJECTION_FIELDS.filter((field) => actual[field] !== expected[field]);
    if (!differences.length) return;
    this.#mismatchFrames += 1;
    this.#lastMismatch = `frame ${expected.type}: ${differences.join(", ")} differ`;
    if (this.#mismatchFrames === 1) console.error(`Rust Discord shadow mismatch: ${this.#lastMismatch}`);
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.#child !== child || this.#status === "FAULT") return;
    this.#status = "FAULT";
    this.#processErrors += 1;
    this.#lastError = `${error.message}${this.#stderrBuffer ? `: ${this.#stderrBuffer.trim()}` : ""}`.slice(0, 500);
    this.#droppedFrames += this.#pending.length;
    this.#pending = [];
    console.error(`Rust Discord shadow disabled: ${this.#lastError}`);
    if (!child.killed) child.kill();
  }
}

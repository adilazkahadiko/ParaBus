import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CommandResult,
  ControlCommand,
  RouterSnapshot,
  WasapiManagementSnapshot,
  WasapiStreamDescriptor,
  WindowsEndpointSnapshot,
} from "../../shared-types/src/index.ts";

export const CORE_IPC_VERSION = 1;
export const CORE_IPC_MAX_LINE_BYTES = 64 * 1024;

function killIfRunning(child: ChildProcessWithoutNullStreams): void {
  if (child.killed || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ESRCH") throw error;
  }
}

export interface CoreHealth {
  status: "ok";
  protocolVersion: number;
  implementation: "rust";
  pid: number;
  uptimeMs: number;
}

export interface WasapiEndpointInventory {
  supported: boolean;
  endpoints: WindowsEndpointSnapshot[];
  selectedEndpointId: string | null;
  selectedEndpointName: string | null;
  selectedAvailable: boolean;
}

export interface WasapiSelectionResult {
  revision: number;
  wasapi: WasapiManagementSnapshot;
}

export interface WasapiPreflightResult {
  revision: number;
  descriptor: WasapiStreamDescriptor;
  streamStarted: false;
}

export type WasapiStreamLifecycleResult = WasapiSelectionResult;

interface CoreIpcResponse<T> {
  v: number;
  id: string;
  type: string;
  ok: boolean;
  payload?: T;
  error?: string;
}

interface PendingRequest {
  type: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface CoreProcessClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inheritEnvironment?: boolean;
  requestTimeoutMs?: number;
}

export type CoreProcessLifecycleState = "STOPPED" | "RUNNING" | "FAULT" | "CLOSED";

const CHILD_ENVIRONMENT_ALLOWLIST = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
]);

function childEnvironment(options: CoreProcessClientOptions): NodeJS.ProcessEnv {
  const inherited = options.inheritEnvironment === false
    ? Object.fromEntries(Object.entries(process.env).filter(([name, value]) => (
        value !== undefined && CHILD_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase())
      )))
    : process.env;
  return { ...inherited, ...options.env };
}

export function resolveCoreBinary(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const explicit = environment.ROUTER_CORE_BIN?.trim();
  if (explicit) return explicit;
  const executable = platform === "win32" ? "router-core.exe" : "router-core";
  const repository = fileURLToPath(new URL("../../..", import.meta.url));
  const candidates = [
    join(repository, "bin", executable),
    join(repository, "target", "release", executable),
    join(repository, "target", "debug", executable),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export class CoreProcessClient {
  readonly options: CoreProcessClientOptions;
  #child: ChildProcessWithoutNullStreams | null = null;
  #nextId = 1;
  #stdoutBuffer = "";
  #stderrBuffer = "";
  #pending = new Map<string, PendingRequest>();
  #lifecycleState: CoreProcessLifecycleState = "STOPPED";
  #latchedFault: Error | null = null;
  #expectedExits = new WeakSet<ChildProcessWithoutNullStreams>();
  #faultListeners = new Set<(error: Error) => void>();

  constructor(options: CoreProcessClientOptions = {}) {
    this.options = options;
  }

  start(): void {
    if (this.#child) return;
    if (this.#lifecycleState === "FAULT") throw this.#latchedFault ?? new Error("router-core process fault is latched");
    if (this.#lifecycleState === "CLOSED") throw new Error("router-core client closed");
    const command = this.options.command ?? resolveCoreBinary();
    const child = spawn(command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: childEnvironment(this.options),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    this.#lifecycleState = "RUNNING";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.#stderrBuffer = `${this.#stderrBuffer}${chunk}`.slice(-8_192);
    });
    child.once("error", (error) => this.latchUnexpectedFault(child, error));
    child.once("exit", (code, signal) => {
      if (this.#child === child) this.#child = null;
      if (this.#expectedExits.has(child)) return;
      this.latchUnexpectedFault(child, new Error(`router-core exited (${code ?? signal ?? "unknown"})${this.#stderrBuffer ? `: ${this.#stderrBuffer.trim()}` : ""}`));
    });
  }

  lifecycleState(): CoreProcessLifecycleState {
    return this.#lifecycleState;
  }

  processId(): number | null {
    return this.#child?.pid ?? null;
  }

  onUnexpectedFault(listener: (error: Error) => void): () => void {
    this.#faultListeners.add(listener);
    return () => this.#faultListeners.delete(listener);
  }

  async health(): Promise<CoreHealth> {
    return this.request<CoreHealth>("health");
  }

  async snapshot(): Promise<RouterSnapshot> {
    return this.request<RouterSnapshot>("get_snapshot");
  }

  async command(command: ControlCommand): Promise<CommandResult> {
    return this.request<CommandResult>("command", command);
  }

  async listWasapiEndpoints(): Promise<WasapiEndpointInventory> {
    return this.request<WasapiEndpointInventory>("list_wasapi_endpoints");
  }

  async selectWasapiEndpoint(endpointId: string): Promise<WasapiSelectionResult> {
    return this.request<WasapiSelectionResult>("select_wasapi_endpoint", { endpointId });
  }

  async clearWasapiEndpoint(): Promise<WasapiSelectionResult> {
    return this.request<WasapiSelectionResult>("clear_wasapi_endpoint");
  }

  async preflightWasapiEndpoint(): Promise<WasapiPreflightResult> {
    return this.request<WasapiPreflightResult>("preflight_wasapi_endpoint");
  }

  async startWasapiStream(): Promise<WasapiStreamLifecycleResult> {
    return this.request<WasapiStreamLifecycleResult>("start_wasapi_stream");
  }

  async stopWasapiStream(): Promise<WasapiStreamLifecycleResult> {
    return this.request<WasapiStreamLifecycleResult>("stop_wasapi_stream");
  }

  close(): void {
    if (this.#lifecycleState === "CLOSED") return;
    const faultWasLatched = this.#lifecycleState === "FAULT";
    const child = this.#child;
    this.#child = null;
    if (!faultWasLatched) this.#lifecycleState = "CLOSED";
    if (child) {
      this.#expectedExits.add(child);
      child.stdin.end();
      killIfRunning(child);
    }
    this.failAll(new Error("router-core client closed"));
  }

  private request<T>(type: string, payload?: unknown): Promise<T> {
    if (this.#lifecycleState === "FAULT") return Promise.reject(this.#latchedFault ?? new Error("router-core process fault is latched"));
    if (this.#lifecycleState === "CLOSED") return Promise.reject(new Error("router-core client closed"));
    this.start();
    const child = this.#child;
    if (!child?.stdin.writable) return Promise.reject(new Error("router-core stdin is not writable"));
    const id = `node-${this.#nextId++}`;
    const encoded = `${JSON.stringify({ v: CORE_IPC_VERSION, id, type, ...(payload === undefined ? {} : { payload }) })}\n`;
    if (Buffer.byteLength(encoded) > CORE_IPC_MAX_LINE_BYTES) {
      return Promise.reject(new RangeError("router-core request exceeds 64 KiB"));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`router-core request timed out: ${type}`));
      }, this.options.requestTimeoutMs ?? 2_000);
      timer.unref();
      this.#pending.set(id, { type, resolve: resolve as (value: unknown) => void, reject, timer });
      child.stdin.write(encoded, (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private handleStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    if (Buffer.byteLength(this.#stdoutBuffer) > CORE_IPC_MAX_LINE_BYTES * 2) {
      this.failAll(new Error("router-core response buffer exceeded its bound"));
      if (this.#child) killIfRunning(this.#child);
      return;
    }
    for (;;) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > CORE_IPC_MAX_LINE_BYTES) {
        this.failAll(new Error("router-core response exceeds 64 KiB"));
        if (this.#child) killIfRunning(this.#child);
        return;
      }
      let response: CoreIpcResponse<unknown>;
      try {
        response = JSON.parse(line) as CoreIpcResponse<unknown>;
      } catch (error) {
        this.failAll(new Error(`invalid router-core response: ${error instanceof Error ? error.message : String(error)}`));
        if (this.#child) killIfRunning(this.#child);
        return;
      }
      const pending = this.#pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(response.id);
      if (response.v !== CORE_IPC_VERSION) pending.reject(new Error(`unsupported router-core protocol version: ${response.v}`));
      else if (response.type !== pending.type) pending.reject(new Error(`router-core response type mismatch: expected ${pending.type}, received ${response.type}`));
      else if (!response.ok) pending.reject(new Error(response.error ?? "router-core request failed"));
      else pending.resolve(response.payload);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  private latchUnexpectedFault(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.#expectedExits.has(child) || this.#lifecycleState === "CLOSED" || this.#lifecycleState === "FAULT") return;
    if (this.#child === child) this.#child = null;
    this.#lifecycleState = "FAULT";
    this.#latchedFault = error;
    this.failAll(error);
    for (const listener of [...this.#faultListeners]) {
      try { listener(error); } catch {}
    }
    this.#expectedExits.add(child);
    killIfRunning(child);
  }
}

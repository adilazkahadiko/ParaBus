import {
  CoreProcessClient,
  type CoreHealth,
  type WasapiEndpointInventory,
  type WasapiPreflightResult,
  type WasapiSelectionResult,
} from "../../../packages/core-ipc/src/index.ts";
import type {
  CommandResult,
  ControlCommand,
  RouterSnapshot,
  RustManagementSnapshot,
  WasapiManagementSnapshot,
  WindowsEndpointDirection,
  WindowsEndpointSnapshot,
} from "../../../packages/shared-types/src/index.ts";
import type { WindowsDevicePresenceProvider } from "./windows-device-presence.ts";

export interface RustManagementCoreClient {
  health(): Promise<CoreHealth>;
  snapshot(): Promise<RouterSnapshot>;
  command?(command: ControlCommand): Promise<CommandResult>;
  listWasapiEndpoints(): Promise<WasapiEndpointInventory>;
  selectWasapiEndpoint(endpointId: string): Promise<WasapiSelectionResult>;
  clearWasapiEndpoint(): Promise<WasapiSelectionResult>;
  preflightWasapiEndpoint(): Promise<WasapiPreflightResult>;
  startWasapiStream(): Promise<WasapiSelectionResult>;
  stopWasapiStream(): Promise<WasapiSelectionResult>;
  processId?(): number | null;
  onUnexpectedFault?(listener: (error: Error) => void): () => void;
  close(): void;
}

export interface RustManagementOptions {
  enabled: boolean;
  streamControlEnabled?: boolean;
  controlShadowEnabled?: boolean;
  clientFactory?: () => RustManagementCoreClient;
}

type ControlShadowCommand =
  | Extract<ControlCommand, { type: "SET_STATE" }>
  | Extract<ControlCommand, { type: "SET_PFL" }>
  | Extract<ControlCommand, { type: "EMERGENCY_MUTE" }>;

function isControlShadowCommand(command: ControlCommand): command is ControlShadowCommand {
  return command.type === "SET_PFL"
    || command.type === "EMERGENCY_MUTE"
    || (command.type === "SET_STATE" && (command.state === "SETUP" || command.state === "READY"));
}

export interface RustManagementRuntimeConfiguration {
  rustManagementEnabled: boolean;
  discordMetadataShadowEnabled: boolean;
}

export class RustManagementUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RustManagementUnavailableError";
  }
}

const EMPTY_WASAPI: WasapiManagementSnapshot = Object.freeze({
  supported: process.platform === "win32",
  selectedEndpointId: null,
  selectedEndpointName: null,
  selectedAvailable: false,
  preflightReady: false,
  descriptor: null,
  streamStarted: false,
  streamState: "STOPPED",
  streamError: null,
  mmcssRegistered: false,
  renderCallbacks: 0,
  outputUnderruns: 0,
});

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("render event timed out")) return "WASAPI render callbackがtimeoutしました";
  if (message.includes("format or period changed")) return "選択したWASAPI endpointのformatまたはperiodが変更されました";
  if (message.includes("timed out")) return "Rust management request timed out";
  if (message.includes("exited")) return "Rust management process exited";
  if (message.includes("not writable") || message.includes("client closed")) return "Rust management IPC is unavailable";
  if (message.includes("Core Audio endpoint is unavailable")) return "選択したWASAPI endpointを利用できません";
  if (message.includes("explicitly selected") || message.includes("explicit WASAPI")) return "明示選択したWASAPI endpointが必要です";
  if (message.includes("mix format")) return "選択したendpointは48/96 kHz Float32形式に対応していません";
  if (message.includes("engine period") || message.includes("10 ms period")) return "選択したendpointは10 ms periodに対応していません";
  if (message.includes("endpoint was invalidated") || message.includes("device was invalidated")) return "選択したWASAPI endpointが切断または無効化されました";
  if (message.includes("before leaving SETUP")) return "SETUPを終了する前にWASAPI silent streamを停止してください";
  if (message.includes("stream is already running")) return "WASAPI silent streamはすでに実行中です";
  if (message.includes("preflight is required")) return "stream開始前にWASAPI preflightが必要です";
  if (message.includes("unavailable on this platform")) return "このOSではWASAPIを利用できません";
  return "Rust management operation failed";
}

function isProcessFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("exited")
    || message.includes("not writable")
    || message.includes("client closed")
    || message.includes("response buffer")
    || message.includes("invalid router-core response")
    || message.includes("request timed out");
}

export class RustManagementBridge implements WindowsDevicePresenceProvider {
  readonly enabled: boolean;
  readonly streamControlEnabled: boolean;
  readonly controlShadowEnabled: boolean;
  readonly #clientFactory: () => RustManagementCoreClient;
  #client: RustManagementCoreClient | null = null;
  #status: RustManagementSnapshot["status"];
  #protocolVersion: number | null = null;
  #endpointCount = 0;
  #endpoints: WindowsEndpointSnapshot[] = [];
  #lastError: string | null = null;
  #wasapi: WasapiManagementSnapshot = EMPTY_WASAPI;
  #refreshing = false;
  #clientFaultUnsubscribe: (() => void) | null = null;
  #unavailableListeners = new Set<() => void>();
  #controlShadowQueue: Promise<void> = Promise.resolve();
  #controlShadowCompared = 0;
  #controlShadowMatched = 0;
  #controlShadowMismatched = 0;
  #controlShadowPending = 0;
  #controlShadowLastMismatch: string | null = null;

  constructor(options: RustManagementOptions) {
    this.enabled = options.enabled;
    this.streamControlEnabled = options.streamControlEnabled === true;
    this.controlShadowEnabled = options.controlShadowEnabled === true;
    this.#status = this.enabled ? "STOPPED" : "DISABLED";
    this.#clientFactory = options.clientFactory ?? (() => new CoreProcessClient({
      inheritEnvironment: false,
      requestTimeoutMs: 2_000,
    }));
  }

  async start(): Promise<void> {
    if (!this.enabled || this.#status !== "STOPPED") return;
    this.#status = "STARTING";
    try {
      const client = this.#clientFactory();
      this.#client = client;
      this.#clientFaultUnsubscribe = client.onUnexpectedFault?.((error) => {
        if (client === this.#client) this.fail(error);
      }) ?? null;
      const [health, snapshot] = await Promise.all([client.health(), client.snapshot()]);
      if (health.status !== "ok" || health.implementation !== "rust") {
        throw new Error("invalid Rust management health response");
      }
      this.#protocolVersion = health.protocolVersion;
      this.#wasapi = snapshot.wasapi ?? EMPTY_WASAPI;
      this.#lastError = null;
      this.#status = "READY";
    } catch (error) {
      this.fail(error);
    }
  }

  snapshot(): RustManagementSnapshot {
    const descriptor = this.#wasapi.descriptor;
    return {
      enabled: this.enabled,
      streamControlEnabled: this.streamControlEnabled,
      status: this.#status,
      protocolVersion: this.#protocolVersion,
      endpointCount: this.#endpointCount,
      lastError: this.#lastError,
      controlShadow: {
        enabled: this.controlShadowEnabled,
        comparedCommands: this.#controlShadowCompared,
        matchedCommands: this.#controlShadowMatched,
        mismatchedCommands: this.#controlShadowMismatched,
        pendingCommands: this.#controlShadowPending,
        lastMismatch: this.#controlShadowLastMismatch,
      },
      wasapi: {
        supported: this.#wasapi.supported,
        selectedEndpointName: this.#wasapi.selectedEndpointName,
        selectedAvailable: this.#wasapi.selectedAvailable,
        preflightReady: this.#wasapi.preflightReady,
        format: descriptor?.format ?? null,
        enginePeriod: descriptor?.enginePeriod ?? null,
        streamStarted: this.#wasapi.streamStarted,
        streamState: this.#wasapi.streamState,
        streamError: this.#wasapi.streamError ? publicError(new Error(this.#wasapi.streamError)) : null,
        mmcssRegistered: this.#wasapi.mmcssRegistered,
        renderCallbacks: this.#wasapi.renderCallbacks,
        outputUnderruns: this.#wasapi.outputUnderruns,
      },
    };
  }

  async listWasapiEndpoints(): Promise<WasapiEndpointInventory> {
    const client = this.requireClient();
    return this.operation(async () => {
      const inventory = await client.listWasapiEndpoints();
      this.#endpointCount = inventory.endpoints.length;
      this.#endpoints = inventory.endpoints.map((endpoint) => ({ ...endpoint }));
      this.#wasapi = {
        ...this.#wasapi,
        supported: inventory.supported,
        selectedEndpointId: inventory.selectedEndpointId,
        selectedEndpointName: inventory.selectedEndpointName,
        selectedAvailable: inventory.selectedAvailable,
        preflightReady: inventory.selectedAvailable && this.#wasapi.preflightReady,
        descriptor: inventory.selectedAvailable ? this.#wasapi.descriptor : null,
        streamStarted: this.#wasapi.streamStarted,
      };
      return inventory;
    });
  }

  isAvailable(): boolean {
    return this.enabled && this.#status === "READY" && this.#client !== null;
  }

  processId(): number | null {
    return this.#client?.processId?.() ?? null;
  }

  onUnavailable(listener: () => void): () => void {
    this.#unavailableListeners.add(listener);
    return () => this.#unavailableListeners.delete(listener);
  }

  cachedEndpoint(endpointId: string, direction: WindowsEndpointDirection): WindowsEndpointSnapshot | null {
    const endpoint = this.#endpoints.find((candidate) => candidate.id === endpointId && candidate.direction === direction);
    return endpoint ? { ...endpoint } : null;
  }

  async refreshEndpoints(): Promise<WindowsEndpointSnapshot[]> {
    const inventory = await this.listWasapiEndpoints();
    return inventory.endpoints.map((endpoint) => ({ ...endpoint }));
  }

  async selectWasapiEndpoint(endpointId: string): Promise<WasapiSelectionResult> {
    this.requireStreamControl();
    if (typeof endpointId !== "string" || !endpointId.trim()) {
      throw new RustManagementUnavailableError("WASAPI endpointを選択してください");
    }
    const client = this.requireClient();
    return this.operation(async () => {
      const result = await client.selectWasapiEndpoint(endpointId);
      this.#wasapi = result.wasapi;
      return result;
    });
  }

  async clearWasapiEndpoint(): Promise<WasapiSelectionResult> {
    this.requireStreamControl();
    const client = this.requireClient();
    return this.operation(async () => {
      const result = await client.clearWasapiEndpoint();
      this.#wasapi = result.wasapi;
      return result;
    });
  }

  async preflightWasapiEndpoint(): Promise<WasapiPreflightResult> {
    this.requireStreamControl();
    const client = this.requireClient();
    return this.operation(async () => {
      const result = await client.preflightWasapiEndpoint();
      this.#wasapi = {
        ...this.#wasapi,
        selectedEndpointId: result.descriptor.endpointId,
        selectedAvailable: true,
        preflightReady: true,
        descriptor: result.descriptor,
        streamStarted: result.streamStarted,
        streamState: "STOPPED",
        streamError: null,
      };
      return result;
    });
  }

  async startWasapiStream(): Promise<WasapiSelectionResult> {
    this.requireStreamControl();
    const client = this.requireClient();
    return this.operation(async () => {
      const result = await client.startWasapiStream();
      this.#wasapi = result.wasapi;
      return result;
    });
  }

  async stopWasapiStream(): Promise<WasapiSelectionResult> {
    this.requireStreamControl();
    const client = this.requireClient();
    return this.operation(async () => {
      const result = await client.stopWasapiStream();
      this.#wasapi = result.wasapi;
      return result;
    });
  }

  async refreshSnapshot(): Promise<void> {
    if (this.#refreshing || this.#status !== "READY" || !this.#client) return;
    this.#refreshing = true;
    try {
      const snapshot = await this.#client.snapshot();
      if (snapshot.wasapi) this.#wasapi = snapshot.wasapi;
    } catch (error) {
      this.fail(error);
    } finally {
      this.#refreshing = false;
    }
  }

  shadowControlCommand(
    command: ControlCommand,
    expected: Pick<RouterSnapshot, "state" | "emergencyMuted" | "monitorSourceId">,
  ): Promise<void> {
    if (!this.controlShadowEnabled || !isControlShadowCommand(command)) return Promise.resolve();
    this.#controlShadowPending += 1;
    const run = this.#controlShadowQueue.then(async () => {
      this.#controlShadowCompared += 1;
      try {
        const client = this.requireClient();
        if (!client.command) throw new Error("Rust control shadow is unavailable");
        const result = await client.command(command);
        const actual = await client.snapshot();
        const mismatch = !result.ok
          ? `${command.type}: Rust rejected an accepted TypeScript command`
          : command.type === "SET_STATE" && actual.state !== expected.state
            ? `${command.type}: expected state ${expected.state}, received ${actual.state}`
            : command.type === "SET_PFL" && actual.monitorSourceId !== expected.monitorSourceId
              ? `${command.type}: expected monitorSourceId ${expected.monitorSourceId}, received ${actual.monitorSourceId}`
            : command.type === "EMERGENCY_MUTE" && actual.emergencyMuted !== expected.emergencyMuted
              ? `${command.type}: expected emergencyMuted ${expected.emergencyMuted}, received ${actual.emergencyMuted}`
              : null;
        if (mismatch) {
          this.#controlShadowMismatched += 1;
          this.#controlShadowLastMismatch = mismatch;
        } else {
          this.#controlShadowMatched += 1;
        }
      } catch (error) {
        this.#controlShadowMismatched += 1;
        this.#controlShadowLastMismatch = `${command.type}: ${publicError(error)}`;
        if (isProcessFailure(error)) this.fail(error);
      } finally {
        this.#controlShadowPending -= 1;
      }
    });
    this.#controlShadowQueue = run.catch(() => {});
    return run;
  }

  async close(): Promise<void> {
    const client = this.#client;
    if (client && this.#wasapi.streamStarted) {
      try {
        const result = await client.stopWasapiStream();
        this.#wasapi = result.wasapi;
      } catch {
        // The bounded Core request timeout still applies; closing the process is the final fallback.
      }
    }
    this.#clientFaultUnsubscribe?.();
    this.#clientFaultUnsubscribe = null;
    client?.close();
    this.#client = null;
    if (this.enabled && this.#status !== "FAULT") this.#status = "STOPPED";
  }

  private requireClient(): RustManagementCoreClient {
    if (!this.enabled) throw new RustManagementUnavailableError("Rust managementはこのruntimeで利用できません");
    if (this.#status !== "READY" || !this.#client) {
      throw new RustManagementUnavailableError(this.#lastError ?? "Rust management processは利用できません");
    }
    return this.#client;
  }

  private requireStreamControl(): void {
    if (!this.streamControlEnabled) {
      throw new RustManagementUnavailableError("Rust management sidecarはread-only presence modeです");
    }
  }

  private async operation<T>(run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      this.#lastError = null;
      return result;
    } catch (error) {
      const message = publicError(error);
      if (isProcessFailure(error)) {
        this.fail(error);
      } else {
        try {
          const snapshot = await this.#client?.snapshot();
          if (snapshot?.wasapi) this.#wasapi = snapshot.wasapi;
          this.#lastError = message;
        } catch (snapshotError) {
          this.fail(snapshotError);
          throw new RustManagementUnavailableError(this.#lastError ?? "Rust management processは利用できません");
        }
      }
      throw new RustManagementUnavailableError(message);
    }
  }

  private fail(error: unknown): void {
    if (this.#status === "FAULT") return;
    this.#lastError = publicError(error);
    this.#status = "FAULT";
    this.#clientFaultUnsubscribe?.();
    this.#clientFaultUnsubscribe = null;
    this.#client?.close();
    this.#client = null;
    for (const listener of [...this.#unavailableListeners]) {
      try { listener(); } catch {}
    }
  }
}

export function createProductionRustManagement(
  configuration: RustManagementRuntimeConfiguration,
  clientFactory?: () => RustManagementCoreClient,
): RustManagementBridge {
  return new RustManagementBridge({
    enabled: configuration.rustManagementEnabled,
    streamControlEnabled: configuration.discordMetadataShadowEnabled,
    controlShadowEnabled: configuration.discordMetadataShadowEnabled,
    clientFactory,
  });
}

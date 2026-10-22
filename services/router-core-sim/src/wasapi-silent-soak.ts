export const DEFAULT_SOAK_DURATION_SECONDS = 600;
export const DEFAULT_SOAK_POLL_SECONDS = 5;
export const MIN_SOAK_DURATION_SECONDS = 30;
export const MAX_SOAK_DURATION_SECONDS = 86_400;
export const MIN_SOAK_POLL_SECONDS = 1;
export const MAX_SOAK_POLL_SECONDS = 60;

export interface WasapiSoakOptions {
  durationSeconds: number;
  pollSeconds: number;
  stateUrl: string;
}

export interface WasapiSoakSummary {
  durationSeconds: number;
  polls: number;
  callbackDelta: number;
  underrunDelta: number;
  discordReadyBots: number;
}

export interface WasapiSoakDependencies {
  fetchState: () => Promise<unknown>;
  sleep: (milliseconds: number) => Promise<void>;
  nowMs: () => number;
}

export class WasapiSoakError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

type SoakSnapshot = {
  state?: unknown;
  coreOwnership?: { effectiveOwner?: unknown };
  rustManagement?: { status?: unknown; wasapi?: WasapiSnapshot };
  discord?: { configuredBots?: unknown; readyBots?: unknown; adapterState?: unknown };
  recorder?: { state?: unknown };
};

type WasapiSnapshot = {
  selectedAvailable?: unknown;
  preflightReady?: unknown;
  streamState?: unknown;
  streamStarted?: unknown;
  renderCallbacks?: unknown;
  outputUnderruns?: unknown;
};

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new WasapiSoakError(`invalid-${label}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new WasapiSoakError(`invalid-${label}`);
  return parsed;
}

export function parseWasapiSoakOptions(args: readonly string[], env: NodeJS.ProcessEnv = process.env): WasapiSoakOptions {
  let duration = env.DBR_WASAPI_SOAK_DURATION_SECONDS;
  let poll = env.DBR_WASAPI_SOAK_POLL_SECONDS;
  let stateUrl = env.DBR_WASAPI_SOAK_STATE_URL ?? "http://127.0.0.1:4173/api/state";
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--duration-seconds") {
      duration = args[++index];
      if (duration === undefined) throw new WasapiSoakError("invalid-options");
    } else if (value === "--poll-seconds") {
      poll = args[++index];
      if (poll === undefined) throw new WasapiSoakError("invalid-options");
    } else if (value === "--state-url") stateUrl = args[++index] ?? "";
    else throw new WasapiSoakError("invalid-options");
  }
  let url: URL;
  try { url = new URL(stateUrl); } catch { throw new WasapiSoakError("invalid-state-url"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/api/state" || url.search || url.hash || url.username || url.password) {
    throw new WasapiSoakError("invalid-state-url");
  }
  return {
    durationSeconds: boundedInteger(duration, DEFAULT_SOAK_DURATION_SECONDS, MIN_SOAK_DURATION_SECONDS, MAX_SOAK_DURATION_SECONDS, "duration-seconds"),
    pollSeconds: boundedInteger(poll, DEFAULT_SOAK_POLL_SECONDS, MIN_SOAK_POLL_SECONDS, MAX_SOAK_POLL_SECONDS, "poll-seconds"),
    stateUrl: url.toString(),
  };
}

function requireEqual(value: unknown, expected: unknown, code: string): void {
  if (value !== expected) throw new WasapiSoakError(code);
}

function counter(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new WasapiSoakError(code);
  return value;
}

export function validateWasapiSoakSnapshot(snapshot: unknown): { callbacks: number; underruns: number; readyBots: number } {
  if (!snapshot || typeof snapshot !== "object") throw new WasapiSoakError("invalid-state-response");
  const state = snapshot as SoakSnapshot;
  const wasapi = state.rustManagement?.wasapi;
  requireEqual(state.state, "SETUP", "router-not-setup");
  requireEqual(state.coreOwnership?.effectiveOwner, "typescript", "effective-owner-not-typescript");
  requireEqual(state.rustManagement?.status, "READY", "rust-management-not-ready");
  requireEqual(wasapi?.selectedAvailable, true, "selected-endpoint-unavailable");
  requireEqual(wasapi?.preflightReady, true, "wasapi-preflight-not-ready");
  requireEqual(wasapi?.streamState, "RUNNING", "wasapi-stream-not-running");
  requireEqual(wasapi?.streamStarted, true, "wasapi-stream-not-running");
  const configuredBots = counter(state.discord?.configuredBots, "discord-status-invalid");
  const readyBots = counter(state.discord?.readyBots, "discord-status-invalid");
  if (configuredBots === 0) throw new WasapiSoakError("discord-no-configured-bots");
  if (configuredBots !== readyBots) throw new WasapiSoakError("discord-bots-not-ready");
  requireEqual(state.discord?.adapterState, "voice-ready", "discord-adapter-not-voice-ready");
  requireEqual(state.recorder?.state, "IDLE", "recorder-not-idle");
  return { callbacks: counter(wasapi?.renderCallbacks, "wasapi-callback-counter-invalid"), underruns: counter(wasapi?.outputUnderruns, "wasapi-underrun-counter-invalid"), readyBots };
}

export async function runWasapiSilentSoak(options: WasapiSoakOptions, dependencies: WasapiSoakDependencies): Promise<WasapiSoakSummary> {
  const initial = validateWasapiSoakSnapshot(await dependencies.fetchState());
  const startedAt = dependencies.nowMs();
  let previous = initial;
  let polls = 1;
  let lastProgressAt = startedAt;
  const maxNoProgressMs = Math.max(options.pollSeconds * 3_000, 5_000);
  while (dependencies.nowMs() - startedAt < options.durationSeconds * 1_000) {
    const remainingMs = options.durationSeconds * 1_000 - (dependencies.nowMs() - startedAt);
    await dependencies.sleep(Math.min(options.pollSeconds * 1_000, remainingMs));
    const current = validateWasapiSoakSnapshot(await dependencies.fetchState());
    polls += 1;
    if (current.callbacks < previous.callbacks || current.underruns < previous.underruns) throw new WasapiSoakError("wasapi-counter-regression");
    if (current.callbacks > previous.callbacks) lastProgressAt = dependencies.nowMs();
    if (dependencies.nowMs() - lastProgressAt >= maxNoProgressMs) throw new WasapiSoakError("wasapi-callback-no-progress");
    previous = current;
  }
  return {
    durationSeconds: Math.floor((dependencies.nowMs() - startedAt) / 1_000),
    polls,
    callbackDelta: previous.callbacks - initial.callbacks,
    underrunDelta: previous.underruns - initial.underruns,
    discordReadyBots: previous.readyBots,
  };
}

async function main(): Promise<void> {
  const options = parseWasapiSoakOptions(process.argv.slice(2));
  const summary = await runWasapiSilentSoak(options, {
    async fetchState() {
      const response = await fetch(options.stateUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new WasapiSoakError("state-request-failed");
      return response.json();
    },
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    nowMs: () => Date.now(),
  });
  console.log(JSON.stringify({ result: "PASS", ...summary }));
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("services/router-core-sim/src/wasapi-silent-soak.ts")) {
  main().catch((error: unknown) => {
    const code = error instanceof WasapiSoakError ? error.code : "monitor-failed";
    console.error(JSON.stringify({ result: "FAIL", reason: code }));
    process.exitCode = 1;
  });
}

import type { ControlCommand } from "../../../packages/shared-types/src/index.ts";

export type Tier = "A" | "B" | "C";
// One entry per discriminant. Adding/removing an internal command breaks typecheck.
export const COMMAND_POLICIES = {
  SET_STATE: "state", SET_CHANNEL_FADER: "fader", SET_CHANNEL_MUTE: "A",
  SET_USER_CHANNEL_COLOR: "C", SET_USER_STRIP_ORDER: "C", RESET_USER_STRIP_ORDER: "C",
  SET_PARTICIPANT_APPROVAL: "C", SET_USER_TRUSTED: "C", SET_RECEIVER_OWNER: "C",
  SET_VC_SEND: "send", SET_BUS_MASTER: "fader", SET_BUS_MUTE: "A",
  SET_BUS_OUTPUT: "C", CLEAR_BUS_OUTPUT: "C", SET_BUS_BINDING: "C", CREATE_VC_BUS: "C",
  SET_GROUP_BUS_SOURCES: "C", REMOVE_VC_BUS: "C", SET_NEW_PARTICIPANT_POLICY: "C",
  SET_BUS_COMPRESSOR: "B", SELECT_OUTPUT_DEVICE: "C", REFRESH_OUTPUT_DEVICES: "C",
  SELECT_CUE_OUTPUT_DEVICE: "C", REFRESH_CUE_OUTPUT_DEVICES: "C", SELECT_INPUT_DEVICE: "C",
  REFRESH_INPUT_DEVICES: "C", SET_DIRECT_OUTPUT: "C", CLEAR_DIRECT_OUTPUT: "C",
  SET_OUTPUT_TEST_TONE: "C", SET_LIMITER: "B", RESET_LOUDNESS: "A", SET_PFL: "A",
  SET_MONITOR_OUTPUT: "C", EMERGENCY_MUTE: "emergency", SAVE_SCENE: "C", PREVIEW_SCENE: "A",
  RECALL_SCENE: "B", DELETE_SCENE: "C", SET_RECALL_SAFE: "C", CLEAR_EVENT_LOG: "C",
  SET_TX_SOURCE: "C", SET_TX_INPUT: "C", SET_TX_MASTER: "fader", ASSIGN_TX_VOICE_CHANNEL: "C",
  CONNECT_DISCORD_BOT: "C", DISCONNECT_DISCORD_BOT: "C", START_TX: "profile",
  SET_TX_TARGETS: "A", START_ARMED: "A", CLEAR_ALL: "A", STOP_TX: "profile",
  START_RECORDING: "B", STOP_RECORDING: "B", DEVICE_LOST: "C", INPUT_DEVICE_LOST: "C",
  ACKNOWLEDGE_FAULT: "C",
} as const satisfies Record<ControlCommand["type"], Tier | "state" | "fader" | "send" | "emergency" | "profile">;

export function classifyCommand(command: ControlCommand, context: { state: string; increaseDb?: number; adjust?: boolean }): Tier {
  const policy = Object.hasOwn(COMMAND_POLICIES, command.type) ? COMMAND_POLICIES[command.type] : "C";
  if (policy === "state") return command.type === "SET_STATE" && command.state === "ON_AIR" && ["SETUP", "READY", "ON_AIR"].includes(context.state) ? "A"
    : command.type === "SET_STATE" && command.state === "SETUP" && ["ON_AIR", "SETUP"].includes(context.state) ? "B" : "C";
  if (policy === "emergency") return command.type === "EMERGENCY_MUTE" && command.active === true ? "A" : "B";
  if (policy === "profile") return "profileId" in command && typeof command.profileId === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(command.profileId) ? "A" : "C";
  if (policy === "send" && command.type === "SET_VC_SEND" && command.db === undefined) return "A";
  if (policy === "fader" || policy === "send") return context.increaseDb === undefined ? "C" : context.increaseDb <= 6 ? "A" : context.adjust ? "C" : "B";
  return policy;
}

export const OPERATIONS = [
  "channel.fader.adjust", "channel.fader.set", "channel.mute.set", "channel.mute.toggle",
  "bus.fader.adjust", "bus.fader.set", "bus.mute.set", "bus.mute.toggle",
  "send.fader.adjust", "send.fader.set", "send.mute.set", "send.mute.toggle",
  "tx.fader.adjust", "tx.fader.set", "pfl.set", "loudness.reset", "emergency.set",
  "settings.lock.set", "tx.start", "tx.stop", "tx.clear", "tx.targets.set", "tx.take",
] as const;
export const TIER_B_OPERATIONS = ["bus.limiter.set", "bus.compressor.set", "scene.preview", "scene.recall", "recording.start", "recording.stop"];
// Only operation names that can be B in §6 are valid persisted permissions (including future 2b operations).
export const ALLOWED_TIER_B_OPERATIONS = ["channel.fader.set", "bus.fader.set", "send.fader.set", "tx.fader.set",
  "emergency.set", "settings.lock.set", "bus.limiter.set", "bus.compressor.set", "scene.recall", "recording.start", "recording.stop"];
export function tierBPermissions(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !ALLOWED_TIER_B_OPERATIONS.includes(v))
    || new Set(value).size !== value.length) return fail("INVALID");
  return [...value].sort();
}
export const LIMITS = {
  maxBodyBytes: 16384, actionRatePerSecond: 20, actionBurst: 20,
  faderMaxIncreaseDb: 6, faderIncreaseFloorDb: -40, faderIncreaseDbPerSecond: 20, faderIncreaseBurstDb: 10,
  safetyRatePerSecond: 5, safetyBurst: 5, getRatePerSecond: 10, getBurst: 10,
  globalActionRatePerSecond: 100, globalActionBurst: 100, globalSafetyRatePerSecond: 20, globalSafetyBurst: 20,
  unauthenticatedRatePerSecond: 10, unauthenticatedBurst: 20,
  maxWsPerDevice: 2, maxWsTotal: 16, maxWsPendingBytes: 262144, stateMaxHz: 10,
  pingIntervalMs: 15000, pongTimeoutMs: 45000, deduplicationMs: 60000, deduplicationCapacity: 2048,
};
export const STATUS = { INVALID: 400, UNAUTHORIZED: 401, HOST_FORBIDDEN: 403, ORIGIN_FORBIDDEN: 403,
  TIER_FORBIDDEN: 403, NOT_FOUND: 404, LOCKED: 409, STALE_REVISION: 409, RATE_LIMITED: 429,
  CONFIRMATION_REQUIRED: 409, ARM_TOO_EARLY: 409, ARM_INVALID: 409, ARM_EXPIRED: 410,
  DISABLED: 503, UNAVAILABLE: 503, INTERNAL: 500 } as const;
export type ErrorCode = keyof typeof STATUS;
const MESSAGES: Record<ErrorCode, string> = {
  INVALID: "Invalid request", UNAUTHORIZED: "Bearer authentication required", HOST_FORBIDDEN: "Host or connection forbidden",
  ORIGIN_FORBIDDEN: "Browser requests are forbidden", TIER_FORBIDDEN: "Operation is not permitted",
  NOT_FOUND: "Target is unavailable", LOCKED: "Operation is blocked by current safety conditions",
  CONFIRMATION_REQUIRED: "Arm and execute confirmation required", ARM_TOO_EARLY: "Minimum confirmation time not reached",
  ARM_INVALID: "Invalid confirmation", ARM_EXPIRED: "Confirmation expired",
  STALE_REVISION: "Related state changed; refresh before retry", RATE_LIMITED: "Request limit exceeded",
  DISABLED: "External control is disabled", UNAVAILABLE: "External control backend is unavailable", INTERNAL: "Internal control failure",
};
export class ExternalError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly current?: { mute: boolean };
  readonly retryAfterSeconds: number;
  constructor(code: ErrorCode, status: number = STATUS[code], current?: { mute: boolean }, retryAfterSeconds = 1) {
    super(MESSAGES[code]); this.code = code; this.status = status; this.current = current; this.retryAfterSeconds = retryAfterSeconds;
  }
  body() { return { ok: false as const, code: this.code, message: this.message, ...(this.current ? { current: this.current } : {}) }; }
}
export function fail(code: ErrorCode, status?: number): never { throw new ExternalError(code, status); }
export type RecordValue = Record<string, unknown>;
export function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("INVALID");
  return value as RecordValue;
}
export function fields(value: unknown, required: string[], optional: string[] = []): RecordValue {
  const item = object(value);
  if (required.some(key => !Object.hasOwn(item, key)) || Object.keys(item).some(key => !required.includes(key) && !optional.includes(key))) fail("INVALID");
  return item;
}
export function textId(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.length || value.length > max || /[\x00-\x1f\x7f]/.test(value)) return fail("INVALID");
  return value;
}
export function boolean(value: unknown): boolean { return typeof value === "boolean" ? value : fail("INVALID"); }
export function finite(value: unknown, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fail("INVALID");
}
export function revision(value: unknown): number { const n = finite(value, 1, Number.MAX_SAFE_INTEGER); return Number.isSafeInteger(n) ? n : fail("INVALID"); }
export function uuid(value: unknown): string { const id = textId(value, 36); return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : fail("INVALID"); }

/** JSON.parse alone loses duplicate keys. Validate the token structure first, including escaped keys. */
export function strictJson(input: string): unknown {
  let offset = 0;
  const space = () => { while (/[\x20\t\r\n]/.test(input[offset] ?? "!") && offset < input.length) offset++; };
  function value(depth: number): void {
    if (depth > 32) fail("INVALID");
    space(); const start = input[offset];
    if (start === "{" || start === "[") {
      const end = start === "{" ? "}" : "]", keys = new Set<string>(); offset++; space();
      if (input[offset] === end) { offset++; return; }
      for (;;) {
        if (start === "{") {
          space(); const key = string(); if (keys.has(key)) fail("INVALID"); keys.add(key);
          space(); if (input[offset++] !== ":") fail("INVALID");
        }
        value(depth + 1); space();
        if (input[offset] === end) { offset++; return; }
        if (input[offset++] !== ",") fail("INVALID");
      }
    }
    if (start === '"') { string(); return; }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(input.slice(offset));
    if (!token) fail("INVALID"); offset += token[0].length;
    if (!/^(true|false|null)$/.test(token[0]) && !Number.isFinite(Number(token[0]))) fail("INVALID");
  }
  function string(): string {
    const token = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(input.slice(offset));
    if (!token) return fail("INVALID"); offset += token[0].length; return JSON.parse(token[0]);
  }
  try { value(0); space(); if (offset !== input.length) fail("INVALID"); return JSON.parse(input); }
  catch { return fail("INVALID"); }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as RecordValue)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Opaque IDs may contain punctuation; tuple encoding prevents dependency-key collisions. */
export function dependencyKey(...parts: string[]): string { return JSON.stringify(parts); }

export class Bucket {
  readonly rate: number; readonly capacity: number;
  tokens: number; at: number;
  constructor(rate: number, capacity: number, now: number) { this.rate = rate; this.capacity = capacity; this.tokens = capacity; this.at = now; }
  ready(now: number, cost = 1): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.at) * this.rate / 1000); this.at = now;
    return this.tokens + 1e-9 >= cost;
  }
  spend(cost = 1) { this.tokens -= cost; }
}

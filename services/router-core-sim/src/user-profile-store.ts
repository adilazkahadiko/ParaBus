import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistentUserProfileSnapshot, TapPoint } from "../../../packages/shared-types/src/index.ts";
import type { AudioChannel } from "./audio-engine.ts";
import { clamp } from "./dsp.ts";

const PROFILE_VERSION = 1;
const DISCORD_USER_ID = /^\d{17,20}$/;
const CHANNEL_COLOR = /^#[0-9a-f]{6}$/i;
const DEFAULT_COLOR = "#3696f5";

type RawRecord = Record<string, unknown>;

function record(value: unknown): RawRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RawRecord : null;
}

function text(value: unknown, fallback = "", max = 80): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function integer(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value as number)) : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function timestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

function sanitizeDirectOutput(value: unknown): PersistentUserProfileSnapshot["directOutput"] {
  const item = record(value);
  if (!item || !Number.isInteger(item.output) || (item.output as number) < 0 || (item.tap !== "PRE" && item.tap !== "POST")) return undefined;
  return {
    output: item.output as number,
    tap: item.tap as TapPoint,
    gainDb: number(item.gainDb, 0, -90, 12),
    mute: boolean(item.mute, false),
  };
}

function sanitizeDirectOutputsByVoiceChannel(value: unknown): PersistentUserProfileSnapshot["directOutputsByVoiceChannel"] {
  const source = record(value);
  const result: PersistentUserProfileSnapshot["directOutputsByVoiceChannel"] = {};
  if (!source) return result;
  for (const [voiceChannelId, rawRoute] of Object.entries(source)) {
    if (!voiceChannelId || voiceChannelId.length > 64) continue;
    const route = sanitizeDirectOutput(rawRoute);
    if (route) result[voiceChannelId] = route;
  }
  return result;
}

function sanitizeBusSends(value: unknown): Record<string, { gainDb: number; mute: boolean }> {
  const source = record(value);
  const result: Record<string, { gainDb: number; mute: boolean }> = {};
  if (!source) return result;
  for (const [busId, rawSend] of Object.entries(source)) {
    if (!busId || busId.length > 256) continue;
    const send = record(rawSend);
    if (!send) continue;
    result[busId] = { gainDb: number(send.gainDb, -12, -90, 12), mute: boolean(send.mute, false) };
  }
  return result;
}

function sanitizeProfile(value: unknown, fallbackPosition: number): PersistentUserProfileSnapshot | null {
  const raw = record(value);
  if (!raw) return null;
  const discordUserId = text(raw.discordUserId ?? raw.id, "", 20);
  if (!DISCORD_USER_ID.test(discordUserId)) return null;
  const now = new Date().toISOString();
  const displayName = text(raw.displayName ?? raw.label, `Discord ${discordUserId}`);
  const channelName = text(raw.channelName ?? raw.label, displayName);
  const hpf = record(raw.hpf);
  const compressor = record(raw.compressor);
  const rawColor = text(raw.channelColor, DEFAULT_COLOR, 7);
  const recallSafe = Array.isArray(raw.recallSafe)
    ? raw.recallSafe.filter((item): item is string => typeof item === "string" && item.length <= 256).slice(0, 128)
    : [];
  return {
    discordUserId,
    displayName,
    channelName,
    channelColor: CHANNEL_COLOR.test(rawColor) ? rawColor.toLowerCase() : DEFAULT_COLOR,
    mainFaderDb: number(raw.mainFaderDb ?? raw.faderDb, 0, -90, 12),
    mainMute: boolean(raw.mainMute ?? raw.mute, false),
    trimDb: number(raw.trimDb, 0, -90, 12),
    hpf: {
      enabled: boolean(hpf?.enabled ?? raw.hpfEnabled, true),
      cutoffHz: number(hpf?.cutoffHz ?? raw.hpfCutoffHz, 80, 20, 2_000),
    },
    compressor: {
      enabled: boolean(compressor?.enabled ?? raw.compressorEnabled, true),
      thresholdDb: number(compressor?.thresholdDb, -18, -60, 0),
      ratio: number(compressor?.ratio, 3, 1, 20),
      attackMs: number(compressor?.attackMs, 8, 0.1, 200),
      releaseMs: number(compressor?.releaseMs, 100, 10, 2_000),
      makeupDb: number(compressor?.makeupDb, 0, -12, 24),
    },
    ...(sanitizeDirectOutput(raw.directOutput) ? { directOutput: sanitizeDirectOutput(raw.directOutput) } : {}),
    directOutputsByVoiceChannel: sanitizeDirectOutputsByVoiceChannel(raw.directOutputsByVoiceChannel),
    preferredStripPosition: integer(raw.preferredStripPosition ?? raw.stripPosition, fallbackPosition),
    busSends: sanitizeBusSends(raw.busSends ?? raw.vcSends),
    recallSafe,
    trusted: boolean(raw.trusted, false),
    createdAt: timestamp(raw.createdAt, now),
    updatedAt: timestamp(raw.updatedAt, now),
  };
}

function cloneProfile(profile: PersistentUserProfileSnapshot): PersistentUserProfileSnapshot {
  return {
    ...profile,
    hpf: { ...profile.hpf },
    compressor: { ...profile.compressor },
    ...(profile.directOutput ? { directOutput: { ...profile.directOutput } } : { directOutput: undefined }),
    directOutputsByVoiceChannel: Object.fromEntries(Object.entries(profile.directOutputsByVoiceChannel).map(([id, route]) => [id, { ...route }])),
    busSends: Object.fromEntries(Object.entries(profile.busSends).map(([id, send]) => [id, { ...send }])),
    recallSafe: [...profile.recallSafe],
  };
}

export class UserProfileStore {
  readonly path: string;
  readonly profiles = new Map<string, PersistentUserProfileSnapshot>();
  #dirty = false;
  #flushTimer: NodeJS.Timeout | null = null;

  constructor(root: string) {
    this.path = join(root, "user-profiles.json");
    this.load();
  }

  snapshot(): PersistentUserProfileSnapshot[] {
    return [...this.profiles.values()]
      .sort((a, b) => a.preferredStripPosition - b.preferredStripPosition || a.discordUserId.localeCompare(b.discordUserId))
      .map(cloneProfile);
  }

  restoreOrCreate(channel: AudioChannel, discordUserId: string, displayName: string): PersistentUserProfileSnapshot {
    if (!DISCORD_USER_ID.test(discordUserId)) throw new Error("Discord User ID must be 17-20 digits");
    let profile = this.profiles.get(discordUserId);
    if (!profile) {
      channel.discordUserId = discordUserId;
      channel.label = displayName || channel.label;
      profile = this.profileFromChannel(channel, this.nextPosition());
      this.profiles.set(discordUserId, profile);
    } else {
      profile.displayName = text(displayName, profile.displayName);
      profile.updatedAt = new Date().toISOString();
      this.applyProfile(channel, profile);
    }
    channel.discordUserId = discordUserId;
    channel.preferredStripPosition = profile.preferredStripPosition;
    this.queueFlush();
    return cloneProfile(profile);
  }

  captureChannel(channel: AudioChannel): void {
    const discordUserId = channel.discordUserId;
    if (!discordUserId || !DISCORD_USER_ID.test(discordUserId)) return;
    const previous = this.profiles.get(discordUserId);
    const profile = this.profileFromChannel(channel, previous?.preferredStripPosition ?? this.nextPosition(), previous);
    this.profiles.set(discordUserId, profile);
    this.queueFlush();
  }

  setChannelColor(channel: AudioChannel, color: string): void {
    if (!channel.discordUserId || !CHANNEL_COLOR.test(color)) return;
    channel.channelColor = color.toLowerCase();
    this.captureChannel(channel);
  }

  setRecallSafe(channel: AudioChannel, parameter: string, safe: boolean): void {
    if (!channel.discordUserId || !parameter || parameter.length > 256) return;
    const profile = this.profiles.get(channel.discordUserId);
    if (!profile) return;
    const recallSafe = new Set(profile.recallSafe);
    safe ? recallSafe.add(parameter) : recallSafe.delete(parameter);
    profile.recallSafe = [...recallSafe].sort();
    profile.updatedAt = new Date().toISOString();
    this.queueFlush();
  }

  setTrusted(channel: AudioChannel, trusted: boolean): boolean {
    if (!channel.discordUserId) return false;
    const profile = this.profiles.get(channel.discordUserId);
    if (!profile || profile.trusted === trusted) return false;
    profile.trusted = trusted;
    profile.updatedAt = new Date().toISOString();
    this.queueFlush();
    return true;
  }

  isTrusted(discordUserId: string): boolean {
    return this.profiles.get(discordUserId)?.trusted === true;
  }

  setStripOrder(discordUserIds: readonly string[]): void {
    const seen = new Set<string>();
    for (const id of discordUserIds) {
      if (seen.has(id) || !this.profiles.has(id)) throw new Error(`unknown or duplicate Discord User ID: ${id}`);
      seen.add(id);
    }
    const tail = this.snapshot().map((profile) => profile.discordUserId).filter((id) => !seen.has(id));
    [...discordUserIds, ...tail].forEach((id, position) => {
      const profile = this.profiles.get(id)!;
      profile.preferredStripPosition = position;
      profile.updatedAt = new Date().toISOString();
    });
    this.queueFlush();
  }

  resetStripOrder(): void {
    [...this.profiles.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.discordUserId.localeCompare(b.discordUserId))
      .forEach((profile, position) => {
        profile.preferredStripPosition = position;
        profile.updatedAt = new Date().toISOString();
      });
    this.queueFlush();
  }

  removeBus(busId: string): void {
    let changed = false;
    for (const profile of this.profiles.values()) {
      if (!(busId in profile.busSends)) continue;
      delete profile.busSends[busId];
      profile.updatedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) this.queueFlush();
  }

  flush(): void {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    if (!this.#dirty) return;
    const temporary = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: PROFILE_VERSION, users: this.snapshot() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.path);
      this.#dirty = false;
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const decoded = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
    const root = record(decoded);
    const users = Array.isArray(root?.users) ? root.users : Array.isArray(root?.profiles) ? root.profiles : [];
    users.forEach((entry, index) => {
      const profile = sanitizeProfile(entry, index);
      if (profile) this.profiles.set(profile.discordUserId, profile);
    });
  }

  private nextPosition(): number {
    const used = new Set([...this.profiles.values()].map((profile) => profile.preferredStripPosition));
    let position = 0;
    while (used.has(position)) position += 1;
    return position;
  }

  private applyProfile(channel: AudioChannel, profile: PersistentUserProfileSnapshot): void {
    channel.label = profile.channelName;
    channel.channelColor = profile.channelColor;
    channel.faderDb = profile.mainFaderDb;
    channel.mute = profile.mainMute;
    channel.trimDb = profile.trimDb;
    channel.hpfEnabled = profile.hpf.enabled;
    channel.hpfCutoffHz = profile.hpf.cutoffHz;
    channel.hpf.configure(channel.sampleRate, profile.hpf.cutoffHz);
    channel.compressorEnabled = profile.compressor.enabled;
    channel.compressor.thresholdDb = profile.compressor.thresholdDb;
    channel.compressor.ratio = profile.compressor.ratio;
    channel.compressor.attackMs = profile.compressor.attackMs;
    channel.compressor.releaseMs = profile.compressor.releaseMs;
    channel.compressor.makeupDb = profile.compressor.makeupDb;
    const voiceChannelId = channel.currentVoiceChannelId;
    const directOutput = voiceChannelId ? profile.directOutputsByVoiceChannel[voiceChannelId] : undefined;
    channel.directOutput = directOutput ? { ...directOutput } : undefined;
    for (const busId of channel.vcSends.keys()) {
      const send = profile.busSends[busId];
      if (send) channel.vcSends.set(busId, { ...send });
    }
  }

  private profileFromChannel(channel: AudioChannel, position: number, previous?: PersistentUserProfileSnapshot): PersistentUserProfileSnapshot {
    const now = new Date().toISOString();
    const directOutputsByVoiceChannel = Object.fromEntries(
      Object.entries(previous?.directOutputsByVoiceChannel ?? {}).map(([id, route]) => [id, { ...route }]),
    );
    if (channel.currentVoiceChannelId) {
      if (channel.directOutput) directOutputsByVoiceChannel[channel.currentVoiceChannelId] = { ...channel.directOutput };
      else delete directOutputsByVoiceChannel[channel.currentVoiceChannelId];
    }
    const busSends = Object.fromEntries(
      Object.entries(previous?.busSends ?? {}).map(([id, send]) => [id, { ...send }]),
    );
    for (const [id, send] of channel.vcSends) busSends[id] = { ...send };
    return {
      discordUserId: channel.discordUserId!,
      displayName: previous?.displayName ?? channel.label,
      channelName: channel.label,
      channelColor: CHANNEL_COLOR.test(channel.channelColor ?? "") ? channel.channelColor!.toLowerCase() : previous?.channelColor ?? DEFAULT_COLOR,
      mainFaderDb: channel.faderDb,
      mainMute: channel.mute,
      trimDb: channel.trimDb,
      hpf: { enabled: channel.hpfEnabled, cutoffHz: channel.hpfCutoffHz },
      compressor: {
        enabled: channel.compressorEnabled,
        thresholdDb: channel.compressor.thresholdDb,
        ratio: channel.compressor.ratio,
        attackMs: channel.compressor.attackMs,
        releaseMs: channel.compressor.releaseMs,
        makeupDb: channel.compressor.makeupDb,
      },
      directOutputsByVoiceChannel,
      preferredStripPosition: position,
      busSends,
      recallSafe: previous ? [...previous.recallSafe] : [],
      trusted: previous?.trusted ?? false,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
  }

  private queueFlush(): void {
    this.#dirty = true;
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => this.flush(), 50);
    this.#flushTimer.unref();
  }
}

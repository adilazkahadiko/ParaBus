import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import type { BotRole, TxAudioMode, TxSubtype } from "../../../packages/shared-types/src/index.ts";
import { isTxDestination } from "../../../packages/shared-types/src/index.ts";
import { AdapterTokenCache, TOKEN_REENTRY_MESSAGE, type TokenProtection, tokenProtection } from "./token-protection.ts";

export const MAX_RX_BOTS = 24;
export const MAX_TX_BOTS = 22;
export const MAX_BOT_CONNECTIONS = 24;

export function isTxCapableRole(role: BotRole): boolean {
  return role === "TX" || role === "DUPLEX";
}

export function isRxCapableRole(role: BotRole): boolean {
  return role !== "TX";
}

export interface DiscordBotProfile {
  txDestination?: string | null;
  profileId: string;
  label: string;
  role: BotRole;
  txSubtype: TxSubtype | null;
  txAudioMode: TxAudioMode | null;
  tokenEnv: string;
  token: string;
  tokenError?: string;
  guildId: string;
  voiceChannelId: string;
}

interface BotFileEntry {
  txDestination?: unknown;
  id?: unknown;
  label?: unknown;
  role?: unknown;
  tokenEnv?: unknown;
  guildId?: unknown;
  voiceChannelId?: unknown;
  enabled?: unknown;
  txSubtype?: unknown;
  txAudioMode?: unknown;
}

export function loadBotRackEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  environmentFile = resolve(".env"),
): NodeJS.ProcessEnv {
  const loaded: NodeJS.ProcessEnv = { ...environment };
  if (!existsSync(environmentFile)) return loaded;
  Object.assign(loaded, parseEnv(readFileSync(environmentFile, "utf8")));
  return loaded;
}

function requiredString(value: unknown, field: string, profile: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${profile}: ${field} is required`);
  return value.trim();
}

function snowflake(value: unknown, field: string, profile: string): string {
  const parsed = requiredString(value, field, profile);
  if (!/^\d{17,20}$/.test(parsed)) throw new Error(`${profile}: ${field} must be a Discord snowflake`);
  return parsed;
}

export function parseBotRackConfig(input: unknown, environment: NodeJS.ProcessEnv = process.env, resolveToken?: (name: string, profileId: string) => { value: string | null; error?: string }): DiscordBotProfile[] {
  const entries = Array.isArray(input) ? input : (input as { bots?: unknown } | null)?.bots;
  if (!Array.isArray(entries)) throw new Error("Bot Rack config must contain a bots array");
  const enabled = entries.filter((entry) => (entry as BotFileEntry | null)?.enabled !== false);
  if (enabled.length > MAX_BOT_CONNECTIONS) throw new Error(`Bot Rack supports at most ${MAX_BOT_CONNECTIONS} total bots`);
  const rxCount = enabled.filter((entry) => (entry as BotFileEntry | null)?.role !== "TX").length;
  const txCount = enabled.filter((entry) => isTxCapableRole(((entry as BotFileEntry | null)?.role ?? "RX") as BotRole)).length;
  if (rxCount > MAX_RX_BOTS) throw new Error(`Bot Rack supports at most ${MAX_RX_BOTS} RX/SPARE/DUPLEX bots`);
  if (txCount > MAX_TX_BOTS) throw new Error(`Bot Rack supports at most ${MAX_TX_BOTS} TX/DUPLEX bots`);
  const seenIds = new Set<string>();
  const seenTargets = new Set<string>();
  const seenTokens = new Set<string>();
  const seenDestinations = new Set<string>();
  return enabled.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`Bot ${index + 1}: invalid profile`);
    const entry = raw as BotFileEntry;
    const fallback = `RX${String(index + 1).padStart(2, "0")}`;
    const profileId = requiredString(entry.id ?? fallback, "id", fallback).slice(0, 32);
    if (!/^[A-Za-z0-9_-]+$/.test(profileId)) throw new Error(`${profileId}: id may only contain letters, numbers, _ and -`);
    if (seenIds.has(profileId)) throw new Error(`duplicate Bot Rack id: ${profileId}`);
    seenIds.add(profileId);
    const role = (entry.role ?? "RX") as BotRole;
    if (role !== "RX" && role !== "TX" && role !== "DUPLEX" && role !== "SPARE") throw new Error(`${profileId}: role must be RX, TX, DUPLEX or SPARE`);
    const txCapable = isTxCapableRole(role);
    const txDestination = txCapable && entry.txDestination != null && entry.txDestination !== "" ? entry.txDestination : null;
    if (txDestination !== null && !isTxDestination(txDestination)) throw new Error(`${profileId}: invalid txDestination`);
    if (txDestination) {
      if (seenDestinations.has(txDestination as string)) throw new Error(`duplicate TX destination: ${txDestination}`);
      seenDestinations.add(txDestination as string);
    }
    const txSubtype = txCapable ? (entry.txSubtype ?? "CUSTOM") as TxSubtype : null;
    if (txSubtype !== null && !["GAME", "CASTER", "COMMENTARY", "IFB", "CUSTOM"].includes(txSubtype)) {
      throw new Error(`${profileId}: invalid txSubtype`);
    }
    const txAudioMode = txCapable ? (entry.txAudioMode ?? "MONO") as TxAudioMode : null;
    if (txAudioMode !== null && txAudioMode !== "MONO" && txAudioMode !== "STEREO") {
      throw new Error(`${profileId}: txAudioMode must be MONO or STEREO`);
    }
    const tokenEnv = requiredString(entry.tokenEnv, "tokenEnv", profileId);
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(tokenEnv)) throw new Error(`${profileId}: invalid tokenEnv name`);
    const resolved = resolveToken?.(tokenEnv, profileId);
    const token = resolved ? resolved.value ?? "" : environment[tokenEnv]?.trim();
    if (!token && !resolved?.error) throw new Error(`${profileId}: environment variable ${tokenEnv} is not set`);
    if (token && seenTokens.has(token)) throw new Error(`${profileId}: duplicate Bot token; use one DUPLEX profile for RX + TX`);
    if (token) seenTokens.add(token);
    const guildId = snowflake(entry.guildId, "guildId", profileId);
    const voiceChannelId = snowflake(entry.voiceChannelId, "voiceChannelId", profileId);
    const target = `${token || profileId}:${guildId}:${voiceChannelId}`;
    if (seenTargets.has(target)) throw new Error(`${profileId}: duplicate bot/guild/VC target`);
    seenTargets.add(target);
    return {
      txDestination: txDestination as string | null,
      profileId,
      label: requiredString(entry.label ?? profileId, "label", profileId).slice(0, 80),
      role,
      txSubtype,
      txAudioMode,
      tokenEnv,
      token: token ?? "",
      ...(resolved?.error ? { tokenError: resolved.error } : {}),
      guildId,
      voiceChannelId,
    };
  });
}

const adapterTokenCache = new AdapterTokenCache();
export async function loadBotRackProfiles(
  environment: NodeJS.ProcessEnv = process.env,
  defaultFile = resolve("discord-bots.json"),
  protection: TokenProtection = tokenProtection,
  cache: AdapterTokenCache = adapterTokenCache,
): Promise<DiscordBotProfile[]> {
  const config = loadBotRackConfig(environment, defaultFile);
  // Validate structure first, without returning ciphertext as a usable credential.
  const profiles = parseBotRackConfig(config, {}, (name, profileId) => ({ value: environment[name]?.trim() ? profileId : "" }));
  const values = profiles.map(profile => environment[profile.tokenEnv]!.trim());
  const decoded = await cache.read(values, protection);
  const byName = new Map(profiles.map((profile, index) => [profile.tokenEnv, decoded[index]]));
  return parseBotRackConfig(config, {}, name => ({ value: byName.get(name) ?? null, ...(byName.get(name) === null ? { error: TOKEN_REENTRY_MESSAGE } : {}) }));
}

/** Shared configuration selection for Adapter profiles and Core startup identity. */
export function loadBotRackConfig(
  environment: NodeJS.ProcessEnv = process.env,
  defaultFile = resolve("discord-bots.json"),
): unknown {
  const configuredFile = environment.DISCORD_BOT_RACK_FILE?.trim();
  const configuredJson = environment.DISCORD_BOT_RACK_JSON?.trim();
  if (configuredFile || existsSync(defaultFile)) {
    const path = resolve(configuredFile || defaultFile);
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new Error("Discord Bot設定ファイルを読めません。JSON形式とアクセス権を確認してください。"); }
  }
  if (configuredJson) {
    try { return JSON.parse(configuredJson); }
    catch { throw new Error("Discord Bot設定のJSON形式を確認してください。"); }
  }

  const token = environment.DISCORD_BOT_TOKEN?.trim();
  const guildId = environment.DISCORD_GUILD_ID?.trim();
  const voiceChannelId = environment.DISCORD_VOICE_CHANNEL_ID?.trim();
  if (!token && !guildId && !voiceChannelId) return [];
  if (!token || !guildId || !voiceChannelId) {
    throw new Error("Discord Bot Rack is not configured. Set DISCORD_BOT_RACK_FILE or the three legacy DISCORD_* values.");
  }
  return {
    bots: [{ id: "RX01", label: "RX 01", role: "RX", tokenEnv: "DISCORD_BOT_TOKEN", guildId, voiceChannelId }],
  };
}

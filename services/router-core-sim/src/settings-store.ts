import { existsSync, readFileSync } from "node:fs";
import { writePrivateFile } from "./private-files.ts";
import { tokenProtection, PROTECTED_TOKEN_PREFIX, TOKEN_PROTECTION_WARNING, type TokenProtection } from "../../discord-adapter/src/token-protection.ts";
import { encryptEnvironmentTokens } from "./token-migration.ts";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { BotRole, TxAudioMode, TxSubtype } from "../../../packages/shared-types/src/index.ts";
import { isTxDestination } from "../../../packages/shared-types/src/index.ts";

export const SETTINGS_MAX_RX_BOTS = 24;
export const SETTINGS_MAX_TX_BOTS = 22;
export const SETTINGS_MAX_BOTS = 24;

export interface PublicBotSettings {
  txDestination?: string | null;
  id: string;
  label: string;
  role: BotRole;
  txSubtype: TxSubtype | null;
  txAudioMode: TxAudioMode | null;
  tokenEnv: string;
  tokenConfigured: boolean;
  guildId: string;
  voiceChannelId: string;
  enabled: boolean;
}

export interface SettingsSnapshot {
  tokenProtectionWarning: string | null;
  bots: PublicBotSettings[];
  operator: {
    port: number;
    lanAccess: boolean;
  };
  tablet: {
    enabled: boolean;
    port: number;
  };
  rackFile: string;
  environmentFile: string;
  limits: { rx: number; tx: number; total: number };
  restartRequired: true;
}

interface RawBotEntry {
  txDestination?: unknown;
  id?: unknown;
  label?: unknown;
  role?: unknown;
  txSubtype?: unknown;
  txAudioMode?: unknown;
  tokenEnv?: unknown;
  guildId?: unknown;
  voiceChannelId?: unknown;
  enabled?: unknown;
  token?: unknown;
}

interface RawTabletSettings {
  enabled?: unknown;
  port?: unknown;
}

interface RawOperatorSettings {
  port?: unknown;
  lanAccess?: unknown;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function tabletPort(value: unknown): number {
  const port = Number(value ?? 4174);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 4174;
}

function operatorPort(value: unknown): number {
  const port = Number(value ?? 4173);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 4173;
}

function readEnvironment(text: string): Map<string, string> {
  return new Map(Object.entries(parseEnv(text)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function updateEnvironment(text: string, updates: Map<string, string>): string {
  const lines = text ? text.replace(/\r\n/g, "\n").split("\n") : [];
  const written = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(lines[index]);
    if (!match || !updates.has(match[1])) continue;
    lines[index] = `${match[1]}=${updates.get(match[1])}`;
    written.add(match[1]);
  }
  const missing = [...updates].filter(([name]) => !written.has(name));
  if (missing.length) {
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push("# Settings画面から保存されたBot設定");
    for (const [name, value] of missing) lines.push(`${name}=${value}`);
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function tokenEnvironmentName(id: string): string {
  return `DISCORD_BOT_TOKEN_${id.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
}

function isTxCapableRole(role: BotRole): boolean {
  return role === "TX" || role === "DUPLEX";
}

export class SettingsStore {
  readonly root: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly environmentPath: string;
  readonly rackPath: string;
  readonly protection: TokenProtection;
  readonly warn: (message: string) => void;
  #pending: Promise<void> = Promise.resolve();

  constructor(root: string, environment: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = message => console.warn(message), protection: TokenProtection = tokenProtection) {
    this.root = root;
    this.environment = environment;
    this.environmentPath = join(root, ".env");
    this.rackPath = join(root, "discord-bots.json");
    this.warn = warn;
    this.protection = protection;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.#pending.then(operation);
    this.#pending = current.then(() => {}, () => {});
    return current;
  }

  flush(): Promise<void> { return this.#pending; }

  private protectionWarning(): void {
    try { this.warn(TOKEN_PROTECTION_WARNING); } catch { /* A warning sink must not abort the plaintext fallback. */ }
  }

  migrateTokens(): Promise<void> {
    return this.enqueue(async () => {
      if (!existsSync(this.environmentPath)) return;
      const original = readFileSync(this.environmentPath, "utf8");
      const migration = await encryptEnvironmentTokens(original, this.protection);
      if (migration.failed) this.protectionWarning();
      if (migration.changed) await writePrivateFile(this.environmentPath, migration.text);
    });
  }

  snapshot(): SettingsSnapshot {
    const environmentText = existsSync(this.environmentPath) ? readFileSync(this.environmentPath, "utf8") : "";
    const environmentValues = readEnvironment(environmentText);
    // Examples are documentation, not user configuration. A clean install
    // starts with an empty rack; the explicit legacy .env path still works.
    const sourcePath = this.rackPath;
    let entries: RawBotEntry[] = [];
    if (existsSync(sourcePath)) {
      let decoded: { bots?: unknown };
      try { decoded = JSON.parse(readFileSync(sourcePath, "utf8")); }
      catch { throw new Error("Bot設定ファイルを読み込めません。JSON形式とアクセス権を確認してください。"); }
      if (Array.isArray(decoded.bots)) entries = decoded.bots as RawBotEntry[];
    }
    if (!existsSync(this.rackPath)) {
      const legacyToken = environmentValues.get("DISCORD_BOT_TOKEN") || this.environment.DISCORD_BOT_TOKEN;
      const legacyGuildId = environmentValues.get("DISCORD_GUILD_ID") || this.environment.DISCORD_GUILD_ID;
      const legacyVoiceChannelId = environmentValues.get("DISCORD_VOICE_CHANNEL_ID") || this.environment.DISCORD_VOICE_CHANNEL_ID;
      if (legacyToken || legacyGuildId || legacyVoiceChannelId) {
        entries[0] = {
          ...(entries[0] ?? {}), id: "RX01", label: "RX 01", role: "RX", tokenEnv: "DISCORD_BOT_TOKEN",
          guildId: legacyGuildId ?? "", voiceChannelId: legacyVoiceChannelId ?? "", enabled: true,
        };
      }
    }
    const bots = entries.slice(0, SETTINGS_MAX_BOTS).map((entry, index): PublicBotSettings => {
      const id = stringValue(entry.id) || `RX${String(index + 1).padStart(2, "0")}`;
      const role = entry.role === "TX" || entry.role === "DUPLEX" || entry.role === "SPARE" ? entry.role : "RX";
      const tokenEnv = stringValue(entry.tokenEnv) || tokenEnvironmentName(id);
      const txCapable = isTxCapableRole(role);
      return {
        id,
        label: stringValue(entry.label) || id,
        role,
        txSubtype: txCapable && ["GAME", "CASTER", "COMMENTARY", "IFB", "CUSTOM"].includes(String(entry.txSubtype)) ? entry.txSubtype as TxSubtype : txCapable ? "CUSTOM" : null,
        txAudioMode: txCapable && entry.txAudioMode === "STEREO" ? "STEREO" : txCapable ? "MONO" : null,
        txDestination: txCapable && isTxDestination(entry.txDestination) ? entry.txDestination : null,
        tokenEnv,
        tokenConfigured: Boolean(environmentValues.get(tokenEnv) || this.environment[tokenEnv]),
        guildId: stringValue(entry.guildId),
        voiceChannelId: stringValue(entry.voiceChannelId),
        enabled: entry.enabled !== false,
      };
    });
    return {
      tokenProtectionWarning: process.platform === "win32" && [...environmentValues].some(([key, value]) => /^DISCORD_BOT_TOKEN(?:_|$)/.test(key) && value && !value.startsWith(PROTECTED_TOKEN_PREFIX))
        ? "Bot Tokenが暗号化されていません。保存先の権限を確認してください。暗号化が利用可能になった後に再起動してください。" : null,
      bots,
      operator: {
        port: operatorPort(environmentValues.get("PORT") ?? this.environment.PORT),
        lanAccess: (environmentValues.get("DBR_LAN_ACCESS") ?? this.environment.DBR_LAN_ACCESS) === "1",
      },
      tablet: {
        enabled: (environmentValues.get("TABLET_CONTROL_ENABLED") ?? this.environment.TABLET_CONTROL_ENABLED) === "1",
        port: tabletPort(environmentValues.get("TABLET_CONTROL_PORT") ?? this.environment.TABLET_CONTROL_PORT),
      },
      rackFile: "discord-bots.json",
      environmentFile: ".env",
      limits: { rx: SETTINGS_MAX_RX_BOTS, tx: SETTINGS_MAX_TX_BOTS, total: SETTINGS_MAX_BOTS },
      restartRequired: true,
    };
  }

  save(input: unknown): Promise<SettingsSnapshot> {
    const captured = structuredClone(input);
    return this.enqueue(() => this.saveLocked(captured));
  }

  private async saveLocked(input: unknown): Promise<SettingsSnapshot> {
    const settings = input as { bots?: unknown; operator?: RawOperatorSettings; tablet?: RawTabletSettings } | null;
    const rawBots = settings?.bots;
    if (!Array.isArray(rawBots)) throw new Error("Bot設定の配列がありません");
    if (rawBots.length > SETTINGS_MAX_BOTS) throw new Error(`Bot設定は最大${SETTINGS_MAX_BOTS}件です`);
    const environmentText = existsSync(this.environmentPath) ? readFileSync(this.environmentPath, "utf8") : "";
    const environmentValues = readEnvironment(environmentText);
    const requestedOperatorPort = Number(settings?.operator?.port ?? operatorPort(environmentValues.get("PORT") ?? this.environment.PORT));
    if (!Number.isInteger(requestedOperatorPort) || requestedOperatorPort < 1024 || requestedOperatorPort > 65535) {
      throw new Error("Application Portは1024〜65535の整数で指定してください");
    }
    const tabletEnabled = settings?.tablet?.enabled === true;
    const requestedTabletPort = Number(settings?.tablet?.port ?? 4174);
    if (!Number.isInteger(requestedTabletPort) || requestedTabletPort < 1024 || requestedTabletPort > 65535) {
      throw new Error("Tablet用ポートは1024〜65535の整数で指定してください");
    }
    if (settings?.tablet && tabletEnabled && requestedOperatorPort === requestedTabletPort) throw new Error("Application PortとTablet用ポートは別の値にしてください");
    if (settings?.operator?.lanAccess !== undefined && typeof settings.operator.lanAccess !== "boolean") throw new Error("LAN公開設定が不正です");
    const lanAccess = settings?.operator?.lanAccess ?? ((environmentValues.get("DBR_LAN_ACCESS") ?? this.environment.DBR_LAN_ACCESS) === "1");
    const updates = new Map<string, string>([
      ["DISCORD_BOT_RACK_FILE", "discord-bots.json"],
      ["PORT", String(requestedOperatorPort)],
      ["DBR_LAN_ACCESS", lanAccess ? "1" : "0"],
    ]);
    // The desktop no longer edits prototype Tablet preferences. Preserve old
    // values when omitted; retaining them never enables a production listener.
    if (settings?.tablet !== undefined) {
      updates.set("TABLET_CONTROL_ENABLED", tabletEnabled ? "1" : "0");
      updates.set("TABLET_CONTROL_PORT", String(requestedTabletPort));
    }
    const seenIds = new Set<string>();
    const seenTokenEnvironments = new Set<string>();
    const effectiveTokens: { id: string; value: string }[] = [];
    let rxCount = 0;
    let txCount = 0;
    const destinations = new Set<string>();

    const bots = rawBots.map((raw, index) => {
      if (!raw || typeof raw !== "object") throw new Error(`Bot ${index + 1}の設定が不正です`);
      const entry = raw as RawBotEntry;
      const id = stringValue(entry.id);
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error(`Bot ${index + 1}: Profile IDは英数字・_・-で32文字以内にしてください`);
      if (seenIds.has(id)) throw new Error(`Profile IDが重複しています: ${id}`);
      seenIds.add(id);
      const label = stringValue(entry.label);
      if (!label || label.length > 80) throw new Error(`${id}: Bot名は1〜80文字にしてください`);
      const role = entry.role === "TX" || entry.role === "DUPLEX" || entry.role === "SPARE" ? entry.role : entry.role === "RX" ? "RX" : null;
      if (!role) throw new Error(`${id}: Roleが不正です`);
      const enabled = entry.enabled !== false;
      const txCapable = isTxCapableRole(role);
      const txDestination = txCapable && entry.txDestination != null && entry.txDestination !== "" ? entry.txDestination : null;
      if (txDestination !== null && !isTxDestination(txDestination)) throw new Error(`${id}: TX送信先区分が不正です`);
      if (enabled && txDestination) {
        if (destinations.has(txDestination as string)) throw new Error(`TX送信先区分が重複しています: ${txDestination}`);
        destinations.add(txDestination as string);
      }
      if (enabled && txCapable) txCount += 1;
      if (enabled && role !== "TX") rxCount += 1;
      const txSubtype = txCapable && ["GAME", "CASTER", "COMMENTARY", "IFB", "CUSTOM"].includes(String(entry.txSubtype)) ? entry.txSubtype as TxSubtype : txCapable ? "CUSTOM" : null;
      const txAudioMode = txCapable && entry.txAudioMode === "STEREO" ? "STEREO" : txCapable ? "MONO" : null;
      const tokenEnv = stringValue(entry.tokenEnv) || tokenEnvironmentName(id);
      if (!/^DISCORD_BOT_TOKEN(_[A-Z0-9_]+)?$/.test(tokenEnv)) throw new Error(`${id}: Token環境変数名が不正です`);
      if (seenTokenEnvironments.has(tokenEnv)) throw new Error(`Token環境変数名が重複しています: ${tokenEnv}`);
      seenTokenEnvironments.add(tokenEnv);
      const guildId = stringValue(entry.guildId);
      const voiceChannelId = stringValue(entry.voiceChannelId);
      if (enabled && !/^\d{17,20}$/.test(guildId)) throw new Error(`${id}: Guild IDは17〜20桁の数字で入力してください`);
      if (enabled && !/^\d{17,20}$/.test(voiceChannelId)) throw new Error(`${id}: VC IDは17〜20桁の数字で入力してください`);
      const token = stringValue(entry.token);
      if (token && (token.startsWith(PROTECTED_TOKEN_PREFIX) || token.length > 256 || /[\s#=]/.test(token))) throw new Error(`${id}: Tokenの形式が不正です`);
      if (token) updates.set(tokenEnv, token);
      const existingToken = token || environmentValues.get(tokenEnv) || this.environment[tokenEnv];
      if (enabled && !existingToken) throw new Error(`${id}: Bot Tokenを入力してください`);
      if (enabled && existingToken) effectiveTokens.push({ id, value: existingToken });
      return { id, label, role, txSubtype, txAudioMode, txDestination, tokenEnv, guildId, voiceChannelId, enabled };
    });
    if (rxCount > SETTINGS_MAX_RX_BOTS) throw new Error(`有効なRX / SPARE Botは最大${SETTINGS_MAX_RX_BOTS}台です`);
    if (txCount > SETTINGS_MAX_TX_BOTS) throw new Error(`有効なTX / DUPLEX Botは最大${SETTINGS_MAX_TX_BOTS}台です`);

    // Option A: the only Core decryption is this save-time duplicate comparison.
    // Never copy decoded values into process.env, snapshots or persisted metadata.
    if (effectiveTokens.length > 1) {
      const protectedValues = [...new Set(effectiveTokens.map(entry => entry.value).filter(value => value.startsWith(PROTECTED_TOKEN_PREFIX)))];
      const decoded = await this.protection.unprotect(protectedValues);
      const compared = new Map(protectedValues.map((value, index) => [value, decoded[index]]));
      const seen = new Set<string>();
      try { for (const entry of effectiveTokens) {
        // Unreadable credentials cannot connect; allow repairing other bots. Identical
        // unreadable ciphertext is still rejected, and re-entry enables full comparison.
        const plain = compared.get(entry.value);
        const identity = entry.value.startsWith(PROTECTED_TOKEN_PREFIX) ? plain ? `plain:${plain}` : `unreadable:${entry.value}` : `plain:${entry.value}`;
        if (seen.has(identity)) throw new Error(`${entry.id}: 同じBot Tokenが複数の有効設定で使われています。1 Botで送受信する場合はRoleをDUPLEXにしてください`);
        seen.add(identity);
      } } finally { compared.clear(); decoded.fill(null); seen.clear(); }
    }
    const migration = await encryptEnvironmentTokens(updateEnvironment(environmentText, updates), this.protection);
    if (migration.failed) this.protectionWarning();
    await writePrivateFile(this.environmentPath, migration.text);
    await writePrivateFile(this.rackPath, `${JSON.stringify({ version: 1, bots }, null, 2)}\n`);
    return this.snapshot();
  }
}

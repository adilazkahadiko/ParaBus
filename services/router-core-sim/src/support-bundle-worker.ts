import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { cpus, freemem, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv, promisify } from "node:util";
import { parentPort, workerData } from "node:worker_threads";
import { crc32 } from "node:zlib";
import { isTxDestination } from "../../../packages/shared-types/src/index.ts";
import type { SupportBundleRequest } from "./support-bundle.ts";

const request = workerData as SupportBundleRequest;
const now = new Date(request.now ?? Date.now());
const days = request.days ?? 7;
const salt = randomBytes(32); // Never exported, nor retained after this worker exits.
const secrets = new Set<string>();
const botNames = new Set<string>();
const MAX_CONSOLE_LOG_BYTES = 5 * 1024 * 1024;
type ConsoleLogInfo = { truncated: boolean; originalSizeBytes: number; exportedBytes: number };
const alias = (kind: string, value: string) => `${kind}-${createHmac("sha256", salt).update(value).digest("hex").slice(0, 12)}`;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Fixed inputs only; symbolic links cannot smuggle other files into the allowlist. */
async function readAllowed(path: string, maxBytes = 1024 * 1024): Promise<string | null> {
  try {
    if (!(await lstat(path)).isFile()) return null;
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if ((await file.stat()).size > maxBytes) return null;
      return await file.readFile("utf8");
    } finally { await file.close(); }
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

function text(value: string, idKind = "user"): string {
  let safe = value;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) safe = safe.split(secret).join("[REDACTED]");
  return safe.replace(/\b\d{17,20}\b/g, (id) => alias(idKind, id))
    .replace(/(?:mfa\.[A-Za-z0-9_-]{20,}|\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b)/g, "[REDACTED]")
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:home|Users|tmp|var|etc|opt|srv|run)\/)[^\s"'<>]*/g, "[PATH]");
}

function anonymous(value: unknown, key = "", parent = ""): unknown {
  if (typeof value === "string") {
    if (key === "guildName") return alias("guild", value);
    if (key === "voiceChannelName") return alias("vc", value);
    if (key === "label" && parent === "participants") return alias("user", value);
    return text(value, key === "guildId" ? "guild" : key === "voiceChannelId" ? "vc" : key === "botId" ? "bot" : "user");
  }
  if (Array.isArray(value)) return value.map((entry) => anonymous(entry, "", key || parent));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([field, entry]) => [field, anonymous(entry, field, parent)]));
  return value;
}

function validRuntime(value: unknown) {
  const raw = object(value);
  return {
    buildCommit: typeof raw.buildCommit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(raw.buildCommit) ? raw.buildCommit : null,
    pcRole: ["RX", "TX", "MIXED", "UNCONFIGURED"].includes(String(raw.pcRole)) ? raw.pcRole : "UNCONFIGURED",
    startedAt: typeof raw.startedAt === "string" && Number.isFinite(Date.parse(raw.startedAt)) ? new Date(raw.startedAt).toISOString() : null,
  };
}

/** Free-form messages may contain unknown historic names/secrets. Keep only diagnostic grammars.
 * Unrecognized text becomes an opaque event alias, NOT a partly scrubbed raw message. */
function diagnosticMessage(message: string): string {
  if (/^RX in-speech underruns: count=\d{1,12}$/.test(message)) return message;
  if (/^Audio fault: target=(?:MAIN_OUTPUT|INPUT) classification=(?:STREAM_ENDED|STREAM_ERROR|DEVICE_UNAVAILABLE|PRESENCE_PROVIDER_UNAVAILABLE|ASIO_FAULT|UNKNOWN) hostApi=(?:Windows WASAPI|ASIO|MME|Windows DirectSound|Windows WDM-KS|Core Audio|CoreAudio|ALSA|JACK|Simulator|UNKNOWN)$/.test(message)) return message;
  if (/^Physical input timing totals: channels=\d{1,3}\/\d{1,3} packets=\d{1,12} gapMax=\d{1,12}\.\dms underruns=\d{1,12} missing=\d{1,12} dropped=\d{1,12}$/.test(message)) return message;
  if (/^Audio timing summary: main inflight=(?:n\/a|\d{1,2}-\d{1,2}) cue inflight=(?:n\/a|\d{1,2}-\d{1,2}) sched maxLate=\d{1,12}\.\dms catchup=\d{1,12} rx underruns=\d{1,12} overflows=\d{1,12}(?: loop p99=\d{1,12}\.\dms max=\d{1,12}\.\dms process max=\d{1,12}\.\dms)?$/.test(message)) return message;
  const participantEvent = /^(user joined|user left|pending created|approval revoked|trusted enabled|trusted disabled|session approval reset): (.+)$/.exec(message);
  if (participantEvent) return `${participantEvent[1]}: ${alias("user", participantEvent[2])}`;
  const approved = /^approved: (.+) \(trusted auto-approve\)$/.exec(message);
  if (approved) return `approved: ${alias("user", approved[1])} (trusted auto-approve)`;
  const manualApproval = /^approved: (.+)$/.exec(message);
  if (manualApproval) return `approved: ${alias("user", manualApproval[1])}`;
  const rejoin = /^rejoin restored: (.+) \((APPROVED|PENDING)\)$/.exec(message);
  if (rejoin) return `rejoin restored: ${alias("user", rejoin[1])} (${rejoin[2]})`;
  if (/^TX targets armed: (?:[A-Za-z0-9_-]{1,32})(?:, [A-Za-z0-9_-]{1,32})*$/.test(message)) return message;
  const botAction = /^(.+?) (started by operator|stopped by operator|disconnected by operator|connection requested by operator|source: Matrix OUT \d+|assigned to Discord VC (?:\d{17,20}|\[ID\]))$/.exec(message);
  if (botAction && (botAction[1] === "Discord TX" || /^[A-Za-z0-9_-]{1,32}$/.test(botAction[1]) || botNames.has(botAction[1]))) return message;
  if (/^ON AIR receiver switch rejected: [A-Za-z0-9_-]{1,32}(?:; confirmation required)?$/.test(message)) return message;
  if (/^ParaBus startup: commit=(?:[a-f0-9]{12}|[a-f0-9]{40}|[a-f0-9]{64}|unknown|\[REDACTED\]) PC=(?:RX|TX|MIXED|UNCONFIGURED) started=[\dTZ:.-]+$/.test(message) && Number.isFinite(Date.parse(message.split("started=")[1]))) return message;
  const channelAction = /^(.+) (fader -?\d+\.\d+ dB|muted|opened|→ Output \d+ \((?:PRE|POST)\))$/.exec(message);
  if (channelAction) return `${alias("user", channelAction[1])} ${channelAction[2]}`;
  const busAction = /^(.+) (→ Output \d+(?:\/\d+ \(DUAL MONO\))?|physical output unassigned|Discord VC binding changed|new participant policy: (?:SAFE|HOLD|PRESET)|limiter (?:enabled|disabled)|integrated loudness reset)$/.exec(message);
  if (busAction) return `${botNames.has(busAction[1]) ? text(busAction[1]) : alias("vc", busAction[1])} ${busAction[2]}`;
  const busLifecycle = /^VC Bus (.+) (created \((?:SAFE|HOLD|PRESET)\)|removed)$/.exec(message);
  if (busLifecycle) return `VC Bus ${alias("vc", busLifecycle[1])} ${busLifecycle[2]}`;
  const scene = /^Scene (.+) (saved|recalled|deleted)$/.exec(message);
  if (scene) return `Scene ${alias("scene", scene[1])} ${scene[2]}`;
  const device = /^(出力デバイス|Cueデバイス): (.+)$/.exec(message);
  if (device) return `${device[1]}: ${alias("device", device[2])}`;
  const inputDevice = /^入力デバイス: (.+) \/ (\d+ch)$/.exec(message);
  if (inputDevice) return `入力デバイス: ${alias("device", inputDevice[1])} / ${inputDevice[2]}`;
  if (/^(?:Router core simulator started|Event Log cleared by operator|Fault acknowledged; select and validate the output device manually|Monitor Out unassigned|Monitor Out moved from Main device to independent Cue device|Monitor Out was unassigned because the selected device has fewer output channels|Intentional output collision confirmed: Output \d+|Monitor Out → Output \d+(?:\/\d+ \(DUAL MONO\)| \(MONO\)))$/.test(message)) return message;
  if (/^(?:Audio engine xruns|Audio output backpressure drops|Discord decode errors|Recorder dropped blocks|Discord RX IPC Opus dropped|Discord RX IPC backpressure writes \(queued, not dropped\)) \+\d+$/.test(message)) return message;
  if (/^(?:Discord Adapter|Audio output|Audio input): [A-Z_]+ → [A-Z_]+$/.test(message)) return message;
  if (/^Operational log queue recovered: \d+ events dropped$/.test(message)) return message;
  if (/^(?:Emergency mute (?:activated|released)|State changed to (?:SETUP|READY|ON_AIR|FAULT)|Armed TX targets started by operator|All TX targets cleared and stopped|Recorder stopping|Recorder started: (?:\d+ selected tracks|Matrix OUT \d+)|OUTPUT DEVICE LOST; output forced to silence|INPUT DEVICE LOST; input buffers cleared and all outputs fail closed)$/.test(message)) return message;
  const health = /^(.+?): ((?:decode errors|packet sequence gaps|audio samples dropped|Discord reconnect|TX dropped frames) \+\d+|receive queue (?:high|recovered) \(\d+ ms\)|(?:WebSocket ping|Voice UDP ping) (?:high|recovered) \(\d+ ms\)|[A-Z_]+ → [A-Z_]+|RX overflow [\dTZ:.-]+; q=[\d.]+ms in=\d+ drop=\d+ gap=[\d.]+ms batch=\d+ bytes=\d+ elapsed=[\d.]+ms maxWork=[\d.]+ms)$/.exec(message);
  if (health) return `${botNames.has(health[1]) ? text(health[1]) : alias("user", health[1])}: ${health[2]}`;
  // Windows tray redirects Adapter/Core stdout into this one known console file.
  const retry = /^\[([A-Za-z0-9_-]{1,32})\] Opus receive stream failed for (\d{17,20}): (.+); retrying in (\d+)ms \(attempt (\d+)\)$/.exec(message);
  if (retry) return `[${text(retry[1])}] Opus receive stream failed for ${alias("user", retry[2])}: ${/DAVE|decrypt/i.test(retry[3]) ? "DAVE " : ""}${alias("error", retry[3])}; retrying in ${retry[4]}ms (attempt ${retry[5]})`;
  const ready = /^\[([A-Za-z0-9_-]{1,32})\] Discord (RX|TX|DUPLEX|SPARE) ready: (.+) \/ (.+)$/.exec(message);
  if (ready) return `[${text(ready[1])}] Discord ${ready[2]} ready: ${alias("guild", ready[3])} / ${alias("vc", ready[4])}`;
  return alias("event", message);
}

async function* logLines(path: string, consoleInfo?: ConsoleLogInfo) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  // Snapshot file length so a busy logger cannot extend the export forever.
  const size = (await file.stat()).size;
  const start = consoleInfo ? Math.max(0, size - MAX_CONSOLE_LOG_BYTES) : 0;
  if (consoleInfo) { consoleInfo.originalSizeBytes = size; consoleInfo.truncated = start > 0; }
  if (!size) { await file.close(); return; }
  let discardFirst = start > 0;
  if (discardFirst) {
    const previous = Buffer.alloc(1);
    await file.read(previous, 0, 1, start - 1);
    discardFirst = previous[0] !== 10;
  }
  const stream = file.createReadStream({ encoding: "utf8", highWaterMark: 64 * 1024, start, end: size - 1, autoClose: false });
  let pending = "", oversized = false;
  try {
    for await (const chunk of stream) {
      const parts = String(chunk).split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (!oversized) pending += parts[i];
        if (pending.length > 16 * 1024) { pending = ""; oversized = true; }
        if (i < parts.length - 1) {
          if (!discardFirst) yield oversized ? "[oversized log line omitted]" : pending.replace(/\r$/, "");
          discardFirst = false;
          pending = ""; oversized = false;
        }
      }
    }
    // Ignore a partially-written final line in an active log.
  } finally { stream.destroy(); await file.close(); }
}

async function* sanitizedLog(path: string, consoleInfo?: ConsoleLogInfo) {
  // Anonymous aliases can be longer than very short input lines. Keep the newest
  // complete output lines within the same cap, with bounded memory and O(n) eviction.
  let tail: Buffer[] = [], first = 0;
  for await (const line of logLines(path, consoleInfo)) {
    if (!line.trim()) continue;
    if (consoleInfo) {
      const bytes = Buffer.from(`${text(diagnosticMessage(line))}\n`);
      tail.push(bytes); consoleInfo.exportedBytes += bytes.length;
      while (consoleInfo.exportedBytes > MAX_CONSOLE_LOG_BYTES) {
        consoleInfo.exportedBytes -= tail[first++].length; consoleInfo.truncated = true;
      }
      if (first > 1024) { tail = tail.slice(first); first = 0; }
      continue;
    }
    let raw: Record<string, unknown>;
    try { raw = object(JSON.parse(line)); } catch { continue; }
    if (typeof raw.at !== "string" || !Number.isFinite(Date.parse(raw.at)) || !["INFO", "WARNING", "CRITICAL"].includes(String(raw.level))) continue;
    yield Buffer.from(`${JSON.stringify({ at: new Date(raw.at).toISOString(), level: raw.level, message: text(diagnosticMessage(typeof raw.message === "string" ? raw.message : "")), ...(raw.runtimeInfo ? { runtimeInfo: validRuntime(raw.runtimeInfo) } : {}) })}\n`);
  }
  for (let i = first; i < tail.length; i++) yield tail[i];
}

async function nativeState(script: string) {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [join(request.projectRoot, "scripts", script)], { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true });
    return JSON.parse(stdout.trim()).state === "READY" ? "READY" : "UNAVAILABLE";
  } catch { return "UNAVAILABLE"; }
}

async function main() {
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(days) || days < 1 || days > 30) throw new Error("Invalid bundle request");
  // Read config only to select permitted facts and redact exact secret values; never archive it.
  const envText = await readAllowed(join(request.settingsRoot, ".env"));
  const environment = { ...process.env, ...(envText ? parseEnv(envText) : {}) };
  for (const [key, value] of Object.entries(environment)) {
    if (value && /token|secret|password|credential|nonce|api.?key/i.test(key)) secrets.add(value);
  }
  if (envText) for (const value of Object.values(parseEnv(envText))) if (value && value.length >= 4 && !/^\d{17,20}$/.test(value)) secrets.add(value);
  let config: unknown;
  const configPath = resolve(environment.DISCORD_BOT_RACK_FILE?.trim() || join(request.settingsRoot, "discord-bots.json"));
  const configText = await readAllowed(configPath);
  try { config = JSON.parse(configText ?? environment.DISCORD_BOT_RACK_JSON ?? "[]"); } catch { config = []; }
  if (!configText && !environment.DISCORD_BOT_RACK_JSON && environment.DISCORD_BOT_TOKEN) config = [{ role: "RX", enabled: true }];
  const entries = Array.isArray(config) ? config : object(config).bots;
  const bots = (Array.isArray(entries) ? entries : []).map((entry) => {
    const bot = object(entry);
    if (typeof bot.token === "string" && bot.token) secrets.add(bot.token);
    if (typeof bot.tokenEnv === "string" && environment[bot.tokenEnv]) secrets.add(environment[bot.tokenEnv]!);
    return { role: ["RX", "TX", "DUPLEX", "SPARE"].includes(String(bot.role ?? "RX")) ? bot.role ?? "RX" : "INVALID", txDestination: isTxDestination(bot.txDestination) ? bot.txDestination : null, enabled: bot.enabled !== false };
  });
  for (const bot of request.diagnostics.discord.bots) {
    if (typeof bot.label === "string") botNames.add(bot.label);
    if (typeof bot.profileId === "string") botNames.add(bot.profileId);
  }
  const runtime = validRuntime(request.runtimeInfo);
  const directory = join(request.settingsRoot, "support");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid support directory");
  const fileName = `ParaBus-support-${runtime.pcRole}-${runtime.buildCommit?.slice(0, 12) ?? "unknown"}-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomBytes(4).toString("hex")}.zip`;
  const path = join(directory, fileName), pendingPath = `${path}.pending`;
  const archive = await open(pendingPath, "wx", 0o600);
  const central: Buffer[] = [];
  let offset = 0, count = 0;
  async function write(bytes: Uint8Array) { await archive.writeFile(bytes); offset += bytes.length; if (offset > 0xffffffff) throw new Error("Bundle exceeds ZIP capacity"); }
  async function add(nameText: string, chunks: AsyncIterable<Uint8Array>) {
    const name = Buffer.from(nameText), start = offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x808, 6); header.writeUInt16LE(33, 12); header.writeUInt16LE(name.length, 26);
    await write(header); await write(name);
    let checksum = 0, bytes = 0;
    for await (const chunk of chunks) { checksum = crc32(chunk, checksum); bytes += chunk.length; await write(chunk); }
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4); descriptor.writeUInt32LE(bytes, 8); descriptor.writeUInt32LE(bytes, 12);
    await write(descriptor);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x808, 8); record.writeUInt16LE(33, 14);
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(bytes, 20); record.writeUInt32LE(bytes, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(start, 42);
    central.push(record, name); count++;
  }
  async function json(name: string, value: unknown) { await add(name, (async function* () { yield Buffer.from(JSON.stringify(anonymous(value), null, 2) + "\n"); })()); }
  try {
    const [opus, naudiodon] = await Promise.all([nativeState("opus-native-check.ts"), nativeState("audio-native-check.ts")]);
    await json("runtime-info.json", runtime);
    let releaseInfo: Record<string, unknown> = {};
    try { releaseInfo = object(JSON.parse(await readAllowed(join(request.projectRoot, "release-build-info.json")) ?? "{}")); } catch {}
    await json("release-build-info.json", { schemaVersion: 1, buildCommit: releaseInfo.schemaVersion === 1 ? validRuntime(releaseInfo).buildCommit : null });
    await json("diagnostics.json", request.diagnostics);
    await json("bot-summary.json", { total: bots.length, enabled: bots.filter((bot) => bot.enabled).length, bots });
    const cpu = cpus();
    await json("system.json", { node: process.version, platform: process.platform, arch: process.arch, osRelease: release(), cpuModel: cpu[0]?.model ?? "unknown", cpuCount: cpu.length, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), nativeDependencies: { "@discordjs/opus": opus, naudiodon2: naudiodon } });
    const logDirectory = join(request.settingsRoot, "logs");
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const included: string[] = [];
    let routerLog: ConsoleLogInfo | null = null;
    let logsPresent = false;
    try { logsPresent = (await lstat(logDirectory)).isDirectory(); } catch {}
    if (logsPresent) for (const name of (await readdir(logDirectory)).sort()) {
      const match = /^operational-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name);
      if (!match) continue;
      const inputPath = join(logDirectory, name), stat = await lstat(inputPath);
      if (!stat.isFile()) continue;
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      if (date < cutoff || date >= today) continue;
      const outputName = `logs/${name}`;
      await add(outputName, sanitizedLog(inputPath)); included.push(outputName);
    }
    // The tray always redirects stdout to the project folder, independently of settingsRoot.
    const consoleDirectory = join(request.projectRoot, "logs"), consolePath = join(consoleDirectory, "router.log");
    let consoleStat: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      if ((await lstat(consoleDirectory)).isDirectory()) consoleStat = await lstat(consolePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (consoleStat?.isFile() && consoleStat.mtime >= cutoff && consoleStat.mtime < today) {
      routerLog = { truncated: false, originalSizeBytes: 0, exportedBytes: 0 };
      await add("logs/router.log", sanitizedLog(consolePath, routerLog)); included.push("logs/router.log");
    }
    await json("bundle-info.json", { schemaVersion: 1, createdAt: now.toISOString(), days, logs: included, routerLog, consoleLogPolicy: "projectRoot/logs/router.log only, selected by modification date; newest complete lines within a 5 MiB input/output cap; free text replaced with event aliases", messagePolicy: "Only recognized diagnostic grammars retain text; other messages are event aliases. No alias map or salt is included." });
    const centralStart = offset;
    for (const bytes of central) await write(bytes);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(offset - centralStart, 12); end.writeUInt32LE(centralStart, 16);
    await write(end); await archive.close(); await rename(pendingPath, path);
    parentPort!.postMessage({ fileName, directory, path });
  } catch (error) {
    await archive.close().catch(() => {}); await rm(pendingPath, { force: true }); throw error;
  }
}

await main();

import { spawn } from "node:child_process";
import { mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { RouterSnapshot, RuntimeInfoSnapshot } from "../../../packages/shared-types/src/index.ts";

function pick(value: unknown, fields: string[]): Record<string, unknown> {
  const source = value as Record<string, unknown> | undefined;
  return Object.fromEntries(fields.filter((key) => source?.[key] !== undefined).map((key) => [key, source![key]]));
}

function writeTiming(value: RouterSnapshot["output"]) {
  const timing = value?.writeTiming;
  return timing ? {
    ...pick(timing, ["measurement", "startedAt", "elapsedMs", "framesWritten", "inFlight", "correctionAddedFrames", "correctionRemovedFrames", "primingFrames", "backlogEwma", "estimatedPpm"]),
    windows: timing.windows.map(window => pick(window, ["startedAt", "durationMs", "samples", "inFlightMin", "inFlightMax", "inFlightMean", "callbackCount", "callbackMaxMs"])),
    backpressureDropTimes: timing.backpressureDropTimes.filter(at => typeof at === "string" && Number.isFinite(Date.parse(at))),
  } : null;
}

// Only driver families, never arbitrary native device names, enter a bundle.
function selectedHostApi(value: string | null | undefined) {
  return ["Windows WASAPI", "ASIO", "MME", "Windows DirectSound", "Windows WDM-KS", "Core Audio", "CoreAudio", "ALSA", "JACK", "Simulator"].includes(value ?? "") ? value : null;
}

/** Export projection, not a raw snapshot: no scenes, routes, profiles, paths or errors. */
export function supportDiagnostics(snapshot: RouterSnapshot) {
  const discord = snapshot.discord;
  const capture = snapshot.input?.captureTiming;
  const runtimeFields = ["startedAt", "durationMs", "eventLoopP99Ms", "eventLoopMaxMs", "processBlockMaxMs", "processBlocks"];
  return {
    ...pick(snapshot, ["state", "emergencyMuted", "sampleRate", "blockSize", "uptimeSeconds", "callbackLoad", "xruns", "topologyMutationFaults"]),
    input: { ...pick(snapshot.input, ["state", "activeChannelCount", "sampleRate", "framesCaptured", "peak"]), selectedHostApi: selectedHostApi(snapshot.input?.selectedHostApi),
      captureTiming: capture ? {
        ...pick(capture, ["elapsedMs", "physicalChannelCount", "packets", "minPacketBytes", "maxPacketBytes", "lastPacketGapMs", "maxPacketGapMs", "lastPacketAgeMs", "pendingFrameBytes"]),
        channels: capture.channels.map(channel => pick(channel, ["channel", "queuedFrames", "maxQueuedFrames", "underruns", "missingFrames", "droppedFrames"])),
      } : null },
    output: { ...pick(snapshot.output, ["state", "activeChannelCount", "sampleRate", "framesWritten", "backpressureDrops", "peak"]), selectedHostApi: selectedHostApi(snapshot.output?.selectedHostApi), writeTiming: writeTiming(snapshot.output) },
    cueOutput: { ...pick(snapshot.cueOutput, ["state", "sampleRate", "framesWritten", "backpressureDrops"]), selectedHostApi: selectedHostApi(snapshot.cueOutput?.selectedHostApi), writeTiming: writeTiming(snapshot.cueOutput) },
    audioTiming: {
      ...pick(snapshot.audioTiming, ["latenessResolutionMs", "latenessOverflowThresholdMs", "catchupCalls", "maxBlocksPerCall"]),
      windows: (snapshot.audioTiming?.windows ?? []).map(window => pick(window, ["startedAt", "durationMs", "samples", "maxLateMs", "p99LateMs", "catchupCalls", "maxBlocksPerCall"])),
    },
    audioRuntimeTiming: snapshot.audioRuntimeTiming ? {
      resolutionMs: snapshot.audioRuntimeTiming.resolutionMs,
      current: pick(snapshot.audioRuntimeTiming.current, runtimeFields),
      windows: snapshot.audioRuntimeTiming.windows.map(window => pick(window, runtimeFields)),
    } : undefined,
    recorder: pick(snapshot.recorder, ["state", "sampleRate", "durationSeconds", "queuedBlocks", "maxQueuedBlocks", "droppedBlocks", "freeBytes", "totalBytes"]),
    system: pick(snapshot.system, ["processCpuPercent", "processRssBytes", "processHeapUsedBytes", "systemTotalMemoryBytes", "systemFreeMemoryBytes"]),
    participants: snapshot.channels.filter((channel) => channel.kind === "DiscordUser").map((channel) => pick(channel, ["id", "label", "discordUserId", "stale"])),
    discord: {
      ...pick(discord, ["connectedAdapters", "adapterState", "configuredBots", "readyBots", "staleBots", "reconnectingBots", "packets", "bytes", "decodeErrors", "decoderState", "txTargetsRevision"]),
      bots: (discord?.bots ?? []).map((bot) => pick(bot, ["profileId", "label", "role", "botId", "guildId", "guildName", "voiceChannelId", "voiceChannelName", "gatewayState", "voiceState", "health", "wsPingMs", "udpPingMs", "reconnectCount", "lastAudioAgoMs", "txEnabled", "txFrames", "txDroppedFrames", "lastTxFrameAgoMs", "lastHeartbeatAgoMs"])),
      txStems: (discord?.txStems ?? []).map((tx) => pick(tx, ["profileId", "label", "destination", "state", "active", "masterDb", "sourceOutput", "sourceInputChannelId", "sourceInputRightChannelId", "guildId", "voiceChannelId", "voiceChannelName", "framesSent", "droppedFrames", "peak", "lastFrameAgoMs"])),
      txTargets: pick(discord?.txTargets, ["armed", "live", "allTeams"]),
      sources: (discord?.sources ?? []).map((source) => ({
        ...pick(source, ["channelId", "botId", "guildId", "voiceChannelId", "userId", "packets", "decodedSamples", "decodeErrors", "sequenceGaps", "queuedMilliseconds", "droppedSamples", "lastPacketAgoMs"]),
        playout: pick(source.playout, ["targetMs", "backlogEwmaMs", "prebufferBlocks", "expandedFrames", "compressedFrames", "staleDiscardedSamples"]),
        rxTiming: {
          ...pick(source.rxTiming, ["maxPacketGapMs", "maxQueuedMilliseconds", "overflowEvents", "underruns", "overflowsAfterUnderrun", "silenceBlocksDropped", "compressedSamples", "queueResolutionMs"]),
          queueWindows: (source.rxTiming?.queueWindows ?? []).map(window => pick(window, ["startedAt", "durationMs", "samples", "p50Ms", "p95Ms", "maxMs"])),
          ...pick(source.rxTiming, ["inSpeechUnderruns", "endOfSpeechUnderruns", "pendingUnderruns", "unclassifiedUnderruns", "jitterResolutionMs", "packetJitterExcludedGaps"]),
          recentInSpeechUnderruns: (source.rxTiming?.recentInSpeechUnderruns ?? []).slice(-50).map(event => pick(event, ["at", "previousPacketAgeMs", "nextPacketDelayMs", "queuedBeforeMs", "queuedAfterPacketMs"])),
          packetJitterWindows: (source.rxTiming?.packetJitterWindows ?? []).slice(-30).map(window => pick(window, ["startedAt", "durationMs", "samples", "p50Ms", "p95Ms", "p99Ms", "maxMs"])),
          fillJitterWindows: (source.rxTiming?.fillJitterWindows ?? []).slice(-30).map(window => pick(window, ["startedAt", "durationMs", "samples", "p50Ms", "p95Ms", "p99Ms", "maxMs"])),
          lastOverflow: pick(source.rxTiming?.lastOverflow, ["at", "queuedBeforeMilliseconds", "incomingSamples", "droppedSamples", "packetGapMs", "batchOpusFrames", "batchBytes", "batchElapsedMs"]),
        },
      })),
      rxDiagnostics: {
        ...pick(discord?.rxDiagnostics, ["inSpeechUnderruns"]),
        rejectedOpus: pick(discord?.rxDiagnostics?.rejectedOpus, ["socketAuthority", "receiverRole", "receiverOwner", "receiverAuthority", "txBot", "membershipMissing", "sourceGeneration", "receiverGeneration", "sequenceReordered", ...["READY", "CONNECTING", "RECONNECTING", "DISCONNECTED", "STALE", "FAULT"].map((health) => `health:${health}`)]),
        ipcBatches: pick(discord?.rxDiagnostics?.ipcBatches, ["count", "maxOpusFrames", "maxBytes", "maxProcessingMs"]),
        adapterIpc: (discord?.rxDiagnostics?.adapterIpc ?? []).map((ipc) => pick(ipc, ["opusDroppedFrames", "backpressureWrites", "writableBytes", "maxWritableBytes"])),
      },
    },
  };
}

export interface SupportBundleRequest {
  settingsRoot: string;
  projectRoot: string;
  runtimeInfo: RuntimeInfoSnapshot;
  diagnostics: ReturnType<typeof supportDiagnostics>;
  days?: number;
  now?: string;
}

export interface SupportBundleResult { fileName: string; directory: string; path: string }

/** All file I/O, HMAC, JSON parsing and ZIP CRC work stays off the audio thread. */
export async function createSupportBundle(request: SupportBundleRequest): Promise<SupportBundleResult> {
  if (request.days !== undefined && (!Number.isInteger(request.days) || request.days < 1 || request.days > 30)) throw new Error("Support Bundle days must be 1..30");
  const worker = new Worker(new URL("./support-bundle-worker.ts", import.meta.url), { workerData: request });
  return new Promise((resolve, reject) => {
    let result: SupportBundleResult | undefined;
    worker.on("message", (message) => { result = message; });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code === 0 && result) resolve(result);
      else reject(new Error("Support Bundle could not be created"));
    });
  });
}

export async function openSupportDirectory(settingsRoot: string): Promise<void> {
  const directory = join(settingsRoot, "support");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid support directory");
  const executable = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [directory], { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

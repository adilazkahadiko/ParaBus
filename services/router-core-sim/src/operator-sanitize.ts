import type { RouterSnapshot } from "../../../packages/shared-types/src/index.ts";

export type OperatorErrorComponent = "audio-input" | "audio-output" | "discord" | "recorder" | "tablet" | "control";

export interface SafeOperatorError {
  component: OperatorErrorComponent;
  severity: "WARNING" | "CRITICAL";
  code: "AUDIO_DEVICE_LOST" | "DISCORD_CONNECTION_ERROR" | "RECORDER_STORAGE_ERROR" | "TABLET_CONTROL_ERROR" | "CONTROL_ERROR";
  summary: string;
  action: string;
}

const SAFE_ERRORS: Record<OperatorErrorComponent, SafeOperatorError> = {
  "audio-input": { component: "audio-input", severity: "CRITICAL", code: "AUDIO_DEVICE_LOST", summary: "Audio input disconnected", action: "Check the audio device and recover it explicitly" },
  "audio-output": { component: "audio-output", severity: "CRITICAL", code: "AUDIO_DEVICE_LOST", summary: "Audio output disconnected", action: "Check the audio device and recover it explicitly" },
  discord: { component: "discord", severity: "WARNING", code: "DISCORD_CONNECTION_ERROR", summary: "Discord receiver connection failed", action: "Check the receiver connection" },
  recorder: { component: "recorder", severity: "WARNING", code: "RECORDER_STORAGE_ERROR", summary: "Recorder unavailable — check storage", action: "Check available storage and recorder settings" },
  tablet: { component: "tablet", severity: "WARNING", code: "TABLET_CONTROL_ERROR", summary: "Tablet control unavailable", action: "Check Tablet setup and reconnect" },
  control: { component: "control", severity: "WARNING", code: "CONTROL_ERROR", summary: "Operation unavailable", action: "Refresh the current state and review the operation" },
};

/** Allow only bounded operator text after removing common structural secret carriers. */
export function sanitizeOperatorMessage(value: unknown, fallback = "Operation unavailable"): string {
  const source = typeof value === "string" ? value : value instanceof Error ? value.message : fallback;
  const sanitized = source
    .replace(/<Buffer\s+[^>]*>/gi, "[AUDIO DATA]")
    .replace(/([?&](?:token|secret|password|credential|authorization|nonce|api[-_]?key)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/\bAuthorization\s*:\s*(?:Bearer\s+)?[^\s,;]+/gi, "[CREDENTIAL REDACTED]")
    .replace(/(["']?(?:token|secret|password|credential|authorization|nonce|api[-_]?key)["']?\s*[:=]\s*)(?:Bearer\s+)?(?:["'][^"']*["']|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:home|Users|tmp|var|etc|opt|srv|run)\/)[^\s"'<>]*/g, "[PATH]")
    .replace(/(^|[\s(])\/(?!\/)[^\s"'<>]*/g, "$1[PATH]")
    .replace(/\b\d{17,20}\b/g, "[ID]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 240);
  return sanitized || fallback;
}

export function safeOperatorError(component: OperatorErrorComponent): SafeOperatorError {
  return { ...SAFE_ERRORS[component] };
}

export function safeOperatorSummary(component: OperatorErrorComponent): string {
  return SAFE_ERRORS[component].summary;
}

/** Removes raw backend errors before a snapshot reaches Desktop or Tablet clients. */
export function operatorFacingSnapshot<T extends RouterSnapshot>(snapshot: T): T {
  return {
    ...snapshot,
    input: snapshot.input ? {
      ...snapshot.input,
      selectedDeviceName: snapshot.input.selectedDeviceName ? sanitizeOperatorMessage(snapshot.input.selectedDeviceName, "Audio input") : null,
      error: snapshot.input.error ? safeOperatorSummary("audio-input") : null,
      devices: (snapshot.input.devices ?? []).map((device) => ({ ...device, name: sanitizeOperatorMessage(device.name, "Audio input"), hostApi: sanitizeOperatorMessage(device.hostApi, "Audio API") })),
    } : snapshot.input,
    output: snapshot.output ? {
      ...snapshot.output,
      selectedDeviceName: snapshot.output.selectedDeviceName ? sanitizeOperatorMessage(snapshot.output.selectedDeviceName, "Audio output") : null,
      error: snapshot.output.error ? safeOperatorSummary("audio-output") : null,
      devices: (snapshot.output.devices ?? []).map((device) => ({ ...device, name: sanitizeOperatorMessage(device.name, "Audio output"), hostApi: sanitizeOperatorMessage(device.hostApi, "Audio API") })),
    } : snapshot.output,
    cueOutput: snapshot.cueOutput ? {
      ...snapshot.cueOutput,
      selectedDeviceName: snapshot.cueOutput.selectedDeviceName ? sanitizeOperatorMessage(snapshot.cueOutput.selectedDeviceName, "Cue output") : null,
      error: snapshot.cueOutput.error ? safeOperatorSummary("audio-output") : null,
      devices: (snapshot.cueOutput.devices ?? []).map((device) => ({ ...device, name: sanitizeOperatorMessage(device.name, "Cue output"), hostApi: sanitizeOperatorMessage(device.hostApi, "Audio API") })),
    } : snapshot.cueOutput,
    recorder: snapshot.recorder ? {
      ...snapshot.recorder,
      folder: "Configured recording folder",
      message: snapshot.recorder.message ? safeOperatorSummary("recorder") : null,
      tracks: snapshot.recorder.tracks.map((track) => ({
        ...track,
        label: sanitizeOperatorMessage(track.label, "Track"),
        fileName: sanitizeOperatorMessage(track.fileName, "Recording track"),
      })),
    } : snapshot.recorder,
    discord: snapshot.discord ? {
      ...snapshot.discord,
      bots: snapshot.discord.bots.map((bot) => ({
        ...bot,
        message: !bot.message ? null
          : /^TX stopped \(tx-(?:stream-failed|player-failed|start-failed|ended)\); restart TX explicitly$/.test(bot.message)
            ? "Discord TX stopped; restart TX explicitly" : safeOperatorSummary("discord"),
      })),
    } : snapshot.discord,
    alerts: snapshot.alerts.map((event) => ({ ...event, message: sanitizeOperatorMessage(event.message, "Operator event") })),
  };
}

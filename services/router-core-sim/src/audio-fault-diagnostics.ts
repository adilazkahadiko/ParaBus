import type { AudioFaultDiagnostic } from "../../../packages/shared-types/src/index.ts";

export const AUDIO_FAULT_CLASSIFICATIONS = ["STREAM_ENDED", "STREAM_ERROR", "DEVICE_UNAVAILABLE", "PRESENCE_PROVIDER_UNAVAILABLE", "ASIO_FAULT", "UNKNOWN"] as const;
export const AUDIO_FAULT_HOST_APIS = ["Windows WASAPI", "ASIO", "MME", "Windows DirectSound", "Windows WDM-KS", "Core Audio", "CoreAudio", "ALSA", "JACK", "Simulator"] as const;

export function audioFaultMessage(target: "MAIN_OUTPUT" | "INPUT", diagnostic?: AudioFaultDiagnostic): string {
  const classification = AUDIO_FAULT_CLASSIFICATIONS.find(value => value === diagnostic?.classification) ?? "UNKNOWN";
  const hostApi = AUDIO_FAULT_HOST_APIS.find(value => value === diagnostic?.hostApi) ?? "UNKNOWN";
  return `Audio fault: target=${target} classification=${classification} hostApi=${hostApi}`;
}

/** Raw driver text is for the local JSONL only. Prevent multiline/log injection and bound its size. */
export function localAudioFaultDetail(reason: string): string {
  return [...reason.replace(/[\p{Cc}\u2028\u2029]/gu, " ")].slice(0, 1024).join("");
}

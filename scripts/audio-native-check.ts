import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyNativeFailure, nativeCheckGuidance } from "./native-check-result.ts";

export function checkAudioNative(load: (name: string) => unknown = createRequire(import.meta.url), platform: NodeJS.Platform = process.platform) {
  try {
    const audio = load("naudiodon2") as Record<string, unknown> | null;
    if (!audio || ["getDevices", "getHostAPIs", "AudioIO"].some((name) => typeof audio[name] !== "function") || audio.SampleFormatFloat32 !== 1) {
      throw new Error("naudiodon2のAPIが不正です");
    }
    if (!String(audio.AudioIO).includes("ParaBus: one native stop")) {
      throw new Error("naudiodon2の停止修正が未適用です。停止した環境で npm run patch:audio-native を実行してください");
    }
    // Loading the binding does not initialize PortAudio. Never enumerate or open devices here.
    return { state: "READY" as const, reason: null, classification: null, classificationSource: null };
  } catch (error) {
    return { state: "UNAVAILABLE" as const, reason: error instanceof Error ? error.message : String(error), ...classifyNativeFailure(error, platform) };
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = checkAudioNative();
  console.log(JSON.stringify({ backend: "naudiodon2", ...result, node: process.version }));
  const guidance = nativeCheckGuidance(result.classification);
  if (guidance) console.error(guidance);
  process.exitCode = result.state === "READY" ? 0 : 1;
}

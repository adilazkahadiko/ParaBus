import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OPUS_CHANNELS, OPUS_FRAME_SAMPLES, OPUS_SAMPLE_RATE, OPUS_SELF_CHECK_PACKET } from "../services/router-core-sim/src/opus-decoder.ts";
import { classifyNativeFailure, nativeCheckGuidance } from "./native-check-result.ts";

/** Same fixed decode probe as the production gate; retain the original load error here. */
export function checkOpusNative(load: (name: string) => unknown = createRequire(import.meta.url), platform: NodeJS.Platform = process.platform) {
  try {
    const native = load("@discordjs/opus") as { OpusEncoder: new (rate: number, channels: number) => { decode(packet: Buffer): Buffer } };
    const probe = new native.OpusEncoder(OPUS_SAMPLE_RATE, OPUS_CHANNELS);
    const pcm = probe.decode(OPUS_SELF_CHECK_PACKET);
    if (!Buffer.isBuffer(pcm) || pcm.length !== OPUS_FRAME_SAMPLES * 2) throw new Error("native Opus decoder returned an invalid frame");
    return { state: "READY" as const, reason: null, classification: null, classificationSource: null };
  } catch (error) {
    return { state: "UNAVAILABLE" as const, reason: error instanceof Error ? error.message : String(error), ...classifyNativeFailure(error, platform) };
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = checkOpusNative();
  console.log(JSON.stringify({ backend: "@discordjs/opus", ...result,
    sampleRate: OPUS_SAMPLE_RATE, channels: OPUS_CHANNELS, frameSamples: OPUS_FRAME_SAMPLES,
    runtime: { node: process.version, platform: process.platform, arch: process.arch } }));
  const guidance = nativeCheckGuidance(result.classification);
  if (guidance) console.error(guidance);
  process.exitCode = result.state === "READY" ? 0 : 1;
}

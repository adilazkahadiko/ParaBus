import { openNativeOpusDecoderGate, OPUS_CHANNELS, OPUS_FRAME_SAMPLES, OPUS_SAMPLE_RATE } from "../services/router-core-sim/src/opus-decoder.ts";

const gate = openNativeOpusDecoderGate();
console.log(JSON.stringify({
  backend: "@discordjs/opus",
  state: gate.state,
  sampleRate: OPUS_SAMPLE_RATE,
  channels: OPUS_CHANNELS,
  frameSamples: OPUS_FRAME_SAMPLES,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  reason: gate.reason,
}));
process.exitCode = gate.state === "READY" ? 0 : 1;

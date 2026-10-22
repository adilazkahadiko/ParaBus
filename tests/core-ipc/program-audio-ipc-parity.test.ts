import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PROGRAM_AUDIO_FRAMES,
  PROGRAM_AUDIO_HEADER_BYTES,
  PROGRAM_AUDIO_MAX_FRAME_BYTES,
  ProgramAudioFrameDecoder,
  decodeProgramAudioFrame,
  encodeProgramAudioFrame,
  projectProgramAudioFrame,
} from "../../packages/program-audio-ipc/src/index.ts";

function frame(sequence: bigint, channels = 2): Buffer {
  const planar = Array.from({ length: channels }, (_, channel) => Float32Array.from({ length: PROGRAM_AUDIO_FRAMES }, (_, sample) => (channel + 1) * (sample - 100) / 1_000));
  return encodeProgramAudioFrame({ sequence, channels, planar });
}

function shadowBinary(): string {
  const override = process.env.ROUTER_CORE_PROGRAM_AUDIO_SHADOW_BIN;
  if (override) return override;
  const name = process.platform === "win32" ? "router-core-program-audio-shadow.exe" : "router-core-program-audio-shadow";
  return fileURLToPath(new URL(`../../target/debug/${name}`, import.meta.url));
}

async function closeWithin(child: ReturnType<typeof spawn>, milliseconds = 5_000): Promise<[number | null, NodeJS.Signals | null]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>,
      new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error("Program Audio shadow timed out")); }, milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("Program Audio v1 TypeScript decoder validates split, coalesced, and fail-closed input", () => {
  const first = frame(7n, 1);
  const second = frame(8n, 3);
  const decoder = new ProgramAudioFrameDecoder();
  assert.deepEqual(decoder.push(first.subarray(0, 13)), []);
  const chunk = Buffer.concat([first.subarray(13), second]);
  assert.deepEqual(decoder.push(chunk).map((item) => item.sequence), [7n, 8n]);
  assert.equal(decoder.bufferedBytes, 0);
  assert.doesNotThrow(() => decoder.finish());

  const layout = encodeProgramAudioFrame({
    sequence: 9n,
    channels: 2,
    planar: [Float32Array.from({ length: PROGRAM_AUDIO_FRAMES }, (_, index) => index + 0.25), Float32Array.from({ length: PROGRAM_AUDIO_FRAMES }, (_, index) => 1_000 + index + 0.5)],
  });
  assert.equal(layout.readFloatLE(PROGRAM_AUDIO_HEADER_BYTES), 0.25);
  assert.equal(layout.readFloatLE(PROGRAM_AUDIO_HEADER_BYTES + 4), 1.25);
  assert.equal(layout.readFloatLE(PROGRAM_AUDIO_HEADER_BYTES + PROGRAM_AUDIO_FRAMES * 4), 1_000.5);
  assert.equal(layout.readFloatLE(PROGRAM_AUDIO_HEADER_BYTES + PROGRAM_AUDIO_FRAMES * 4 + 4), 1_001.5);

  const malformed = Buffer.from(first);
  malformed[4] = 2;
  assert.throws(() => decoder.push(malformed), /unsupported Program Audio version/);
  assert.equal(decoder.bufferedBytes, 0);
  const unknownType = Buffer.from(first);
  unknownType[5] = 99;
  assert.throws(() => decoder.push(unknownType), /unknown Program Audio frame type/);
  const overlarge = Buffer.from(first);
  overlarge[6] = 65;
  assert.throws(() => decoder.push(overlarge), /channels must be 1\.\.64/);
  const nonFinite = Buffer.from(first);
  nonFinite.writeFloatLE(Number.NaN, PROGRAM_AUDIO_HEADER_BYTES);
  assert.throws(() => decodeProgramAudioFrame(nonFinite), /sample must be finite/);
  assert.throws(() => encodeProgramAudioFrame({ sequence: 1 as unknown as bigint, channels: 1, planar: [new Float32Array(PROGRAM_AUDIO_FRAMES)] }), /sequence must be a bigint/);
  assert.deepEqual(decoder.push(first.subarray(0, 11)), []);
  assert.throws(() => decoder.finish(), /truncated Program Audio frame at EOF/);
  assert.equal(decoder.bufferedBytes, 0);
  assert.ok(PROGRAM_AUDIO_MAX_FRAME_BYTES < 128 * 1024);
});

test("Program Audio v1 TypeScript encoder and Rust decoder have byte/projection parity", async () => {
  const first = frame(4n, 1);
  const second = frame(5n, 64);
  const expected = [first, second].map((bytes) => projectProgramAudioFrame(decodeProgramAudioFrame(bytes)));
  const child = spawn(shadowBinary(), [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.write(first.subarray(0, 17));
  child.stdin.write(Buffer.concat([first.subarray(17), second]));
  child.stdin.end();
  const [code] = await closeWithin(child);
  assert.equal(code, 0, stderr);
  assert.deepEqual(stdout.trim().split("\n").map((line) => JSON.parse(line)), expected);
});

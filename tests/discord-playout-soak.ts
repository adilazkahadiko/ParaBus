import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { DiscordPcmSource } from "../services/router-core-sim/src/discord-pcm-source.ts";

// Run separately from npm test: 64 receivers x one virtual hour, no real sleep,
// Opus, device or network. RX_SOAK_BASELINE_REF=<commit> compares an older RX controller
// against the same ring/observer implementation, isolating controller cost.
let Source = DiscordPcmSource;
const baselineRef = process.env.RX_SOAK_BASELINE_REF;
const baseline = Boolean(baselineRef);
if (baseline) {
  const path = "services/router-core-sim/src/discord-pcm-source.ts";
  let code = execFileSync("git", ["show", `${baselineRef}:${path}`], { encoding: "utf8" });
  for (const name of ["audio-engine.ts", "audio-timing.ts"]) {
    code = code.replace(`"./${name}"`, JSON.stringify(new URL(`../services/router-core-sim/src/${name}`, import.meta.url).href));
  }
  const url = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(code)).toString("base64")}`;
  Source = (await import(url)).DiscordPcmSource;
}

const participants = 64, blocks = 360_000;
let now = 0;
const sources = Array.from({ length: participants }, () => new Source(5760, 48000, 480, () => now));
const nextPackets = new Float64Array(participants), heldUntil = new Float64Array(participants);
const target = new Float32Array(480), timings = new Float64Array(blocks), queueHistogram = new Uint32Array(121);
const pcm = Buffer.alloc(1920), quiet = Buffer.alloc(1920);
for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(Math.sin(i * Math.PI / 60) * 8192), i * 2);
let maximumQueue = 0, firstFiveMinutes = 0, lastFiveMinutes = 0;
for (let block = 0; block < blocks; block++) {
  now = block * 10;
  const started = performance.now();
  for (let user = 0; user < participants; user++) {
    const source = sources[user];
    if (now % 60_000 === 2_000 + user * 100) heldUntil[user] = now + 60 + (Math.floor(now / 60_000) % 3) * 20;
    if (now >= heldUntil[user]) while (nextPackets[user] <= now) {
      // Half the participants exercise quiet cuts as well as voiced correction.
      source.pushInt16Le(user % 2 && now % 10_000 >= 5_000 ? quiet : pcm, now);
      nextPackets[user] += 20 / (1 + 500 / 1e6);
    }
    const queueMs = source.queuedSamples / 48;
    queueHistogram[Math.ceil(queueMs)]++;
    maximumQueue = Math.max(maximumQueue, queueMs);
    if (block < 30_000) firstFiveMinutes += queueMs;
    if (block >= blocks - 30_000) lastFiveMinutes += queueMs;
    source.fill(target);
  }
  timings[block] = performance.now() - started;
}
let count = 0, p95QueueMs = 0;
for (let i = 0; i < queueHistogram.length; i++) {
  count += queueHistogram[i];
  if (count >= participants * blocks * 0.95) { p95QueueMs = i; break; }
}
timings.sort();
const report = {
  baseline, baselineRef: baselineRef ?? null, participants, virtualMinutes: blocks / 6000, p95QueueMs, maximumQueue,
  firstFiveMinutesMeanMs: firstFiveMinutes / (participants * 30_000),
  lastFiveMinutesMeanMs: lastFiveMinutes / (participants * 30_000),
  droppedSamples: sources.reduce((sum, source) => sum + source.droppedSamples, 0),
  silenceBlocksDropped: sources.reduce((sum, source) => sum + source.timing!.silenceBlocksDropped, 0),
  compressedSamples: sources.reduce((sum, source) => sum + source.compressedFrames, 0),
  p99ProcessingMs: timings[Math.floor(blocks * 0.99)], maxProcessingMs: timings.at(-1),
  limitation: "Capture enqueue, RX control and timing only; excludes DSP, Opus, native devices, network and UI.",
};
console.log(JSON.stringify(report, null, 2));
if (!baseline) {
  assert.equal(report.droppedSamples, 0);
  assert.ok(report.p95QueueMs <= 80);
  assert.ok(report.lastFiveMinutesMeanMs <= report.firstFiveMinutesMeanMs + 10);
  assert.ok(report.p99ProcessingMs < 10);
  for (const source of sources) assert.ok(source.timing!.snapshot().queueWindows.length <= 30);
}

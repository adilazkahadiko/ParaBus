// Offline benchmark: no server, Discord connection, native backend or device.
import { cpus } from "node:os";
import { AudioChannel, AudioEngine, SineSource, VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { OutputSelector } from "../services/router-core-sim/src/output-selector.ts";

const sourceIds = Array.from({ length: 20 }, (_, i) => `bus-${i}`);
function fixture(kind: "baseline" | "idle" | "steady" | "fading") {
  const engine = new AudioEngine(48000, 480, 16);
  for (const id of sourceIds) engine.addBus(new VcBus(id, id, 480));
  for (let i = 0; i < 60; i++) {
    const channel = new AudioChannel(`input-${i}`, `Input ${i}`, "TestTone", new SineSource(300 + i * 17, -48), 480, 48000);
    channel.vcSends.set(sourceIds[i % 20], { gainDb: 0, mute: false }); engine.addChannel(channel);
  }
  const selectors: OutputSelector[] = [];
  if (kind !== "baseline") for (let i = 0; i < 8; i++) {
    const bus = new VcBus(`selector-${i}`, `Selector ${i}`, 480);
    bus.selector = new OutputSelector("ADDITIVE", 2000, sourceIds, kind === "idle" ? [] : sourceIds);
    bus.compressorEnabled = false; selectors.push(bus.selector); engine.addBus(bus);
    engine.addMatrixRoute({ id: `out-${i}`, sourceId: bus.id, output: i, gainDb: 0, mute: false, tap: "POST" });
  }
  let block = 0;
  const step = () => {
    if (kind === "fading" && block++ % 50 === 0) for (const selector of selectors) for (const id of sourceIds) selector.operate(id, "TOGGLE", 48000);
    engine.processBlock();
    return engine.lastBlockDurationMs;
  };
  return step;
}
const kinds = ["baseline", "idle", "steady", "fading"] as const;
const fixtures = kinds.map(fixture), samples = kinds.map(() => [] as number[]), averages = kinds.map(() => [] as number[]);
for (const step of fixtures) for (let i = 0; i < 500; i++) step();
for (let round = 0; round < 7; round++) {
  // Alternate order to reduce thermal/order bias. Capture callback time only;
  // control-command work and sample-array bookkeeping stay outside its timing.
  const order = round % 2 ? [3, 2, 1, 0] : [0, 1, 2, 3];
  for (const index of order) {
    let total = 0;
    for (let block = 0; block < 500; block++) { const time = fixtures[index](); samples[index].push(time); total += time; }
    averages[index].push(total / 500);
  }
}
const percentile = (values: number[], quantile: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * quantile)];
const baseline = percentile(averages[0], .5);
console.log(JSON.stringify({ node: process.version, cpu: cpus()[0].model, sampleRate: 48000, blockSize: 480, blockBudgetMs: 10,
  channels: 60, vcBuses: 20, selectors: 8, sourcesPerSelector: 20, warmupBlocks: 500, rounds: 7, measuredBlocksPerCase: 3500,
  results: kinds.map((kind, i) => {
    const meanMs = percentile(averages[i], .5);
    return { kind, medianRoundMeanMs: meanMs, p95BlockMs: percentile(samples[i], .95), deltaMs: meanMs - baseline, deltaBudgetPercent: (meanMs - baseline) / 10 * 100 };
  }) }, null, 2));

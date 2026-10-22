import { AudioEngine } from "../../services/router-core-sim/src/audio-engine.ts";
import { PerformanceObserver } from "node:perf_hooks";
import { MAX_RX_CHANNELS } from "../../packages/shared-types/src/index.ts";

function boundedIntegerOption(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw new RangeError(`${name} must be an integer ${minimum}..${maximum}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer ${minimum}..${maximum}`);
  }
  return value;
}

const channelCount = boundedIntegerOption("CHANNELS", 64, 1, MAX_RX_CHANNELS);
const blocks = boundedIntegerOption("BLOCKS", 2_000, 100, 100_000);
const engine = AudioEngine.createDemo(channelCount);

// Exclude JIT warmup from the real-time distribution.
for (let block = 0; block < 100; block += 1) engine.processBlock();
const memoryBefore = process.memoryUsage();
const timings = new Float64Array(blocks);
let timingSum = 0;
let deadlineMisses = 0;
let gcEvents = 0;
const gcObserver = new PerformanceObserver((list) => {
  gcEvents += list.getEntries().length;
});
gcObserver.observe({ entryTypes: ["gc"] });
const deadlineMs = (engine.blockSize / engine.sampleRate) * 1_000;
for (let block = 0; block < blocks; block += 1) {
  const started = performance.now();
  engine.processBlock();
  const elapsedMs = performance.now() - started;
  timings[block] = elapsedMs;
  timingSum += elapsedMs;
  if (elapsedMs > deadlineMs) deadlineMisses += 1;
}

const memoryAfter = process.memoryUsage();
// PerformanceObserver delivery is asynchronous. This tick is outside the
// measurement and lets pending GC entries arrive before the count is frozen.
await new Promise<void>((resolve) => setImmediate(resolve));
gcObserver.disconnect();
timings.sort();
const percentile = (value: number) => timings[Math.min(timings.length - 1, Math.floor(timings.length * value))];
const report = {
  channels: engine.channels.size,
  outputs: engine.outputs.length,
  blocks,
  deadlineMs,
  averageMs: timingSum / timings.length,
  p95Ms: percentile(0.95),
  p99Ms: percentile(0.99),
  maximumMs: timings.at(-1),
  deadlineMisses,
  finiteMeters: [...engine.channels.values()].every((channel) => Number.isFinite(channel.outputMeter.rms)),
  topologyMutationFaults: engine.topologyMutationFaults,
  runtime: {
    node: process.versions.node,
    classification: /^22\.(1[89]|[2-9]\d)\./.test(process.versions.node) ? "production-node22" : "development-only",
  },
  memoryBytes: {
    heapUsedBefore: memoryBefore.heapUsed,
    heapUsedAfter: memoryAfter.heapUsed,
    rssBefore: memoryBefore.rss,
    rssAfter: memoryAfter.rss,
  },
  gc: {
    observedEvents: gcEvents,
    limitation: "Passive post-measurement observer count with no forced GC. Heap/RSS and GC include Node/runtime activity, so they are evidence only, not an engine-allocation proof.",
  },
};

console.log(JSON.stringify(report, null, 2));
if (!report.finiteMeters || report.p99Ms > deadlineMs || report.deadlineMisses > 0 || report.topologyMutationFaults > 0) process.exitCode = 1;

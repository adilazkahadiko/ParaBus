import { AudioSchedulerTiming, OutputWriteTiming, RxQueueTiming } from "../services/router-core-sim/src/audio-timing.ts";
import { AudioRuntimeTiming } from "../services/router-core-sim/src/audio-runtime-timing.ts";

// Observer-only microbenchmark: does not include DSP, PCM conversion, Opus, native I/O or JSON.
const participants = 112, blocks = 20_000;
const rx = Array.from({ length: participants }, () => new RxQueueTiming(48_000, 120));
const main = new OutputWriteTiming(), cue = new OutputWriteTiming(), scheduler = new AudioSchedulerTiming();
const runtime = new AudioRuntimeTiming();
function observe(block: number): void {
  const now = performance.now();
  for (let i = 0; i < rx.length; i++) rx[i].fill(block % 5_761, 480);
  main.observeInFlight(block % 9, now); main.callback(0.2, now);
  cue.observeInFlight(0, now); cue.callback(0.1, now);
  scheduler.record(block % 10 / 10, 1, now);
  runtime.recordBlock(0.2);
}
for (let block = 0; block < 5_000; block++) observe(block);
const started = performance.now();
for (let block = 0; block < blocks; block++) observe(block);
const meanMicroseconds = (performance.now() - started) * 1_000 / blocks;
runtime.close();
console.log(JSON.stringify({ participants, blocks, observerOnlyMeanMicrosecondsPerEngineBlock: meanMicroseconds, node: process.version }));

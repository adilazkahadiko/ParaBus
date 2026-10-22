import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AudioChannel, AudioEngine, PcmRingSource, VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { AudioOutputManager } from "../services/router-core-sim/src/audio-output.ts";
import { AudioSchedulerTiming, OutputWriteTiming, RxQueueTiming, audioTimingSummary } from "../services/router-core-sim/src/audio-timing.ts";

class DelayedStream extends EventEmitter {
  callbacks: Array<() => void> = []; blocks: Buffer[] = [];
  starts = 0;
  start() { this.starts++; }
  abort() {}
  write(buffer: Buffer, callback: () => void) { this.blocks.push(Buffer.from(buffer)); this.callbacks.push(callback); return false; }
  flush() { for (const callback of this.callbacks.splice(0)) callback(); }
}

function backend(hostAPIName: string) {
  const streams: DelayedStream[] = [], options: any[] = [];
  return { streams, options, module: { SampleFormatFloat32: 1,
    getDevices: () => [{ id: 7, name: "Test", hostAPIName, maxOutputChannels: 2, defaultSampleRate: 48_000 }],
    AudioIO: class { constructor(value: any) { options.push(value); const stream = new DelayedStream(); streams.push(stream); return stream; } },
  } as never };
}

test("WASAPI timing records priming and delayed callbacks; uncorrected PCM and other APIs remain unchanged", t => {
  let now = 1_000;
  t.mock.method(performance, "now", () => now);
  const measured = backend("Windows WASAPI"), unmeasured = backend("Core Audio");
  const main = new AudioOutputManager(48_000, 480, 2, measured.module, 60_000, null, "linux");
  const baseline = new AudioOutputManager(48_000, 480, 2, unmeasured.module, 60_000, null, "linux");
  t.after(() => { main.stop(); baseline.stop(); });
  main.selectDevice("pa:7"); baseline.selectDevice("pa:7");
  assert.equal(measured.options[0].outOptions.maxQueue, 6);
  assert.equal(unmeasured.options[0].outOptions.maxQueue, 8);
  assert.equal(measured.streams[0].blocks.length, 6);
  assert.equal(measured.streams[0].starts, 0, "wait for all priming writes before starting the device");
  assert.ok(measured.streams[0].blocks.every(block => block.every(byte => byte === 0)));
  measured.streams[0].flush();
  assert.equal(measured.streams[0].starts, 1);
  assert.equal(measured.options[0].outOptions.framesPerBuffer, 480);
  const outputs = [Float32Array.from({ length: 480 }, (_, i) => Math.sin(i) / 4), new Float32Array(480).fill(-0.25)];
  for (let i = 0; i < 9; i++) { now = 1_000 + i * 10; main.writeBlock(outputs); baseline.writeBlock(outputs); }
  const pending = main.snapshot().writeTiming!;
  assert.equal(pending.inFlight, 8);
  assert.deepEqual([pending.windows[0].inFlightMin, pending.windows[0].inFlightMax, pending.windows[0].inFlightMean], [0, 8, 4]);
  assert.equal(main.snapshot().backpressureDrops, 1);
  assert.equal(pending.framesWritten, 480 * 14);
  assert.equal(pending.elapsedMs, 80);
  assert.equal(pending.backpressureDropTimes.length, 1);
  now = 1_300; measured.streams[0].flush(); unmeasured.streams[0].flush();
  const finished = main.snapshot().writeTiming!;
  assert.equal(finished.inFlight, 0);
  assert.equal(finished.windows[0].callbackMaxMs, 300);
  assert.equal(finished.windows[0].callbackCount, 14);
  assert.equal(finished.measurement, "js-write-completion-not-playback");
  assert.equal(baseline.snapshot().writeTiming, null);
  assert.deepEqual(measured.streams[0].blocks.slice(6), unmeasured.streams[0].blocks, "without correction output PCM is unchanged");
  assert.equal(main.snapshot().framesWritten - finished.primingFrames, baseline.snapshot().framesWritten);
  assert.equal(main.snapshot().backpressureDrops, baseline.snapshot().backpressureDrops);
  main.stop(); now = 9_000;
  assert.equal(main.snapshot().writeTiming!.elapsedMs, 300, "stopped streams do not accumulate imaginary playback time");
  main.selectDevice("mock-64"); assert.equal(main.snapshot().writeTiming, null);
});

test("emergency stop during WASAPI priming cannot be undone by stale write callbacks", () => {
  const measured = backend("Windows WASAPI");
  const manager = new AudioOutputManager(48_000, 480, 2, measured.module, 60_000, null, "linux");
  manager.selectDevice("pa:7");
  manager.emergencyStop();
  measured.streams[0].flush();
  assert.equal(measured.streams[0].starts, 0);
  assert.equal(manager.snapshot().state, "STOPPED");
  manager.selectDevice("pa:7");
  measured.streams[0].flush();
  assert.equal(measured.streams[1].starts, 0);
  measured.streams[1].flush();
  assert.equal(measured.streams[1].starts, 1);
  manager.stop();
});

test("output windows and drop timestamps have bounded retention and reset per stream", () => {
  const timing = new OutputWriteTiming(0);
  for (let i = 0; i < 65; i++) { timing.observeInFlight(i % 9, i * 10_000); timing.callback(5 + i, i * 10_000); timing.drop(i * 10_000); }
  const result = timing.snapshot(480 * 65, 1, 640_001);
  assert.equal(result.windows.length, 60);
  assert.equal(result.windows[0].inFlightMax, 5);
  assert.equal(result.windows.at(-1)!.callbackMaxMs, 69);
  assert.equal(result.backpressureDropTimes.length, 20);
  assert.equal(Date.parse(result.backpressureDropTimes.at(-1)!) - Date.parse(result.backpressureDropTimes[0]), 190_000);
  assert.equal(new OutputWriteTiming(640_001).snapshot(0, 0, 640_001).windows.length, 0);
});

test("RX counts shortages only within 200ms of PCM arrival and correlates overflow within two seconds", () => {
  let now = 0;
  const timing = new RxQueueTiming(48_000, 120, () => now);
  const source = new PcmRingSource(5_760, timing), target = new Float32Array(480);
  source.fill(target); assert.equal(timing.underruns, 0, "no packet has ever arrived");
  source.pushInt16Le(Buffer.alloc(240 * 2));
  now = 10; assert.equal(source.fill(target), true); assert.equal(timing.underruns, 1);
  now = 200; source.fill(target); assert.equal(timing.underruns, 2, "200ms boundary is included");
  now = 201; source.fill(target); assert.equal(timing.underruns, 2, "normal silence outside the active window is not an underrun");
  now = 2_200; source.pushInt16Le(Buffer.alloc(6_720 * 2));
  assert.equal(timing.overflowsAfterUnderrun, 1, "two-second boundary is included");
  assert.equal(source.droppedSamples, 960, "overflow still discards exactly the oldest samples");
  now = 2_201; source.pushInt16Le(Buffer.alloc(960 * 2)); assert.equal(timing.overflowsAfterUnderrun, 1);
  source.fill(target);
  const snapshot = timing.snapshot();
  assert.equal(snapshot.queueWindows[0].maxMs, 120);
  assert.equal(snapshot.queueResolutionMs, 1);
});

test("RX minute p50/p95/max and scheduler p99/catchup retain bounded windows without stale histogram bins", () => {
  let now = 0;
  const rx = new RxQueueTiming(48_000, 120, () => now);
  for (let i = 1; i <= 100; i++) rx.fill(i * 48, 480);
  const first = rx.snapshot().queueWindows[0];
  assert.deepEqual([first.p50Ms, first.p95Ms, first.maxMs], [50, 95, 100]);
  const scheduler = new AudioSchedulerTiming(0);
  for (let i = 0; i < 999; i++) scheduler.record(1.01, 1, i * 10);
  scheduler.record(42, 12, 10_000);
  const early = scheduler.snapshot(10_000);
  assert.equal(early.windows[0].maxLateMs, 42); assert.equal(early.windows[0].p99LateMs, 1.1);
  assert.equal(early.catchupCalls, 1); assert.equal(early.maxBlocksPerCall, 12);
  for (let i = 1; i <= 35; i++) { now = i * 60_000; rx.fill(480, 480); scheduler.record(0, i === 35 ? 2 : 1, now); }
  assert.equal(rx.snapshot().queueWindows.length, 30);
  assert.equal(rx.snapshot().queueWindows.at(-1)!.p95Ms, 10);
  const later = scheduler.snapshot(now);
  assert.equal(later.windows.length, 30); assert.equal(later.windows.at(-1)!.p99LateMs, 0);
  assert.equal(later.windows.at(-1)!.catchupCalls, 1); assert.equal(later.catchupCalls, 2);
  scheduler.record(2_500, 12, now + 1);
  assert.equal(scheduler.snapshot(now + 1).windows.at(-1)!.maxLateMs, 2_500);
  const history = rx.snapshot().queueWindows[0]; now += 1;
  assert.equal(rx.snapshot().queueWindows[0], history, "completed windows reuse cached percentiles/dates");
  assert.equal(Object.isFrozen(history), true, "callers cannot corrupt cached diagnostics");
});

test("RX active-window clock is packet arrival, not decoder completion", () => {
  let now = 100;
  const timing = new RxQueueTiming(48_000, 120, () => now), source = new PcmRingSource(5_760, timing);
  // A packet arrived at t=0 but decoding completed at t=100.
  source.pushInt16Le(Buffer.alloc(240 * 2), 0);
  now = 201; source.fill(new Float32Array(480));
  assert.equal(timing.underruns, 0, "slow decode does not incorrectly extend the 200ms active window");
  now = 300; timing.packet(300); // An accepted packet whose decoder fails still counts as an arrival.
  now = 310; source.fill(new Float32Array(480));
  assert.equal(timing.underruns, 1);
});

/** Frozen pre-instrumentation ring behavior (a6b3e4f), not a second copy of the measured implementation. */
class ReferenceRing {
  samples: number[] = []; droppedSamples = 0;
  pushInt16Le(pcm: Buffer) { for (let i = 0; i < pcm.length / 2; i++) { if (this.samples.length === 5_760) { this.samples.shift(); this.droppedSamples++; } this.samples.push(pcm.readInt16LE(i * 2) / 32768); } }
  fill(target: Float32Array) { const count = Math.min(target.length, this.samples.length); for (let i = 0; i < count; i++) target[i] = this.samples.shift()!; target.fill(0, count); return count > 0; }
  clear() { this.samples.length = 0; }
}

test("instrumented RX rings produce bit-identical graph samples and drops across bursts, silence, clear and wraparound", () => {
  let now = 0;
  const measured = new PcmRingSource(5_760, new RxQueueTiming(48_000, 120, () => now)), reference = new ReferenceRing();
  const engines = [measured, reference].map(source => {
    const engine = new AudioEngine(48_000, 480, 2);
    const channel = new AudioChannel("guest", "Guest", "DiscordUser", source, 480, 48_000);
    channel.approvalGateOpen = true; channel.vcSends.set("bus", { gainDb: -6, mute: false }); engine.addChannel(channel);
    engine.addBus(new VcBus("bus", "Bus", 480, 48_000));
    engine.addMatrixRoute({ id: "out", sourceId: "bus", output: 0, gainDb: -3, mute: false, tap: "POST" });
    return engine;
  });
  let nonzero = false;
  for (let block = 0; block < 300; block++) {
    now += 10;
    if (block % 3 === 0) {
      const pcm = Buffer.alloc((block % 21 === 0 ? 6_720 : 960) * 2);
      for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin((i + block) / 17) * 10_000), i * 2);
      measured.pushInt16Le(pcm); reference.pushInt16Le(pcm);
    }
    if (block % 47 === 0) { measured.clear(); reference.clear(); }
    for (const engine of engines) engine.processBlock();
    assert.deepEqual(engines[0].outputs, engines[1].outputs, `block ${block}`);
    assert.equal(measured.droppedSamples, reference.droppedSamples);
    if (engines[0].outputs[0].some(sample => sample !== 0)) nonzero = true;
  }
  assert.equal(nonzero, true, "comparison covers real audio, not just silence");
});

test("timing summary is numeric-only and server instrumentation preserves the timer producer and catchup limit", () => {
  const scheduler = new AudioSchedulerTiming(0); scheduler.record(4.2, 2, 0);
  const output = new OutputWriteTiming(0); output.observeInFlight(0, 0); output.observeInFlight(3, 0);
  const summary = audioTimingSummary(output.snapshot(960, 0, 0), null, scheduler.snapshot(0), 3, 2, 1);
  assert.equal(summary, "Audio timing summary: main inflight=0-3 cue inflight=n/a sched maxLate=4.2ms catchup=1 rx underruns=3 overflows=2");
  assert.doesNotMatch(summary, /\b\d{17,20}\b/);
  const server = readFileSync(new URL("../services/router-core-sim/src/server.ts", import.meta.url), "utf8");
  assert.match(server, /MAX_AUDIO_CATCH_UP_BLOCKS = 12/);
  assert.match(server, /const now = performance.now\(\)/);
  assert.match(server, /const latenessMs = now - nextAudioBlockAt/);
  assert.match(server, /nextAudioBlockAt \+= blockIntervalMs/);
  assert.match(server, /audioSchedulerTiming.record\(latenessMs, processed, now\)/);
  assert.match(server, /setTimeout\(scheduleAudioBlock, delayMs\)/);
  assert.match(server, /}, 60_000\).unref\(\)/);
});

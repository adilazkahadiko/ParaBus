import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AudioOutputManager } from "../services/router-core-sim/src/audio-output.ts";
import { supportDiagnostics } from "../services/router-core-sim/src/support-bundle.ts";

// Native bounded CHUNK queue + current chunk + serial JS Writable waiting for
// admission. Write completion means copied/admitted, never playback completion.
class ClockedDevice extends EventEmitter {
  queue: number[] = [];
  pending: Array<{ frames: number; callback: () => void }> = [];
  current = 0;
  lastAt = 0;
  underrunFrames = 0;
  framesAccepted = 0;
  capture = false;
  blocks: Buffer[] = [];
  stopped = false;
  ppm: number;
  readonly channels: number;
  constructor(ppm: number, channels = 1) { super(); this.ppm = ppm; this.channels = channels; }
  start() {}
  abort() { this.stopped = true; this.queue.length = 0; this.pending.length = 0; }
  write(buffer: Buffer, callback: () => void) {
    if (this.capture) this.blocks.push(Buffer.from(buffer));
    this.pending.push({ frames: buffer.length / (4 * this.channels), callback });
    this.admit(); return false;
  }
  admit() {
    while (this.pending.length && this.queue.length < 6) {
      const next = this.pending.shift()!;
      this.queue.push(next.frames); this.framesAccepted += next.frames; next.callback();
    }
  }
  advance(now: number) {
    let consume = (now - this.lastAt) * 48 * (1 + this.ppm / 1e6); this.lastAt = now;
    while (consume > 1e-6) {
      if (this.current === 0) { this.current = this.queue.shift() ?? 0; this.admit(); }
      if (!this.current) { this.underrunFrames += consume; break; }
      const count = Math.min(consume, this.current); consume -= count; this.current -= count;
    }
  }
  get latencyMs() { return (this.current + this.queue.reduce((a, b) => a + b, 0) + this.pending.reduce((a, b) => a + b.frames, 0)) / 48; }
}

function output(device: ClockedDevice) {
  const module = { SampleFormatFloat32: 1, getDevices: () => [{ id: 0, name: "Virtual WASAPI", hostAPIName: "Windows WASAPI", maxOutputChannels: device.channels, defaultSampleRate: 48_000 }],
    AudioIO: class { constructor(options: any) { assert.equal(options.outOptions.maxQueue, 6); return device; } } } as never;
  const manager = new AudioOutputManager(48_000, 480, device.channels, module, 60_000, null, "linux");
  manager.selectDevice("pa:0"); return manager;
}

test("independent +/-200ppm WASAPI devices run an hour without drops, starvation or growing latency", t => {
  let now = 0; const clock = t.mock.method(performance, "now", () => now);
  const devices = [new ClockedDevice(200), new ClockedDevice(-200)], managers = devices.map(output);
  t.after(() => managers.forEach(manager => manager.stop()));
  const samples = [new Float32Array(480).fill(0.125)];
  const minimum = [Infinity, Infinity], maximum = [0, 0];
  for (let block = 1; block <= 360_000; block++) {
    now = block * 10;
    // The mock records every call; drop them so an hour of blocks fits in a 2 GB heap.
    if (block % 1_000 === 0) clock.mock.resetCalls();
    for (let i = 0; i < 2; i++) {
      devices[i].advance(now); managers[i].writeBlock(samples);
      if (block > 6_000) { minimum[i] = Math.min(minimum[i], devices[i].latencyMs); maximum[i] = Math.max(maximum[i], devices[i].latencyMs); }
    }
  }
  for (let i = 0; i < 2; i++) {
    const snapshot = managers[i].snapshot(), timing = snapshot.writeTiming!;
    assert.equal(snapshot.backpressureDrops, 0); assert.equal(devices[i].underrunFrames, 0);
    assert.ok(minimum[i] >= 50 && maximum[i] <= 105, `bounded latency ${minimum[i]}..${maximum[i]}ms`);
    assert.ok(timing.backlogEwma >= 0.5 && timing.backlogEwma <= 2.5);
    assert.ok(Math.abs(timing.estimatedPpm - devices[i].ppm) < 20, `${timing.estimatedPpm}ppm`);
    assert.equal(snapshot.framesWritten, devices[i].framesAccepted + devices[i].pending.reduce((a, b) => a + b.frames, 0));
    t.diagnostic(`${devices[i].ppm}ppm: correction=${timing.estimatedPpm.toFixed(2)}ppm latency=${minimum[i].toFixed(2)}..${maximum[i].toFixed(2)}ms drops=0`);
  }
  managers[1].stop();
  const cueFrames = managers[1].snapshot().framesWritten;
  for (let block = 0; block < 100; block++) { now += 10; devices[0].advance(now); managers[0].writeBlock(samples); managers[1].writeBlock(samples); }
  assert.equal(managers[0].snapshot().state, "READY"); assert.equal(managers[1].snapshot().framesWritten, cueFrames);
  const support = supportDiagnostics({ output: managers[0].snapshot(), channels: [] } as any).output.writeTiming! as Record<string, unknown>;
  assert.equal(support.correctionAddedFrames, managers[0].snapshot().writeTiming!.correctionAddedFrames);
  assert.equal(support.estimatedPpm, managers[0].snapshot().writeTiming!.estimatedPpm);
});

test("linear frame correction preserves DC, amplitude, endpoints and stereo separation", t => {
  let now = 0; t.mock.method(performance, "now", () => now);
  const device = new ClockedDevice(200, 2), manager = output(device);
  t.after(() => manager.stop()); device.capture = true;
  const left = Float32Array.from({ length: 480 }, (_, i) => -0.5 + i / 479);
  const right = new Float32Array(480).fill(-0.25);
  let extended = false, shortened = false;
  let previousEnd: number | undefined;
  for (let block = 0; block < 4_000; block++) {
    // Exercise both directions without discarding a block.
    if (block === 1_000) device.ppm = -2_000;
    const direction = block % 2 ? -1 : 1;
    for (let i = 0; i < 480; i++) left[i] = (-0.5 + i / 479) * direction;
    now += 10;
    device.advance(now);
    manager.writeBlock([left, right]);
    const pcm = device.blocks.pop()!; const frames = pcm.length / 8;
    extended ||= frames === 481; shortened ||= frames === 479;
    assert.equal(pcm.readFloatLE(0), left[0]); assert.equal(pcm.readFloatLE((frames - 1) * 8), left[479]);
    if (previousEnd !== undefined) assert.equal(pcm.readFloatLE(0), previousEnd, "no new step at the block boundary");
    previousEnd = pcm.readFloatLE((frames - 1) * 8);
    for (let i = 0; i < frames; i++) {
      assert.equal(pcm.readFloatLE(i * 8 + 4), -0.25);
      assert.ok(Math.abs(pcm.readFloatLE(i * 8) - (-0.5 + i / (frames - 1)) * direction) < 1e-6);
    }
  }
  assert.ok(extended && shortened, "both correction signs are exercised");
});

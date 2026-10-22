import assert from "node:assert/strict";
import test from "node:test";
import { IntegratedLoudnessHistogram, LoudnessMeter, energyToLufs } from "../services/router-core-sim/src/dsp.ts";

const energy = (lufs: number) => 10 ** ((lufs + 0.691) / 10);

// Original two-pass gate, independent of histogram quantization.
function reference(history: number[]): number {
  const absolute = history.filter(value => energyToLufs(value) >= -70);
  if (!absolute.length) return -Infinity;
  const threshold = Math.max(-70, energyToLufs(absolute.reduce((a, b) => a + b, 0) / absolute.length) - 10);
  const gated = absolute.filter(value => energyToLufs(value) >= threshold);
  return gated.length ? energyToLufs(gated.reduce((a, b) => a + b, 0) / gated.length) : -Infinity;
}

test("integrated histogram matches the original gate for speech, silence, mixtures, wrap and reset", () => {
  for (const capacity of [13, 100, 216_000]) {
    const histogram = new IntegratedLoudnessHistogram(capacity), history: number[] = [];
    for (let index = 0; index < 600; index++) {
      const value = index < 30 || index % 7 === 0 ? 0
        : index % 9 === 0 ? energy(-70.001) : energy(-54 + 32 * (0.5 + 0.5 * Math.sin(index / 17)));
      histogram.add(value); history.push(value); if (history.length > capacity) history.shift();
      const expected = reference(history), actual = histogram.value();
      assert.ok(actual === expected || Math.abs(actual - expected) <= 0.05, `${capacity}/${index}: ${actual} vs ${expected}`);
      if (index === 300) { histogram.reset(); history.length = 0; assert.equal(histogram.value(), -Infinity); }
    }
    for (let index = 0; index < capacity; index++) histogram.add(0);
    assert.equal(histogram.value(), -Infinity, "overwriting all audible history returns exact silence");
  }
  const boundary = new IntegratedLoudnessHistogram(2);
  boundary.add(energy(-70.00001)); assert.equal(boundary.value(), -Infinity);
  boundary.add(energy(-70)); assert.ok(Math.abs(boundary.value() + 70) < 1e-9, "absolute gate includes its exact boundary");
});

test("six-hour history wraps correctly and calculation cost does not grow with retained history", t => {
  const short = new IntegratedLoudnessHistogram(600), long = new IntegratedLoudnessHistogram(216_000);
  for (let i = 0; i < 216_600; i++) { const e = energy(-30 + (i % 40) / 10); long.add(e); if (i < 600) short.add(e); }
  assert.ok(Math.abs(long.value() - short.value()) < 0.000001);
  function measure(histogram: IntegratedLoudnessHistogram) {
    for (let i = 0; i < 200; i++) histogram.value();
    const runs: number[] = [];
    for (let run = 0; run < 5; run++) {
      const start = performance.now(); for (let i = 0; i < 500; i++) histogram.value();
      runs.push((performance.now() - start) / 500);
    }
    return runs.sort((a, b) => a - b)[2];
  }
  const shortMs = measure(short), longMs = measure(long);
  t.diagnostic(`LUFS-I calculation: 1min=${shortMs.toFixed(4)}ms, 6h=${longMs.toFixed(4)}ms`);
  assert.ok(longMs <= shortMs * 4 + 0.05, "360x more history must not cause proportional work");
});

test("LUFS-I recomputes once per second after capacity and reset without changing PCM or M/S", t => {
  let calculations = 0;
  const original = IntegratedLoudnessHistogram.prototype.value;
  t.mock.method(IntegratedLoudnessHistogram.prototype, "value", function(this: IntegratedLoudnessHistogram) { calculations++; return original.call(this); });
  const meter = new LoudnessMeter(48_000, 480, true, 1 / 3600);
  const unintegrated = new LoudnessMeter(48_000, 480, false);
  const block = Float32Array.from({ length: 480 }, (_, i) => Math.sin(i * Math.PI / 24) * 0.2), copy = block.slice();
  for (let i = 0; i < 1_039; i++) { meter.process(block); unintegrated.process(block); }
  assert.equal(calculations, 10, "full ring must not trigger a scan every 100ms");
  assert.deepEqual(block, copy, "meter leaves all input PCM bits untouched");
  assert.equal(meter.value.momentary, unintegrated.value.momentary);
  assert.equal(meter.value.shortTerm, unintegrated.value.shortTerm);
  meter.resetIntegrated();
  for (let i = 0; i < 99; i++) meter.process(block);
  assert.equal(calculations, 10); assert.equal(meter.value.integrated, -Infinity);
  meter.process(block); assert.equal(calculations, 11);
});

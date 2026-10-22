import test from "node:test";
import assert from "node:assert/strict";
import { Compressor, HighPassFilter, LoudnessMeter, SafetyLimiter, dbToGain, gainToDb } from "../services/router-core-sim/src/dsp.ts";

test("dB conversion round-trips across the operating range", () => {
  for (const db of [-90, -60, -18, -3, 0, 12]) {
    assert.ok(Math.abs(gainToDb(dbToGain(db)) - db) < 0.000001);
  }
});

test("high-pass filter rejects a DC signal", () => {
  const filter = new HighPassFilter(48_000, 80);
  const block = new Float32Array(480);
  for (let index = 0; index < 20; index += 1) {
    block.fill(0.5);
    filter.processInPlace(block);
  }
  assert.ok(Math.abs(block.at(-1) ?? 1) < 0.001);
});

test("compressor leaves signals below threshold unchanged", () => {
  const compressor = new Compressor();
  const block = new Float32Array(480);
  for (let index = 0; index < block.length; index += 1) block[index] = Math.sin(index) * dbToGain(-24);
  const original = block.slice();
  compressor.processInPlace(block, 48_000);
  assert.deepEqual(block, original);
  assert.equal(compressor.gainReductionDb, 0);
});

test("compressor reduces signals above threshold", () => {
  const compressor = new Compressor();
  compressor.attackMs = 0.1;
  const block = new Float32Array(480).fill(1);
  compressor.processInPlace(block, 48_000);
  assert.ok(block.at(-1)! < 1);
  assert.ok(compressor.gainReductionDb > 0);
});

test("safety limiter holds samples below its ceiling", () => {
  const limiter = new SafetyLimiter();
  const block = new Float32Array([0.2, 1.8, -2, 0.5]);
  limiter.processInPlace(block, 48_000);
  const ceiling = dbToGain(-1);
  assert.ok(Math.max(...block.map(Math.abs)) <= ceiling + 0.000001);
  assert.ok(limiter.gainReductionDb > 0);
});

test("EBU loudness windows report a calibrated 1 kHz mono tone", () => {
  const meter = new LoudnessMeter(48_000, 480, true);
  const block = new Float32Array(480);
  const gain = dbToGain(-18);
  let phase = 0;
  for (let blockIndex = 0; blockIndex < 310; blockIndex += 1) {
    for (let index = 0; index < block.length; index += 1) {
      block[index] = Math.sin(phase) * gain;
      phase += 2 * Math.PI * 1_000 / 48_000;
    }
    meter.process(block);
  }
  const measured = meter.snapshot();
  assert.ok(Math.abs(measured.momentary - (-21)) < 0.1);
  assert.ok(Math.abs(measured.shortTerm - (-21)) < 0.1);
  assert.ok(Math.abs(measured.integrated - (-21)) < 0.1);
});

test("integrated loudness can be reset independently", () => {
  const meter = new LoudnessMeter(48_000, 480, true);
  const block = new Float32Array(480);
  let phase = 0;
  for (let blockIndex = 0; blockIndex < 200; blockIndex += 1) {
    for (let index = 0; index < block.length; index += 1) {
      block[index] = Math.sin(phase) * 0.1;
      phase += 2 * Math.PI * 1_000 / 48_000;
    }
    meter.process(block);
  }
  assert.ok(Number.isFinite(meter.snapshot().integrated));
  const momentaryBeforeReset = meter.snapshot().momentary;
  meter.resetIntegrated();
  const reset = meter.snapshot();
  assert.equal(reset.integrated, Number.NEGATIVE_INFINITY);
  assert.equal(reset.momentary, momentaryBeforeReset);
});

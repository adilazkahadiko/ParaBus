import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

function rejectsOption(name: "CHANNELS" | "BLOCKS", value: string): void {
  const result = spawnSync(process.execPath, ["tests/audio-load/run.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, [name]: value },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`${name} must be an integer`));
}

test("audio load harness rejects invalid bounded options before measurement", () => {
  rejectsOption("CHANNELS", "NaN");
  rejectsOption("CHANNELS", "121");
  rejectsOption("BLOCKS", "99");
});

test("audio load harness measures all 120 inputs without silently clamping to 64", () => {
  const result = spawnSync(process.execPath, ["tests/audio-load/run.ts"], {
    env: { ...process.env, CHANNELS: "120", BLOCKS: "100" },
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  assert.ifError(result.error);
  const report = JSON.parse(result.stdout);
  assert.equal(report.channels, 120);
  assert.equal(report.outputs, 64);
  assert.equal(report.blocks, 100);
  assert.equal(report.deadlineMs, 10);
  assert.equal(report.finiteMeters, true);
  assert.equal(report.topologyMutationFaults, 0);
  assert.ok(report.p99Ms > 0 && report.maximumMs >= report.p99Ms);
  assert.ok(Number.isSafeInteger(report.deadlineMisses));
  // Scheduling on parallel CI workers is not a hardware acceptance test.
  assert.equal(result.status, report.p99Ms > 10 || report.deadlineMisses > 0 ? 1 : 0);
});

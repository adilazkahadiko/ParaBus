import assert from "node:assert/strict";
import test from "node:test";
import type { RouterSnapshot } from "../packages/shared-types/src/index.ts";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { deriveOperatorHealth } from "../services/router-core-sim/src/operator-health.ts";
import { operatorFacingSnapshot, sanitizeOperatorMessage } from "../services/router-core-sim/src/operator-sanitize.ts";

const rawPath = "/home/operator/private/session.wav";
const rawToken = "bot-token-value-that-must-not-appear";
const rawNonce = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const rawId = "333333333333333333";

test("TX failures remain distinct from RX faults without exposing backend detail", () => {
  const base = new ControlPlane(AudioEngine.createDemo(1)).snapshot();
  const project = (message: string | null) => operatorFacingSnapshot({
    ...base, discord: { ...base.discord, bots: [{ message }] },
  } as RouterSnapshot).discord!.bots[0].message;
  for (const code of ["stream-failed", "player-failed", "start-failed", "ended"]) {
    assert.equal(project(`TX stopped (tx-${code}); restart TX explicitly`), "Discord TX stopped; restart TX explicitly");
  }
  assert.equal(project(null), null);
  assert.equal(project(`TX stopped (tx-stream-failed); restart TX explicitly token=${rawToken}`), "Discord receiver connection failed");
  assert.equal(project(`voice failed ${rawPath} token=${rawToken}`), "Discord receiver connection failed");
});

test("common sanitizer removes paths, credentials, query secrets, IDs, nonce and raw payloads", () => {
  const safe = sanitizeOperatorMessage(
    `Recorder write failed ${rawPath} token=${rawToken} Authorization: Bearer auth-value https://local.test/run?secret=query-value ${rawNonce} ${rawId} <Buffer 01 02 03>`,
  );
  assert.match(safe, /Recorder write failed/);
  for (const sensitive of [rawPath, rawToken, "Authorization", "auth-value", "query-value", rawNonce, rawId, "01 02 03"]) {
    assert.doesNotMatch(safe, new RegExp(sensitive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(safe, /\[PATH\]|\[REDACTED\]|\[ID\]|\[AUDIO DATA\]/);
});

test("standard audit events and operator health expose safe summaries without backend detail", () => {
  const control = new ControlPlane(AudioEngine.createDemo(1));
  control.recordExternalEvent("CRITICAL", `Recorder failed ${rawPath} nonce=${rawNonce} user=${rawId}`);
  const audit = JSON.stringify(control.snapshot().alerts);
  assert.match(audit, /Recorder failed/);
  for (const sensitive of [rawPath, rawNonce, rawId]) assert.doesNotMatch(audit, new RegExp(sensitive));

  const source = control.snapshot();
  const unsafe = {
    ...source,
    state: "FAULT",
    emergencyMuted: true,
    output: {
      ...source.output!,
      state: "FAULT",
      selectedDeviceId: `endpoint:${rawPath}`,
      selectedDeviceName: rawPath,
      error: `device ${rawPath} token=${rawToken}`,
    },
    recorder: {
      state: "FAULT", folder: rawPath, format: "WAV_FLOAT32", sampleRate: 48_000,
      startedAt: null, durationSeconds: 0, matrixOutput: 0, includeUsers: false, includeBuses: false,
      queuedBlocks: 0, maxQueuedBlocks: 20, droppedBlocks: 0, freeBytes: null, totalBytes: null,
      message: `write ${rawPath} token=${rawToken}`, tracks: [],
    },
  } as RouterSnapshot;
  const projected = operatorFacingSnapshot(unsafe);
  assert.equal(projected.output?.error, "Audio output disconnected");
  assert.equal(projected.output?.selectedDeviceName, "[PATH]");
  assert.equal(projected.recorder?.message, "Recorder unavailable — check storage");
  assert.equal(projected.recorder?.folder, "Configured recording folder");

  const healthJson = JSON.stringify(deriveOperatorHealth(projected));
  for (const sensitive of [rawPath, rawToken, projected.output!.selectedDeviceId!]) assert.doesNotMatch(healthJson, new RegExp(sensitive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(healthJson, /Audio output disconnected/);
  assert.match(healthJson, /Recorder unavailable/);
});

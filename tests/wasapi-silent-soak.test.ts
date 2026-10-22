import assert from "node:assert/strict";
import test from "node:test";
import {
  WasapiSoakError,
  parseWasapiSoakOptions,
  runWasapiSilentSoak,
  validateWasapiSoakSnapshot,
} from "../services/router-core-sim/src/wasapi-silent-soak.ts";

function snapshot(callbacks: number, overrides: Record<string, unknown> = {}) {
  const value = {
    state: "SETUP",
    coreOwnership: { effectiveOwner: "typescript" },
    rustManagement: { status: "READY", wasapi: { selectedAvailable: true, preflightReady: true, streamState: "RUNNING", streamStarted: true, renderCallbacks: callbacks, outputUnderruns: Math.floor(callbacks / 10) } },
    discord: { configuredBots: 2, readyBots: 2, adapterState: "voice-ready" },
    recorder: { state: "IDLE" },
  };
  return { ...value, ...overrides };
}

function errorCode(action: () => unknown): string {
  try { action(); } catch (error) { return (error as WasapiSoakError).code; }
  throw new Error("expected failure");
}

test("silent soak validates a progressing read-only stream and returns a sanitized summary", async () => {
  let clock = 0;
  let calls = 0;
  const summary = await runWasapiSilentSoak({ durationSeconds: 30, pollSeconds: 10, stateUrl: "http://127.0.0.1:4173/api/state" }, {
    fetchState: async () => snapshot(calls++ * 100),
    sleep: async (milliseconds) => { clock += milliseconds; },
    nowMs: () => clock,
  });
  assert.deepEqual(summary, { durationSeconds: 30, polls: 4, callbackDelta: 300, underrunDelta: 30, discordReadyBots: 2 });
  assert.doesNotMatch(JSON.stringify(summary), /endpoint|token|guild|user|path/i);
});

test("stream faults and Discord degradation fail with sanitized reasons", () => {
  assert.equal(errorCode(() => validateWasapiSoakSnapshot(snapshot(1, { rustManagement: { status: "READY", wasapi: { selectedAvailable: true, preflightReady: true, streamState: "FAULT", streamStarted: false, renderCallbacks: 1, outputUnderruns: 0 } } }))), "wasapi-stream-not-running");
  assert.equal(errorCode(() => validateWasapiSoakSnapshot(snapshot(1, { discord: { configuredBots: 2, readyBots: 1, adapterState: "voice-ready" } }))), "discord-bots-not-ready");
  assert.equal(errorCode(() => validateWasapiSoakSnapshot(snapshot(1, { discord: { configuredBots: 0, readyBots: 0, adapterState: "voice-ready" } }))), "discord-no-configured-bots");
});

test("counter regression fails immediately while no progress tolerates snapshot refresh lag", async () => {
  for (const values of [[10, 9], [10, 10, 10, 10]]) {
    let clock = 0;
    let index = 0;
    await assert.rejects(runWasapiSilentSoak({ durationSeconds: 30, pollSeconds: 10, stateUrl: "http://127.0.0.1:4173/api/state" }, {
      fetchState: async () => snapshot(values[Math.min(index++, values.length - 1)]),
      sleep: async (milliseconds) => { clock += milliseconds; }, nowMs: () => clock,
    }), new RegExp(values[1] < values[0] ? "wasapi-counter-regression" : "wasapi-callback-no-progress"));
  }
});

test("a delayed 1 Hz snapshot can progress before the no-progress deadline", async () => {
  let clock = 0;
  let index = 0;
  const summary = await runWasapiSilentSoak({ durationSeconds: 30, pollSeconds: 1, stateUrl: "http://127.0.0.1:4173/api/state" }, {
    fetchState: async () => snapshot(Math.max(0, index++ - 2)),
    sleep: async (milliseconds) => { clock += milliseconds; }, nowMs: () => clock,
  });
  assert.equal(summary.callbackDelta, 28);
});

test("options are bounded and the state endpoint stays loopback GET-only", () => {
  assert.deepEqual(parseWasapiSoakOptions(["--duration-seconds", "30", "--poll-seconds", "1"], {}), { durationSeconds: 30, pollSeconds: 1, stateUrl: "http://127.0.0.1:4173/api/state" });
  for (const args of [["--duration-seconds", "29"], ["--duration-seconds"], ["--poll-seconds"], ["--poll-seconds", "61"], ["--state-url", "http://example.test/api/state"], ["--state-url", "http://localhost:4173/api/state"], ["--state-url", "http://127.0.0.1/api/command"]]) {
    assert.throws(() => parseWasapiSoakOptions(args, {}), WasapiSoakError);
  }
});

test("the final sleep is limited to the remaining soak duration", async () => {
  let clock = 0;
  let calls = 0;
  const sleeps: number[] = [];
  const summary = await runWasapiSilentSoak({ durationSeconds: 30, pollSeconds: 60, stateUrl: "http://127.0.0.1:4173/api/state" }, {
    fetchState: async () => snapshot(calls++),
    sleep: async (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; }, nowMs: () => clock,
  });
  assert.deepEqual(sleeps, [30_000]);
  assert.equal(summary.durationSeconds, 30);
});

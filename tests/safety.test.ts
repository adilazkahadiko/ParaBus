import test from "node:test";
import assert from "node:assert/strict";
import { AudioChannel, AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";

function clearEmergency(control: ControlPlane, confirmed?: boolean) {
  return control.execute({
    type: "EMERGENCY_MUTE",
    active: false,
    confirmed,
    expectedEmergencyEpoch: control.snapshot().emergencyEpoch,
  });
}

test("central command validation rejects malformed numeric and boolean values without mutation", () => {
  const engine = AudioEngine.createDemo(1);
  const control = new ControlPlane(engine);
  const channel = engine.channels.get("user-01")!;
  const beforeRevision = control.revision;
  const bad = [
    { type: "SET_CHANNEL_FADER", channelId: "user-01", db: "bad" },
    { type: "SET_VC_SEND", channelId: "user-01", busId: "interview", db: "bad" },
    { type: "SET_BUS_MASTER", busId: "interview", db: null },
    { type: "SET_BUS_COMPRESSOR", busId: "interview", thresholdDb: -20, ratio: "bad" },
    { type: "SET_CHANNEL_MUTE", channelId: "user-01", mute: "false" },
    { type: "SET_DIRECT_OUTPUT", channelId: "user-01", output: 0, tap: "SIDE", gainDb: 0 },
  ];
  for (const command of bad) assert.equal(control.execute(command as never).ok, false);
  assert.equal(control.revision, beforeRevision);
  assert.equal(channel.faderDb, 0);
  assert.equal(channel.vcSends.get("interview")?.gainDb, -12);
  assert.equal(engine.buses.get("interview")?.compressor.ratio, 2);
});

test("central numeric validation rejects every nonfinite, wrong-type, and out-of-range control field atomically", () => {
  const invalidValues = ["bad", null, Number.NaN, Number.POSITIVE_INFINITY, -999_999, 999_999];
  const commands: Array<(value: unknown) => unknown> = [
    (db) => ({ type: "SET_CHANNEL_FADER", channelId: "user-01", db }),
    (db) => ({ type: "SET_VC_SEND", channelId: "user-01", busId: "interview", db }),
    (db) => ({ type: "SET_BUS_MASTER", busId: "interview", db }),
    (defaultSendDb) => ({ type: "CREATE_VC_BUS", name: "new", defaultSendDb }),
    (defaultSendDb) => ({ type: "SET_NEW_PARTICIPANT_POLICY", busId: "interview", policy: "SAFE", defaultSendDb }),
    (thresholdDb) => ({ type: "SET_BUS_COMPRESSOR", busId: "interview", thresholdDb }),
    (ratio) => ({ type: "SET_BUS_COMPRESSOR", busId: "interview", ratio }),
    (attackMs) => ({ type: "SET_BUS_COMPRESSOR", busId: "interview", attackMs }),
    (releaseMs) => ({ type: "SET_BUS_COMPRESSOR", busId: "interview", releaseMs }),
    (makeupDb) => ({ type: "SET_BUS_COMPRESSOR", busId: "interview", makeupDb }),
    (channelCount) => ({ type: "SELECT_INPUT_DEVICE", deviceId: "mock-input", channelCount }),
    (output) => ({ type: "SET_DIRECT_OUTPUT", channelId: "user-01", output, tap: "PRE" }),
    (gainDb) => ({ type: "SET_DIRECT_OUTPUT", channelId: "user-01", output: 0, tap: "PRE", gainDb }),
    (output) => ({ type: "SET_OUTPUT_TEST_TONE", output, active: true }),
    (output) => ({ type: "SET_TX_SOURCE", output }),
    (matrixOutput) => ({ type: "START_RECORDING", matrixOutput, includeUsers: false, includeBuses: false, confirmed: true }),
  ];
  for (const factory of commands) {
    for (const value of invalidValues) {
      const control = new ControlPlane(AudioEngine.createDemo(1));
      const beforeRevision = control.revision;
      const before = JSON.stringify({
        state: control.state,
        channel: control.engine.channels.get("user-01"),
        bus: control.engine.buses.get("interview"),
        matrix: [...control.engine.matrixRoutes.entries()],
        tones: [...control.engine.outputTestTones],
      });
      const result = control.execute(factory(value) as never);
      assert.equal(result.ok, false);
      assert.equal(control.revision, beforeRevision);
      assert.equal(JSON.stringify({
        state: control.state,
        channel: control.engine.channels.get("user-01"),
        bus: control.engine.buses.get("interview"),
        matrix: [...control.engine.matrixRoutes.entries()],
        tones: [...control.engine.outputTestTones],
      }), before);
    }
  }
});

test("long device and scene identifiers remain valid at their explicit operational limits", () => {
  const control = new ControlPlane(AudioEngine.createDemo(1));
  const deviceId = "d".repeat(6_000);
  assert.equal(control.execute({ type: "DEVICE_LOST", deviceId }).ok, true);
  assert.equal(control.state, "FAULT");
  assert.equal(control.engine.emergencyMuted, true);
  const recovery = new ControlPlane(AudioEngine.createDemo(1));
  const result = recovery.execute({ type: "SET_RECALL_SAFE", parameter: "p".repeat(3_000), safe: true });
  assert.equal(result.ok, false);
  assert.equal(result.error, "unknown scene parameter", "unknown but well-formed parameter reaches normal semantic validation");
  const tooLargeDevice = recovery.execute({ type: "DEVICE_LOST", deviceId: "あ".repeat(2_731) });
  assert.equal(tooLargeDevice.ok, false, "8 KiB is an UTF-8 byte bound, not a UTF-16 code-unit bound");
  const tooLargeParameter = recovery.execute({ type: "SET_RECALL_SAFE", parameter: "あ".repeat(1_366), safe: true });
  assert.equal(tooLargeParameter.ok, false, "4 KiB is an UTF-8 byte bound, not a UTF-16 code-unit bound");
});

test("scene recall validates every live target before mutating", () => {
  const engine = AudioEngine.createDemo(1);
  const control = new ControlPlane(engine);
  const saved = control.execute({ type: "SAVE_SCENE", name: "safe" });
  const scene = control.scenes.get((saved.data as { id: string }).id)!;
  scene.values["channel.user-01.faderDb"] = -6;
  scene.values["bus.interview.compressorRatio"] = "bad";
  const before = engine.channels.get("user-01")!.faderDb;
  const result = control.execute({ type: "RECALL_SCENE", sceneId: scene.id, confirmed: true });
  assert.equal(result.ok, false);
  assert.equal(engine.channels.get("user-01")!.faderDb, before, "no earlier scene value may partially apply");
});

test("non-finite source audio is silenced and the next block recovers", () => {
  const engine = AudioEngine.createDemo(0);
  const source = { fill(target: Float32Array) { target.fill(Number.NaN); return true; } };
  const channel = new AudioChannel("bad", "bad", "TestTone", source, engine.blockSize, engine.sampleRate);
  channel.directOutput = { output: 0, tap: "POST", gainDb: 0, mute: false };
  engine.addChannel(channel);
  engine.processBlock();
  assert.deepEqual([...engine.outputs[0]], new Array(engine.blockSize).fill(0));
  (source as { fill(target: Float32Array): boolean }).fill = (target) => { target.fill(0.25); return true; };
  engine.processBlock();
  assert.ok(engine.outputs[0].every((sample) => Number.isFinite(sample) && sample !== 0));
  channel.directOutput!.gainDb = Number.NaN; // defensive final-output path, independent of limiter state
  engine.processBlock();
  assert.ok(engine.outputs[0].every((sample) => sample === 0));
  channel.directOutput!.gainDb = 0;
  engine.processBlock();
  assert.ok(engine.outputs[0].every((sample) => Number.isFinite(sample) && sample !== 0));
});

test("going ON AIR requires confirmation and active safety limiters", () => {
  const engine = AudioEngine.createDemo(2);
  const control = new ControlPlane(engine);
  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, true);
  const unconfirmed = control.execute({ type: "SET_STATE", state: "ON_AIR" });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.confirmationRequired, true);
  assert.equal(control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true }).ok, true);
});

test("limiter topology is locked ON AIR while faders remain operable", () => {
  const control = new ControlPlane(AudioEngine.createDemo(2));
  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  assert.equal(control.execute({ type: "SET_LIMITER", busId: "interview", enabled: false }).ok, false);
  assert.equal(control.execute({ type: "SET_CHANNEL_FADER", channelId: "user-01", db: -8 }).ok, true);
});

test("output device loss enters FAULT without selecting a fallback", () => {
  const engine = AudioEngine.createDemo(2);
  const control = new ControlPlane(engine);
  const result = control.execute({ type: "DEVICE_LOST", deviceId: "SoundGrid Core Audio" });
  assert.equal(result.ok, true);
  assert.equal(control.state, "FAULT");
  assert.equal(engine.emergencyMuted, true);
  assert.match(control.snapshot().alerts[0].message, /OUTPUT DEVICE LOST/);
});

test("scene recall honors parameter-level recall safe", () => {
  const engine = AudioEngine.createDemo(1);
  const control = new ControlPlane(engine);
  control.execute({ type: "SET_CHANNEL_FADER", channelId: "user-01", db: -3 });
  const saved = control.execute({ type: "SAVE_SCENE", name: "Opening" });
  const sceneId = (saved.data as { id: string }).id;
  control.execute({ type: "SET_CHANNEL_FADER", channelId: "user-01", db: -12 });
  control.execute({ type: "SET_RECALL_SAFE", parameter: "channel.user-01.faderDb", safe: true });
  control.execute({ type: "RECALL_SCENE", sceneId, confirmed: true });
  assert.equal(engine.channels.get("user-01")?.faderDb, -12);
});

test("emergency mute release requires confirmation", () => {
  const control = new ControlPlane(AudioEngine.createDemo(1));
  control.execute({ type: "EMERGENCY_MUTE", active: true });
  assert.equal(clearEmergency(control).confirmationRequired, true);
  assert.equal(control.engine.emergencyMuted, true);
  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, true);
  assert.equal(clearEmergency(control, true).ok, true);
  assert.equal(control.engine.emergencyMuted, false);
});

test("FAULT rejects emergency clear and acknowledgement never clears it", () => {
  const control = new ControlPlane(AudioEngine.createDemo(1));
  control.execute({ type: "DEVICE_LOST", deviceId: "SoundGrid" });
  const rejected = clearEmergency(control, true);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error ?? "", /FAULT/);
  assert.equal(control.engine.emergencyMuted, true);
  assert.equal(control.execute({ type: "ACKNOWLEDGE_FAULT", confirmed: true }).ok, true);
  assert.equal(control.state, "SETUP");
  assert.equal(control.engine.emergencyMuted, true, "fault acknowledgement cannot resume audio");
  assert.equal(clearEmergency(control, true).ok, false, "SETUP is not a recovered READY state");
  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, true);
  assert.equal(clearEmergency(control, true).ok, true);
});

test("Emergency Clear uses a per-activation epoch while Emergency ON stays fail-safe and idempotent", () => {
  const control = new ControlPlane(AudioEngine.createDemo(1));
  assert.equal(control.execute({ type: "EMERGENCY_MUTE", active: true }).ok, true);
  const firstEpoch = control.snapshot().emergencyEpoch;
  assert.ok(firstEpoch > 0);
  assert.equal(control.execute({ type: "EMERGENCY_MUTE", active: true }).ok, true);
  assert.equal(control.snapshot().emergencyEpoch, firstEpoch, "duplicate ON is a safe no-op");

  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, true);
  assert.equal(clearEmergency(control, true).ok, true);
  assert.equal(control.engine.emergencyMuted, false);
  assert.equal(control.execute({ type: "EMERGENCY_MUTE", active: true }).ok, true);
  const secondEpoch = control.snapshot().emergencyEpoch;
  assert.equal(secondEpoch, firstEpoch + 1);

  const delayedClear = control.execute({
    type: "EMERGENCY_MUTE",
    active: false,
    confirmed: true,
    expectedEmergencyEpoch: firstEpoch,
  });
  assert.equal(delayedClear.ok, false);
  assert.equal(delayedClear.code, "STALE_STATE");
  assert.equal(delayedClear.conflict?.resource, "emergency-mute");
  assert.equal(control.engine.emergencyMuted, true, "an old screen cannot clear the new emergency episode");
  assert.equal(clearEmergency(control, true).ok, true);
});

test("scene recall cannot release Emergency Mute or FAULT", () => {
  const control = new ControlPlane(AudioEngine.createDemo(1));
  const saved = control.execute({ type: "SAVE_SCENE", name: "Before fault" });
  const sceneId = (saved.data as { id: string }).id;
  control.execute({ type: "DEVICE_LOST", deviceId: "SoundGrid" });
  assert.equal(control.execute({ type: "RECALL_SCENE", sceneId, confirmed: true }).ok, false);
  assert.equal(control.state, "FAULT");
  assert.equal(control.engine.emergencyMuted, true);
});

test("integrated loudness reset is available while ON AIR", () => {
  const control = new ControlPlane(AudioEngine.createDemo(1));
  for (let index = 0; index < 100; index += 1) control.engine.processBlock();
  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  assert.equal(control.execute({ type: "RESET_LOUDNESS", busId: "interview" }).ok, true);
  assert.equal(control.engine.buses.get("interview")?.loudnessValue.integrated, Number.NEGATIVE_INFINITY);
});

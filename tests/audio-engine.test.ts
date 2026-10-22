import test from "node:test";
import assert from "node:assert/strict";
import { AudioChannel, AudioEngine, SilenceSource, SineSource, VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { isRecorderSelection } from "../services/router-core-sim/src/recorder.ts";

test("Phase 0 reference configuration processes 64 sources and 64 outputs", () => {
  const engine = AudioEngine.createDemo(64);
  for (let index = 0; index < 100; index += 1) engine.processBlock();
  assert.equal(engine.channels.size, 64);
  assert.equal(engine.outputs.length, 64);
  assert.equal(engine.blocksProcessed, 100);
  assert.ok([...engine.channels.values()].every((channel) => Number.isFinite(channel.outputMeter.rms)));
  assert.ok((engine.buses.get("interview")?.meter.peak ?? 2) <= 1);
});

test("Engine and Recorder selection admit 120 inputs and reject input 121", () => {
  const engine = AudioEngine.createDemo(120);
  engine.processBlock();
  assert.equal(engine.channels.size, 120);
  assert.ok([...engine.channels.values()].every((channel) => Number.isFinite(channel.outputMeter.rms)));
  const extra = new AudioChannel("extra", "Extra", "LocalMonoInput", new SilenceSource(), 480, 48_000);
  assert.throws(() => engine.addChannel(extra), /maximum 120 channels exceeded/);
  const selection = { outputs: [], busIds: [], channelIds: [...engine.channels.keys()] };
  assert.equal(isRecorderSelection(selection), true);
  assert.equal(isRecorderSelection({ ...selection, channelIds: [...selection.channelIds, "extra"] }), false);
});

test("PRE direct output is independent of the channel fader", () => {
  const engine = new AudioEngine(48_000, 48, 2);
  const channel = new AudioChannel("a", "A", "TestTone", new SineSource(1_000, -6), 48, 48_000);
  channel.directOutput = { output: 0, tap: "PRE", gainDb: 0, mute: false };
  channel.faderDb = -90;
  engine.addChannel(channel);
  engine.processBlock();
  assert.ok(Math.max(...engine.outputs[0].map(Math.abs)) > 0.1);
  assert.ok(Math.max(...channel.post.map(Math.abs)) < 0.0001);
});

test("missing input becomes silence and is marked stale", () => {
  const engine = new AudioEngine(48_000, 48, 1);
  const channel = new AudioChannel("lost", "Lost", "DiscordUser", new SilenceSource(), 48, 48_000);
  channel.lastAudioAt = Date.now() - 1_000;
  channel.directOutput = { output: 0, tap: "PRE", gainDb: 0, mute: false };
  engine.addChannel(channel);
  engine.processBlock();
  assert.equal(channel.stale, true);
  assert.equal(Math.max(...engine.outputs[0]), 0);
});

test("Discord participant processing keeps Peak/RMS but leaves LUFS to the VC bus", () => {
  const engine = new AudioEngine(48_000, 480, 2);
  const channel = new AudioChannel("guest", "Guest", "DiscordUser", new SineSource(1_000, -12), 480, 48_000);
  channel.approvalGateOpen = true;
  engine.addChannel(channel);
  engine.processBlock();
  assert.ok(channel.outputMeter.rms > 0);
  assert.equal(channel.loudnessValue.momentary, Number.NEGATIVE_INFINITY);
});

test("emergency mute silences direct and bus outputs", () => {
  const engine = new AudioEngine(48_000, 48, 2);
  const bus = new VcBus("vc", "VC", 48);
  const channel = new AudioChannel("a", "A", "TestTone", new SineSource(1_000, -6), 48, 48_000);
  channel.directOutput = { output: 0, tap: "PRE", gainDb: 0, mute: false };
  channel.vcSends.set("vc", { gainDb: 0, mute: false });
  engine.addBus(bus);
  engine.addChannel(channel);
  engine.addMatrixRoute({ id: "bus-out", sourceId: "vc", output: 1, gainDb: 0, mute: false, tap: "POST" });
  engine.emergencyMuted = true;
  engine.processBlock();
  assert.equal(Math.max(...engine.outputs[0]), 0);
  assert.equal(Math.max(...engine.outputs[1]), 0);
});

test("VC CUE is pre-master without bypassing approval, send mute or emergency mute", () => {
  const engine = new AudioEngine(48_000, 480, 2);
  const bus = new VcBus("vc", "VC", 480);
  const channel = new AudioChannel("guest", "Guest", "DiscordUser", new SineSource(1_000, -12), 480, 48_000);
  channel.vcSends.set(bus.id, { gainDb: 0, mute: false });
  engine.addBus(bus);
  engine.addChannel(channel);
  engine.addMatrixRoute({ id: "main", sourceId: bus.id, output: 0, gainDb: 0, mute: false, tap: "POST" });
  engine.setMonitorSource(bus.id);
  engine.setMonitorOutput(1, "MONO");
  const peak = (buffer: Float32Array) => Math.max(...buffer.map(Math.abs));

  engine.processBlock();
  assert.equal(peak(engine.monitorSourceBlock()!), 0, "PENDING is silent in CUE too");
  channel.approvalGateOpen = true;
  bus.mute = true;
  engine.processBlock();
  assert.equal(peak(engine.outputs[0]), 0, "Main stays muted");
  assert.ok(peak(engine.monitorSourceBlock()!) > 0.01, "independent CUE hears a muted VC");
  assert.deepEqual(engine.outputs[1], engine.monitorSourceBlock(), "Main-device Monitor uses the same pre-master tap");
  bus.mute = false;
  bus.masterDb = -90;
  engine.processBlock();
  assert.ok(peak(engine.outputs[0]) < 0.0001);
  assert.ok(peak(engine.monitorSourceBlock()!) > 0.01, "Master fader does not affect CUE");
  channel.vcSends.get(bus.id)!.mute = true;
  engine.processBlock();
  assert.equal(peak(engine.monitorSourceBlock()!), 0, "excluded sends stay excluded");
  channel.vcSends.get(bus.id)!.mute = false;
  channel.trimDb = 36;
  bus.compressorEnabled = false;
  engine.processBlock();
  assert.ok(peak(engine.monitorSourceBlock()!) <= Math.pow(10, -1 / 20) + 0.000001, "pre-master CUE remains limited");
  engine.emergencyMuted = true;
  assert.equal(engine.monitorSourceBlock(), null, "mute immediately hides the previous CUE block");
  engine.processBlock();
  assert.equal(peak(bus.preMaster), 0);
  assert.equal(peak(engine.outputs[1]), 0);
});

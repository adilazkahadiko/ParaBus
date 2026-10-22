import assert from "node:assert/strict";
import test from "node:test";
import { AudioChannel, AudioEngine, SineSource, VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";

function peak(buffer: Float32Array): number {
  let maximum = 0;
  for (const sample of buffer) maximum = Math.max(maximum, Math.abs(sample));
  return maximum;
}

test("BUS-only, Direct-only, and Hybrid are valid output topologies", () => {
  const engine = AudioEngine.createDemo(1);
  const control = new ControlPlane(engine);

  assert.equal(control.execute({ type: "CLEAR_DIRECT_OUTPUT", channelId: "user-01" }).ok, true);
  assert.equal(control.snapshot().channels[0].directOutput, undefined, "an unassigned Direct Out is a normal snapshot state");
  engine.processBlock();
  assert.equal(peak(engine.outputs[0]), 0, "BUS-only does not require a user Direct Out");
  assert.ok(peak(engine.outputs[63]) > 0, "BUS-only reaches its physical output");

  assert.equal(control.execute({ type: "CLEAR_BUS_OUTPUT", busId: "interview" }).ok, true);
  assert.equal(control.execute({ type: "SET_DIRECT_OUTPUT", channelId: "user-01", output: 4, tap: "PRE" }).ok, true);
  engine.processBlock();
  assert.ok(peak(engine.outputs[4]) > 0, "Direct-only reaches its physical output");
  assert.equal(peak(engine.outputs[63]), 0);

  assert.equal(control.execute({ type: "SET_BUS_OUTPUT", busId: "interview", output: 30 }).ok, true);
  engine.processBlock();
  assert.ok(peak(engine.outputs[4]) > 0, "Hybrid keeps Direct Out active");
  assert.ok(peak(engine.outputs[30]) > 0, "Hybrid keeps BUS output active");
  assert.deepEqual(control.snapshot().buses[0].physicalOutputs, [{ output: 30, gainDb: 0, mute: false }]);
});

test("a BUS output configured through ROUTE cannot bypass the participant Approval Gate", () => {
  const engine = new AudioEngine(48_000, 480, 4);
  const bus = new VcBus("interview", "INTERVIEW", engine.blockSize, engine.sampleRate);
  const participant = new AudioChannel("discord-user:test", "Pending Guest", "DiscordUser", new SineSource(1_000, -6), engine.blockSize, engine.sampleRate);
  participant.vcSends.set(bus.id, { gainDb: 0, mute: false });
  engine.addBus(bus);
  engine.addChannel(participant);
  const control = new ControlPlane(engine);

  assert.equal(control.execute({ type: "SET_BUS_OUTPUT", busId: bus.id, output: 2 }).ok, true);
  engine.processBlock();
  assert.equal(participant.approvalGateOpen, false);
  assert.equal(peak(engine.outputs[2]), 0, "PENDING remains fail closed on the new BUS route");

  participant.approvalGateOpen = true;
  engine.processBlock();
  assert.ok(peak(engine.outputs[2]) > 0, "the same route opens only after approval");
});

test("VC MIX DUAL MONO duplicates one safe bus into an adjacent output pair", () => {
  const engine = new AudioEngine(48_000, 480, 4);
  const bus = new VcBus("interview", "Interview", 480, 48_000);
  const participant = new AudioChannel("guest", "Guest", "TestTone", new SineSource(1_000, -12), 480, 48_000);
  participant.approvalGateOpen = true;
  participant.vcSends.set(bus.id, { gainDb: 0, mute: false });
  engine.addBus(bus);
  engine.addChannel(participant);
  const control = new ControlPlane(engine);

  assert.equal(control.execute({ type: "SET_BUS_OUTPUT", busId: bus.id, output: 0, mode: "DUAL_MONO" }).ok, true);
  engine.processBlock();
  assert.deepEqual(control.snapshot().buses[0].physicalOutputs.map((route) => route.output), [0, 1]);
  assert.deepEqual(engine.outputs[0], engine.outputs[1], "DUAL MONO carries the same VC MIX on both outputs");

  assert.equal(control.execute({ type: "SET_BUS_OUTPUT", busId: bus.id, output: 3, mode: "DUAL_MONO" }).ok, false);
  assert.deepEqual(control.snapshot().buses[0].physicalOutputs.map((route) => route.output), [0, 1], "invalid pair is atomic");
});

test("BUS output structure is locked ON AIR and an Advanced multi-output BUS is not flattened", () => {
  const engine = AudioEngine.createDemo(1);
  const control = new ControlPlane(engine);
  engine.addMatrixRoute({ id: "interview-backup", sourceId: "interview", output: 30, gainDb: -3, mute: false, tap: "POST" });

  const ambiguous = control.execute({ type: "SET_BUS_OUTPUT", busId: "interview", output: 20 });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error ?? "", /Advanced Matrix/);
  assert.equal(engine.matrixRoutes.get("interview-program")?.output, 63);
  assert.equal(engine.matrixRoutes.get("interview-backup")?.output, 30);

  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  assert.equal(control.execute({ type: "SET_BUS_OUTPUT", busId: "interview", output: 20 }).ok, false);
  assert.equal(control.execute({ type: "CLEAR_BUS_OUTPUT", busId: "interview" }).ok, false);
  assert.equal(control.execute({ type: "SET_DIRECT_OUTPUT", channelId: "user-01", output: 5, tap: "POST" }).ok, false);
});

test("normal routing rejects physical output collisions and reports existing occupants", () => {
  const engine = new AudioEngine(48_000, 480, 8);
  const first = new AudioChannel("first", "Alice", "TestTone", new SineSource(400, -24), 480, 48_000);
  const second = new AudioChannel("second", "Bob", "TestTone", new SineSource(500, -24), 480, 48_000);
  const bus = new VcBus("interview", "Interview", 480, 48_000);
  engine.addChannel(first);
  engine.addChannel(second);
  engine.addBus(bus);
  const control = new ControlPlane(engine);

  assert.equal(control.execute({ type: "SET_DIRECT_OUTPUT", channelId: first.id, output: 1, tap: "PRE" }).ok, true);
  const directCollision = control.execute({ type: "SET_DIRECT_OUTPUT", channelId: second.id, output: 1, tap: "PRE" });
  assert.equal(directCollision.ok, false);
  assert.equal(directCollision.confirmationRequired, true);
  assert.match(directCollision.error ?? "", /OUT 2.*Alice Direct Out/);
  assert.equal(second.directOutput, undefined);

  const busCollision = control.execute({ type: "SET_BUS_OUTPUT", busId: bus.id, output: 1 });
  assert.equal(busCollision.ok, false);
  assert.match(busCollision.error ?? "", /Alice Direct Out/);
  assert.equal([...engine.matrixRoutes.values()].some((route) => route.sourceId === bus.id), false);

  assert.equal(control.execute({ type: "SET_BUS_OUTPUT", busId: bus.id, output: 2 }).ok, true, "unused output remains available");
  assert.equal(control.execute({ type: "SET_BUS_OUTPUT", busId: bus.id, output: 2 }).ok, true, "idempotent update does not collide with itself");
});

test("intentional Advanced Many-to-One requires both allowCollision and confirmation", () => {
  const engine = new AudioEngine(48_000, 480, 8);
  const matrixBus = new VcBus("matrix-source", "Matrix Source", 480, 48_000);
  const targetBus = new VcBus("target", "Target", 480, 48_000);
  engine.addBus(matrixBus);
  engine.addBus(targetBus);
  engine.addMatrixRoute({ id: "advanced-matrix", sourceId: matrixBus.id, output: 3, gainDb: -6, mute: false, tap: "POST" });
  const control = new ControlPlane(engine);

  assert.equal(control.execute({ type: "SET_BUS_OUTPUT", busId: targetBus.id, output: 3 }).ok, false, "BUS + Matrix collision is rejected");
  assert.equal(control.execute({ type: "SET_BUS_OUTPUT", busId: targetBus.id, output: 3, allowCollision: true }).ok, false, "advanced flag alone is insufficient");
  assert.equal(control.execute({ type: "SET_BUS_OUTPUT", busId: targetBus.id, output: 3, confirmed: true }).ok, false, "confirmation alone is insufficient");
  assert.equal(control.execute({ type: "SET_BUS_OUTPUT", busId: targetBus.id, output: 3, allowCollision: true, confirmed: true }).ok, true);
  assert.equal([...engine.matrixRoutes.values()].filter((route) => route.output === 3).length, 2);
  assert.ok(control.alerts.some((entry) => entry.message === "Intentional output collision confirmed: Output 4"));

  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  assert.equal(control.execute({ type: "SET_BUS_OUTPUT", busId: targetBus.id, output: 4, allowCollision: true, confirmed: true }).ok, false, "confirmation cannot bypass ON AIR structural lock");
});

test("Monitor Out sends CUE pre-fader to selectable MONO or DUAL MONO outputs", () => {
  const engine = new AudioEngine(48_000, 480, 4);
  const channel = new AudioChannel("guest", "Guest", "TestTone", new SineSource(1_000, -12), 480, 48_000);
  channel.faderDb = -90;
  channel.mute = true;
  engine.addChannel(channel);
  const control = new ControlPlane(engine);

  assert.equal(control.execute({ type: "SET_MONITOR_OUTPUT", output: 0 }).ok, true);
  assert.equal(control.execute({ type: "SET_PFL", sourceId: channel.id }).ok, true);
  engine.processBlock();
  assert.ok(peak(engine.outputs[0]) > 0, "PFL is audible before the channel fader and mute");
  assert.deepEqual(engine.outputs[0], engine.outputs[1], "mono CUE is duplicated to the stereo monitor pair");
  assert.equal(control.execute({ type: "SET_DIRECT_OUTPUT", channelId: channel.id, output: 1, tap: "PRE" }).ok, false, "Monitor Out reserves both physical outputs");

  assert.equal(control.execute({ type: "SET_MONITOR_OUTPUT", output: 2, mode: "MONO" }).ok, true);
  engine.processBlock();
  assert.ok(peak(engine.outputs[2]) > 0, "MONO Monitor Out uses its selected output");
  assert.equal(peak(engine.outputs[3]), 0, "MONO Monitor Out does not consume the adjacent output");
  assert.equal(control.snapshot().monitorOutput?.rightOutput, null);
  assert.equal(control.execute({ type: "SET_DIRECT_OUTPUT", channelId: channel.id, output: 3, tap: "PRE" }).ok, true, "adjacent output remains available in MONO mode");

  engine.emergencyMuted = true;
  engine.processBlock();
  assert.equal(peak(engine.outputs[2]), 0, "Emergency Mute also silences Monitor Out");
});

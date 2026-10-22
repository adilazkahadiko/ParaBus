import assert from "node:assert/strict";
import test from "node:test";
import { AudioChannel, AudioEngine, VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";

test("groups sum post-VC PCM, honor both levels of mute, preserve PRE and reject feedback or direct sends", () => {
  const engine = new AudioEngine(48000, 480, 4), control = new ControlPlane(engine);
  for (const id of ["one", "two"]) {
    const channel = new AudioChannel(id, id, "LocalMonoInput", { fill(target) { target.fill(.1); return true; } }, 480, 48000);
    channel.hpfEnabled = false; channel.compressorEnabled = false;
    channel.vcSends.set(id, { gainDb: 0, mute: false });
    const bus = new VcBus(id, id, 480, 48000); bus.compressorEnabled = false;
    engine.addChannel(channel); engine.addBus(bus);
  }
  const create = control.execute({ type: "CREATE_VC_BUS", name: "Red", groupSourceIds: ["one", "two"] });
  assert.equal(create.ok, true);
  const red = engine.buses.get("red")!;
  assert.equal(control.execute({ type: "SET_BUS_OUTPUT", busId: "red", output: 0 }).ok, true);
  engine.emergencyMuted = false; engine.processBlock();
  assert.ok(Math.abs(engine.outputs[0][0] - .2) < 1e-6);
  engine.buses.get("one")!.mute = true; engine.processBlock();
  assert.ok(Math.abs(engine.outputs[0][0] - .1) < 1e-6);
  assert.ok(engine.buses.get("one")!.preMaster[0] > .09, "existing VC PRE recording is independent of VC master mute");
  red.mute = true; engine.processBlock(); assert.equal(engine.outputs[0][0], 0);
  assert.ok(red.preMaster[0] > .09, "group PRE ignores its own master mute, but follows child VC mute");
  red.mute = false; red.masterDb = -6; engine.processBlock();
  assert.ok(Math.abs(engine.outputs[0][0] - .1 * 10 ** (-6 / 20)) < 1e-6);
  engine.emergencyMuted = true; engine.processBlock(); assert.equal(engine.outputs[0][0], 0); assert.equal(red.preMaster[0], 0);
  assert.equal(control.execute({ type: "SET_VC_SEND", channelId: "one", busId: "red", db: 0 }).ok, false);
  assert.equal(control.execute({ type: "SET_GROUP_BUS_SOURCES", busId: "red", sourceBusIds: ["red"] }).ok, false);
  const size = engine.buses.size;
  assert.equal(control.execute({ type: "CREATE_VC_BUS", name: "Nested", groupSourceIds: ["red"] }).ok, false);
  assert.equal(engine.buses.size, size, "invalid create is atomic");
  assert.deepEqual(control.snapshot().buses.find(bus => bus.id === "red")!.groupSourceIds, ["one", "two"]);
  control.state = "ON_AIR";
  assert.equal(control.execute({ type: "SET_GROUP_BUS_SOURCES", busId: "red", sourceBusIds: [] }).ok, false);
  control.state = "SETUP"; engine.removeBus("two"); engine.emergencyMuted = false; engine.processBlock();
  assert.deepEqual(red.groupSourceIds, ["one"]); assert.equal(engine.outputs[0][0], 0, "deleted or muted child cannot leak stale PCM");
});

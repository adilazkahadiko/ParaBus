import assert from "node:assert/strict";
import test from "node:test";
import { AudioChannel, AudioEngine, type SourceProvider, SineSource, VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";

function maxAbs(buffer: Float32Array): number {
  let maximum = 0;
  for (let index = 0; index < buffer.length; index += 1) maximum = Math.max(maximum, Math.abs(buffer[index]));
  return maximum;
}

function allOutputsAreZero(engine: AudioEngine): boolean {
  for (let outputIndex = 0; outputIndex < engine.outputs.length; outputIndex += 1) {
    if (maxAbs(engine.outputs[outputIndex]) !== 0) return false;
  }
  return true;
}

test("public topology Map and Set mutations rebuild the next execution plan", () => {
  const engine = new AudioEngine(48_000, 48, 2);
  const bus = new VcBus("vc", "VC", 48, 48_000);
  const channel = new AudioChannel("guest", "Guest", "TestTone", new SineSource(1_000, -3), 48, 48_000);
  channel.directOutput = { output: 0, tap: "PRE", gainDb: 0, mute: false };
  channel.vcSends.set(bus.id, { gainDb: 0, mute: false }); // attach after this pre-existing send
  engine.buses.set(bus.id, bus);
  engine.channels.set(channel.id, channel);
  engine.processBlock();
  assert.ok(maxAbs(bus.buffer) > 0, "pre-existing send is present in the first plan");

  channel.vcSends.delete(bus.id);
  engine.processBlock();
  assert.equal(maxAbs(bus.buffer), 0, "direct delete is live on the next block");

  channel.vcSends.set(bus.id, { gainDb: 0, mute: false });
  engine.matrixRoutes.set("vc-out", { id: "vc-out", sourceId: bus.id, output: 1, gainDb: 0, mute: false, tap: "POST" });
  engine.processBlock();
  assert.ok(maxAbs(engine.outputs[1]) > 0, "direct Map.set is live on the next block");

  engine.matrixRoutes.clear();
  engine.outputTestTones.add(1);
  engine.processBlock();
  assert.ok(maxAbs(engine.outputs[1]) > 0, "direct Set.add is included in the rebuilt plan");
  engine.outputTestTones.clear();
  engine.processBlock();
  assert.equal(maxAbs(engine.outputs[1]), 0, "direct Set.clear is live on the next block");
});

test("normal callback uses no Map or Set lookup, iterator, or topology rebuild", () => {
  const engine = AudioEngine.createDemo(8);
  engine.processBlock(); // Build and warm every plan before instrumentation.
  let mapGet = 0;
  let mapForEach = 0;
  let mapIterator = 0;
  let setForEach = 0;
  let setIterator = 0;
  const originalMapGet = Map.prototype.get;
  const originalMapForEach = Map.prototype.forEach;
  const originalMapIterator = Map.prototype[Symbol.iterator];
  const originalSetForEach = Set.prototype.forEach;
  const originalSetIterator = Set.prototype[Symbol.iterator];
  Map.prototype.get = function get<K, V>(this: Map<K, V>, key: K): V | undefined {
    mapGet += 1;
    return originalMapGet.call(this, key);
  };
  Map.prototype.forEach = function forEach<K, V>(this: Map<K, V>, callbackfn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    mapForEach += 1;
    return originalMapForEach.call(this, callbackfn, thisArg);
  };
  Map.prototype[Symbol.iterator] = function iterator<K, V>(this: Map<K, V>): MapIterator<[K, V]> {
    mapIterator += 1;
    return originalMapIterator.call(this);
  };
  Set.prototype.forEach = function forEach<T>(this: Set<T>, callbackfn: (value: T, value2: T, set: Set<T>) => void, thisArg?: unknown): void {
    setForEach += 1;
    return originalSetForEach.call(this, callbackfn, thisArg);
  };
  Set.prototype[Symbol.iterator] = function iterator<T>(this: Set<T>): SetIterator<T> {
    setIterator += 1;
    return originalSetIterator.call(this);
  };
  try {
    engine.processBlock();
  } finally {
    Map.prototype.get = originalMapGet;
    Map.prototype.forEach = originalMapForEach;
    Map.prototype[Symbol.iterator] = originalMapIterator;
    Set.prototype.forEach = originalSetForEach;
    Set.prototype[Symbol.iterator] = originalSetIterator;
  }
  assert.deepEqual({ mapGet, mapForEach, mapIterator, setForEach, setIterator }, {
    mapGet: 0,
    mapForEach: 0,
    mapIterator: 0,
    setForEach: 0,
    setIterator: 0,
  });
});

test("nonexistent TopologyMap delete from a source is a no-op, not a callback fault", () => {
  let engine: AudioEngine;
  const source: SourceProvider = {
    fill(target): boolean {
      assert.equal(engine.matrixRoutes.delete("missing"), false);
      target.fill(0.25);
      return true;
    },
  };
  engine = new AudioEngine(48_000, 48, 1);
  const channel = new AudioChannel("no-op", "No-op", "TestTone", source, 48, 48_000);
  channel.directOutput = { output: 0, tap: "PRE", gainDb: 0, mute: false };
  engine.addChannel(channel);
  engine.processBlock();
  assert.ok(maxAbs(engine.outputs[0]) > 0);
  assert.equal(engine.topologyMutationFaults, 0);
});

test("topology mutation after a safe mix fails closed for all outputs and saturates without changing operator state", () => {
  let attemptsRemaining = 1;
  let engine: AudioEngine;
  const source: SourceProvider = {
    fill(target): boolean {
      if (attemptsRemaining > 0) {
        attemptsRemaining -= 1;
        engine.outputTestTones.add(1);
      }
      target.fill(0.25);
      return true;
    },
  };
  engine = new AudioEngine(48_000, 48, 2);
  const safe = new AudioChannel("safe", "Safe", "TestTone", new SineSource(1_000, -3), 48, 48_000);
  safe.directOutput = { output: 0, tap: "PRE", gainDb: 0, mute: false };
  const channel = new AudioChannel("malicious", "Malicious", "TestTone", source, 48, 48_000);
  channel.directOutput = { output: 1, tap: "PRE", gainDb: 0, mute: false };
  engine.addChannel(safe); // insertion order guarantees this mix happens before the attempted mutation
  engine.addChannel(channel);
  const planChannelsBefore = engine.channels.size;
  const tonesBefore = engine.outputTestTones.size;
  const emergencyBefore = engine.emergencyMuted;

  engine.processBlock();
  assert.equal(allOutputsAreZero(engine), true, "faulting block zeros even outputs already mixed earlier in the block");
  assert.equal(engine.topologyMutationFaults, 1);
  assert.equal(new ControlPlane(engine).snapshot().topologyMutationFaults, 1, "fault counter is observable in the RouterSnapshot");
  assert.equal(engine.channels.size, planChannelsBefore, "old graph is retained");
  assert.equal(engine.outputTestTones.size, tonesBefore, "attempted Set mutation is rejected before change");
  assert.equal(engine.emergencyMuted, emergencyBefore, "operator Emergency Mute is not changed");

  engine.processBlock();
  assert.ok(maxAbs(engine.outputs[0]) > 0 && maxAbs(engine.outputs[1]) > 0, "next block recovers with the unchanged plan");
  assert.equal(engine.topologyMutationFaults, 1);

  engine.topologyMutationFaults = Number.MAX_SAFE_INTEGER;
  attemptsRemaining = 1;
  engine.processBlock();
  assert.equal(allOutputsAreZero(engine), true);
  assert.equal(engine.topologyMutationFaults, Number.MAX_SAFE_INTEGER, "fault counter saturates");
  engine.processBlock();
  assert.ok(maxAbs(engine.outputs[0]) > 0 && maxAbs(engine.outputs[1]) > 0, "recovery remains available after a saturated diagnostic counter");
});

test("scene channel reorder is batched and the rebuilt plan and reused loudness value are live next block", () => {
  const engine = AudioEngine.createDemo(2);
  const control = new ControlPlane(engine);
  const sceneId = (control.execute({ type: "SAVE_SCENE", name: "order" }).data as { id: string }).id;
  const reversed = [...engine.channels.values()].reverse();
  engine.setChannelOrder(reversed);
  assert.equal(control.execute({ type: "RECALL_SCENE", sceneId, confirmed: true }).ok, true);
  const firstChannel = engine.channels.get("user-01")!;
  const loudnessValue = firstChannel.loudness.value;
  engine.processBlock();
  assert.deepEqual([...engine.channels.keys()], ["user-01", "user-02"]);
  assert.equal(firstChannel.loudnessValue, loudnessValue, "normal loudness uses its reusable live value");
  assert.ok(firstChannel.outputMeter.peak > 0, "the recalled plan processed audio immediately");
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AudioEngine, PcmRingSource } from "../services/router-core-sim/src/audio-engine.ts";
import { AudioOutputManager } from "../services/router-core-sim/src/audio-output.ts";
import { AudioInputManager } from "../services/router-core-sim/src/audio-input.ts";
import { AsioDuplexStream } from "../services/router-core-sim/src/asio-duplex.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import type { WindowsEndpointSnapshot } from "../packages/shared-types/src/index.ts";

function clearEmergency(control: ControlPlane) {
  return control.execute({ type: "EMERGENCY_MUTE", active: false, confirmed: true, expectedEmergencyEpoch: control.snapshot().emergencyEpoch });
}

class CapturedInputStream extends EventEmitter {
  aborted = false;
  start(): void {}
  abort(): void { this.aborted = true; }
}

function capturedInputDevice(name = "Captured Input") {
  return { id: 9, name, hostAPIName: "Test", maxInputChannels: 2, maxOutputChannels: 0, defaultSampleRate: 48_000 };
}

function inputBackend(streams: CapturedInputStream[], inventory = { devices: [capturedInputDevice()], reads: 0 }) {
  return {
    SampleFormatFloat32: 1,
    getDevices: () => { inventory.reads += 1; return inventory.devices; },
    AudioIO: class { constructor() { const stream = new CapturedInputStream(); streams.push(stream); return stream; } },
  } as never;
}

test("physical capture preserves interleaved frames split at arbitrary byte boundaries", t => {
  const streams: CapturedInputStream[] = [];
  const engine = AudioEngine.createDemo(0);
  // This PCM fixture has no Windows endpoint; Windows presence has separate tests below.
  const input = new AudioInputManager(engine, inputBackend(streams), undefined, null, "linux");
  t.after(() => input.stop());
  input.selectDevice("pa:9", 2);
  const pcm = Buffer.alloc(480 * 2 * 4);
  for (let frame = 0; frame < 480; frame++) {
    pcm.writeFloatLE(frame / 1024, frame * 8);
    pcm.writeFloatLE(-frame / 1024, frame * 8 + 4);
  }
  let offset = 0;
  for (const length of [1, 5, 17, 1024, 2049, pcm.length]) {
    const end = Math.min(pcm.length, offset + length);
    streams[0].emit("data", pcm.subarray(offset, end)); offset = end;
  }
  assert.equal(input.snapshot().framesCaptured, 480);
  for (let channel = 0; channel < 2; channel++) {
    const expected = new Float32Array(480), actual = new Float32Array(480);
    const reference = new PcmRingSource(4800);
    reference.pushFloat32Le(pcm, channel, 2); reference.fill(expected);
    engine.channels.get(`local-input:${channel + 1}`)!.source.fill(actual, engine.sampleRate);
    assert.deepEqual(actual, expected, "fragmentation must not change lanes or PCM");
  }
});

test("ASIO capture uses physical lane count and preserves IN1 across old 16 KiB read boundaries", t => {
  const stream = new CapturedInputStream();
  const backend = { SampleFormatFloat32: 1,
    getDevices: () => [{ ...capturedInputDevice(), hostAPIName: "ASIO", maxInputChannels: 10 }],
    AudioIO: class { constructor() { return stream; } },
  } as never;
  const asio = new AsioDuplexStream(backend);
  const engine = AudioEngine.createDemo(0);
  const input = new AudioInputManager(engine, backend, undefined, null, "win32", asio);
  t.after(() => input.stop());
  input.selectDevice("pa:9", 1);
  const pcm = Buffer.alloc(1200 * 10 * 4);
  for (let frame = 0; frame < 1200; frame++) for (let lane = 0; lane < 10; lane++) pcm.writeFloatLE((lane + 1) / 16, (frame * 10 + lane) * 4);
  for (let offset = 0; offset < pcm.length; offset += 16384) stream.emit("data", pcm.subarray(offset, offset + 16384));
  const result = new Float32Array(1200);
  engine.channels.get("local-input:1")!.source.fill(result, engine.sampleRate);
  assert.ok(result.every(sample => sample === 1 / 16), "no other input lane may leak into IN1");
  assert.equal(input.snapshot().framesCaptured, 1200);
  assert.equal(input.snapshot().captureTiming!.physicalChannelCount, 10);
});

test("physical input diagnostics count shortages and overflow without changing PCM; retain faults and reset on selection", t => {
  let now = 100;
  t.mock.method(performance, "now", () => now);
  const streams: CapturedInputStream[] = [];
  const engine = AudioEngine.createDemo(0);
  const input = new AudioInputManager(engine, inputBackend(streams), undefined, null, "linux");
  t.after(() => input.stop());
  input.selectDevice("pa:9", 1);
  const source = engine.channels.get("local-input:1")!.source;
  const actual = new Float32Array(480), expected = new Float32Array(480);
  const reference = new PcmRingSource(4800);
  source.fill(actual, engine.sampleRate); // Starting before the first capture is not an underrun.
  const pcm = Buffer.alloc(480 * 4);
  for (let i = 0; i < 480; i++) pcm.writeFloatLE(i / 1024, i * 4);
  const push = () => { now += 10; streams[0].emit("data", pcm); reference.pushFloat32Le(pcm); };
  const fill = () => { source.fill(actual, engine.sampleRate); reference.fill(expected); assert.deepEqual(actual, expected); };
  push(); fill(); fill(); // One real shortage.
  now += 80;
  for (let block = 0; block < 12; block++) push();
  fill();
  const timing = input.snapshot().captureTiming!;
  assert.equal(timing.physicalChannelCount, 1);
  assert.equal(timing.packets, 13);
  assert.equal(timing.maxPacketGapMs, 90);
  assert.equal(timing.minPacketBytes, 1920);
  assert.equal(timing.maxPacketBytes, 1920);
  assert.equal(timing.channels[0].underruns, 1);
  assert.equal(timing.channels[0].missingFrames, 480);
  assert.equal(timing.channels[0].droppedFrames, 960);
  assert.equal(timing.channels[0].maxQueuedFrames, 4800);
  assert.equal(timing.channels[0].queuedFrames, 4320);
  input.failClosed("test capture fault");
  assert.equal(input.snapshot().captureTiming!.channels[0].underruns, 1);
  assert.equal(input.snapshot().captureTiming!.channels[0].queuedFrames, 0);
  const elapsed = input.snapshot().captureTiming!.elapsedMs;
  now += 1000;
  assert.equal(input.snapshot().captureTiming!.elapsedMs, elapsed, "stopped capture duration stays fixed");
  input.selectDevice("pa:9", 1);
  assert.equal(input.snapshot().captureTiming!.packets, 0);
  assert.equal(input.snapshot().captureTiming!.channels[0].underruns, 0);
  input.selectDevice("mock-studio-8", 1);
  assert.equal(input.snapshot().captureTiming, null);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not reached before timeout");
}

class FakeWindowsPresence {
  available = true;
  reads = 0;
  endpoints: WindowsEndpointSnapshot[] = [{ id: "capture-a", name: "EVO4 Microphone", direction: "capture", state: "ACTIVE" }];
  isAvailable() { return this.available; }
  cachedEndpoint(id: string, direction: "render" | "capture") {
    return this.endpoints.find((endpoint) => endpoint.id === id && endpoint.direction === direction) ?? null;
  }
  async refreshEndpoints() {
    this.reads += 1;
    return this.endpoints.map((endpoint) => ({ ...endpoint }));
  }
}

test("explicit Studio input selection creates local mono sources", () => {
  const engine = AudioEngine.createDemo(1);
  const input = new AudioInputManager(engine, null);
  const control = new ControlPlane(engine, undefined, undefined, input);
  assert.equal(input.snapshot().state, "UNSELECTED");
  const result = control.execute({ type: "SELECT_INPUT_DEVICE", deviceId: "mock-studio-8", channelCount: 2 });
  assert.equal(result.ok, true);
  assert.equal(input.snapshot().activeChannelCount, 2);
  assert.equal(engine.channels.get("local-input:1")?.kind, "LocalMonoInput");
  engine.processBlock();
  assert.ok(engine.channels.get("local-input:1")!.inputMeter.peak > 0);
  input.stop();
  assert.equal(engine.channels.has("local-input:1"), false);
});

test("Studio input device is structural and locks outside SETUP", () => {
  const engine = AudioEngine.createDemo(1);
  const input = new AudioInputManager(engine, null);
  const control = new ControlPlane(engine, undefined, undefined, input);
  control.execute({ type: "SET_STATE", state: "READY" });
  const denied = control.execute({ type: "SELECT_INPUT_DEVICE", deviceId: "mock-studio-8", channelCount: 2 });
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? "", /SETUP/);
});

test("input loss clears its ring, latches FAULT, and requires explicit recovery before release", () => {
  const streams: CapturedInputStream[] = [];
  const provider = new FakeWindowsPresence();
  const engine = AudioEngine.createDemo(0);
  const input = new AudioInputManager(engine, inputBackend(streams), undefined, provider, "win32");
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, null);
  const control = new ControlPlane(engine, output, undefined, input);
  assert.equal(control.execute({ type: "SELECT_INPUT_DEVICE", deviceId: "pa:9", channelCount: 1, windowsEndpointId: "capture-a" }).ok, true);
  const channel = engine.channels.get("local-input:1")!;
  channel.directOutput = { output: 0, tap: "PRE", gainDb: 0, mute: false };
  const ring = channel.source as PcmRingSource;
  assert.equal(ring.capacity, engine.blockSize * 10, "physical capture latency is bounded to ten graph blocks");
  const pcm = Buffer.alloc(engine.blockSize * 4);
  for (let offset = 0; offset < pcm.length; offset += 4) pcm.writeFloatLE(0.5, offset);
  streams[0].emit("data", pcm);
  assert.equal(ring.queuedSamples, engine.blockSize);

  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, true);
  assert.equal(control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true }).ok, true);
  const lost = control.execute({ type: "INPUT_DEVICE_LOST", deviceId: "Captured Input" });
  assert.equal(lost.ok, true);
  assert.equal(control.state, "FAULT");
  assert.equal(control.engine.emergencyMuted, true);
  assert.equal(input.snapshot().state, "FAULT");
  assert.equal(ring.queuedSamples, 0);
  assert.equal(streams[0].aborted, true);
  assert.equal(engine.channels.has("local-input:1"), false);
  engine.processBlock();
  assert.ok(engine.outputs[0].every((sample) => sample === 0));

  assert.equal(control.execute({ type: "ACKNOWLEDGE_FAULT", confirmed: true }).ok, true);
  input.refreshDevices();
  assert.equal(input.snapshot().state, "FAULT", "device enumeration cannot auto-recover the latched input");
  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, false);
  assert.equal(clearEmergency(control).ok, false);
  assert.equal(control.execute({ type: "SELECT_INPUT_DEVICE", deviceId: "pa:9", channelCount: 1, windowsEndpointId: "capture-a" }).ok, true);
  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "mock-64" }).ok, true);
  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, true);
  assert.equal(control.engine.emergencyMuted, true);
  assert.equal(clearEmergency(control).ok, true);
});

test("stale input stream error and close cannot fault a recovered stream", () => {
  const streams: CapturedInputStream[] = [];
  const provider = new FakeWindowsPresence();
  const engine = AudioEngine.createDemo(0);
  const input = new AudioInputManager(engine, inputBackend(streams), undefined, provider, "win32");
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, null);
  const control = new ControlPlane(engine, output, undefined, input);
  input.onFault = (deviceId, message) => { control.execute({ type: "INPUT_DEVICE_LOST", deviceId: `${deviceId}: ${message}` }); };

  assert.equal(control.execute({ type: "SELECT_INPUT_DEVICE", deviceId: "pa:9", channelCount: 1, windowsEndpointId: "capture-a" }).ok, true);
  const first = streams[0];
  first.emit("error", new Error("first input failed"));
  assert.equal(control.state, "FAULT");
  assert.equal(control.execute({ type: "ACKNOWLEDGE_FAULT", confirmed: true }).ok, true);
  assert.equal(control.execute({ type: "SELECT_INPUT_DEVICE", deviceId: "pa:9", channelCount: 1, windowsEndpointId: "capture-a" }).ok, true);
  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "mock-64" }).ok, true);
  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, true);
  const second = streams[1];

  first.emit("error", new Error("late first input error"));
  first.emit("close");
  assert.equal(input.snapshot().state, "READY");
  assert.equal(control.state, "READY");
  assert.equal(control.engine.emergencyMuted, true, "stream recovery never clears Emergency Mute");

  second.emit("error", new Error("current input failed"));
  assert.equal(input.snapshot().state, "FAULT");
  assert.equal(control.state, "FAULT");
  assert.equal(control.execute({ type: "ACKNOWLEDGE_FAULT", confirmed: true }).ok, true);
  assert.equal(control.execute({ type: "SELECT_INPUT_DEVICE", deviceId: "pa:9", channelCount: 1, windowsEndpointId: "capture-a" }).ok, true);
  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "mock-64" }).ok, true);
  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, true);
  streams[2].emit("close");
  assert.equal(input.snapshot().state, "FAULT", "current stream close still fails closed");
  assert.equal(control.state, "FAULT");
  assert.equal(control.engine.emergencyMuted, true);
});

test("input presence monitor fails closed, clears captured PCM, and never auto-resumes", async () => {
  const streams: CapturedInputStream[] = [];
  const provider = new FakeWindowsPresence();
  const engine = AudioEngine.createDemo(0);
  const input = new AudioInputManager(engine, inputBackend(streams), 10, provider, "win32");
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, null);
  const control = new ControlPlane(engine, output, undefined, input);
  input.onFault = (deviceId, message) => { control.execute({ type: "INPUT_DEVICE_LOST", deviceId: `${deviceId}: ${message}` }); };

  assert.equal(control.execute({ type: "SELECT_INPUT_DEVICE", deviceId: "pa:9", channelCount: 1, windowsEndpointId: "capture-a" }).ok, true);
  const channel = engine.channels.get("local-input:1")!;
  const ring = channel.source as PcmRingSource;
  const pcm = Buffer.alloc(engine.blockSize * 4);
  for (let offset = 0; offset < pcm.length; offset += 4) pcm.writeFloatLE(0.5, offset);
  streams[0].emit("data", pcm);
  assert.equal(ring.queuedSamples, engine.blockSize);
  await waitFor(() => provider.reads >= 2);
  assert.equal(input.snapshot().state, "READY", "a present selected input remains READY");

  provider.endpoints = [];
  await waitFor(() => input.snapshot().state === "FAULT");
  const failed = input.snapshot();
  assert.equal(control.state, "FAULT");
  assert.equal(control.engine.emergencyMuted, true);
  assert.equal(failed.activeChannelCount, 0);
  assert.equal(failed.selectedDeviceId, "pa:9");
  assert.equal(ring.queuedSamples, 0);
  assert.equal(streams[0].aborted, true);
  assert.equal(engine.channels.has("local-input:1"), false);

  provider.endpoints = [{ id: "capture-a", name: "EVO4 Microphone", direction: "capture", state: "ACTIVE" }];
  const streamCount = streams.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(input.snapshot().state, "FAULT", "device reappearance cannot clear the input fault");
  assert.equal(streams.length, streamCount, "device reappearance cannot reopen the input stream");
  assert.equal(control.engine.emergencyMuted, true);
  input.stop();
});

test("Windows input requires explicit active capture binding and fails closed from MMDevice presence", async () => {
  const streams: CapturedInputStream[] = [];
  const provider = new FakeWindowsPresence();
  const engine = AudioEngine.createDemo(0);
  const input = new AudioInputManager(engine, inputBackend(streams), 10, provider, "win32");
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, null);
  const control = new ControlPlane(engine, output, undefined, input);
  input.onFault = (deviceId, message) => { control.execute({ type: "INPUT_DEVICE_LOST", deviceId: `${deviceId}: ${message}` }); };

  assert.equal(control.execute({ type: "SELECT_INPUT_DEVICE", deviceId: "pa:9", channelCount: 1 }).ok, false);
  assert.equal(control.execute({ type: "SELECT_INPUT_DEVICE", deviceId: "pa:9", channelCount: 1, windowsEndpointId: "capture-a" }).ok, true);
  const ring = engine.channels.get("local-input:1")?.source as PcmRingSource;
  const pcm = Buffer.alloc(engine.blockSize * 4);
  for (let offset = 0; offset < pcm.length; offset += 4) pcm.writeFloatLE(0.5, offset);
  streams[0].emit("data", pcm);
  assert.equal(ring.queuedSamples, engine.blockSize);
  await waitFor(() => provider.reads > 0);
  assert.equal(input.presenceMonitoringReady(), true);

  provider.endpoints = [];
  await waitFor(() => input.snapshot().state === "FAULT");
  assert.equal(control.state, "FAULT");
  assert.equal(control.engine.emergencyMuted, true);
  assert.equal(input.snapshot().activeChannelCount, 0);
  assert.equal(input.snapshot().selectedDeviceId, "pa:9");
  assert.equal(input.snapshot().windowsEndpointBinding?.endpointId, "capture-a");
  assert.equal(input.snapshot().windowsEndpointBinding?.state, "NOT_PRESENT");
  assert.equal(ring.queuedSamples, 0);
  assert.equal(streams[0].aborted, true);

  provider.endpoints = [{ id: "capture-a", name: "EVO4 Microphone", direction: "capture", state: "ACTIVE" }];
  const readsAfterFault = provider.reads;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(input.snapshot().state, "FAULT");
  assert.equal(control.engine.emergencyMuted, true);
  assert.equal(provider.reads, readsAfterFault, "fault cleanup stops the Windows presence monitor");
});

test("Windows ASIO input opens without an MMDevice binding", () => {
  const streams: CapturedInputStream[] = [];
  const inventory = { devices: [{ ...capturedInputDevice("Waves SoundGrid ASIO"), hostAPIName: "ASIO", maxInputChannels: 64 }], reads: 0 };
  const engine = AudioEngine.createDemo(0);
  const backend = inputBackend(streams, inventory);
  const input = new AudioInputManager(engine, backend, undefined, null, "win32", new AsioDuplexStream(backend));
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, null);
  const control = new ControlPlane(engine, output, undefined, input);

  assert.equal(control.execute({ type: "SELECT_INPUT_DEVICE", deviceId: "pa:9", channelCount: 64 }).ok, true);
  assert.equal(input.snapshot().activeChannelCount, 8);
  assert.equal(input.snapshot().windowsEndpointBinding, null);
  assert.equal(input.presenceMonitoringReady(), true);
  const pcm = Buffer.alloc(64 * 4);
  pcm.writeFloatLE(0.5, 0);
  streams[0].emit("data", pcm);
  assert.equal((engine.channels.get("local-input:1")?.source as PcmRingSource).queuedSamples, 1, "8 selected inputs read the first channels from the 64ch ASIO stream");
  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, true);
  input.stop();
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { AudioOutputManager } from "../services/router-core-sim/src/audio-output.ts";
import { AsioDuplexStream } from "../services/router-core-sim/src/asio-duplex.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import type { WindowsEndpointSnapshot } from "../packages/shared-types/src/index.ts";

function clearEmergency(control: ControlPlane) {
  return control.execute({ type: "EMERGENCY_MUTE", active: false, confirmed: true, expectedEmergencyEpoch: control.snapshot().emergencyEpoch });
}

class BackpressuredOutputStream extends EventEmitter {
  aborted = false;
  readonly pending: Array<() => void> = [];
  readonly callbacks: Array<() => void> = [];
  start(): void {}
  abort(): void { this.aborted = true; this.pending.length = 0; }
  write(_buffer: Buffer, callback: () => void): boolean {
    this.pending.push(callback);
    this.callbacks.push(callback);
    return false;
  }
}

function capturedOutputDevice(name = "Backpressured Output") {
  return { id: 7, name, hostAPIName: "Test", maxInputChannels: 0, maxOutputChannels: 2, defaultSampleRate: 48_000 };
}

function outputBackend(streams: BackpressuredOutputStream[], inventory = { devices: [capturedOutputDevice()], reads: 0 }) {
  return {
    SampleFormatFloat32: 1,
    getDevices: () => { inventory.reads += 1; return inventory.devices; },
    AudioIO: class { constructor() { const stream = new BackpressuredOutputStream(); streams.push(stream); return stream; } },
  } as never;
}

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
  endpoints: WindowsEndpointSnapshot[] = [{ id: "render-a", name: "EVO4 Speakers", direction: "render", state: "ACTIVE" }];
  deferred: Promise<WindowsEndpointSnapshot[]> | null = null;
  isAvailable() { return this.available; }
  cachedEndpoint(id: string, direction: "render" | "capture") {
    return this.endpoints.find((endpoint) => endpoint.id === id && endpoint.direction === direction) ?? null;
  }
  async refreshEndpoints() {
    this.reads += 1;
    return this.deferred ? this.deferred : this.endpoints.map((endpoint) => ({ ...endpoint }));
  }
}

test("mock 64ch output consumes engine blocks without backpressure", () => {
  const engine = AudioEngine.createDemo(2);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, null);
  engine.processBlock();
  output.writeBlock(engine.outputs);
  const snapshot = output.snapshot();
  assert.equal(snapshot.selectedDeviceId, "mock-64");
  assert.equal(snapshot.activeChannelCount, 64);
  assert.equal(snapshot.framesWritten, 480);
  assert.equal(snapshot.backpressureDrops, 0);
  assert.ok(snapshot.peak > 0);
});

test("direct output mapping is controlled explicitly with PRE or POST", () => {
  const engine = AudioEngine.createDemo(1);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, null);
  const control = new ControlPlane(engine, output);
  assert.equal(control.execute({ type: "SET_DIRECT_OUTPUT", channelId: "user-01", output: 7, tap: "POST", gainDb: -3 }).ok, true);
  assert.deepEqual(engine.channels.get("user-01")?.directOutput, { output: 7, tap: "POST", gainDb: -3, mute: false });
  assert.equal(control.execute({ type: "CLEAR_DIRECT_OUTPUT", channelId: "user-01" }).ok, true);
  assert.equal(engine.channels.get("user-01")?.directOutput, undefined);
});

test("independent WASAPI Cue faults without stopping Main output", () => {
  const streams: BackpressuredOutputStream[] = [];
  const provider = new FakeWindowsPresence();
  const inventory = { devices: [{ ...capturedOutputDevice("Laptop Headphones"), hostAPIName: "Windows WASAPI" }], reads: 0 };
  const engine = AudioEngine.createDemo(1);
  const main = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, null);
  const cue = new AudioOutputManager(engine.sampleRate, engine.blockSize, 2, outputBackend(streams, inventory), undefined, provider, "win32");
  const control = new ControlPlane(engine, main, undefined, undefined, undefined, undefined, undefined, cue);

  assert.equal(control.execute({ type: "SELECT_CUE_OUTPUT_DEVICE", deviceId: "pa:7", windowsEndpointId: "render-a" }).ok, true);
  const duplicateMain = control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "pa:7", windowsEndpointId: "render-a" });
  assert.equal(duplicateMain.ok, false);
  assert.match(duplicateMain.error ?? "", /同じ物理デバイス/);
  assert.equal(control.execute({ type: "SET_MONITOR_OUTPUT", output: 0 }).ok, false, "independent Cue cannot also be routed through Main outputs");
  cue.onFault = () => control.recordExternalEvent("WARNING", "Cue output disconnected; Main output remains active");
  streams[0].emit("error", new Error("headphone unplugged"));

  assert.equal(cue.snapshot().state, "FAULT");
  assert.equal(main.snapshot().state, "READY");
  assert.equal(control.state, "SETUP");
  assert.equal(control.engine.emergencyMuted, false);
  assert.match(control.snapshot().alerts[0]?.message ?? "", /Main output remains active/);
});

test("mapping and output test tones are locked while ON AIR", () => {
  const engine = AudioEngine.createDemo(1);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, null);
  const control = new ControlPlane(engine, output);
  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  assert.equal(control.execute({ type: "SET_DIRECT_OUTPUT", channelId: "user-01", output: 1, tap: "PRE" }).ok, false);
  assert.equal(control.execute({ type: "SET_OUTPUT_TEST_TONE", output: 1, active: true }).ok, false);
});

test("output test tone is routed to one channel and obeys emergency mute", () => {
  const engine = AudioEngine.createDemo(0);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, null);
  const control = new ControlPlane(engine, output);
  assert.equal(control.execute({ type: "SET_OUTPUT_TEST_TONE", output: 3, active: true }).ok, true);
  engine.processBlock();
  assert.ok(engine.outputs[3].some((sample) => Math.abs(sample) > 0.01));
  assert.ok(engine.outputs[2].every((sample) => sample === 0));
  control.execute({ type: "EMERGENCY_MUTE", active: true });
  engine.processBlock();
  assert.ok(engine.outputs[3].every((sample) => sample === 0));
});

test("output test tone permits only one physical channel at a time", () => {
  const engine = AudioEngine.createDemo(0);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, null);
  const control = new ControlPlane(engine, output);
  assert.equal(control.execute({ type: "SET_OUTPUT_TEST_TONE", output: 1, active: true }).ok, true);
  assert.equal(control.execute({ type: "SET_OUTPUT_TEST_TONE", output: 2, active: true }).ok, true);
  assert.deepEqual([...engine.outputTestTones], [2]);
});

test("unknown output device never triggers an automatic fallback", () => {
  const engine = AudioEngine.createDemo(0);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, null);
  const control = new ControlPlane(engine, output);
  const result = control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "missing-device" });
  assert.equal(result.ok, false);
  assert.equal(output.snapshot().selectedDeviceId, "mock-64");
});

test("Emergency Mute aborts queued physical output and stale callbacks cannot repopulate the next stream", () => {
  const streams: BackpressuredOutputStream[] = [];
  const provider = new FakeWindowsPresence();
  const engine = AudioEngine.createDemo(1);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, outputBackend(streams), undefined, provider, "win32");
  const control = new ControlPlane(engine, output);
  output.selectDevice("pa:7", "render-a");
  engine.processBlock();
  for (let index = 0; index < 8; index += 1) output.writeBlock(engine.outputs);
  assert.equal(streams[0].pending.length, 8, "test backend intentionally holds every PortAudio block");

  assert.equal(control.execute({ type: "EMERGENCY_MUTE", active: true }).ok, true);
  assert.equal(streams[0].aborted, true);
  assert.equal(streams[0].pending.length, 0, "abort flushes backend-owned pending blocks");
  assert.equal(output.snapshot().state, "STOPPED");
  assert.equal(clearEmergency(control).ok, false);

  output.selectDevice("pa:7", "render-a");
  for (const callback of streams[0].callbacks) callback();
  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, true);
  assert.equal(clearEmergency(control).ok, true);
  engine.processBlock();
  for (let index = 0; index < 9; index += 1) output.writeBlock(engine.outputs);
  assert.equal(output.snapshot().backpressureDrops, 1, "callbacks from the aborted stream cannot add stale buffers to the new pool");
});

test("stale output stream error and close cannot fault a recovered stream", () => {
  const streams: BackpressuredOutputStream[] = [];
  const provider = new FakeWindowsPresence();
  const engine = AudioEngine.createDemo(0);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, outputBackend(streams), undefined, provider, "win32");
  const control = new ControlPlane(engine, output);
  output.onFault = (deviceId, message) => { control.execute({ type: "DEVICE_LOST", deviceId: `${deviceId}: ${message}` }); };

  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "pa:7", windowsEndpointId: "render-a" }).ok, true);
  const first = streams[0];
  first.emit("error", new Error("first output failed"));
  assert.equal(control.state, "FAULT");
  assert.equal(control.execute({ type: "ACKNOWLEDGE_FAULT", confirmed: true }).ok, true);
  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "pa:7", windowsEndpointId: "render-a" }).ok, true);
  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, true);
  const second = streams[1];

  first.emit("error", new Error("late first output error"));
  first.emit("close");
  assert.equal(output.snapshot().state, "READY");
  assert.equal(control.state, "READY");
  assert.equal(control.engine.emergencyMuted, true, "stream recovery never clears Emergency Mute");

  second.emit("error", new Error("current output failed"));
  assert.equal(output.snapshot().state, "FAULT");
  assert.equal(control.state, "FAULT");
  assert.equal(control.execute({ type: "ACKNOWLEDGE_FAULT", confirmed: true }).ok, true);
  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "pa:7", windowsEndpointId: "render-a" }).ok, true);
  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, true);
  streams[2].emit("close");
  assert.equal(output.snapshot().state, "FAULT", "current stream close still fails closed");
  assert.equal(control.state, "FAULT");
  assert.equal(control.engine.emergencyMuted, true);
});

test("output presence monitor fails closed when the selected device disappears and never auto-resumes", async () => {
  const streams: BackpressuredOutputStream[] = [];
  const provider = new FakeWindowsPresence();
  const engine = AudioEngine.createDemo(0);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, outputBackend(streams), 10, provider, "win32");
  const control = new ControlPlane(engine, output);
  output.onFault = (deviceId, message) => { control.execute({ type: "DEVICE_LOST", deviceId: `${deviceId}: ${message}` }); };

  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "pa:7", windowsEndpointId: "render-a" }).ok, true);
  await waitFor(() => provider.reads >= 2);
  assert.equal(output.snapshot().state, "READY", "a present selected output remains READY");

  provider.endpoints = [];
  await waitFor(() => output.snapshot().state === "FAULT");
  const failed = output.snapshot();
  assert.equal(control.state, "FAULT");
  assert.equal(control.engine.emergencyMuted, true);
  assert.equal(failed.activeChannelCount, 0);
  assert.equal(failed.selectedDeviceId, "pa:7");
  assert.equal(failed.selectedDeviceName, "Backpressured Output");
  assert.equal(streams[0].aborted, true);
  assert.notEqual(failed.selectedDeviceId, "mock-64", "presence loss never selects a fallback");

  provider.endpoints = [{ id: "render-a", name: "EVO4 Speakers", direction: "render", state: "ACTIVE" }];
  const streamCount = streams.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(output.snapshot().state, "FAULT", "device reappearance cannot clear the output fault");
  assert.equal(streams.length, streamCount, "device reappearance cannot reopen the output stream");
  assert.equal(control.engine.emergencyMuted, true);
  output.stop();
});

test("output presence monitor rejects a reused PortAudio index and cleans up old generations", async () => {
  const streams: BackpressuredOutputStream[] = [];
  const inventory = { devices: [capturedOutputDevice()], reads: 0 };
  const provider = new FakeWindowsPresence();
  const engine = AudioEngine.createDemo(0);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, outputBackend(streams, inventory), 10, provider, "win32");
  const control = new ControlPlane(engine, output);
  output.onFault = (deviceId, message) => { control.execute({ type: "DEVICE_LOST", deviceId: `${deviceId}: ${message}` }); };

  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "pa:7", windowsEndpointId: "render-a" }).ok, true);
  await waitFor(() => provider.reads >= 2);
  inventory.devices = [capturedOutputDevice("Different Device At Reused Index")];
  provider.endpoints = [{ id: "render-b", name: "Different Device", direction: "render", state: "ACTIVE" }];
  await waitFor(() => output.snapshot().state === "FAULT");
  assert.equal(output.snapshot().selectedDeviceName, "Backpressured Output", "the reused index is not accepted as the selected device");

  assert.equal(control.execute({ type: "ACKNOWLEDGE_FAULT", confirmed: true }).ok, true);
  provider.endpoints = [{ id: "render-a", name: "EVO4 Speakers", direction: "render", state: "ACTIVE" }];
  output.refreshDevices();
  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "pa:7", windowsEndpointId: "render-a" }).ok, true);
  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, true);
  await waitFor(() => provider.reads >= 4);
  assert.equal(output.snapshot().state, "READY", "old-generation presence work cannot fault the replacement stream");
  assert.equal(control.engine.emergencyMuted, true, "recovery never clears Emergency Mute");

  output.stop();
  const readsAfterStop = provider.reads;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(provider.reads, readsAfterStop, "shutdown removes the presence monitor");
});

test("Windows output requires explicit active render binding and fails closed from MMDevice presence", async () => {
  const streams: BackpressuredOutputStream[] = [];
  const provider = new FakeWindowsPresence();
  const engine = AudioEngine.createDemo(0);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, outputBackend(streams), 10, provider, "win32");
  const control = new ControlPlane(engine, output);
  output.onFault = (deviceId, message) => { control.execute({ type: "DEVICE_LOST", deviceId: `${deviceId}: ${message}` }); };

  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "pa:7" }).ok, false, "unbound physical output is never monitored or opened");
  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "pa:7", windowsEndpointId: "render-a" }).ok, true);
  assert.equal(output.snapshot().windowsEndpointBinding?.endpointId, "render-a");
  assert.equal(output.presenceMonitoringReady(), true);
  await waitFor(() => provider.reads > 0);
  assert.equal(output.snapshot().state, "READY");

  provider.endpoints = [{ id: "render-a", name: "EVO4 Speakers", direction: "render", state: "DISABLED" }];
  await waitFor(() => output.snapshot().state === "FAULT");
  assert.equal(control.state, "FAULT");
  assert.equal(control.engine.emergencyMuted, true);
  assert.equal(output.snapshot().activeChannelCount, 0);
  assert.equal(output.snapshot().selectedDeviceId, "pa:7");
  assert.equal(output.snapshot().windowsEndpointBinding?.state, "DISABLED");
  assert.equal(streams[0].aborted, true);

  provider.endpoints = [{ id: "render-a", name: "EVO4 Speakers", direction: "render", state: "ACTIVE" }];
  const readsAfterFault = provider.reads;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(output.snapshot().state, "FAULT", "endpoint reappearance cannot resume output");
  assert.equal(control.engine.emergencyMuted, true);
  assert.equal(provider.reads, readsAfterFault, "fault cleanup stops the Windows presence monitor");
});

test("Windows ASIO output opens without an MMDevice binding", () => {
  const streams: BackpressuredOutputStream[] = [];
  const inventory = { devices: [{ ...capturedOutputDevice("Waves SoundGrid ASIO"), hostAPIName: "ASIO", maxOutputChannels: 64 }], reads: 0 };
  const engine = AudioEngine.createDemo(0);
  const backend = outputBackend(streams, inventory);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, backend, undefined, null, "win32", new AsioDuplexStream(backend));
  const control = new ControlPlane(engine, output);

  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "pa:7" }).ok, true);
  assert.equal(output.snapshot().activeChannelCount, 64);
  assert.equal(output.snapshot().windowsEndpointBinding, null);
  assert.equal(output.snapshot().writeTiming, null, "ASIO output is outside WASAPI timing instrumentation");
  assert.equal(output.presenceMonitoringReady(), true);
  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, true);
  output.stop();
});

test("switching ASIO drivers requires restart without stopping the active output", () => {
  const streams: BackpressuredOutputStream[] = [];
  const inventory = {
    devices: [
      { ...capturedOutputDevice("Waves SoundGrid ASIO"), hostAPIName: "ASIO", maxOutputChannels: 64 },
      { ...capturedOutputDevice("Audient USB Audio ASIO Driver"), id: 8, hostAPIName: "ASIO", maxOutputChannels: 4 },
    ],
    reads: 0,
  };
  const engine = AudioEngine.createDemo(0);
  const backend = outputBackend(streams, inventory);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, backend, undefined, null, "win32", new AsioDuplexStream(backend));

  output.selectDevice("pa:7");
  assert.throws(() => output.selectDevice("pa:8"), /アプリを再起動/);
  assert.equal(output.snapshot().selectedDeviceId, "pa:7");
  assert.equal(output.snapshot().state, "READY");
  assert.equal(streams[0].aborted, false);
  output.stop();
});

test("Windows output treats a different endpoint at the same PortAudio index as device loss", async () => {
  const streams: BackpressuredOutputStream[] = [];
  const provider = new FakeWindowsPresence();
  const engine = AudioEngine.createDemo(0);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, outputBackend(streams), 10, provider, "win32");
  const control = new ControlPlane(engine, output);
  output.onFault = (deviceId, message) => { control.execute({ type: "DEVICE_LOST", deviceId: `${deviceId}: ${message}` }); };

  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "pa:7", windowsEndpointId: "render-a" }).ok, true);
  await waitFor(() => provider.reads > 0);
  provider.endpoints = [{ id: "render-b", name: "Different Device", direction: "render", state: "ACTIVE" }];
  await waitFor(() => output.snapshot().state === "FAULT");
  assert.equal(output.snapshot().windowsEndpointBinding?.endpointId, "render-a");
  assert.equal(output.snapshot().windowsEndpointBinding?.state, "NOT_PRESENT");
});

test("stale Windows inventory response cannot fault a replacement output generation", async () => {
  const streams: BackpressuredOutputStream[] = [];
  const provider = new FakeWindowsPresence();
  let releaseOld!: (endpoints: WindowsEndpointSnapshot[]) => void;
  provider.deferred = new Promise((resolve) => { releaseOld = resolve; });
  const engine = AudioEngine.createDemo(0);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, outputBackend(streams), 1_000, provider, "win32");
  const control = new ControlPlane(engine, output);
  output.onFault = (deviceId, message) => { control.execute({ type: "DEVICE_LOST", deviceId: `${deviceId}: ${message}` }); };

  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "pa:7", windowsEndpointId: "render-a" }).ok, true);
  await waitFor(() => provider.reads === 1);
  output.stop();
  provider.deferred = null;
  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "pa:7", windowsEndpointId: "render-a" }).ok, true);
  releaseOld([]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(output.snapshot().state, "READY");
  output.stop();
});

test("Windows output provider availability is required before READY and ON AIR", () => {
  const streams: BackpressuredOutputStream[] = [];
  const provider = new FakeWindowsPresence();
  const engine = AudioEngine.createDemo(0);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, outputBackend(streams), 10_000, provider, "win32");
  const control = new ControlPlane(engine, output);
  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "pa:7", windowsEndpointId: "render-a" }).ok, true);
  provider.available = false;
  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, false);
  assert.equal(control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true }).ok, false);
  output.stop();
});

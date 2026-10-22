import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AsioDuplexStream } from "../services/router-core-sim/src/asio-duplex.ts";
import { AudioOutputManager } from "../services/router-core-sim/src/audio-output.ts";
import { AudioInputManager } from "../services/router-core-sim/src/audio-input.ts";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";

for (const fault of [false, true]) test(`ASIO ${fault ? "device fault" : "emergency stop"} aborts queued output even while duplex input is active`, async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const queued: Buffer[] = [], callbacks: Array<() => void> = [];
  let aborted = 0, inputFaults = 0, outputRequests = 0;
  const stream = Object.assign(new EventEmitter(), {
    start() {}, abort() { aborted++; queued.length = 0; },
    write(buffer: Buffer, callback?: () => void) { queued.push(Buffer.from(buffer)); if (callback) callbacks.push(callback); return true; },
  });
  const backend = { SampleFormatFloat32: 1, getDevices: () => [{ id: 7, name: "Test ASIO", hostAPIName: "ASIO", maxInputChannels: 2, maxOutputChannels: 2, defaultSampleRate: 48000 }], AudioIO: class { constructor() { return stream; } } } as never;
  const asio = new AsioDuplexStream(backend);
  const engine = new AudioEngine(48000, 480, 2);
  const input = new AudioInputManager(engine, backend, undefined, null, "win32", asio);
  const output = new AudioOutputManager(48000, 480, 2, backend, undefined, null, "win32", asio);
  const control = new ControlPlane(engine, output, undefined, input);
  input.onFault = (deviceId) => { inputFaults++; control.execute({ type: "INPUT_DEVICE_LOST", deviceId }); };
  output.onFault = (deviceId) => { control.execute({ type: "DEVICE_LOST", deviceId }); };
  t.after(() => { output.stop(); input.stop(); });
  asio.onOutputReady = () => { outputRequests++; };
  input.selectDevice("pa:7", 2);
  output.selectDevice("pa:7");
  output.writeBlock([new Float32Array(480).fill(0.5), new Float32Array(480).fill(0.5)]);
  assert.ok(queued.some(buffer => buffer.some(byte => byte !== 0)));
  assert.equal(control.execute(fault ? { type: "DEVICE_LOST", deviceId: "pa:7" } : { type: "EMERGENCY_MUTE", active: true }).ok, true);
  assert.equal(output.snapshot().state, fault ? "FAULT" : "STOPPED");
  assert.equal(input.snapshot().state, "FAULT");
  assert.equal(engine.emergencyMuted, true);
  assert.equal(aborted, 1, "queued audio must be aborted, not followed with silence");
  assert.equal(queued.length, 0);
  assert.equal(inputFaults, 1, "the shared input must no longer report READY");
  const requests = outputRequests;
  for (const callback of callbacks) callback();
  t.mock.timers.tick(100); await Promise.resolve();
  assert.equal(outputRequests, requests); assert.equal(queued.length, 0);
  assert.equal(asio.outputClockActive(), false);
  output.writeBlock([new Float32Array(480).fill(0.5)]); assert.equal(queued.length, 0);
  output.selectDevice("pa:7"); assert.equal(output.snapshot().state, "READY", "only explicit selection reopens output");
});

class CapturedDuplexStream extends EventEmitter {
  aborted = false;
  writes = 0;
  start(): void {}
  abort(): void { this.aborted = true; }
  write(_buffer: Buffer, callback?: () => void): boolean {
    this.writes += 1;
    callback?.();
    return true;
  }
}

class ClockedDuplexStream extends EventEmitter {
  readonly pending: Array<() => void> = [];
  start(): void {}
  abort(): void { this.pending.length = 0; }
  write(_buffer: Buffer, callback?: () => void): boolean {
    if (callback) this.pending.push(callback);
    return true;
  }
}

test("ASIO input and output reuse one already-open duplex stream", () => {
  const streams: CapturedDuplexStream[] = [];
  const options: Array<{ inOptions?: { channelCount: number }; outOptions?: { channelCount: number } }> = [];
  const backend = {
    SampleFormatFloat32: 1,
    getDevices: () => [{ id: 51, name: "Waves SoundGrid ASIO", hostAPIName: "ASIO", maxInputChannels: 64, maxOutputChannels: 64, defaultSampleRate: 48_000 }],
    AudioIO: class {
      constructor(value: { inOptions?: { channelCount: number }; outOptions?: { channelCount: number } }) {
        options.push(value);
        const stream = new CapturedDuplexStream();
        streams.push(stream);
        return stream;
      }
    },
  } as never;
  const asio = new AsioDuplexStream(backend);
  let captured = 0;

  asio.selectOutput({ deviceId: 51, channelCount: 64, sampleRate: 48_000, blockSize: 480 }, () => {});
  asio.selectInput({ deviceId: 51, channelCount: 8, sampleRate: 48_000, blockSize: 480 }, (buffer) => { captured += buffer.length; }, () => {});

  assert.equal(streams.length, 1, "adding input reuses the already-open duplex stream");
  assert.equal(streams[0].aborted, false);
  assert.equal(options[0].outOptions?.channelCount, 64);
  assert.equal(options[0].inOptions?.channelCount, 64);
  assert.equal(streams[0].writes, 1, "duplex output is primed with silence before start");
  streams[0].emit("data", Buffer.alloc(64 * 4));
  assert.equal(captured, 256);
  assert.equal(asio.writeBlock([new Float32Array(480)]).accepted, true);
  assert.equal(streams[0].writes, 2);
});

test("ASIO output requests the next engine block after native enqueue completes", async () => {
  const stream = new ClockedDuplexStream();
  const backend = {
    SampleFormatFloat32: 1,
    getDevices: () => [{ id: 7, name: "Audient ASIO", hostAPIName: "ASIO", maxInputChannels: 4, maxOutputChannels: 4, defaultSampleRate: 48_000 }],
    AudioIO: class { constructor() { return stream; } },
  } as never;
  const asio = new AsioDuplexStream(backend);
  let requested = 0;
  asio.onOutputReady = () => { requested += 1; };

  asio.selectInput({ deviceId: 7, channelCount: 4, sampleRate: 48_000, blockSize: 480 }, () => {}, () => {});
  assert.equal(asio.outputClockActive(), false);
  asio.selectOutput({ deviceId: 7, channelCount: 4, sampleRate: 48_000, blockSize: 480 }, () => {});
  await Promise.resolve();
  assert.equal(requested, 1, "opening the device requests the first block");
  assert.equal(asio.outputClockActive(), true);

  assert.equal(asio.writeBlock([new Float32Array(480)]).accepted, true);
  assert.equal(requested, 1, "a pending native write must not request another engine block");
  stream.pending.shift()?.();
  await Promise.resolve();
  assert.equal(requested, 2, "native enqueue completion requests exactly one replacement");

  asio.clearOutput();
  assert.equal(asio.outputClockActive(), false);
  asio.clearInput();
});

test("ASIO input-only silence follows bounded native queue completion and stops on detach/fault", async t => {
  const scheduled = new Map<object, () => void>();
  t.mock.method(globalThis, "setImmediate", (callback: () => void) => {
    const handle = { unref() {} }; scheduled.set(handle, callback); return handle;
  });
  t.mock.method(globalThis, "clearImmediate", (handle: object) => scheduled.delete(handle));
  const flush = () => {
    for (let turns = 0; scheduled.size; turns++) {
      assert.ok(turns < 20, "must wait for native queue capacity, not busy-loop");
      const [handle, callback] = scheduled.entries().next().value!;
      scheduled.delete(handle); callback();
    }
  };
  let queued = 0, writes = 0, aborts = 0, inputBlocks = 0;
  let pending: (() => void) | undefined;
  let options: { inOptions?: { highwaterMark?: number } } = {};
  const stream = Object.assign(new EventEmitter(), {
    start() {},
    abort() { aborts++; queued = 0; },
    write(buffer: Buffer, callback?: () => void) {
      writes++;
      assert.ok(buffer.every(byte => byte === 0), "unused ASIO outputs must stay silent");
      if (queued < 8) { queued++; callback?.(); }
      else { assert.equal(pending, undefined, "at most one silence write may wait"); pending = callback; }
      return true;
    },
  });
  const backend = { SampleFormatFloat32: 1,
    getDevices: () => [{ id: 7, name: "Test ASIO", hostAPIName: "ASIO", maxInputChannels: 10, maxOutputChannels: 2, defaultSampleRate: 48000 }],
    AudioIO: class { constructor(value: typeof options) { options = value; return stream; } },
  } as never;
  const asio = new AsioDuplexStream(backend);
  t.after(() => asio.clearInput());
  const direction = { deviceId: 7, channelCount: 1, sampleRate: 48000, blockSize: 480 };
  asio.selectInput(direction, () => inputBlocks++, () => {});
  flush();
  assert.equal(queued, 8);
  assert.equal(options.inOptions?.highwaterMark, 480 * 10 * 4, "read chunks must be whole capture blocks, including all ASIO lanes");
  for (let block = 0; block < 1_000; block++) {
    assert.ok(queued > 0, "input callback must not wait for unused output silence");
    queued--;
    stream.emit("data", Buffer.alloc(480 * 10 * 4));
    if (pending) { queued++; const done = pending; pending = undefined; done(); }
    if (block % 4 === 3) { // Up to four callbacks pass before JS can refill.
      flush();
      assert.equal(queued, 8);
    }
  }
  assert.equal(inputBlocks, 1_000);
  assert.equal(asio.outputClockActive(), false, "input-only must not become the engine clock");
  asio.selectOutput(direction, () => {});
  asio.clearOutput(); // Changing owners must not create a second pending producer.
  flush();
  const lateCallback = pending!;
  asio.emergencyStop();
  const stoppedWrites = writes;
  lateCallback(); flush(); await Promise.resolve();
  assert.equal(writes, stoppedWrites);
  assert.equal(queued, 0);
  assert.equal(aborts, 1);
});

test("ASIO input-only write failure aborts and never refills after a stale completion", t => {
  let refill: (() => void) | null = null;
  t.mock.method(globalThis, "setImmediate", (callback: () => void) => { refill = callback; return { unref() {} }; });
  t.mock.method(globalThis, "clearImmediate", () => { refill = null; });
  let complete: (error?: Error | null) => void = () => {};
  let writes = 0, aborted = 0;
  const faults: string[] = [];
  const stream = Object.assign(new EventEmitter(), { start() {}, abort() { aborted++; },
    write(_buffer: Buffer, callback?: typeof complete) { writes++; if (callback) complete = callback; return true; } });
  const backend = { SampleFormatFloat32: 1,
    getDevices: () => [{ id: 7, name: "Test ASIO", hostAPIName: "ASIO", maxInputChannels: 2, maxOutputChannels: 2, defaultSampleRate: 48000 }],
    AudioIO: class { constructor() { return stream; } },
  } as never;
  const asio = new AsioDuplexStream(backend);
  asio.selectInput({ deviceId: 7, channelCount: 1, sampleRate: 48000, blockSize: 480 }, () => {}, message => faults.push(message));
  assert.ok(refill);
  const runRefill = refill as () => void;
  refill = null;
  runRefill();
  complete(new Error("test native enqueue failed"));
  complete();
  assert.deepEqual(faults, ["test native enqueue failed"]);
  assert.equal(aborted, 1);
  assert.equal(writes, 2);
  assert.equal(refill, null);
});

test("ASIO cannot reopen before native abort completes; failed release stays closed", async () => {
  let release!: () => void;
  let reject!: (error: Error) => void;
  let closing = new Promise<void>(resolve => { release = resolve; });
  const backend = {
    SampleFormatFloat32: 1,
    getDevices: () => [{ id: 7, name: "Audient ASIO", hostAPIName: "ASIO", maxInputChannels: 4, maxOutputChannels: 4, defaultSampleRate: 48_000 }],
    AudioIO: class { constructor() { return Object.assign(new CapturedDuplexStream(), { abort: () => closing }); } },
  } as never;
  const options = { deviceId: 7, channelCount: 4, sampleRate: 48_000, blockSize: 480 };
  const asio = new AsioDuplexStream(backend);
  asio.selectOutput(options, () => {});
  asio.clearOutput();
  assert.equal(asio.outputClockActive(), false);
  assert.throws(() => asio.selectOutput(options, () => {}), /停止処理中/);
  assert.throws(() => asio.selectInput(options, () => {}, () => {}), /停止処理中/);
  release();
  await Promise.resolve();
  asio.selectOutput(options, () => {});
  assert.equal(asio.outputClockActive(), true);
  asio.clearOutput();
  await Promise.resolve();

  const failed = new AsioDuplexStream(backend);
  closing = new Promise<void>((_resolve, fail) => { reject = fail; });
  failed.selectOutput(options, () => {});
  failed.clearOutput();
  reject(new Error("driver release failed"));
  await Promise.resolve();
  assert.throws(() => failed.selectOutput(options, () => {}), /ASIO停止に失敗/);
  assert.equal(failed.outputClockActive(), false);
});

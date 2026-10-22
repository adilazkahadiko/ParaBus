import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { AudioInputManager } from "../services/router-core-sim/src/audio-input.ts";
import { AudioOutputManager } from "../services/router-core-sim/src/audio-output.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { resolveCoreOwnership } from "../services/router-core-sim/src/core-ownership.ts";
import {
  createProductionRustManagement,
  type RustManagementCoreClient,
} from "../services/router-core-sim/src/rust-management.ts";
import type { RouterSnapshot, WasapiManagementSnapshot } from "../packages/shared-types/src/index.ts";
import type { WasapiPreflightResult, WasapiSelectionResult } from "../packages/core-ipc/src/index.ts";

class TestStream extends EventEmitter {
  aborted = false;
  start(): void {}
  abort(): void { this.aborted = true; }
  write(_buffer: Buffer, callback: () => void): boolean { callback(); return true; }
}

class ProductionManagementClient implements RustManagementCoreClient {
  closed = false;
  listError: Error | null = null;
  readonly wasapi: WasapiManagementSnapshot = {
    supported: true,
    selectedEndpointId: null,
    selectedEndpointName: null,
    selectedAvailable: false,
    preflightReady: false,
    descriptor: null,
    streamStarted: false,
    streamState: "STOPPED",
    streamError: null,
    mmcssRegistered: false,
    renderCallbacks: 0,
    outputUnderruns: 0,
  };

  async health() { return { status: "ok" as const, protocolVersion: 1, implementation: "rust" as const, pid: 42, uptimeMs: 1 }; }
  async snapshot() { return { wasapi: this.wasapi } as RouterSnapshot; }
  async listWasapiEndpoints() {
    if (this.listError) throw this.listError;
    return {
      supported: true,
      endpoints: [
        { id: "render-production", name: "Production Render", direction: "render" as const, state: "ACTIVE" as const },
        { id: "capture-production", name: "Production Capture", direction: "capture" as const, state: "ACTIVE" as const },
      ],
      selectedEndpointId: null,
      selectedEndpointName: null,
      selectedAvailable: false,
    };
  }
  async selectWasapiEndpoint(): Promise<WasapiSelectionResult> { throw new Error("read-only test client"); }
  async clearWasapiEndpoint(): Promise<WasapiSelectionResult> { throw new Error("read-only test client"); }
  async preflightWasapiEndpoint(): Promise<WasapiPreflightResult> { throw new Error("read-only test client"); }
  async startWasapiStream(): Promise<WasapiSelectionResult> { throw new Error("read-only test client"); }
  async stopWasapiStream(): Promise<WasapiSelectionResult> { throw new Error("read-only test client"); }
  close() { this.closed = true; }
}

function portAudioBackend(streams: TestStream[]) {
  return {
    SampleFormatFloat32: 1,
    getDevices: () => [
      { id: 7, name: "PortAudio Output", hostAPIName: "Windows WASAPI", maxInputChannels: 0, maxOutputChannels: 2, defaultSampleRate: 48_000 },
      { id: 9, name: "PortAudio Input", hostAPIName: "Windows WASAPI", maxInputChannels: 2, maxOutputChannels: 0, defaultSampleRate: 48_000 },
    ],
    AudioIO: class { constructor() { const stream = new TestStream(); streams.push(stream); return stream; } },
  } as never;
}

async function waitFor(predicate: () => boolean, describe = () => "condition was not reached before timeout"): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(describe());
}

test("Windows TypeScript production wires one read-only Rust provider and fails closed on provider death", async () => {
  const ownership = resolveCoreOwnership({ ROUTER_CORE_OWNERSHIP: "typescript" }, "win32");
  assert.equal(ownership.snapshot.effectiveOwner, "typescript");
  assert.equal(ownership.snapshot.managementProvider, "rust-read-only");
  assert.equal(ownership.discordMetadataShadowEnabled, false);
  assert.equal(ownership.rustManagementEnabled, true);

  const client = new ProductionManagementClient();
  let childCreations = 0;
  const management = createProductionRustManagement(
    ownership,
    () => { childCreations += 1; return client; },
  );
  await management.start();
  await management.start();
  const inventory = await management.listWasapiEndpoints();
  assert.equal(childCreations, 1);
  assert.equal(management.snapshot().status, "READY");
  assert.equal(management.snapshot().streamControlEnabled, false);
  assert.deepEqual(inventory.endpoints.map((endpoint) => endpoint.direction), ["render", "capture"]);

  const streams: TestStream[] = [];
  const backend = portAudioBackend(streams);
  const engine = AudioEngine.createDemo(0);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, backend, 10, management, "win32");
  const input = new AudioInputManager(engine, backend, 10, management, "win32");
  const control = new ControlPlane(engine, output, undefined, input);
  output.onFault = (deviceId, message) => { control.execute({ type: "DEVICE_LOST", deviceId: `${deviceId}: ${message}` }); };
  input.onFault = (deviceId, message) => { control.execute({ type: "INPUT_DEVICE_LOST", deviceId: `${deviceId}: ${message}` }); };

  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "pa:7", windowsEndpointId: "render-production" }).ok, true);
  assert.equal(control.execute({ type: "SELECT_INPUT_DEVICE", deviceId: "pa:9", channelCount: 1, windowsEndpointId: "capture-production" }).ok, true);
  assert.equal(output.presenceMonitoringReady(), true);
  assert.equal(input.presenceMonitoringReady(), true);
  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, true);

  client.listError = new Error("router-core exited (1)");
  await waitFor(
    () => output.snapshot().state !== "READY" && input.snapshot().state === "FAULT",
    () => JSON.stringify({ output: output.snapshot().state, input: input.snapshot().state, management: management.snapshot().status }),
  );
  assert.equal(control.state, "FAULT");
  assert.equal(control.engine.emergencyMuted, true);
  assert.equal(output.snapshot().activeChannelCount, 0);
  assert.equal(input.snapshot().activeChannelCount, 0);
  assert.equal(output.snapshot().windowsEndpointBinding?.endpointId, "render-production");
  assert.equal(input.snapshot().windowsEndpointBinding?.endpointId, "capture-production");

  client.listError = null;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.notEqual(output.snapshot().state, "READY", "provider recovery cannot reopen output");
  assert.equal(input.snapshot().state, "FAULT", "provider recovery cannot reopen input");
  assert.equal(control.engine.emergencyMuted, true, "provider recovery cannot clear Emergency Mute");

  output.stop();
  input.stop();
  await management.close();
  assert.equal(client.closed, true);
});

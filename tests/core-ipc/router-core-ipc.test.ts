import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  CoreProcessClient,
  type CoreHealth,
  type WasapiEndpointInventory,
} from "../../packages/core-ipc/src/index.ts";
import { AudioEngine } from "../../services/router-core-sim/src/audio-engine.ts";
import { AudioInputManager } from "../../services/router-core-sim/src/audio-input.ts";
import { AudioOutputManager } from "../../services/router-core-sim/src/audio-output.ts";
import { ControlPlane } from "../../services/router-core-sim/src/control-plane.ts";
import { resolveCoreOwnership } from "../../services/router-core-sim/src/core-ownership.ts";
import {
  createProductionRustManagement,
  type RustManagementCoreClient,
} from "../../services/router-core-sim/src/rust-management.ts";

class LifecycleStream extends EventEmitter {
  aborted = false;
  start(): void {}
  abort(): void { this.aborted = true; }
  write(_buffer: Buffer, callback: () => void): boolean { callback(); return true; }
}

class RealChildPresenceClient implements RustManagementCoreClient {
  readonly core = new CoreProcessClient({ inheritEnvironment: false, requestTimeoutMs: 5_000 });
  async health() { return this.core.health(); }
  async snapshot() { return this.core.snapshot(); }
  async listWasapiEndpoints(): Promise<WasapiEndpointInventory> {
    await this.core.health();
    return {
      supported: true,
      endpoints: [
        { id: "render-real-child", name: "Test Render", direction: "render", state: "ACTIVE" },
        { id: "capture-real-child", name: "Test Capture", direction: "capture", state: "ACTIVE" },
      ],
      selectedEndpointId: null,
      selectedEndpointName: null,
      selectedAvailable: false,
    };
  }
  async selectWasapiEndpoint(endpointId: string) { return this.core.selectWasapiEndpoint(endpointId); }
  async clearWasapiEndpoint() { return this.core.clearWasapiEndpoint(); }
  async preflightWasapiEndpoint() { return this.core.preflightWasapiEndpoint(); }
  async startWasapiStream() { return this.core.startWasapiStream(); }
  async stopWasapiStream() { return this.core.stopWasapiStream(); }
  processId() { return this.core.processId(); }
  onUnexpectedFault(listener: (error: Error) => void) { return this.core.onUnexpectedFault(listener); }
  close() { this.core.close(); }
}

function lifecyclePortAudio(streams: LifecycleStream[]) {
  return {
    SampleFormatFloat32: 1,
    getDevices: () => [
      { id: 7, name: "Physical Output", hostAPIName: "Windows WASAPI", maxInputChannels: 0, maxOutputChannels: 2, defaultSampleRate: 48_000 },
      { id: 9, name: "Physical Input", hostAPIName: "Windows WASAPI", maxInputChannels: 2, maxOutputChannels: 0, defaultSampleRate: 48_000 },
    ],
    AudioIO: class { constructor() { const stream = new LifecycleStream(); streams.push(stream); return stream; } },
  } as never;
}

async function waitForLifecycle(predicate: () => boolean, describe = () => "lifecycle condition was not reached before timeout"): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(describe());
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("TypeScript Windows production starts the real read-only management child without rust-shadow", async (t) => {
  const ownership = resolveCoreOwnership({ ROUTER_CORE_OWNERSHIP: "typescript" }, "win32");
  const management = createProductionRustManagement(ownership);
  t.after(() => management.close());

  await management.start();
  const inventory = await management.listWasapiEndpoints();
  assert.equal(ownership.snapshot.effectiveOwner, "typescript");
  assert.equal(ownership.discordMetadataShadowEnabled, false);
  assert.equal(management.snapshot().status, "READY");
  assert.equal(management.snapshot().streamControlEnabled, false);
  assert.equal(inventory.endpoints.every((endpoint) => endpoint.direction === "render" || endpoint.direction === "capture"), true);
  await assert.rejects(management.startWasapiStream(), /read-only presence mode/);
});

test("unexpected real management child death latches FAULT and fail-closes physical I/O without respawn", async () => {
  const ownership = resolveCoreOwnership({ ROUTER_CORE_OWNERSHIP: "typescript" }, "win32");
  const client = new RealChildPresenceClient();
  const management = createProductionRustManagement(ownership, () => client);
  await management.start();
  await management.listWasapiEndpoints();
  const oldPid = management.processId();
  assert.ok(oldPid && oldPid > 0);
  assert.equal(management.snapshot().status, "READY");

  const streams: LifecycleStream[] = [];
  const backend = lifecyclePortAudio(streams);
  const engine = AudioEngine.createDemo(0);
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, backend, 1_000, management, "win32");
  const input = new AudioInputManager(engine, backend, 1_000, management, "win32");
  const control = new ControlPlane(engine, output, undefined, input);
  output.onFault = (deviceId, message) => { control.execute({ type: "DEVICE_LOST", deviceId: `${deviceId}: ${message}` }); };
  input.onFault = (deviceId, message) => { control.execute({ type: "INPUT_DEVICE_LOST", deviceId: `${deviceId}: ${message}` }); };
  assert.equal(control.execute({ type: "SELECT_OUTPUT_DEVICE", deviceId: "pa:7", windowsEndpointId: "render-real-child" }).ok, true);
  assert.equal(control.execute({ type: "SELECT_INPUT_DEVICE", deviceId: "pa:9", channelCount: 1, windowsEndpointId: "capture-real-child" }).ok, true);
  assert.equal(control.execute({ type: "SET_STATE", state: "READY" }).ok, true);

  process.kill(oldPid, "SIGKILL");
  await waitForLifecycle(
    () => management.snapshot().status === "FAULT"
      && output.snapshot().state !== "READY"
      && input.snapshot().state === "FAULT",
    () => JSON.stringify({ management: management.snapshot().status, output: output.snapshot().state, input: input.snapshot().state }),
  );
  assert.equal(control.state, "FAULT");
  assert.equal(control.engine.emergencyMuted, true);
  assert.equal(output.snapshot().activeChannelCount, 0);
  assert.equal(input.snapshot().activeChannelCount, 0);
  assert.equal(engine.channels.has("local-input:1"), false, "provider death clears the input source and ring");
  assert.equal(streams.every((stream) => stream.aborted), true);
  assert.equal(management.processId(), null);
  assert.equal(client.core.lifecycleState(), "FAULT", "unexpected death remains latched in the process client");
  await assert.rejects(management.listWasapiEndpoints(), /exited|unavailable/i);
  await assert.rejects(management.listWasapiEndpoints(), /exited|unavailable/i);
  await assert.rejects(client.core.health(), /closed|fault|exited/i);
  assert.equal(management.processId(), null, "requests after death never create a replacement PID");
  await waitForLifecycle(() => !processExists(oldPid));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.notEqual(output.snapshot().state, "READY");
  assert.equal(input.snapshot().state, "FAULT");
  assert.equal(control.engine.emergencyMuted, true);
  await management.close();

  const restarted = new CoreProcessClient({ inheritEnvironment: false, requestTimeoutMs: 5_000 });
  let unexpectedStops = 0;
  restarted.onUnexpectedFault(() => { unexpectedStops += 1; });
  const restartedHealth = await restarted.health();
  assert.ok(restartedHealth.pid > 0 && restartedHealth.pid !== oldPid, "a new application/client instance may start normally");
  restarted.close();
  await waitForLifecycle(() => !processExists(restartedHealth.pid));
  assert.equal(restarted.lifecycleState(), "CLOSED");
  assert.equal(unexpectedStops, 0, "normal shutdown is not reported as unexpected death");
});

test("Rust core process supports health, snapshot, and command round-trip", async (t) => {
  const core = new CoreProcessClient({ requestTimeoutMs: 5_000 });
  t.after(() => core.close());

  const health = await core.health();
  assert.equal(health.status, "ok");
  assert.equal(health.protocolVersion, 1);
  assert.equal(health.implementation, "rust");
  assert.ok(health.pid > 0);

  const initial = await core.snapshot();
  assert.equal(initial.state, "SETUP");
  assert.equal(initial.revision, 1);
  assert.equal(initial.sampleRate, 48_000);
  assert.equal(initial.blockSize, 480);

  const command = await core.command({ type: "SET_STATE", state: "READY" });
  assert.deepEqual(command, { ok: true, revision: 2 });
  const updated = await core.snapshot();
  assert.equal(updated.state, "READY");
  assert.equal(updated.revision, 2);

  assert.deepEqual(await core.command({ type: "SET_PFL", sourceId: "user-01" }), { ok: true, revision: 3 });
  assert.equal((await core.snapshot()).monitorSourceId, "user-01");
});

test("Rust core keeps unmigrated commands under TypeScript ownership", async (t) => {
  const core = new CoreProcessClient({ requestTimeoutMs: 5_000 });
  t.after(() => core.close());

  const result = await core.command({ type: "SET_CHANNEL_FADER", channelId: "user-01", db: -6 });
  assert.equal(result.ok, false);
  assert.equal(result.revision, 1);
  assert.match(result.error ?? "", /not owned by the Rust core/);
});

test("Rust and TypeScript match emergency mute confirmation transitions", async (t) => {
  const rust = new CoreProcessClient({ requestTimeoutMs: 5_000 });
  t.after(() => rust.close());
  const reference = new ControlPlane(AudioEngine.createDemo(1));

  const referenceActive = reference.execute({ type: "EMERGENCY_MUTE", active: true });
  const rustActive = await rust.command({ type: "EMERGENCY_MUTE", active: true });
  assert.deepEqual(
    { ok: rustActive.ok, revision: rustActive.revision },
    { ok: referenceActive.ok, revision: referenceActive.revision },
  );
  assert.equal((await rust.snapshot()).emergencyMuted, reference.snapshot().emergencyMuted);

  const referenceDenied = reference.execute({ type: "EMERGENCY_MUTE", active: false, expectedEmergencyEpoch: 1 });
  const rustDenied = await rust.command({ type: "EMERGENCY_MUTE", active: false, expectedEmergencyEpoch: 1 });
  assert.equal(rustDenied.ok, referenceDenied.ok);
  assert.equal(rustDenied.confirmationRequired, referenceDenied.confirmationRequired);
  assert.equal((await rust.snapshot()).emergencyMuted, reference.snapshot().emergencyMuted);

  const referenceReady = reference.execute({ type: "SET_STATE", state: "READY" });
  const rustReady = await rust.command({ type: "SET_STATE", state: "READY" });
  assert.deepEqual({ ok: rustReady.ok, revision: rustReady.revision }, { ok: referenceReady.ok, revision: referenceReady.revision });
  const referenceReleased = reference.execute({ type: "EMERGENCY_MUTE", active: false, confirmed: true, expectedEmergencyEpoch: 1 });
  const rustReleased = await rust.command({ type: "EMERGENCY_MUTE", active: false, confirmed: true, expectedEmergencyEpoch: 1 });
  assert.deepEqual(
    { ok: rustReleased.ok, revision: rustReleased.revision },
    { ok: referenceReleased.ok, revision: referenceReleased.revision },
  );
  assert.equal((await rust.snapshot()).emergencyMuted, reference.snapshot().emergencyMuted);
});

test("Rust core exposes read-only WASAPI inventory without implicit selection", async (t) => {
  const core = new CoreProcessClient({ requestTimeoutMs: 5_000 });
  t.after(() => core.close());

  const inventory = await core.listWasapiEndpoints();
  assert.equal(inventory.supported, process.platform === "win32");
  assert.equal(inventory.selectedEndpointId, null);
  assert.equal(inventory.selectedEndpointName, null);
  assert.equal(inventory.selectedAvailable, false);
  assert.equal(new Set(inventory.endpoints.map((endpoint) => endpoint.id)).size, inventory.endpoints.length);
  for (const endpoint of inventory.endpoints) {
    assert.ok(endpoint.id.trim().length > 0);
    assert.ok(endpoint.name.trim().length > 0);
  }

  const snapshot = await core.snapshot();
  assert.equal(snapshot.wasapi?.supported, process.platform === "win32");
  assert.equal(snapshot.wasapi?.preflightReady, false);
  assert.equal(snapshot.wasapi?.streamStarted, false);
});

test("Rust core rejects unlisted WASAPI IDs without reflecting them", async (t) => {
  const core = new CoreProcessClient({ requestTimeoutMs: 5_000 });
  t.after(() => core.close());
  const marker = "DO-NOT-REFLECT-ENDPOINT-MARKER";

  await assert.rejects(
    core.selectWasapiEndpoint(marker),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(marker));
      return true;
    },
  );
  const snapshot = await core.snapshot();
  assert.equal(snapshot.wasapi?.selectedEndpointId, null);
  assert.equal(snapshot.wasapi?.preflightReady, false);
});

test("Rust core preflight and stream start require prior explicit selection", async (t) => {
  const core = new CoreProcessClient({ requestTimeoutMs: 5_000 });
  t.after(() => core.close());

  await assert.rejects(core.preflightWasapiEndpoint(), /explicitly selected|unavailable on this platform/);
  await assert.rejects(core.startWasapiStream(), /explicitly selected|unavailable on this platform/);
  const snapshot = await core.snapshot();
  assert.equal(snapshot.wasapi?.streamStarted, false);
  assert.equal(snapshot.wasapi?.streamState, "STOPPED");
  assert.equal(snapshot.wasapi?.preflightReady, false);
});

test("Rust management child can run without inheriting parent secrets", async (t) => {
  const markerName = "DBR_CORE_IPC_TEST_SECRET";
  const previous = process.env[markerName];
  process.env[markerName] = "must-not-cross-process-boundary";
  t.after(() => {
    if (previous === undefined) delete process.env[markerName];
    else process.env[markerName] = previous;
  });

  const script = [
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', chunk => {",
    "for (const line of chunk.trim().split('\\n')) {",
    "const request = JSON.parse(line)",
    `const payload = { status: 'ok', protocolVersion: 1, implementation: 'rust', pid: process.pid, uptimeMs: 0, secretVisible: Boolean(process.env.${markerName}) }`,
    "console.log(JSON.stringify({ v: 1, id: request.id, type: request.type, ok: true, payload }))",
    "}",
    "})",
  ].join(";");
  const core = new CoreProcessClient({
    command: process.execPath,
    args: ["-e", script],
    inheritEnvironment: false,
    requestTimeoutMs: 5_000,
  });
  t.after(() => core.close());

  const health = await core.health() as CoreHealth & { secretVisible: boolean };
  assert.equal(health.secretVisible, false);
});

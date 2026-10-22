import assert from "node:assert/strict";
import test from "node:test";
import type { CommandResult, ControlCommand, RouterSnapshot, WasapiManagementSnapshot, WasapiStreamDescriptor } from "../packages/shared-types/src/index.ts";
import {
  RustManagementBridge,
  type RustManagementCoreClient,
} from "../services/router-core-sim/src/rust-management.ts";

const descriptor: WasapiStreamDescriptor = {
  endpointId: "opaque-device-id",
  format: { sampleRate: 48_000, framesPerBuffer: 480, channels: 2, sampleFormat: "FLOAT32" },
  enginePeriod: { defaultFrames: 480, fundamentalFrames: 16, minimumFrames: 160, maximumFrames: 960 },
};

const emptyWasapi: WasapiManagementSnapshot = {
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

class FakeClient implements RustManagementCoreClient {
  listCalls = 0;
  closed = false;
  stopError: Error | null = null;
  listError: Error | null = null;
  endpoints = [
    { id: descriptor.endpointId, name: "Studio Output", direction: "render" as const, state: "ACTIVE" as const },
    { id: "opaque-capture-id", name: "Studio Input", direction: "capture" as const, state: "UNPLUGGED" as const },
  ];
  faultListeners = new Set<(error: Error) => void>();
  wasapi: WasapiManagementSnapshot = { ...emptyWasapi };
  state: RouterSnapshot["state"] = "SETUP";
  emergencyMuted = false;
  monitorSourceId: string | null = null;

  async health() {
    return { status: "ok" as const, protocolVersion: 1, implementation: "rust" as const, pid: 42, uptimeMs: 1 };
  }

  async snapshot() {
    return { state: this.state, emergencyMuted: this.emergencyMuted, monitorSourceId: this.monitorSourceId, wasapi: this.wasapi } as RouterSnapshot;
  }

  async command(command: ControlCommand): Promise<CommandResult> {
    if (command.type === "SET_STATE") this.state = command.state;
    if (command.type === "SET_PFL") this.monitorSourceId = command.sourceId;
    if (command.type === "EMERGENCY_MUTE") this.emergencyMuted = command.active;
    return { ok: true, revision: 2 };
  }

  async listWasapiEndpoints() {
    this.listCalls += 1;
    if (this.listError) throw this.listError;
    return {
      supported: true,
      endpoints: this.endpoints,
      selectedEndpointId: this.wasapi.selectedEndpointId,
      selectedEndpointName: this.wasapi.selectedEndpointName,
      selectedAvailable: this.wasapi.selectedAvailable,
    };
  }

  async selectWasapiEndpoint(endpointId: string) {
    assert.equal(endpointId, descriptor.endpointId);
    this.wasapi = { ...emptyWasapi, selectedEndpointId: endpointId, selectedEndpointName: "Studio Output", selectedAvailable: true };
    return { revision: 2, wasapi: this.wasapi };
  }

  async clearWasapiEndpoint() {
    this.wasapi = { ...emptyWasapi };
    return { revision: 4, wasapi: this.wasapi };
  }

  async preflightWasapiEndpoint() {
    this.wasapi = { ...this.wasapi, preflightReady: true, descriptor };
    return { revision: 3, descriptor, streamStarted: false as const };
  }

  async startWasapiStream() {
    assert.equal(this.wasapi.preflightReady, true);
    this.wasapi = { ...this.wasapi, streamStarted: true, streamState: "RUNNING", mmcssRegistered: true };
    return { revision: 4, wasapi: this.wasapi };
  }

  async stopWasapiStream() {
    if (this.stopError) throw this.stopError;
    this.wasapi = {
      ...this.wasapi,
      streamStarted: false,
      streamState: "STOPPED",
      renderCallbacks: 25,
      outputUnderruns: 25,
    };
    return { revision: 5, wasapi: this.wasapi };
  }

  close() {
    this.closed = true;
  }

  processId() { return this.closed ? null : 42; }

  onUnexpectedFault(listener: (error: Error) => void) {
    this.faultListeners.add(listener);
    return () => this.faultListeners.delete(listener);
  }

  triggerUnexpectedFault() {
    for (const listener of [...this.faultListeners]) listener(new Error("router-core exited (1)"));
  }
}

test("Rust management remains disabled without rust-shadow", async () => {
  let created = false;
  const bridge = new RustManagementBridge({ enabled: false, clientFactory: () => { created = true; return new FakeClient(); } });
  await bridge.start();
  assert.equal(created, false);
  assert.equal(bridge.snapshot().status, "DISABLED");
  await assert.rejects(bridge.listWasapiEndpoints(), /runtime/);
});

test("control shadow serially compares supported TypeScript state without taking ownership", async (t) => {
  const client = new FakeClient();
  const bridge = new RustManagementBridge({ enabled: true, controlShadowEnabled: true, clientFactory: () => client });
  t.after(() => bridge.close());
  await bridge.start();

  await Promise.all([
    bridge.shadowControlCommand({ type: "SET_STATE", state: "READY" }, { state: "READY", emergencyMuted: false, monitorSourceId: null }),
    bridge.shadowControlCommand({ type: "EMERGENCY_MUTE", active: true }, { state: "READY", emergencyMuted: true, monitorSourceId: null }),
  ]);
  await bridge.shadowControlCommand({ type: "SET_STATE", state: "SETUP" }, { state: "READY", emergencyMuted: true, monitorSourceId: null });
  await bridge.shadowControlCommand({ type: "SET_PFL", sourceId: "user-01" }, { state: "READY", emergencyMuted: true, monitorSourceId: "user-01" });

  const shadow = bridge.snapshot().controlShadow;
  assert.deepEqual(
    { compared: shadow.comparedCommands, matched: shadow.matchedCommands, mismatched: shadow.mismatchedCommands, pending: shadow.pendingCommands },
    { compared: 4, matched: 3, mismatched: 1, pending: 0 },
  );
  assert.match(shadow.lastMismatch ?? "", /expected state READY, received SETUP/);
});

test("read-only management mode exposes inventory but cannot start Rust audio", async (t) => {
  const client = new FakeClient();
  let creations = 0;
  const bridge = new RustManagementBridge({ enabled: true, clientFactory: () => { creations += 1; return client; } });
  t.after(() => bridge.close());

  await bridge.start();
  await bridge.start();
  const inventory = await bridge.listWasapiEndpoints();
  assert.equal(creations, 1, "one runtime creates only one management child");
  assert.equal(bridge.snapshot().streamControlEnabled, false);
  assert.equal(inventory.endpoints.some((endpoint) => endpoint.direction === "render"), true);
  assert.equal(inventory.endpoints.some((endpoint) => endpoint.direction === "capture"), true);
  await assert.rejects(bridge.selectWasapiEndpoint(descriptor.endpointId), /read-only presence mode/);
  await assert.rejects(bridge.preflightWasapiEndpoint(), /read-only presence mode/);
  await assert.rejects(bridge.startWasapiStream(), /read-only presence mode/);
});

test("unexpected child notification latches provider FAULT without creating a replacement", async () => {
  const client = new FakeClient();
  let creations = 0;
  let unavailable = 0;
  const bridge = new RustManagementBridge({ enabled: true, clientFactory: () => { creations += 1; return client; } });
  bridge.onUnavailable(() => { unavailable += 1; });
  await bridge.start();
  assert.equal(bridge.processId(), 42);

  client.triggerUnexpectedFault();
  assert.equal(bridge.snapshot().status, "FAULT");
  assert.equal(bridge.isAvailable(), false);
  assert.equal(bridge.processId(), null);
  assert.equal(unavailable, 1);
  await bridge.start();
  await assert.rejects(bridge.listWasapiEndpoints(), /exited/);
  assert.equal(creations, 1, "latched FAULT cannot create another child");
  await bridge.close();
  assert.equal(bridge.snapshot().status, "FAULT");
});

test("Rust management starts without enumerating or selecting a WASAPI endpoint", async (t) => {
  const client = new FakeClient();
  const bridge = new RustManagementBridge({ enabled: true, streamControlEnabled: true, clientFactory: () => client });
  t.after(() => bridge.close());

  await bridge.start();
  assert.equal(bridge.snapshot().status, "READY");
  assert.equal(client.listCalls, 0);
  assert.equal(bridge.snapshot().wasapi.selectedEndpointName, null);

  const inventory = await bridge.listWasapiEndpoints();
  assert.equal(inventory.endpoints.length, 2);
  assert.deepEqual(inventory.endpoints.map(({ direction, state }) => ({ direction, state })), [
    { direction: "render", state: "ACTIVE" },
    { direction: "capture", state: "UNPLUGGED" },
  ]);
  assert.equal(bridge.cachedEndpoint(descriptor.endpointId, "render")?.id, descriptor.endpointId);
  assert.equal(bridge.cachedEndpoint("opaque-capture-id", "capture")?.state, "UNPLUGGED");
  assert.equal(inventory.selectedEndpointId, null);

  await bridge.selectWasapiEndpoint(descriptor.endpointId);
  await bridge.preflightWasapiEndpoint();
  const snapshot = bridge.snapshot();
  assert.equal(snapshot.wasapi.selectedEndpointName, "Studio Output");
  assert.equal(snapshot.wasapi.preflightReady, true);
  assert.equal(snapshot.wasapi.streamStarted, false);
  assert.equal("endpointId" in snapshot.wasapi, false, "public snapshot must not expose the opaque ID");
  assert.doesNotMatch(JSON.stringify(snapshot), /opaque-device-id/);
  assert.equal(snapshot.wasapi.format?.sampleRate, 48_000);

  await bridge.startWasapiStream();
  assert.equal(bridge.snapshot().wasapi.streamState, "RUNNING");
  assert.equal(bridge.snapshot().wasapi.streamStarted, true);
  await bridge.stopWasapiStream();
  assert.equal(bridge.snapshot().wasapi.streamState, "STOPPED");
  assert.equal(bridge.snapshot().wasapi.renderCallbacks, 25);

  client.wasapi = {
    ...client.wasapi,
    descriptor: null,
    preflightReady: false,
    streamStarted: false,
    streamState: "FAULT",
    streamError: "the selected WASAPI endpoint was invalidated",
  };
  await bridge.refreshSnapshot();
  assert.equal(bridge.snapshot().wasapi.streamState, "FAULT");
  assert.match(bridge.snapshot().wasapi.streamError ?? "", /切断または無効化/);
  assert.doesNotMatch(JSON.stringify(bridge.snapshot()), /opaque-device-id/);

  client.wasapi = { ...client.wasapi, streamError: "WASAPI render event timed out" };
  await bridge.refreshSnapshot();
  assert.match(bridge.snapshot().wasapi.streamError ?? "", /render callback.*timeout/);
  assert.doesNotMatch(bridge.snapshot().wasapi.streamError ?? "", /management request/);

  client.wasapi = { ...client.wasapi, streamError: "WASAPI endpoint format or period changed while running" };
  await bridge.refreshSnapshot();
  assert.match(bridge.snapshot().wasapi.streamError ?? "", /formatまたはperiod/);

  client.wasapi = { ...client.wasapi, streamError: "the explicitly selected Core Audio endpoint is unavailable" };
  await bridge.refreshSnapshot();
  assert.match(bridge.snapshot().wasapi.streamError ?? "", /利用できません/);

  await bridge.clearWasapiEndpoint();
  assert.equal(bridge.snapshot().wasapi.selectedEndpointName, null);
  assert.equal(bridge.snapshot().wasapi.preflightReady, false);
});

test("a WASAPI render timeout faults the stream without faulting management IPC", async (t) => {
  const client = new FakeClient();
  const bridge = new RustManagementBridge({ enabled: true, streamControlEnabled: true, clientFactory: () => client });
  t.after(() => bridge.close());

  await bridge.start();
  client.wasapi = {
    ...emptyWasapi,
    selectedEndpointName: "Studio Output",
    selectedAvailable: true,
    streamState: "FAULT",
    streamError: "WASAPI render event timed out",
  };
  client.stopError = new Error("WASAPI render event timed out");

  await assert.rejects(bridge.stopWasapiStream(), /render callback.*timeout/);
  assert.equal(bridge.snapshot().status, "READY");
  assert.equal(bridge.snapshot().wasapi.streamState, "FAULT");
});

test("Rust management shutdown stops a running silent stream before closing the child", async () => {
  const client = new FakeClient();
  const bridge = new RustManagementBridge({ enabled: true, streamControlEnabled: true, clientFactory: () => client });
  await bridge.start();
  await bridge.listWasapiEndpoints();
  await bridge.selectWasapiEndpoint(descriptor.endpointId);
  await bridge.preflightWasapiEndpoint();
  await bridge.startWasapiStream();

  await bridge.close();

  assert.equal(client.wasapi.streamStarted, false);
  assert.equal(client.wasapi.streamState, "STOPPED");
  assert.equal(client.closed, true);
  assert.equal(bridge.snapshot().status, "STOPPED");
});

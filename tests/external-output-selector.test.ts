import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { ExternalDeviceStore } from "../services/router-core-sim/src/external-device-store.ts";
import { ExternalState } from "../services/router-core-sim/src/external-state.ts";
import { COMMAND_POLICIES, classifyCommand, dependencyKey } from "../services/router-core-sim/src/external-protocol.ts";
import type { SelectorMode, SelectorOperation } from "../packages/shared-types/src/index.ts";
import { fixture } from "./helpers/external-control-fixture.ts";
import { connectWs } from "./helpers/external-ws.ts";

const PRIVATE_SOURCE = "discord-vc:610000000000000001:620000000000000001";
const code = (reply: any, value: string, status: number) => { assert.equal(reply.body.code, value); assert.equal(reply.status, status); };
async function setup(t: test.TestContext, mode: SelectorMode = "SWITCH") {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await fixture(t);
  const second = new VcBus(PRIVATE_SOURCE, "Synthetic team B", 480); f.engine.addBus(second);
  const outside = new VcBus("outside", "Synthetic unlisted team", 480); f.engine.addBus(outside);
  const group = new VcBus("group", "Synthetic group", 480); group.groupSourceIds = [f.bus.id]; f.engine.addBus(group);
  const created = f.control.execute({ type: "CREATE_OUTPUT_SELECTOR", name: "Director", mode, outputMode: "MONO", output: 0, sourceBusIds: [f.bus.id, second.id] });
  assert.equal(created.ok, true);
  const internalId = (created.data as { selectorId: string }).selectorId, bus = f.engine.buses.get(internalId)!;
  f.api.manage({ action: "enable" });
  const selectorId = f.api.state.publicBusId(internalId), a = f.api.state.publicBusId(f.bus.id), b = f.api.state.publicBusId(second.id);
  const select = (busId: string, operation: SelectorOperation = "SWITCH", extra: Record<string, unknown> = {}) => f.action("selector.select", { selectorId, busId, operation }, extra);
  return { ...f, second, outside, group, internalId, selectorId, selectorBus: bus, a, b, select };
}

test("selector SWITCH/ADD/REMOVE/OFF run as Tier A ON AIR and preserve no-op fades and last-team guard", async t => {
  const f = await setup(t); f.control.state = "ON_AIR";
  const info = await (await fetch(f.base + '/info', { headers: f.headers })).json() as any;
  for (const name of ['selector.select', 'selector.off']) assert.deepEqual(info.data.operations.find((op: any) => op.name === name).tiers, ['A']);
  assert.ok(info.data.features.includes('selectors'));
  assert.equal(COMMAND_POLICIES.SELECT_OUTPUT_SELECTOR, 'A'); assert.equal(COMMAND_POLICIES.OUTPUT_SELECTOR_OFF, 'A');
  assert.equal(classifyCommand({ type: 'SELECT_OUTPUT_SELECTOR', selectorId: f.internalId, busId: f.bus.id, operation: 'SWITCH' }, { state: 'ON_AIR' }), 'A');
  assert.equal((await f.select(f.a)).status, 200);
  f.engine.processBlock(); const leg = { ...f.selectorBus.selector!.legs[0] }, before = f.api.state.revision;
  const noop = await f.select(f.a); assert.equal(noop.status, 200); assert.equal(noop.body.revision, before); assert.deepEqual(f.selectorBus.selector!.legs[0], leg);
  const added = await f.select(f.b, 'ADD'); assert.deepEqual(added.body.data.selectedBusIds, [f.a, f.b]); assert.equal(added.body.data.primaryBusId, f.a);
  const same = await f.select(f.b); assert.deepEqual(same.body.data.selectedBusIds, [f.a, f.b]); assert.equal(same.body.data.primaryBusId, f.a);
  assert.deepEqual((await f.select(f.a, 'REMOVE')).body.data.selectedBusIds, [f.b]);
  code(await f.select(f.b, 'REMOVE'), 'LOCKED', 409);
  const off = await f.action('selector.off', { selectorId: f.selectorId }); assert.equal(off.status, 200); assert.deepEqual(off.body.data.selectedBusIds, []); assert.equal(off.body.data.primaryBusId, null);
  const offAgain = await f.action('selector.off', { selectorId: f.selectorId }); assert.equal(offAgain.body.revision, off.body.revision);
  await f.select(f.a); const switched = await f.select(f.b); assert.deepEqual(switched.body.data.selectedBusIds, [f.b]);
  assert.deepEqual(f.commands[0], { type: 'SELECT_OUTPUT_SELECTOR', selectorId: f.internalId, busId: f.bus.id, operation: 'SWITCH' });
  assert.ok(f.commands.some((command: any) => command.type === 'OUTPUT_SELECTOR_OFF' && command.selectorId === f.internalId));
  assert.ok(f.logs.some(line => line.includes('operation=selector.select tier=A result=SUCCESS')));
});

test("additive TOGGLE affects only its team, deduplicates requests and honors instance/revision validation", async t => {
  const f = await setup(t, 'ADDITIVE');
  const body = f.request('selector.select', { selectorId: f.selectorId, busId: f.a, operation: 'TOGGLE' });
  const first = await f.raw(body), cached = await f.raw(body); assert.equal(first.status, 200); assert.deepEqual(cached.body, first.body); assert.equal(f.commands.length, 1);
  assert.deepEqual(f.selectorBus.selector!.snapshot().selectedBusIds, [f.bus.id]);
  code(await f.raw({ ...body, args: { ...body.args as object, busId: f.b } }), 'INVALID', 400);
  const both = await f.select(f.b, 'TOGGLE'); assert.deepEqual(both.body.data.selectedBusIds, [f.a, f.b]); assert.equal(both.body.data.primaryBusId, null);
  const removed = await f.select(f.a, 'TOGGLE'); assert.deepEqual(removed.body.data.selectedBusIds, [f.b]);
  assert.deepEqual((await f.action('selector.off', { selectorId: f.selectorId })).body.data.selectedBusIds, []);
  const count = f.commands.length;
  code(await f.select(f.a, 'TOGGLE', { instanceId: randomUUID() }), 'STALE_REVISION', 409);
  code(await f.select(f.a, 'TOGGLE', { expectedRevision: 'bad' }), 'INVALID', 400); assert.equal(f.commands.length, count);
  // Global expectedRevision retains the existing reference-only meaning for Tier A.
  assert.equal((await f.select(f.a, 'TOGGLE', { expectedRevision: 1 })).status, 200);
});

test("selector errors distinguish missing targets, invalid sources/operations and unavailable structural operations", async t => {
  const f = await setup(t);
  code(await f.action('selector.select', { selectorId: 'missing', busId: f.a, operation: 'SWITCH' }), 'NOT_FOUND', 404);
  code(await f.action('selector.off', { selectorId: f.a }), 'NOT_FOUND', 404);
  code(await f.select('missing'), 'NOT_FOUND', 404);
  for (const busId of [f.outside.id, f.group.id, f.selectorId]) code(await f.select(busId), 'INVALID', 400);
  code(await f.select(f.a, 'TOGGLE'), 'INVALID', 400);
  code(await f.action('selector.select', { selectorId: f.selectorId, busId: f.a, operation: 'UNKNOWN' }), 'INVALID', 400);
  code(await f.action('selector.select', { selectorId: f.selectorId, busId: f.a }), 'INVALID', 400);
  code(await f.action('selector.off', { selectorId: f.selectorId, busId: f.a }), 'INVALID', 400);
  for (const operation of ['CREATE_OUTPUT_SELECTOR', 'UPDATE_OUTPUT_SELECTOR', 'REMOVE_OUTPUT_SELECTOR', 'SELECT_OUTPUT_SELECTOR', 'OUTPUT_SELECTOR_OFF']) {
    code(await f.action(operation, { selectorId: f.selectorId }), 'TIER_FORBIDDEN', 403);
  }
  for (const operation of ['selector.create', 'selector.update', 'selector.remove']) code(await f.action(operation, {}), 'INVALID', 400);
  code(await f.raw(f.request('selector.off', { selectorId: f.selectorId }), '/arm'), 'INVALID', 400);
  assert.equal(f.commands.length, 0);
});

for (const names of [false, true]) test(`selector state uses stable public IDs, always returns its name and respects team-name permission: ${names}`, async t => {
  const f = await setup(t);
  f.api.manage({ action: 'permissions', deviceId: f.registration.deviceId, readDisplayNames: names });
  const state = await f.state(), selector = state.selectors[0];
  assert.deepEqual(Object.keys(selector).sort(), ['selectorId', 'name', 'mode', 'fadeMs', 'sourceBusIds', 'selectedBusIds', 'primaryBusId', 'emergencyMuted'].sort());
  assert.equal(selector.name, 'Director'); assert.equal(selector.mode, 'SWITCH'); assert.equal(selector.fadeMs, 300);
  assert.deepEqual(selector.sourceBusIds, [f.a, f.b]); assert.deepEqual(selector.selectedBusIds, []); assert.equal(selector.primaryBusId, null);
  assert.match(f.selectorId, /^external-bus:[A-Za-z0-9_-]{43}$/); assert.match(f.b, /^external-bus:[A-Za-z0-9_-]{43}$/);
  assert.equal(state.buses.find((bus: any) => bus.busId === f.selectorId).busId, selector.selectorId);
  assert.equal(Object.hasOwn(state.buses.find((bus: any) => bus.busId === f.b), 'label'), names);
  const json = JSON.stringify(state); for (const marker of [PRIVATE_SOURCE, f.internalId, '610000000000000001', '620000000000000001']) assert.equal(json.includes(marker), false);
  assert.equal(json.includes(f.second.label), names);
  const reloaded = new ExternalState(f.control, () => f.ingest.snapshot(), undefined, undefined, new ExternalDeviceStore(f.root));
  assert.equal(reloaded.publicBusId(f.internalId), f.selectorId); assert.equal(reloaded.publicBusId(PRIVATE_SOURCE), f.b);
  const key = JSON.parse(readFileSync(f.store.path, 'utf8')).busAliasKey; assert.equal(json.includes(key), false);
  const ws = await connectWs(f.api.port, f.headers.authorization); t.after(() => ws.socket.destroy());
  const initial = await ws.next(); assert.deepEqual(initial.payload.selectors, state.selectors);
  await f.select(f.b); f.api.tick(); const changed = await ws.next(); assert.deepEqual(changed.payload.selectors[0].selectedBusIds, [f.b]);
  assert.equal(JSON.stringify(changed).includes(f.second.label), names);
  f.control.execute({ type: 'EMERGENCY_MUTE', active: true });
  const muted = await f.select(f.a); assert.equal(muted.status, 200); assert.equal(muted.body.data.emergencyMuted, true);
  f.engine.processBlock(); assert.ok(f.engine.outputs.every(output => output.every(sample => sample === 0)));
});

test("local selection ABA advances revision and dependency generations synchronously without full projections; no-op stays unchanged", async t => {
  const f = await setup(t); await f.select(f.a);
  const key = dependencyKey('selector', f.internalId, 'selection'), before = f.api.state.dependencies([key]), revision = f.api.state.revision;
  const initial = f.selectorBus.selector!.snapshot();
  let full = 0; const observe = f.api.state.observe.bind(f.api.state); f.api.state.observe = () => { full++; observe(); };
  f.control.execute({ type: 'OUTPUT_SELECTOR_OFF', selectorId: f.internalId });
  f.control.execute({ type: 'SELECT_OUTPUT_SELECTOR', selectorId: f.internalId, busId: f.bus.id, operation: 'SWITCH' });
  assert.equal(full, 0); assert.ok(f.api.state.revision >= revision + 2); assert.notEqual(f.api.state.dependencies([key]), before); assert.deepEqual(f.selectorBus.selector!.snapshot(), initial);
  const after = f.api.state.revision, generation = f.api.state.dependencies([key]);
  f.control.execute({ type: 'SELECT_OUTPUT_SELECTOR', selectorId: f.internalId, busId: f.bus.id, operation: 'SWITCH' });
  assert.equal(f.api.state.revision, after); assert.equal(f.api.state.dependencies([key]), generation);
  f.api.state.observe = observe;
  assert.ok((await f.state()).revision > revision);
});

test("selector actions retain authentication, enablement, origin restrictions and normal rate limits", async t => {
  const f = await setup(t, 'ADDITIVE'), args = { selectorId: f.selectorId, busId: f.a, operation: 'TOGGLE' };
  code(await f.raw(f.request('selector.select', args), '/actions', { 'content-type': 'application/json' } as typeof f.headers), 'UNAUTHORIZED', 401);
  code(await f.raw(f.request('selector.select', args), '/actions', { ...f.headers, origin: 'http://localhost' } as typeof f.headers), 'ORIGIN_FORBIDDEN', 403);
  f.api.manage({ action: 'stop' }); code(await f.raw(f.request('selector.select', args)), 'DISABLED', 503); f.api.manage({ action: 'enable' });
  assert.equal(f.commands.length, 0);
  const responses = [];
  for (let i = 0; i < 21; i++) responses.push(await f.raw(f.request('selector.select', args)));
  assert.ok(responses.slice(0, 20).every(reply => reply.status === 200)); code(responses[20], 'RATE_LIMITED', 429); assert.equal(f.commands.length, 20);
});

test("Bus deletion updates selector projection and missing selector/source never executes a command", async t => {
  const f = await setup(t); await f.select(f.b); const before = (await f.state()).revision;
  assert.equal(f.control.execute({ type: 'REMOVE_VC_BUS', busId: PRIVATE_SOURCE, confirmed: true }).ok, true);
  const after = await f.state(); assert.ok(after.revision > before); assert.deepEqual(after.selectors[0].sourceBusIds, [f.a]); assert.deepEqual(after.selectors[0].selectedBusIds, []);
  code(await f.select(f.b), 'NOT_FOUND', 404);
  f.control.execute({ type: 'REMOVE_OUTPUT_SELECTOR', selectorId: f.internalId, confirmed: true });
  code(await f.action('selector.off', { selectorId: f.selectorId }), 'NOT_FOUND', 404); assert.equal((await f.state()).selectors.length, 0);
  assert.equal(f.commands.length, 1);
});

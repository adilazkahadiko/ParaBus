import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlCommand, OutputSelectorConfig, SelectorOperation } from "../packages/shared-types/src/index.ts";
import { AudioChannel, AudioEngine, VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { OutputSelector } from "../services/router-core-sim/src/output-selector.ts";
import { OutputSelectorStore } from "../services/router-core-sim/src/output-selector-store.ts";
import { RecorderManager, isRecorderSelection } from "../services/router-core-sim/src/recorder.ts";

const config: OutputSelectorConfig = { name: "Director", output: 0, outputMode: "MONO", mode: "SWITCH", fadeMs: 0, sourceBusIds: ["a", "b", "c"] };
function fixture(overrides: Partial<OutputSelectorConfig> = {}) {
  const engine = new AudioEngine(48000, 48, 16), control = new ControlPlane(engine);
  for (const [index, id] of ["a", "b", "c"].entries()) {
    const channel = new AudioChannel(`input-${id}`, `Input ${id}`, "TestTone", { fill(target) { target.fill((index + 1) * .1); return true; } }, 48, 48000);
    channel.hpfEnabled = channel.compressorEnabled = false;
    channel.vcSends.set(id, { gainDb: 0, mute: false }); engine.addChannel(channel);
    const bus = new VcBus(id, id.toUpperCase(), 48, 48000); bus.compressorEnabled = false; engine.addBus(bus);
  }
  const result = control.execute({ type: "CREATE_OUTPUT_SELECTOR", ...config, ...overrides });
  assert.equal(result.ok, true, result.error ?? "selector created");
  const selectorId = (result.data as { selectorId: string }).selectorId;
  const bus = engine.buses.get(selectorId)!;
  const select = (busId: string, operation: SelectorOperation = "SWITCH") => control.execute({ type: "SELECT_OUTPUT_SELECTOR", selectorId, busId, operation });
  const selected = () => bus.selector!.snapshot().selectedBusIds;
  const sample = () => { engine.processBlock(); return engine.outputs[0][0]; };
  return { engine, control, selectorId, bus, select, selected, sample };
}
const near = (actual: number, expected: number, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≈ ${expected}`);

test("switch/add/remove/no-op/OFF, including the last-team refusal", () => {
  const f = fixture(); near(f.sample(), 0);
  assert.equal(f.select("a").ok, true); near(f.sample(), .1);
  assert.match(f.select("a", "REMOVE").error!, /OFF/);
  assert.equal(f.select("b", "ADD").ok, true); near(f.sample(), .3);
  assert.equal(f.select("a").ok, true); assert.deepEqual(f.selected(), ["a", "b"]); near(f.sample(), .3);
  f.select("b", "REMOVE"); near(f.sample(), .1);
  f.select("c"); assert.deepEqual(f.selected(), ["c"]); near(f.sample(), .3);
  f.control.execute({ type: "OUTPUT_SELECTOR_OFF", selectorId: f.selectorId }); near(f.sample(), 0);
  assert.deepEqual(f.selected(), []);
  assert.equal(f.select("missing").ok, false);
  assert.equal(f.select("a", "TOGGLE").ok, false);
  f.select("b"); f.select("a", "ADD");
  assert.equal(f.bus.selector!.primaryBusId, "b", "the added team is identified independently of source-list order");
  f.select("a"); assert.equal(f.bus.selector!.primaryBusId, "b", "selecting an already playing overlay stays a no-op");
  f.select("b", "REMOVE"); assert.equal(f.bus.selector!.primaryBusId, "a");
});

test("additive ON/OFF changes only the addressed team; OFF clears all", () => {
  const f = fixture({ mode: "ADDITIVE" });
  f.select("a", "TOGGLE"); f.select("b", "TOGGLE"); near(f.sample(), .3);
  f.select("a", "TOGGLE"); assert.deepEqual(f.selected(), ["b"]); near(f.sample(), .2);
  assert.equal(f.select("a", "SWITCH").ok, false);
  f.control.execute({ type: "OUTPUT_SELECTOR_OFF", selectorId: f.selectorId }); near(f.sample(), 0);
});

test("sample-level equal-power, continuous interrupted SWITCH/ADD/REMOVE/OFF and additive toggles", () => {
  const selector = new OutputSelector("SWITCH", 10, ["a", "b", "c"], ["a"]);
  const pcm = new Float32Array([.1]), target = new Float32Array(1);
  const render = () => { target.fill(0); selector.mix(target, [pcm, pcm, pcm]); return target[0]; };
  selector.operate("b", "SWITCH", 48000);
  for (let sample = 0; sample <= 480; sample++) {
    render(); near(selector.legs[0].gain ** 2 + selector.legs[1].gain ** 2, 1, 1e-12);
    if (sample === 240) near(selector.legs[0].gain, Math.SQRT1_2, 1e-12);
  }
  near(selector.legs[1].gain, 1);
  for (const operation of ["SWITCH", "ADD", "REMOVE", "OFF"] as const) {
    if (operation === "REMOVE") selector.operate("c", "ADD", 48000);
    for (let n = 0; n < 73; n++) render();
    const previous = render(), gains = selector.legs.map(leg => leg.gain);
    if (operation === "OFF") selector.off(48000);
    else selector.operate(operation === "REMOVE" || operation === "ADD" ? "c" : "a", operation, 48000);
    near(render(), previous, 1e-7);
    selector.legs.forEach((leg, index) => near(leg.gain, gains[index], 1e-12));
  }
  for (let n = 0; n < 482; n++) render(); near(target[0], 0);
  const additive = new OutputSelector("ADDITIVE", 10, ["a"]);
  additive.operate("a", "TOGGLE", 48000);
  for (let n = 0; n < 43; n++) additive.mix(target.fill(0), [pcm]);
  const before = target[0]; additive.operate("a", "TOGGLE", 48000); additive.mix(target.fill(0), [pcm]); near(target[0], before, 1e-9);
});

test("selecting a target during its fade is a true no-op and two teams are not normalized", () => {
  const f = fixture({ fadeMs: 300 });
  f.select("a"); f.sample();
  const leg = { ...f.bus.selector!.legs[0] };
  f.select("a"); assert.deepEqual(f.bus.selector!.legs[0], leg);
  for (let n = 0; n < 301; n++) f.sample();
  f.select("b", "ADD"); for (let n = 0; n < 301; n++) f.sample();
  near(f.sample(), .3);
  f.control.execute({ type: "OUTPUT_SELECTOR_OFF", selectorId: f.selectorId });
  const first = f.sample(); assert.ok(first > .29);
  for (let n = 0; n < 301; n++) f.sample(); near(f.sample(), 0);
});

test("ON AIR selection allowed, structure restricted to SETUP, malformed inputs atomic", () => {
  const f = fixture();
  const create = { type: "CREATE_OUTPUT_SELECTOR", ...config, output: 4 } as const;
  const update = { type: "UPDATE_OUTPUT_SELECTOR", ...config, selectorId: f.selectorId } as const;
  for (const state of ["READY", "ON_AIR", "FAULT"] as const) {
    f.control.state = state;
    for (const command of [create, update, { type: "REMOVE_OUTPUT_SELECTOR", selectorId: f.selectorId, confirmed: true } as const]) assert.equal(f.control.execute(command).ok, false);
  }
  f.control.state = "ON_AIR"; assert.equal(f.select("a").ok, true);
  assert.equal(f.control.execute({ type: "OUTPUT_SELECTOR_OFF", selectorId: f.selectorId }).ok, true);
  f.control.state = "SETUP";
  for (const value of [-1, 2001, NaN]) assert.equal(f.control.execute({ ...update, fadeMs: value }).ok, false);
  for (const sourceBusIds of [["a", "a"], [f.selectorId], ["unknown"]]) assert.equal(f.control.execute({ ...update, sourceBusIds }).ok, false);
  assert.equal(f.control.execute({ ...update, name: "x".repeat(81) }).ok, false);
  assert.equal(f.control.execute({ ...update, output: 15, outputMode: "DUAL_MONO" }).ok, false);
  assert.equal(f.control.execute({ type: "SET_VC_SEND", channelId: "input-a", busId: f.selectorId, db: 0 }).ok, false);
  assert.equal(f.control.execute({ type: "SET_BUS_OUTPUT", busId: f.selectorId, output: 3 }).ok, false);
  assert.equal(f.control.execute({ type: "REMOVE_VC_BUS", busId: f.selectorId, confirmed: true }).ok, false);
});

test("output collision confirmation and MONO/DUAL_MONO use the existing Bus guard", () => {
  const f = fixture(); const command = { type: "CREATE_OUTPUT_SELECTOR", ...config, outputMode: "DUAL_MONO" } as const;
  const size = f.engine.buses.size, routes = f.engine.matrixRoutes.size;
  assert.equal(f.control.execute(command).ok, false);
  assert.equal(f.engine.buses.size, size); assert.equal(f.engine.matrixRoutes.size, routes);
  assert.equal(f.control.execute({ ...command, allowCollision: true }).ok, false);
  const result = f.control.execute({ ...command, allowCollision: true, confirmed: true }); assert.equal(result.ok, true);
  const selectorId = (result.data as any).selectorId;
  f.control.execute({ type: "SELECT_OUTPUT_SELECTOR", selectorId, busId: "b", operation: "SWITCH" });
  f.select("a"); near(f.sample(), .3); near(f.engine.outputs[1][0], .2);
});

test("independent masters, limiter, emergency mute, source mute and deletion", () => {
  const f = fixture(); f.select("a");
  f.control.execute({ type: "SET_BUS_MASTER", busId: f.selectorId, db: -6 }); near(f.sample(), .1 * 10 ** (-6 / 20));
  f.control.execute({ type: "SET_BUS_MUTE", busId: f.selectorId, mute: true }); near(f.sample(), 0);
  f.control.execute({ type: "SET_BUS_MUTE", busId: f.selectorId, mute: false });
  f.engine.buses.get("a")!.mute = true; near(f.sample(), 0); f.engine.buses.get("a")!.mute = false;
  f.control.execute({ type: "EMERGENCY_MUTE", active: true }); f.select("b"); near(f.sample(), 0); near(f.bus.preMaster[0], 0);
  assert.deepEqual(f.selected(), ["b"]);
  f.engine.emergencyMuted = false;
  f.control.execute({ type: "REMOVE_VC_BUS", busId: "b", confirmed: true });
  assert.deepEqual(f.selected(), []); assert.ok(!f.bus.selector!.snapshot().sourceBusIds.includes("b")); near(f.sample(), 0);
  f.control.execute({ type: "SET_BUS_MASTER", busId: f.selectorId, db: 12 }); f.select("c");
  assert.ok(f.sample() <= 10 ** (-1 / 20) + 1e-6);
});

test("Scene restores normal Bus parameters without changing selection", () => {
  const f = fixture(); f.select("a"); f.bus.masterDb = -12;
  const scene = f.control.execute({ type: "SAVE_SCENE", name: "Scene" }).data as { id: string; values: Record<string, unknown> };
  assert.ok(Object.keys(scene.values).includes(`bus.${f.selectorId}.masterDb`));
  assert.ok(!Object.keys(scene.values).some(key => /selector|selected/.test(key.split('.').at(-1)!)));
  f.select("b"); f.bus.masterDb = 0;
  assert.equal(f.control.execute({ type: "RECALL_SCENE", sceneId: scene.id, confirmed: true }).ok, true);
  assert.deepEqual(f.selected(), ["b"]); assert.equal(f.bus.masterDb, -12);
});

test("settings and selected targets restore after a new engine; private queue attaches to commands", async t => {
  const root = mkdtempSync(join(tmpdir(), "parabus-selector-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fixture({ fadeMs: 300, outputMode: "DUAL_MONO" }), store = new OutputSelectorStore(root);
  store.attach(f.control); f.select("a"); f.select("b", "ADD");
  f.control.execute({ type: "SET_BUS_MASTER", busId: f.selectorId, db: -9 });
  await store.flush();
  const engine = new AudioEngine(48000, 48, 16); new OutputSelectorStore(root).restore(engine);
  const restored = engine.buses.get(f.selectorId)!;
  assert.deepEqual(restored.selector!.snapshot(), f.bus.selector!.snapshot()); assert.equal(restored.masterDb, -9);
  assert.deepEqual([...engine.matrixRoutes.values()], [...f.engine.matrixRoutes.values()]);
  assert.deepEqual([...engine.buses.keys()], [...f.engine.buses.keys()]);
  const c = new ControlPlane(engine); store.attach(c);
  c.execute({ type: "REMOVE_VC_BUS", busId: "a", confirmed: true }); await store.flush();
  const again = new AudioEngine(48000, 48, 16); store.restore(again);
  assert.deepEqual(again.buses.get(f.selectorId)!.selector!.snapshot().selectedBusIds, ["b"]);
  assert.equal(again.buses.has("a"), false);
  c.execute({ type: "REMOVE_OUTPUT_SELECTOR", selectorId: f.selectorId, confirmed: true }); await store.flush();
  const empty = new AudioEngine(); store.restore(empty); assert.equal(empty.buses.size, 0);
  writeFileSync(store.path, '{"version":1,"sources":[],"selectors":[{}]}');
  assert.throws(() => store.restore(new AudioEngine()), /JSON/);
});

test("save failures are reported safely and latest state can be retried", async t => {
  const root = mkdtempSync(join(tmpdir(), "parabus-selector-failure-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  let fail = true; const warnings: string[] = [], writes: string[] = [];
  const store = new OutputSelectorStore(root, message => warnings.push(message), async (_path, content) => { if (fail) throw new Error('private backend detail'); writes.push(String(content)); });
  const f = fixture(); store.attach(f.control); f.select("a"); await store.flush();
  assert.ok(warnings.length); assert.ok(!warnings.join().includes('private backend detail'));
  fail = false; f.select("b"); await store.flush(); assert.deepEqual(JSON.parse(writes.at(-1)!).selectors[0].selectedBusIds, ["b"]);
});

test("group, Cue and Advanced Matrix remain independent of selector choices", () => {
  const f = fixture();
  assert.equal(f.control.execute({ type: "CREATE_VC_BUS", name: "Group", groupSourceIds: ["a", "b"] }).ok, true);
  f.engine.addMatrixRoute({ id: "group-route", sourceId: "group", output: 4, gainDb: 0, mute: false, tap: "POST" });
  f.engine.setMonitorSource("group"); f.engine.setMonitorOutput(6, "MONO");
  f.engine.addMatrixRoute({ id: "advanced", sourceId: "a", output: 8, gainDb: -6, mute: false, tap: "POST" });
  f.select("c"); near(f.sample(), .3); near(f.engine.outputs[4][0], .3); near(f.engine.outputs[6][0], .3); near(f.engine.outputs[8][0], .1 * 10 ** (-6 / 20));
  assert.equal(f.control.execute({ type: "UPDATE_OUTPUT_SELECTOR", ...config, selectorId: f.selectorId, sourceBusIds: ["group"] }).ok, false);
  assert.equal(f.control.execute({ type: "SET_GROUP_BUS_SOURCES", busId: "group", sourceBusIds: [f.selectorId] }).ok, false);
  f.control.execute({ type: "OUTPUT_SELECTOR_OFF", selectorId: f.selectorId }); near(f.sample(), 0); near(f.engine.outputs[4][0], .3); near(f.engine.outputs[6][0], .3);
});

test("eight selectors do not reduce the 32-Bus allowance and all can be recorded", async t => {
  const f = fixture();
  for (let i = 1; i < 8; i++) assert.equal(f.control.execute({ type: "CREATE_OUTPUT_SELECTOR", ...config, name: `Selector ${i}`, output: i }).ok, true);
  assert.equal(f.control.execute({ type: "CREATE_OUTPUT_SELECTOR", ...config, output: 9 }).ok, false);
  for (let i = 3; i < 32; i++) f.engine.addBus(new VcBus(`bus-${i}`, `Bus ${i}`, 48));
  assert.equal(f.engine.buses.size, 40);
  const selection = { outputs: [], busIds: [...f.engine.buses.keys()], channelIds: [] };
  assert.equal(isRecorderSelection(selection), true);
  const root = mkdtempSync(join(tmpdir(), "parabus-selector-record-")); const recorder = new RecorderManager(f.engine, root);
  t.after(async () => { await recorder.close(); rmSync(root, { recursive: true, force: true }); });
  recorder.start({ matrixOutput: 0, includeUsers: false, includeBuses: true, selection });
  f.select("a"); f.sample(); recorder.captureBlock();
  const track = recorder.tracks.find(track => track.sourceId === f.selectorId)!; assert.ok(track);
  recorder.stop(); await recorder.waitForIdle();
  assert.ok(readFileSync(join(root, track.fileName)).length > 44);
});

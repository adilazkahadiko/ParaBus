import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AudioEngine, VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { OutputSelectorStore } from "../services/router-core-sim/src/output-selector-store.ts";

const now = () => new Date("2026-11-27T12:34:56.789Z");
const recovery = { now, protect() {}, rename: renameSync };
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "parabus-selector-recovery-"));
  t.after(() => { assert.ok(root.startsWith(join(tmpdir(), "parabus-selector-recovery-"))); rmSync(root, { recursive: true, force: true }); });
  const warnings: string[] = [];
  return { root, warnings, store: new OutputSelectorStore(root, message => warnings.push(message), undefined, recovery) };
}
async function seed(store: OutputSelectorStore) {
  const engine = new AudioEngine(); engine.addBus(new VcBus("a", "Team A", 480));
  const control = new ControlPlane(engine);
  assert.equal(control.execute({ type: "CREATE_OUTPUT_SELECTOR", name: "Director", output: 0, outputMode: "MONO", mode: "SWITCH", sourceBusIds: ["a"] }).ok, true);
  await store.save(engine); await store.flush();
  return JSON.parse(readFileSync(store.path, "utf8"));
}

for (const scenario of ["json", "validation", "oversize", "selector collision", "route collision", "source collision"] as const) {
  test(`invalid selector settings recover atomically without aborting startup: ${scenario}`, async t => {
    const f = fixture(t), saved = await seed(f.store), engine = new AudioEngine();
    if (scenario === "selector collision") engine.addBus(new VcBus(saved.selectors[0].id, "Existing", 480));
    if (scenario === "route collision") engine.addMatrixRoute({ ...saved.selectors[0].routes[0], sourceId: "existing-source" });
    if (scenario === "source collision") { const bus = new VcBus("a", "Existing group", 480); bus.groupSourceIds = []; engine.addBus(bus); }
    const bytes = scenario === "json" ? "{broken-private-detail" : scenario === "validation" ? '{"version":2}' : scenario === "oversize" ? " ".repeat(1_048_577) : JSON.stringify(saved);
    writeFileSync(f.store.path, bytes);
    const before = [...engine.buses.keys()], routes = [...engine.matrixRoutes.keys()];
    assert.doesNotThrow(() => f.store.restore(engine));
    assert.deepEqual([...engine.buses.keys()], before); assert.deepEqual([...engine.matrixRoutes.keys()], routes);
    const backup = "output-selectors.json.invalid-2026-11-27T12-34-56.789Z";
    assert.equal(readFileSync(join(f.root, backup), "utf8"), bytes); assert.equal(existsSync(f.store.path), false);
    assert.match(f.warnings[0], /出力セレクターの設定を読み込めなかったため、セレクターなしで起動しました。/);
    assert.ok(f.warnings[0].includes(backup)); assert.ok(!f.warnings[0].includes("broken-private-detail"));
    await f.store.save(engine); await f.store.flush();
    assert.equal(JSON.parse(readFileSync(f.store.path, "utf8")).selectors.length, 0);
    assert.equal(readFileSync(join(f.root, backup), "utf8"), bytes);
  });
}

test("quarantine keeps preexisting UTC backups and does not overwrite evidence", t => {
  const f = fixture(t), backup = join(f.root, "output-selectors.json.invalid-2026-11-27T12-34-56.789Z");
  writeFileSync(backup, "previous"); writeFileSync(f.store.path, "broken");
  f.store.restore(new AudioEngine());
  assert.equal(readFileSync(backup, "utf8"), "previous");
  const backups = readdirSync(f.root).filter(name => name.startsWith("output-selectors.json.invalid-"));
  assert.equal(backups.length, 2); assert.ok(backups.some(name => readFileSync(join(f.root, name), "utf8") === "broken"));
});

for (const step of ["rename", "protect"] as const) test(`failed quarantine ${step} continues startup and blocks all subsequent saves`, async t => {
  const f = fixture(t); writeFileSync(f.store.path, "broken-original");
  let writes = 0;
  const store = new OutputSelectorStore(f.root, message => f.warnings.push(message), async () => { writes++; },
    { ...recovery, [step]: () => { throw new Error("private-backend-error"); } });
  const engine = new AudioEngine(), control = new ControlPlane(engine); store.attach(control);
  assert.doesNotThrow(() => store.restore(engine));
  engine.addBus(new VcBus("a", "Team A", 480));
  control.execute({ type: "CREATE_OUTPUT_SELECTOR", name: "New", mode: "SWITCH", outputMode: "MONO", output: 0, sourceBusIds: ["a"] });
  await store.save(engine); await store.flush();
  assert.equal(writes, 0); assert.equal(readFileSync(store.path, "utf8"), "broken-original");
  assert.equal(f.warnings.length, 1); assert.match(f.warnings[0], /上書き保存しません/); assert.doesNotMatch(f.warnings[0], /private-backend-error/);
});

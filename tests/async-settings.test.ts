import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SceneStore, SCENE_SAVE_WARNING } from "../services/router-core-sim/src/scene-store.ts";
import { ReceiverOwnershipStore, RECEIVER_SAVE_WARNING } from "../services/router-core-sim/src/receiver-ownership-store.ts";
import { writePrivateFile } from "../services/router-core-sim/src/private-files.ts";

const scene = (name: string) => ({ id: "fixture", name, createdAt: "2026-11-21T00:00:00Z", values: { "bus.fixture.faderDb": -6 } });
function root(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "async-settings-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("scene saves yield immediately and serialize overlapping requests with the final state on disk", async t => {
  const directory = root(t); let release!: () => void, active = 0, maximum = 0, writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const store = new SceneStore(directory, () => assert.fail("unexpected warning"), async (path, content) => {
    maximum = Math.max(maximum, ++active);
    if (writes++ === 0) await gate;
    await writePrivateFile(path, content); active--;
  });
  const first = store.save([scene("first")], "fixture");
  await Promise.resolve();
  assert.equal(existsSync(store.path), false);
  const pending: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) pending.push(store.save([scene(`latest-${i}`)], "fixture"));
  const shutdownFlush = store.flush(); let drained = false;
  void shutdownFlush.then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  assert.equal(store.snapshot().scenes[0].name, "latest-19");
  release(); await Promise.all([first, ...pending, shutdownFlush]);
  assert.equal(maximum, 1); assert.equal(new SceneStore(directory).snapshot().scenes[0].name, "latest-19");
});

test("scene disk errors warn without undoing the active state and can be retried", async t => {
  const directory = root(t), warnings: string[] = []; let fail = true;
  await new SceneStore(directory).save([scene("old disk")], "fixture");
  const store = new SceneStore(directory, m => warnings.push(m), async (path, content) => {
    if (fail) throw new Error("simulated permission failure");
    await writePrivateFile(path, content);
  });
  await store.save([scene("active state")], "fixture"); await store.flush();
  assert.deepEqual(warnings, [SCENE_SAVE_WARNING]);
  assert.equal(store.snapshot().scenes[0].name, "active state");
  assert.equal(new SceneStore(directory).snapshot().scenes[0].name, "old disk");
  fail = false; await store.flush();
  assert.equal(new SceneStore(directory).snapshot().scenes[0].name, "active state");
});

test("receiver updates do not block control and shutdown flush keeps the last owner without concurrent writes", async t => {
  const directory = root(t); let release!: () => void, active = 0, maximum = 0, writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const store = new ReceiverOwnershipStore(directory, () => assert.fail("unexpected warning"), async (path, content) => {
    maximum = Math.max(maximum, ++active);
    if (writes++ === 0) await gate;
    await writePrivateFile(path, content); active--;
  });
  const guild = "1".repeat(18), vc = "2".repeat(18);
  store.set(guild, vc, "RX0"); await Promise.resolve();
  for (let i = 1; i <= 20; i++) store.set(guild, vc, `RX${i}`);
  assert.equal(store.get(guild, vc), "RX20"); assert.equal(existsSync(store.path), false);
  const flush = store.flush(); release(); await flush;
  assert.equal(maximum, 1); assert.equal(new ReceiverOwnershipStore(directory).get(guild, vc), "RX20");
});

test("receiver save failure preserves control state, warns and retains the newest retry state", async t => {
  const directory = root(t), warnings: string[] = []; let fail = true;
  const store = new ReceiverOwnershipStore(directory, m => warnings.push(m), async (path, content) => {
    if (fail) throw new Error("simulated permission failure");
    await writePrivateFile(path, content);
  });
  const guild = "1".repeat(18), vc = "2".repeat(18);
  store.set(guild, vc, "RX1"); await store.flush();
  store.set(guild, vc, "RX2"); await store.flush();
  assert.equal(store.get(guild, vc), "RX2"); assert.deepEqual(warnings, [RECEIVER_SAVE_WARNING]);
  fail = false; await store.flush();
  assert.equal(new ReceiverOwnershipStore(directory).get(guild, vc), "RX2");
});

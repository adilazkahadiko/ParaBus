import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SceneStore } from "../services/router-core-sim/src/scene-store.ts";

test("SceneStore restores saved Scenes and current selection", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dbr-scenes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scene = {
    id: "scene-1",
    name: "Baseline",
    createdAt: "2026-09-26T00:00:00.000Z",
    values: { "channel.user-1.faderDb": -6, "channel.user-1.mute": false },
  };

  new SceneStore(root).save([scene], scene.id);
  assert.deepEqual(new SceneStore(root).snapshot(), { scenes: [scene], currentSceneId: scene.id });
});

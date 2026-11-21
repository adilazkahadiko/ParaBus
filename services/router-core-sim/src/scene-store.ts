import { existsSync, readFileSync } from "node:fs";
import { PrivateFileSaveQueue, writePrivateFile } from "./private-files.ts";
import { join } from "node:path";
import type { SceneSnapshot, SceneValue } from "../../../packages/shared-types/src/index.ts";

const MAX_SCENES = 128;
const MAX_VALUES = 5_000;
export const SCENE_SAVE_WARNING = "シーンのディスク保存に失敗しました。画面の変更は維持していますが、再起動すると失われる場合があります。保存先の権限を確認してください。音声と運用は継続します。";

export interface StoredScenes {
  scenes: SceneSnapshot[];
  currentSceneId: string | null;
}

function sceneValue(value: unknown): value is SceneValue {
  return typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string" && value.length <= 256);
}

function readScene(value: unknown): SceneSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SceneSnapshot>;
  if (typeof raw.id !== "string" || !raw.id || raw.id.length > 128) return null;
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 80) return null;
  if (typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) return null;
  if (!raw.values || typeof raw.values !== "object" || Array.isArray(raw.values)) return null;
  const entries = Object.entries(raw.values);
  if (entries.length > MAX_VALUES || entries.some(([key, entry]) => !key || key.length > 4_096 || !sceneValue(entry))) return null;
  return { id: raw.id, name: raw.name, createdAt: raw.createdAt, values: Object.fromEntries(entries) };
}

function clone(scene: SceneSnapshot): SceneSnapshot {
  return { ...scene, values: { ...scene.values } };
}

export class SceneStore {
  readonly path: string;
  #state: StoredScenes = { scenes: [], currentSceneId: null };
  readonly #saveQueue: PrivateFileSaveQueue;

  constructor(root: string, warn: (message: string) => void = message => console.warn(message), write = writePrivateFile) {
    this.path = join(root, "scenes.json");
    this.#saveQueue = new PrivateFileSaveQueue(this.path, warn, SCENE_SAVE_WARNING, write);
    if (!existsSync(this.path)) return;
    let decoded: { scenes?: unknown; currentSceneId?: unknown };
    try { decoded = JSON.parse(readFileSync(this.path, "utf8")); }
    catch { throw new Error("シーン設定ファイルを読み込めません。JSON形式とアクセス権を確認してください。"); }
    const scenes = Array.isArray(decoded.scenes)
      ? decoded.scenes.slice(0, MAX_SCENES).map(readScene).filter((scene): scene is SceneSnapshot => scene !== null)
      : [];
    const currentSceneId = typeof decoded.currentSceneId === "string" && scenes.some((scene) => scene.id === decoded.currentSceneId)
      ? decoded.currentSceneId
      : null;
    this.#state = { scenes, currentSceneId };
  }

  snapshot(): StoredScenes {
    return { scenes: this.#state.scenes.map(clone), currentSceneId: this.#state.currentSceneId };
  }

  save(scenes: readonly SceneSnapshot[], currentSceneId: string | null): Promise<void> {
    if (scenes.length > MAX_SCENES) throw new Error("Sceneは最大" + MAX_SCENES + "件です");
    const validated = scenes.map(readScene);
    if (validated.some((scene) => scene === null)) throw new Error("Sceneデータが不正です");
    const nextScenes = validated as SceneSnapshot[];
    const nextCurrent = currentSceneId && nextScenes.some((scene) => scene.id === currentSceneId) ? currentSceneId : null;
    this.#state = { scenes: nextScenes.map(clone), currentSceneId: nextCurrent };
    return this.#saveQueue.save(JSON.stringify({ version: 1, scenes: nextScenes, currentSceneId: nextCurrent }, null, 2) + "\n");
  }
  flush(): Promise<void> { return this.#saveQueue.flush(); }
  async saveConfirmed(scenes: readonly SceneSnapshot[], currentSceneId: string | null): Promise<void> {
    await this.save(scenes, currentSceneId);
    await this.#saveQueue.confirmSaved();
  }
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_OUTPUT_SELECTORS, MAX_VC_BUSES, type ControlCommand, type OutputSelectorSnapshot } from "../../../packages/shared-types/src/index.ts";
import { AudioEngine, VcBus, type MatrixRoute } from "./audio-engine.ts";
import type { ControlPlane } from "./control-plane.ts";
import { OutputSelector } from "./output-selector.ts";
import { PrivateFileSaveQueue, writePrivateFile } from "./private-files.ts";

interface SourceIdentity { id: string; label: string; guildId?: string; voiceChannelId?: string; autoCreated: boolean }
interface StoredSelector extends OutputSelectorSnapshot {
  id: string;
  name: string;
  masterDb: number;
  mute: boolean;
  limiterEnabled: boolean;
  limiterCeilingDb: number;
  limiterReleaseMs: number;
  compressor: { enabled: boolean; thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; makeupDb: number };
  routes: MatrixRoute[];
}
interface StoredSelectors { version: 1; sources: SourceIdentity[]; selectors: StoredSelector[] }
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v);
const number = (v: unknown, min: number, max: number): boolean => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 32 && v.every(id) && new Set(v).size === v.length;

function validate(value: StoredSelectors): boolean {
  if (!value || value.version !== 1 || !Array.isArray(value.sources) || value.sources.length > 32 || !Array.isArray(value.selectors) || value.selectors.length > 8) return false;
  const seen = new Set<string>();
  for (const source of value.sources) {
    if (!source || !id(source.id) || seen.has(source.id) || typeof source.label !== "string" || source.label.length > 80 || typeof source.autoCreated !== "boolean"
      || source.guildId !== undefined && (typeof source.guildId !== "string" || !/^\d{1,20}$/.test(source.guildId))
      || source.voiceChannelId !== undefined && (typeof source.voiceChannelId !== "string" || !/^\d{1,20}$/.test(source.voiceChannelId))) return false;
    seen.add(source.id);
  }
  const sourceIds = new Set(seen);
  for (const selector of value.selectors) {
    if (!selector || !/^selector-[a-zA-Z0-9-]{1,80}$/.test(selector.id) || seen.has(selector.id) || typeof selector.name !== "string" || selector.name.length > 80
      || !["SWITCH", "ADDITIVE"].includes(selector.mode) || !number(selector.fadeMs, 0, 2000) || !ids(selector.sourceBusIds) || selector.sourceBusIds.some(id => !sourceIds.has(id))
      || !ids(selector.selectedBusIds) || selector.selectedBusIds.some(id => !selector.sourceBusIds.includes(id)) || !number(selector.masterDb, -90, 12) || typeof selector.mute !== "boolean"
      || typeof selector.limiterEnabled !== "boolean" || !number(selector.limiterCeilingDb, -24, 0) || !number(selector.limiterReleaseMs, 10, 2000)) return false;
    const c = selector.compressor;
    if (selector.primaryBusId !== null && (!id(selector.primaryBusId) || !selector.selectedBusIds.includes(selector.primaryBusId))) return false;
    if (!c || typeof c.enabled !== "boolean" || !number(c.thresholdDb, -60, 0) || !number(c.ratio, 1, 20) || !number(c.attackMs, .1, 200) || !number(c.releaseMs, 10, 2000) || !number(c.makeupDb, -12, 24)) return false;
    if (!Array.isArray(selector.routes) || selector.routes.length > 64 || selector.routes.some(route => !route || !id(route.id) || route.sourceId !== selector.id || !Number.isInteger(route.output) || !number(route.output, 0, 63) || !number(route.gainDb, -90, 12) || typeof route.mute !== "boolean" || !["PRE", "POST"].includes(route.tap))) return false;
    seen.add(selector.id);
  }
  const routes = value.selectors.flatMap(selector => selector.routes.map(route => route.id));
  return new Set(routes).size === routes.length;
}

const SAVED_COMMANDS = new Set<ControlCommand["type"]>([
  "CREATE_OUTPUT_SELECTOR", "UPDATE_OUTPUT_SELECTOR", "REMOVE_OUTPUT_SELECTOR", "SELECT_OUTPUT_SELECTOR", "OUTPUT_SELECTOR_OFF",
  "REMOVE_VC_BUS", "SET_BUS_BINDING", "SET_BUS_MASTER", "SET_BUS_MUTE", "SET_LIMITER", "SET_BUS_COMPRESSOR", "RECALL_SCENE",
]);

export class OutputSelectorStore {
  readonly path: string;
  readonly #queue: PrivateFileSaveQueue;
  constructor(root: string, warn: (message: string) => void = message => console.warn(message), write = writePrivateFile) {
    this.path = join(root, "output-selectors.json");
    this.#queue = new PrivateFileSaveQueue(this.path, warn, "出力セレクターの保存に失敗しました。再起動すると変更が失われる場合があります。保存先の権限を確認してください。", write);
  }

  restore(engine: AudioEngine): void {
    if (!existsSync(this.path)) return;
    let data: StoredSelectors;
    try {
      const text = readFileSync(this.path, "utf8");
      if (Buffer.byteLength(text) > 1_048_576) throw new Error();
      data = JSON.parse(text);
      if (!validate(data)) throw new Error();
      if (data.selectors.some(s => engine.buses.has(s.id) || s.routes.some(r => r.output >= engine.outputChannelCount || engine.matrixRoutes.has(r.id)))) throw new Error();
      if (data.sources.some(s => { const bus = engine.buses.get(s.id); return bus && (bus.selector || bus.groupSourceIds !== null); })) throw new Error();
      const existingSelectors = [...engine.buses.values()].filter(bus => bus.selector).length;
      if (existingSelectors + data.selectors.length > MAX_OUTPUT_SELECTORS || engine.buses.size - existingSelectors + data.sources.filter(source => !engine.buses.has(source.id)).length > MAX_VC_BUSES) throw new Error();
    } catch { throw new Error("出力セレクター設定を読み込めません。JSON形式とアクセス権を確認してください。"); }
    // Referenced source identities must exist before Discord reconnects. No PCM,
    // participants, credentials, or selected-state scene parameters are stored.
    for (const source of data.sources) if (!engine.buses.has(source.id)) {
      const bus = new VcBus(source.id, source.label, engine.blockSize, engine.sampleRate);
      bus.linkedDiscordGuildId = source.guildId; bus.linkedDiscordVoiceChannelId = source.voiceChannelId; bus.autoCreated = source.autoCreated;
      engine.addBus(bus);
    }
    for (const saved of data.selectors) {
      const bus = new VcBus(saved.id, saved.name, engine.blockSize, engine.sampleRate);
      bus.selector = new OutputSelector(saved.mode, saved.fadeMs, saved.sourceBusIds, saved.selectedBusIds, saved.primaryBusId);
      bus.masterDb = saved.masterDb; bus.mute = saved.mute;
      bus.limiter.enabled = saved.limiterEnabled; bus.limiter.ceilingDb = saved.limiterCeilingDb; bus.limiter.releaseMs = saved.limiterReleaseMs;
      bus.compressorEnabled = saved.compressor.enabled;
      const c = saved.compressor;
      Object.assign(bus.compressor, { thresholdDb: c.thresholdDb, ratio: c.ratio, attackMs: c.attackMs, releaseMs: c.releaseMs, makeupDb: c.makeupDb });
      engine.addBus(bus);
      for (const route of saved.routes) engine.addMatrixRoute(route);
    }
  }

  attach(control: ControlPlane): () => void {
    return control.onCommand(command => { if (SAVED_COMMANDS.has(command.type)) void this.save(control.engine); });
  }

  save(engine: AudioEngine): Promise<void> {
    const sourceIds = new Set<string>();
    const selectors: StoredSelector[] = [];
    for (const bus of engine.buses.values()) if (bus.selector) {
      const state = bus.selector.snapshot();
      for (const id of state.sourceBusIds) sourceIds.add(id);
      const c = bus.compressor;
      selectors.push({ ...state, id: bus.id, name: bus.label, masterDb: bus.masterDb, mute: bus.mute,
        limiterEnabled: bus.limiter.enabled, limiterCeilingDb: bus.limiter.ceilingDb, limiterReleaseMs: bus.limiter.releaseMs,
        compressor: { enabled: bus.compressorEnabled, thresholdDb: c.thresholdDb, ratio: c.ratio, attackMs: c.attackMs, releaseMs: c.releaseMs, makeupDb: c.makeupDb },
        routes: [...engine.matrixRoutes.values()].filter(route => route.sourceId === bus.id).map(route => ({ ...route })) });
    }
    const sources = [...sourceIds].flatMap(id => {
      const bus = engine.buses.get(id);
      return bus ? [{ id, label: bus.label, guildId: bus.linkedDiscordGuildId, voiceChannelId: bus.linkedDiscordVoiceChannelId, autoCreated: bus.autoCreated }] : [];
    });
    return this.#queue.save(JSON.stringify({ version: 1, sources, selectors } satisfies StoredSelectors, null, 2) + "\n");
  }
  flush(): Promise<void> { return this.#queue.flush(); }
}

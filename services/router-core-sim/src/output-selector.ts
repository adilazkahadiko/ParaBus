import type { OutputSelectorSnapshot, SelectorMode, SelectorOperation } from "../../../packages/shared-types/src/index.ts";

export interface SelectorLeg {
  id: string;
  gain: number;
  start: number;
  target: number;
}

/** Control changes capture the last rendered sample, never a previous target.
 * Squared-gain interpolation with sin² easing gives sin/cos equal-power fades
 * for a full crossfade, and preserves continuity when interrupted. */
export class OutputSelector {
  mode: SelectorMode;
  fadeMs: number;
  readonly legs: SelectorLeg[];
  primaryBusId: string | null;
  #elapsed = 0;
  #duration = 0;

  constructor(mode: SelectorMode, fadeMs: number, sourceIds: readonly string[], selected: readonly string[] = [], primaryBusId: string | null = selected[0] ?? null) {
    this.mode = mode;
    this.fadeMs = fadeMs;
    this.legs = sourceIds.map(id => ({ id, gain: selected.includes(id) ? 1 : 0, start: selected.includes(id) ? 1 : 0, target: selected.includes(id) ? 1 : 0 }));
    this.primaryBusId = mode === "SWITCH" ? this.legs.find(leg => leg.id === primaryBusId && leg.target)?.id ?? this.legs.find(leg => leg.target)?.id ?? null : null;
  }

  snapshot(): OutputSelectorSnapshot {
    return { mode: this.mode, fadeMs: this.fadeMs, sourceBusIds: this.legs.map(leg => leg.id), selectedBusIds: this.legs.filter(leg => leg.target === 1).map(leg => leg.id), primaryBusId: this.primaryBusId };
  }

  continueFrom(previous: OutputSelector, sampleRate: number): void {
    for (const leg of this.legs) leg.gain = previous.legs.find(candidate => candidate.id === leg.id)?.gain ?? 0;
    this.#retarget(sampleRate);
  }

  removeSource(busId: string): void {
    const index = this.legs.findIndex(leg => leg.id === busId);
    if (index >= 0) this.legs.splice(index, 1);
    if (this.primaryBusId === busId) this.primaryBusId = this.legs.find(leg => leg.target)?.id ?? null;
  }

  operate(busId: string, operation: SelectorOperation, sampleRate: number): boolean {
    const leg = this.legs.find(leg => leg.id === busId);
    if (!leg) throw new Error("選択できるVC Busではありません");
    if ((this.mode === "ADDITIVE") !== (operation === "TOGGLE")) throw new Error("セレクターの動きと操作が一致しません");
    if (operation === "SWITCH" && leg.target === 1) return false;
    if (operation === "ADD" && leg.target === 1 || operation === "REMOVE" && leg.target === 0) return false;
    if (operation === "REMOVE" && this.legs.filter(candidate => candidate.target === 1).length <= 1) throw new Error("最後の1チームは外せません。OFFを使ってください");
    if (operation === "SWITCH") for (const candidate of this.legs) candidate.target = 0;
    leg.target = operation === "REMOVE" ? 0 : operation === "TOGGLE" ? 1 - leg.target : 1;
    if (this.mode === "SWITCH") {
      if (operation === "SWITCH" || !this.primaryBusId) this.primaryBusId = busId;
      if (operation === "REMOVE" && this.primaryBusId === busId) this.primaryBusId = this.legs.find(leg => leg.target)?.id ?? null;
    }
    this.#retarget(sampleRate);
    return true;
  }

  off(sampleRate: number): boolean {
    if (!this.legs.some(leg => leg.target !== 0)) return false;
    for (const leg of this.legs) leg.target = 0;
    this.primaryBusId = null;
    this.#retarget(sampleRate);
    return true;
  }

  #retarget(sampleRate: number): void {
    this.#elapsed = 0;
    this.#duration = Math.round(this.fadeMs * sampleRate / 1000);
    for (const leg of this.legs) {
      leg.start = leg.gain;
      if (!this.#duration) leg.gain = leg.target;
    }
  }

  /** Fixed plan arrays; no allocations, Map lookups or topology changes in the callback. */
  mix(target: Float32Array, sources: readonly (Float32Array | null)[]): void {
    if (this.#elapsed >= this.#duration) {
      for (let source = 0; source < this.legs.length; source++) {
        const leg = this.legs[source];
        const pcm = sources[source], gain = leg.gain = leg.target;
        if (!pcm || !gain) continue;
        for (let frame = 0; frame < target.length; frame++) target[frame] += pcm[frame] * gain;
      }
      return;
    }
    for (let frame = 0; frame < target.length; frame++) {
      // First sample repeats the last rendered gain, including after retargeting.
      const progress = Math.min(1, this.#elapsed / this.#duration);
      const weight = Math.sin(progress * Math.PI / 2) ** 2;
      for (let source = 0; source < this.legs.length; source++) {
        const leg = this.legs[source];
        leg.gain = Math.sqrt(Math.max(0, leg.start ** 2 * (1 - weight) + leg.target ** 2 * weight));
        const pcm = sources[source];
        if (pcm) target[frame] += pcm[frame] * leg.gain;
      }
      this.#elapsed++;
    }
    // Keep the exact last rendered sample until the next block, even at the end.
  }
}

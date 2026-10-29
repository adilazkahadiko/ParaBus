export type HistogramWindow = { slot: number; startedAt: string; durationMs: number; samples: number; maxMs: number; p50Ms: number; p95Ms: number; p99Ms: number };

/** Fixed rings only on the hot path. Dates, arrays and percentile scans are snapshot-only. */
export class WindowHistogram {
  readonly origin: number;
  readonly epoch = Date.now();
  readonly widthMs: number;
  readonly resolutionMs: number;
  readonly slots: number;
  readonly bins: number;
  readonly ids: Float64Array;
  readonly samples: Float64Array;
  readonly maxima: Float64Array;
  readonly highestBin: Uint32Array;
  readonly buckets: Uint32Array;
  readonly bucketIds: Float64Array;
  #cache: Array<HistogramWindow | undefined>;
  #cacheIds: Float64Array;

  constructor(widthMs: number, slots: number, resolutionMs: number, maximumMs: number, origin: number) {
    this.origin = origin; this.widthMs = widthMs; this.slots = slots; this.resolutionMs = resolutionMs;
    this.bins = Math.ceil(maximumMs / resolutionMs) + 2;
    this.ids = new Float64Array(slots).fill(-1);
    this.samples = new Float64Array(slots);
    this.maxima = new Float64Array(slots);
    this.highestBin = new Uint32Array(slots);
    this.buckets = new Uint32Array(slots * this.bins);
    this.bucketIds = new Float64Array(slots * this.bins).fill(-1);
    this.#cache = new Array(slots); this.#cacheIds = new Float64Array(slots).fill(-1);
  }

  record(value: number, now: number): number {
    const id = Math.max(0, Math.floor((now - this.origin) / this.widthMs)), slot = id % this.slots;
    if (this.ids[slot] !== id) {
      this.ids[slot] = id; this.samples[slot] = 0; this.maxima[slot] = 0; this.highestBin[slot] = 0;
    }
    const bin = Math.min(this.bins - 1, Math.ceil(Math.max(0, value) / this.resolutionMs));
    const index = slot * this.bins + bin;
    if (this.bucketIds[index] !== id) { this.bucketIds[index] = id; this.buckets[index] = 0; }
    this.buckets[index] += 1; this.samples[slot] += 1;
    this.maxima[slot] = Math.max(this.maxima[slot], value);
    this.highestBin[slot] = Math.max(this.highestBin[slot], bin);
    return slot;
  }

  percentile(slot: number, fraction: number): number {
    const target = Math.ceil(this.samples[slot] * fraction);
    let count = 0;
    for (let bin = 0; bin <= this.highestBin[slot]; bin++) {
      const index = slot * this.bins + bin;
      if (this.bucketIds[index] === this.ids[slot]) count += this.buckets[index];
      if (count >= target) return bin === this.bins - 1 ? this.maxima[slot] : Math.min(this.maxima[slot], bin * this.resolutionMs);
    }
    return 0;
  }

  windows(now: number) {
    const current = Math.max(0, Math.floor((now - this.origin) / this.widthMs));
    const result: HistogramWindow[] = [];
    for (let id = Math.max(0, current - this.slots + 1); id <= current; id++) {
      const slot = id % this.slots;
      if (this.ids[slot] !== id || !this.samples[slot]) continue;
      const durationMs = Math.min(this.widthMs, Math.max(0, now - this.origin - id * this.widthMs));
      let cached = this.#cache[slot];
      if (this.#cacheIds[slot] !== id || cached?.samples !== this.samples[slot] || cached.durationMs !== durationMs) {
        cached = { slot, startedAt: new Date(this.epoch + id * this.widthMs).toISOString(), durationMs, samples: this.samples[slot], maxMs: this.maxima[slot],
          p50Ms: this.percentile(slot, 0.5), p95Ms: this.percentile(slot, 0.95), p99Ms: this.percentile(slot, 0.99) };
        this.#cache[slot] = cached; this.#cacheIds[slot] = id;
      }
      result.push(cached);
    }
    return result;
  }
}

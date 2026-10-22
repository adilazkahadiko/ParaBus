import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import type { AudioRuntimeTimingSnapshot, AudioRuntimeWindow } from "../../../packages/shared-types/src/index.ts";

export class AudioRuntimeTiming {
  #histogram: Pick<IntervalHistogram, "enable" | "disable" | "reset" | "percentile" | "count" | "max">;
  #startedAt = Date.now();
  #windowStart = performance.now();
  #processMax = 0;
  #blocks = 0;
  #windows: AudioRuntimeWindow[] = [];

  constructor(histogram: Pick<IntervalHistogram, "enable" | "disable" | "reset" | "percentile" | "count" | "max"> = monitorEventLoopDelay({ resolution: 20 })) {
    this.#histogram = histogram;
    histogram.enable();
  }

  recordBlock(durationMs: number): void {
    this.#processMax = Math.max(this.#processMax, durationMs);
    this.#blocks++;
  }

  private current(now = performance.now()): AudioRuntimeWindow {
    return {
      startedAt: new Date(this.#startedAt).toISOString(), durationMs: Math.max(0, now - this.#windowStart),
      eventLoopP99Ms: this.#histogram.count ? this.#histogram.percentile(99) / 1e6 : 0,
      eventLoopMaxMs: this.#histogram.count ? this.#histogram.max / 1e6 : 0,
      processBlockMaxMs: this.#processMax, processBlocks: this.#blocks,
    };
  }

  finishWindow(now = performance.now()): AudioRuntimeWindow {
    const window = this.current(now);
    if (this.#windows.length === 30) this.#windows.shift();
    this.#windows.push(window);
    this.#histogram.reset();
    this.#startedAt += window.durationMs; this.#windowStart = now;
    this.#processMax = 0; this.#blocks = 0;
    return window;
  }

  snapshot(): AudioRuntimeTimingSnapshot { return { resolutionMs: 20, current: this.current(), windows: this.#windows.slice() }; }
  close(): void { this.#histogram.disable(); }
}

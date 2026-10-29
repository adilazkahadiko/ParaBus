import type { AudioOutputTimingSnapshot, AudioSchedulerTimingSnapshot, AudioRuntimeWindow } from "../../../packages/shared-types/src/index.ts";

import { RtpTiming, type PacketProvenance, type GapKind } from "./rtp-timing.ts";

import { WindowHistogram, type HistogramWindow } from "./window-histogram.ts";
export { WindowHistogram } from "./window-histogram.ts";

export class OutputWriteTiming {
  readonly startedAt: number;
  readonly epoch = Date.now();
  #stoppedAt: number | null = null;
  #ids = new Float64Array(60).fill(-1);
  #counts = new Float64Array(60);
  #min = new Float64Array(60);
  #max = new Float64Array(60);
  #sum = new Float64Array(60);
  #callbackMax = new Float64Array(60);
  #callbackCounts = new Float64Array(60);
  #drops = new Float64Array(20);
  #dropCount = 0;
  correctionAddedFrames = 0;
  correctionRemovedFrames = 0;
  primingFrames = 0;
  #nominalFrames = 0;
  #backlogEwma = 1.5;

  constructor(now = performance.now()) { this.startedAt = now; }

  private slot(now: number): number {
    const id = Math.max(0, Math.floor((now - this.startedAt) / 10_000)), slot = id % 60;
    if (this.#ids[slot] !== id) {
      this.#ids[slot] = id; this.#counts[slot] = 0; this.#sum[slot] = 0;
      this.#min[slot] = Infinity; this.#max[slot] = 0; this.#callbackMax[slot] = 0; this.#callbackCounts[slot] = 0;
    }
    return slot;
  }

  observeInFlight(inFlight: number, now: number): void {
    const slot = this.slot(now);
    this.#counts[slot] += 1; this.#sum[slot] += inFlight;
    this.#min[slot] = Math.min(this.#min[slot], inFlight); this.#max[slot] = Math.max(this.#max[slot], inFlight);
  }

  callback(elapsedMs: number, now: number): void {
    const slot = this.slot(now);
    this.#callbackMax[slot] = Math.max(this.#callbackMax[slot], elapsedMs); this.#callbackCounts[slot] += 1;
  }

  drop(now: number): void { this.#drops[this.#dropCount++ % 20] = now; }
  correction(adjustment: number, nominalFrames: number, backlogEwma: number): void {
    this.correctionAddedFrames += Math.max(0, adjustment);
    this.correctionRemovedFrames += Math.max(0, -adjustment);
    this.#nominalFrames += nominalFrames;
    this.#backlogEwma = backlogEwma;
  }
  stop(now: number): void { this.#stoppedAt ??= now; }

  snapshot(framesWritten: number, inFlight: number, now = performance.now()): AudioOutputTimingSnapshot {
    const end = this.#stoppedAt ?? now, current = Math.max(0, Math.floor((end - this.startedAt) / 10_000));
    const windows: AudioOutputTimingSnapshot["windows"] = [];
    for (let id = Math.max(0, current - 59); id <= current; id++) {
      const slot = id % 60;
      if (this.#ids[slot] !== id) continue;
      windows.push({ startedAt: new Date(this.epoch + id * 10_000).toISOString(), durationMs: Math.min(10_000, Math.max(0, end - this.startedAt - id * 10_000)), samples: this.#counts[slot],
        inFlightMin: this.#counts[slot] ? this.#min[slot] : null, inFlightMax: this.#max[slot], inFlightMean: this.#counts[slot] ? this.#sum[slot] / this.#counts[slot] : null,
        callbackCount: this.#callbackCounts[slot], callbackMaxMs: this.#callbackMax[slot] });
    }
    const backpressureDropTimes: string[] = [];
    for (let i = Math.max(0, this.#dropCount - 20); i < this.#dropCount; i++) backpressureDropTimes.push(new Date(this.epoch + this.#drops[i % 20] - this.startedAt).toISOString());
    return { measurement: "js-write-completion-not-playback", startedAt: new Date(this.epoch).toISOString(), elapsedMs: Math.max(0, end - this.startedAt), framesWritten, inFlight, windows, backpressureDropTimes,
      correctionAddedFrames: this.correctionAddedFrames, correctionRemovedFrames: this.correctionRemovedFrames, primingFrames: this.primingFrames, backlogEwma: this.#backlogEwma,
      estimatedPpm: this.#nominalFrames ? (this.correctionAddedFrames - this.correctionRemovedFrames) / this.#nominalFrames * 1_000_000 : 0 };
  }
}

export class RxQueueTiming {
  readonly sampleRate: number;
  #clock: () => number;
  #histogram: WindowHistogram;
  #lastPacketAt = -Infinity;
  #lastUnderrunAt = -Infinity;
  #packetJitter: WindowHistogram;
  #fillJitter: WindowHistogram;
  readonly rtp: RtpTiming;
  #lastArrivalAt = -Infinity;
  #lastFillAt = -Infinity;
  // Fixed storage on the audio path. Overflow is explicit, never silently misclassified.
  #pendingAt = new Float64Array(256);
  #pendingAge = new Float64Array(256);
  #pendingQueue = new Float64Array(256);
  #pendingHead = 0;
  #pendingCount = 0;
  #recent = Array.from({ length: 50 }, () => ({ at: 0, previousPacketAgeMs: 0, nextPacketDelayMs: 0, queuedBeforeMs: 0, queuedAfterPacketMs: 0, classification: "unknown" as GapKind, gapSerial: 0 }));
  #recentCount = 0;
  #resumedFrom = 0;
  #classifiedGapSerial = 0;
  #classifiedGapCount = 0;
  #windows: Array<{ source: HistogramWindow; window: Omit<HistogramWindow, "slot" | "p99Ms"> } | undefined> = new Array(30);
  underruns = 0;
  overflowsAfterUnderrun = 0;
  silenceBlocksDropped = 0;
  compressedSamples = 0;
  inSpeechUnderruns = 0;
  inSpeechByKind: Record<GapKind, number> = { loss: 0, senderPause: 0, delayed: 0, fillBurst: 0, unknown: 0 };
  microInSpeechUnderruns = 0;
  endOfSpeechUnderruns = 0;
  unclassifiedUnderruns = 0;
  packetJitterExcludedGaps = 0;

  constructor(sampleRate: number, maximumQueueMs: number, clock = () => performance.now()) {
    this.sampleRate = sampleRate; this.#clock = clock;
    this.#histogram = new WindowHistogram(60_000, 30, 1, maximumQueueMs, clock());
    this.#packetJitter = new WindowHistogram(60_000, 30, 1, 250, this.#histogram.origin);
    this.#fillJitter = new WindowHistogram(60_000, 30, 1, 250, this.#histogram.origin);
    this.rtp = new RtpTiming(this.#histogram.origin);
  }

  /** Exactly once per accepted Opus packet, before decoding (not the PCM enqueue callback). */
  observePacket(now: number, queuedSamples: number, provenance?: PacketProvenance): void {
    const evidence = this.rtp.observe(provenance, now);
    if (evidence.confirmedSerial === this.#classifiedGapSerial) {
      this.inSpeechByKind.unknown -= this.#classifiedGapCount; this.inSpeechByKind.delayed += this.#classifiedGapCount;
    }
    if (evidence.confirmedSerial !== null) for (const event of this.#recent) {
      if (event.gapSerial === evidence.confirmedSerial && event.classification === "unknown") { event.classification = "delayed"; }
    }
    this.expirePending(now);
    const gap = now - this.#lastArrivalAt;
    if (Number.isFinite(gap) && gap >= 0) {
      if (gap <= 200) this.#packetJitter.record(Math.abs(gap - 20), now);
      else this.packetJitterExcludedGaps++;
    }
    this.#lastArrivalAt = now;
    this.#resumedFrom = this.#recentCount;
    this.#classifiedGapSerial = evidence.serial; this.#classifiedGapCount = this.#pendingCount;
    while (this.#pendingCount) {
      const slot = this.#pendingHead;
      const event = this.#recent[this.#recentCount++ % 50];
      event.classification = evidence.kind; event.gapSerial = evidence.serial;
      event.at = this.#pendingAt[slot]; event.previousPacketAgeMs = this.#pendingAge[slot];
      event.nextPacketDelayMs = now - event.at; event.queuedBeforeMs = this.#pendingQueue[slot];
      event.queuedAfterPacketMs = queuedSamples / this.sampleRate * 1000;
      this.inSpeechUnderruns++; this.inSpeechByKind[evidence.kind]++;
      if (event.queuedBeforeMs <= .5 && event.previousPacketAgeMs <= 20) this.microInSpeechUnderruns++;
      this.#pendingHead = (slot + 1) % 256; this.#pendingCount--;
    }
  }

  /** Complete the resuming packet's queue measurement after PCM enqueue; no PCM is touched. */
  observeQueued(queuedSamples: number): void {
    for (let i = Math.max(this.#resumedFrom, this.#recentCount - 50); i < this.#recentCount; i++) {
      this.#recent[i % 50].queuedAfterPacketMs = queuedSamples / this.sampleRate * 1000;
    }
  }

  /** Once at entry to DiscordPcmSource.fill, including prefill and silence. */
  observeFill(now: number, nominalIntervalMs: number): void {
    if (Number.isFinite(this.#lastFillAt)) this.#fillJitter.record(Math.abs(now - this.#lastFillAt - nominalIntervalMs), now);
    this.#lastFillAt = now;
    this.expirePending(now);
  }

  private expirePending(now: number): void {
    while (this.#pendingCount && now - this.#pendingAt[this.#pendingHead] > 200) {
      this.endOfSpeechUnderruns++;
      this.#pendingHead = (this.#pendingHead + 1) % 256; this.#pendingCount--;
    }
  }

  packet(receivedAt = this.#clock()): void { this.#lastPacketAt = receivedAt; }
  fill(queuedSamples: number, blockSamples: number, playing = true): void {
    const now = this.#clock();
    this.#histogram.record(queuedSamples / this.sampleRate * 1000, now);
    const age = now - this.#lastPacketAt;
    if (playing && age >= 0 && age <= 200 && queuedSamples < blockSamples) {
      this.underruns += 1; this.#lastUnderrunAt = now;
      this.expirePending(now);
      if (this.#pendingCount === 256) this.unclassifiedUnderruns++;
      else {
        const slot = (this.#pendingHead + this.#pendingCount++) % 256;
        this.#pendingAt[slot] = now; this.#pendingAge[slot] = age;
        this.#pendingQueue[slot] = queuedSamples / this.sampleRate * 1000;
      }
    }
  }
  overflow(): void {
    const gap = this.#clock() - this.#lastUnderrunAt;
    if (gap >= 0 && gap <= 2_000) this.overflowsAfterUnderrun += 1;
  }
  snapshot(includeDetails = true) {
    const histogram = this.#histogram;
    const now = this.#clock();
    this.expirePending(now);
    const jitterWindows = (value: WindowHistogram) => value.windows(now).map(({ slot, ...window }) => window);
    const recentInSpeechUnderruns = [];
    for (let i = includeDetails ? Math.max(0, this.#recentCount - 50) : this.#recentCount; i < this.#recentCount; i++) {
      const event = this.#recent[i % 50];
      const { gapSerial, ...publicEvent } = event;
      recentInSpeechUnderruns.push({ ...publicEvent, at: new Date(histogram.epoch + event.at - histogram.origin).toISOString() });
    }
    return { inSpeechByKind: { ...this.inSpeechByKind }, microInSpeechUnderruns: this.microInSpeechUnderruns, rtp: this.rtp.snapshot(now, includeDetails), underruns: this.underruns, overflowsAfterUnderrun: this.overflowsAfterUnderrun,
      inSpeechUnderruns: this.inSpeechUnderruns, endOfSpeechUnderruns: this.endOfSpeechUnderruns,
      pendingUnderruns: this.#pendingCount, unclassifiedUnderruns: this.unclassifiedUnderruns,
      jitterResolutionMs: 1, packetJitterExcludedGaps: this.packetJitterExcludedGaps,
      ...(includeDetails ? { recentInSpeechUnderruns, packetJitterWindows: jitterWindows(this.#packetJitter), fillJitterWindows: jitterWindows(this.#fillJitter) } : {}),
      silenceBlocksDropped: this.silenceBlocksDropped, compressedSamples: this.compressedSamples, queueResolutionMs: histogram.resolutionMs,
      queueWindows: histogram.windows(this.#clock()).map(source => {
        let cached = this.#windows[source.slot];
        if (cached?.source !== source) { const { slot, p99Ms, ...window } = source; cached = { source, window: Object.freeze(window) }; this.#windows[slot] = cached; }
        return cached.window;
      }) };
  }
}

export class AudioSchedulerTiming {
  #histogram: WindowHistogram;
  #catchups = new Float64Array(30);
  #maxBlocks = new Uint32Array(30);
  #ids = new Float64Array(30).fill(-1);
  #windows: Array<{ source: HistogramWindow; window: AudioSchedulerTimingSnapshot["windows"][number] } | undefined> = new Array(30);
  catchupCalls = 0;
  maxBlocksPerCall = 0;

  constructor(now = performance.now()) { this.#histogram = new WindowHistogram(60_000, 30, 0.1, 1_000, now); }

  record(latenessMs: number, processed: number, now: number): void {
    const slot = this.#histogram.record(Math.max(0, latenessMs), now);
    if (this.#ids[slot] !== this.#histogram.ids[slot]) { this.#ids[slot] = this.#histogram.ids[slot]; this.#catchups[slot] = 0; this.#maxBlocks[slot] = 0; }
    if (processed >= 2) { this.#catchups[slot] += 1; this.catchupCalls += 1; }
    this.#maxBlocks[slot] = Math.max(this.#maxBlocks[slot], processed); this.maxBlocksPerCall = Math.max(this.maxBlocksPerCall, processed);
  }

  snapshot(now = performance.now()): AudioSchedulerTimingSnapshot {
    const histogram = this.#histogram;
    return { latenessResolutionMs: histogram.resolutionMs, latenessOverflowThresholdMs: 1_000, catchupCalls: this.catchupCalls, maxBlocksPerCall: this.maxBlocksPerCall,
      windows: histogram.windows(now).map(source => {
        let cached = this.#windows[source.slot];
        if (cached?.source !== source) {
          cached = { source, window: Object.freeze({ startedAt: source.startedAt, durationMs: source.durationMs, samples: source.samples, maxLateMs: source.maxMs, p99LateMs: source.p99Ms, catchupCalls: this.#catchups[source.slot], maxBlocksPerCall: this.#maxBlocks[source.slot] }) };
          this.#windows[source.slot] = cached;
        }
        return cached.window;
      }) };
  }
}

/** Numeric-only grammar: never interpolate participant/Bot names or IDs. Counts are per minute. */
export function audioTimingSummary(main: AudioOutputTimingSnapshot | null | undefined, cue: AudioOutputTimingSnapshot | null | undefined, scheduler: AudioSchedulerTimingSnapshot, rxUnderruns: number, rxOverflows: number, catchupCalls: number, runtime?: AudioRuntimeWindow): string {
  const range = (timing: AudioOutputTimingSnapshot | null | undefined) => {
    const windows = timing?.windows.slice(-6).filter(window => window.samples) ?? [];
    return windows.length ? `${Math.min(...windows.map(window => window.inFlightMin!))}-${Math.max(...windows.map(window => window.inFlightMax))}` : "n/a";
  };
  const maxLate = Math.max(0, ...scheduler.windows.slice(-2).map(window => window.maxLateMs));
  return `Audio timing summary: main inflight=${range(main)} cue inflight=${range(cue)} sched maxLate=${maxLate.toFixed(1)}ms catchup=${catchupCalls} rx underruns=${rxUnderruns} overflows=${rxOverflows}`
    + (runtime ? ` loop p99=${runtime.eventLoopP99Ms.toFixed(1)}ms max=${runtime.eventLoopMaxMs.toFixed(1)}ms process max=${runtime.processBlockMaxMs.toFixed(1)}ms` : "");
}

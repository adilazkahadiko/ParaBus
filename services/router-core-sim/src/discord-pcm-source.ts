import { PcmRingSource } from "./audio-engine.ts";
import { RxQueueTiming } from "./audio-timing.ts";

// Two 20ms packets cushion ordinary Discord jitter without a long monitor delay.
export const RX_TARGET_MS = 40;
// Leave 40ms below the unchanged 120ms hard cap for a late packet burst.
export const RX_HIGH_WATER_MS = 80;
// A brief gap must refill before restarting; isolated short tails wait at most 30ms.
export const RX_PREFILL_MS = 30;
// Ignore transient packet batching; only persistent latency enables trimming.
export const RX_HIGH_WATER_HOLD_MS = 200;
// At 48kHz/480 frames this bounds transient speed-up to 5/480 (about 1%).
export const RX_MAX_COMPRESSED_SAMPLES = 5;
const QUIET_MEAN_SQUARE = 1e-5; // -50 dBFS RMS, compared without log/sqrt.

/** RX-only playout. PRE records the resulting received PCM; its tap is unchanged. */
export class DiscordPcmSource extends PcmRingSource {
  readonly blockSize: number;
  readonly targetSamples: number;
  readonly sampleRate: number;
  #clock: () => number;
  #lastPacketAt = -Infinity;
  #waiting = true;
  #backlogEwma: number;
  #scratch: Float32Array;
  #views: Float32Array[];
  #expanded: Float32Array;
  #highSince = -1;
  #lastHighAt = -Infinity;
  #reducing = false;
  #prefillSamples: number;
  #highWaterSamples: number;
  expandedFrames = 0;
  compressedFrames = 0;
  prebufferBlocks = 0;
  staleDiscardedSamples = 0;

  constructor(capacity: number, sampleRate: number, blockSize: number, clock = () => performance.now()) {
    super(capacity, new RxQueueTiming(sampleRate, capacity / sampleRate * 1000, clock));
    this.sampleRate = sampleRate; this.blockSize = blockSize; this.#clock = clock;
    this.targetSamples = Math.min(capacity - blockSize, Math.round(sampleRate * RX_TARGET_MS / 1000));
    this.#prefillSamples = Math.min(this.targetSamples, Math.round(sampleRate * RX_PREFILL_MS / 1000));
    this.#highWaterSamples = Math.round(sampleRate * RX_HIGH_WATER_MS / 1000);
    this.#backlogEwma = this.targetSamples;
    this.#scratch = new Float32Array(blockSize + RX_MAX_COMPRESSED_SAMPLES);
    this.#views = Array.from({ length: RX_MAX_COMPRESSED_SAMPLES }, (_, i) => this.#scratch.subarray(0, blockSize + i + 1));
    this.#expanded = this.#scratch.subarray(0, blockSize - 1);
  }

  override pushInt16Le(pcm: Uint8Array, receivedAt = this.#clock()): number {
    if (pcm.byteLength < 2) return 0;
    // A new talkspurt must not replay queued audio from before a long stall.
    if (receivedAt - this.#lastPacketAt > 200) {
      this.staleDiscardedSamples += this.queuedSamples;
      this.clear();
    }
    this.#lastPacketAt = receivedAt;
    return super.pushInt16Le(pcm, receivedAt);
  }

  override fill(target: Float32Array): boolean {
    if (target.length !== this.blockSize) throw new Error("Discord playout block size changed");
    const now = this.#clock();
    this.timing?.observeFill(now, this.blockSize / this.sampleRate * 1000);
    if (this.queuedSamples > 0 && now - this.#lastPacketAt > 200) {
      this.staleDiscardedSamples += this.queuedSamples;
      this.clear();
    }
    const queued = this.queuedSamples;
    if (this.#waiting && (queued === 0 || (queued < this.#prefillSamples && now - this.#lastPacketAt < RX_PREFILL_MS))) {
      if (queued > 0) this.prebufferBlocks += 1;
      this.timing?.fill(queued, this.blockSize, false);
      target.fill(0);
      return false;
    }
    this.#waiting = false;
    if (queued < this.blockSize) {
      const received = super.fill(target);
      this.#waiting = true;
      this.#backlogEwma = this.targetSamples;
      this.#highSince = -1;
      this.#lastHighAt = -Infinity;
      this.#reducing = false;
      return received;
    }
    this.#backlogEwma += 0.02 * (queued - this.#backlogEwma);
    if (queued > this.#highWaterSamples) {
      if (this.#highSince < 0) this.#highSince = now;
      this.#lastHighAt = now;
      if (now - this.#highSince >= RX_HIGH_WATER_HOLD_MS) this.#reducing = true;
    } else if (now - this.#lastHighAt >= 20) this.#highSince = -1;
    // Use the 20ms packet envelope: the normal 10ms trough between arrivals
    // must not reset a persistently high queue's 200ms hold on every packet.
    if (queued <= this.targetSamples) this.#reducing = false;
    // Preserve the existing slow-sender correction, but never expand a drained
    // tail or after packets stop. Silence/prebuffering must not replay speech.
    const expand = !this.#reducing && this.#backlogEwma < this.targetSamples
      && queued >= this.blockSize * 2 && now - this.#lastPacketAt < this.blockSize / this.sampleRate * 1000;
    if (!this.#reducing && !expand) return super.fill(target); // Bit-identical when not correcting.
    if (this.#reducing && queued - this.blockSize >= this.targetSamples && this.discardQuietBlock(this.blockSize, QUIET_MEAN_SQUARE)) {
      this.timing!.silenceBlocksDropped++;
      this.timing!.fill(queued, this.blockSize);
      return this.readInto(target);
    }
    // 1 extra sample near 80ms, +1 per 2ms excess, at most 5. The reducing
    // latch stays on below 80ms until 40ms, avoiding packet-rate on/off chatter.
    const adjustment = expand ? -1 : Math.min(RX_MAX_COMPRESSED_SAMPLES, queued - this.targetSamples,
      1 + Math.ceil(Math.max(0, queued - this.#highWaterSamples) / (this.sampleRate * 0.002)));
    const source = expand ? this.#expanded : this.#views[adjustment - 1];
    super.fill(source);
    const scale = (source.length - 1) / (target.length - 1);
    for (let i = 0; i < target.length - 1; i++) {
      const position = i * scale, left = Math.floor(position), fraction = position - left;
      target[i] = source[left] + (source[left + 1] - source[left]) * fraction;
    }
    target[target.length - 1] = source[source.length - 1];
    if (adjustment > 0) {
      this.compressedFrames += adjustment;
      this.timing!.compressedSamples += adjustment;
    } else this.expandedFrames++;
    return true;
  }

  override clear(): void {
    super.clear();
    this.#waiting = true;
    this.#lastPacketAt = -Infinity;
    this.#backlogEwma = this.targetSamples;
    this.#highSince = -1;
    this.#lastHighAt = -Infinity;
    this.#reducing = false;
  }

  playoutSnapshot() {
    return { targetMs: this.targetSamples / this.sampleRate * 1000, backlogEwmaMs: this.#backlogEwma / this.sampleRate * 1000,
      prebufferBlocks: this.prebufferBlocks, expandedFrames: this.expandedFrames, compressedFrames: this.compressedFrames, staleDiscardedSamples: this.staleDiscardedSamples };
  }
}

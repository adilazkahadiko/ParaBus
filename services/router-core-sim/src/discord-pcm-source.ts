import { PcmRingSource } from "./audio-engine.ts";
import { RxAdaptation } from "./rx-adaptation.ts";
import { RxQueueTiming } from "./audio-timing.ts";

// Initial three-packet reserve, adapted only at refill/speech boundaries.
export const RX_TARGET_MS = 60;
// Initial high water; subsequent thresholds follow the selected target.
export const RX_HIGH_WATER_MS = 80;
// Short utterances wait no longer than 60ms even when the target is 100ms.
export const RX_MAX_PREFILL_MS = 60;
// Ignore transient packet batching; only persistent latency enables trimming.
export const RX_HIGH_WATER_HOLD_MS = 200;
// At 48kHz/480 frames this bounds transient speed-up to 5/480 (about 1%).
export const RX_MAX_COMPRESSED_SAMPLES = 5;
const QUIET_MEAN_SQUARE = 1e-5; // -50 dBFS RMS, compared without log/sqrt.

/** RX-only playout. PRE records the resulting received PCM; its tap is unchanged. */
export class DiscordPcmSource extends PcmRingSource {
  readonly blockSize: number;
  targetSamples: number;
  readonly sampleRate: number;
  #adaptation = new RxAdaptation();
  #firstQueuedAt = -Infinity;
  #seenInSpeech = 0;
  #seenAllInSpeech = 0;
  #fadeIn = true;
  #lastOutput = 0;
  #targetBlocks = new Uint32Array(4);
  #effectiveCapSamples: number;
  microShortages = 0;
  silenceSamples = 0;
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
    this.#effectiveCapSamples = capacity;
    this.targetSamples = Math.min(capacity - blockSize, Math.round(sampleRate * RX_TARGET_MS / 1000));
    this.#prefillSamples = this.targetSamples;
    this.#highWaterSamples = Math.round(sampleRate * RX_HIGH_WATER_MS / 1000);
    this.#backlogEwma = this.targetSamples;
    this.#scratch = new Float32Array(blockSize + RX_MAX_COMPRESSED_SAMPLES);
    this.#views = Array.from({ length: RX_MAX_COMPRESSED_SAMPLES }, (_, i) => this.#scratch.subarray(0, blockSize + i + 1));
    this.#expanded = this.#scratch.subarray(0, blockSize - 1);
  }

  override pushInt16Le(pcm: Uint8Array, receivedAt = this.#clock()): number {
    if (pcm.byteLength < 2) return 0;
    const newTalk = receivedAt - this.#lastPacketAt > 200;
    // A new talkspurt must not replay queued audio from before a long stall.
    if (receivedAt - this.#lastPacketAt > 200) {
      this.staleDiscardedSamples += this.queuedSamples;
      this.clear();
    }
    const talkStart = newTalk;
    this.#adaptation.packet(receivedAt);
    const kinds = this.timing!.inSpeechByKind;
    // Buffer growth cannot replace packets that were never received.
    const inSpeech = kinds.fillBurst + this.timing!.microInSpeechUnderruns;
    if (this.timing!.inSpeechUnderruns > this.#seenAllInSpeech) this.#adaptation.shortage(inSpeech > this.#seenInSpeech);
    this.#seenAllInSpeech = this.timing!.inSpeechUnderruns;
    this.#seenInSpeech = inSpeech;
    if (talkStart || this.#waiting) {
      this.#adaptation.boundary(talkStart);
      this.targetSamples = Math.min(this.capacity - this.blockSize, Math.round(this.sampleRate * this.#adaptation.targetMs / 1000));
      this.#prefillSamples = this.targetSamples;
      this.#effectiveCapSamples = Math.min(this.capacity, Math.round(this.sampleRate * this.#adaptation.hardCapMs / 1000));
      this.#highWaterSamples = Math.min(this.sampleRate * .100, this.targetSamples + this.sampleRate * .020);
    }
    if (this.queuedSamples === 0) this.#firstQueuedAt = receivedAt;
    this.#lastPacketAt = receivedAt;
    return super.pushInt16Le(pcm, receivedAt);
  }

  protected override get queueLimit(): number { return this.#effectiveCapSamples; }

  override fill(target: Float32Array): boolean {
    const now = this.#clock();
    this.#adaptation.fill(now, this.blockSize / this.sampleRate * 1000);
    this.#targetBlocks[Math.max(0, Math.min(3, Math.round((this.targetSamples / this.sampleRate * 1000 - 40) / 20)))]++;
    const before = this.queuedSamples;
    const result = this.playout(target);
    const available = Math.min(target.length, before);
    const fade = Math.round(this.sampleRate * .003);
    if (result && this.#fadeIn) {
      for (let i = 0; i < Math.min(fade, available); i++) target[i] *= i / fade;
      this.#fadeIn = false;
    }
    if (result && available < target.length) {
      const length = Math.min(fade, available);
      if (available >= fade) {
        for (let i = 0; i < length; i++) target[available - length + i] *= (length - i - 1) / length;
      } else {
        // A sub-ms fragment cannot contain a 3ms ramp. Extend only its terminal
        // value towards zero, never loop speech or advance the Opus decoder.
        const last = target[available - 1];
        for (let i = 0; i < available; i++) target[i] *= 1 - i / fade;
        for (let i = available; i < fade; i++) target[i] = last * (1 - (i + 1) / fade);
      }
      this.#fadeIn = true;
    } else if (!result) {
      // If drained exactly at a block boundary the end cannot be predicted without
      // look-ahead. Ramp the last sample to zero, <=3ms, without replaying old PCM.
      if (this.#lastOutput !== 0) for (let i = 0; i < fade; i++) target[i] = this.#lastOutput * (1 - (i + 1) / fade);
      this.#fadeIn = true;
    }
    this.#lastOutput = target[target.length - 1];
    if (!result) this.silenceSamples += target.length;
    else this.silenceSamples += target.length - available;
    return result;
  }

  private playout(target: Float32Array): boolean {
    if (target.length !== this.blockSize) throw new Error("Discord playout block size changed");
    const now = this.#clock();
    this.timing?.observeFill(now, this.blockSize / this.sampleRate * 1000);
    if (this.queuedSamples > 0 && now - this.#lastPacketAt > 200) {
      this.staleDiscardedSamples += this.queuedSamples;
      this.clear();
    }
    const queued = this.queuedSamples;
    if (this.#waiting && (queued === 0 || (queued < this.#prefillSamples && now - this.#firstQueuedAt < Math.min(RX_MAX_PREFILL_MS, this.#adaptation.targetMs)))) {
      if (queued > 0) this.prebufferBlocks += 1;
      this.timing?.fill(queued, this.blockSize, false);
      target.fill(0);
      return false;
    }
    this.#waiting = false;
    if (queued < this.blockSize) {
      const received = super.fill(target);
      const age = now - this.#lastPacketAt;
      // A fractional clock-correction tail must not impose another long prefill.
      const micro = queued <= Math.ceil(this.sampleRate * .0005) && age <= 20;
      if (micro) this.microShortages++;
      this.#waiting = !micro;
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
    const expand = !this.#reducing && this.#backlogEwma < this.targetSamples - this.sampleRate * .020
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
    this.#fadeIn = true; this.#lastOutput = 0;
    this.#lastPacketAt = -Infinity;
    this.#backlogEwma = this.targetSamples;
    this.#highSince = -1;
    this.#lastHighAt = -Infinity;
    this.#reducing = false;
  }

  playoutSnapshot() {
    return { hardCapMs: this.#effectiveCapSamples / this.sampleRate * 1000, microShortages: this.microShortages, silenceMs: this.silenceSamples / this.sampleRate * 1000, fadeMs: 3, targetBlocks: Array.from(this.#targetBlocks), targetMs: this.targetSamples / this.sampleRate * 1000, backlogEwmaMs: this.#backlogEwma / this.sampleRate * 1000,
      prebufferBlocks: this.prebufferBlocks, expandedFrames: this.expandedFrames, compressedFrames: this.compressedFrames, staleDiscardedSamples: this.staleDiscardedSamples };
  }
}

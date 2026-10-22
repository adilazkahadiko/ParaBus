const MIN_DB = -120;

export function dbToGain(db: number): number {
  return db <= MIN_DB ? 0 : 10 ** (db / 20);
}

export function gainToDb(gain: number): number {
  return gain <= 0.000001 ? MIN_DB : 20 * Math.log10(gain);
}

export function clamp(value: number, min: number, max: number): number {
  // Callers that mutate state validate first. This fallback is deliberately
  // non-throwing so an unexpected value can never inject NaN into audio DSP.
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function energyToLufs(energy: number): number {
  return energy > 0 ? -0.691 + 10 * Math.log10(energy) : Number.NEGATIVE_INFINITY;
}

class Biquad {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
  #x1 = 0;
  #x2 = 0;
  #y1 = 0;
  #y2 = 0;

  constructor(
    b0: number,
    b1: number,
    b2: number,
    a1: number,
    a2: number,
  ) {
    this.b0 = b0;
    this.b1 = b1;
    this.b2 = b2;
    this.a1 = a1;
    this.a2 = a2;
  }

  process(input: number): number {
    const output = this.b0 * input + this.b1 * this.#x1 + this.b2 * this.#x2 - this.a1 * this.#y1 - this.a2 * this.#y2;
    this.#x2 = this.#x1;
    this.#x1 = input;
    this.#y2 = this.#y1;
    this.#y1 = output;
    return output;
  }

  reset(): void {
    this.#x1 = 0;
    this.#x2 = 0;
    this.#y1 = 0;
    this.#y2 = 0;
  }
}

/** ITU-R BS.1770 K-weighting coefficients for the fixed 48 kHz project rate. */
class KWeightingFilter {
  readonly #preFilter = new Biquad(
    1.53512485958697,
    -2.69169618940638,
    1.19839281085285,
    -1.69065929318241,
    0.73248077421585,
  );
  readonly #rlbFilter = new Biquad(
    1,
    -2,
    1,
    -1.99004745483398,
    0.99007225036621,
  );

  process(input: number): number {
    return this.#rlbFilter.process(this.#preFilter.process(input));
  }

  reset(): void {
    this.#preFilter.reset();
    this.#rlbFilter.reset();
  }
}

export interface LoudnessSnapshot {
  momentary: number;
  shortTerm: number;
  integrated: number;
}

/** 100 ms gate energies, with bounded work independent of the retained duration. */
export class IntegratedLoudnessHistogram {
  readonly #energies: Float64Array;
  readonly #bins: Int16Array;
  readonly #counts = new Uint32Array(7_501);
  readonly #sums = new Float64Array(7_501);
  #index = 0;
  #absoluteCount = 0;
  #absoluteEnergy = 0;

  constructor(capacity: number) {
    this.#energies = new Float64Array(capacity);
    this.#bins = new Int16Array(capacity).fill(-1);
  }

  add(energy: number): void {
    const oldBin = this.#bins[this.#index];
    if (oldBin >= 0) {
      this.#counts[oldBin]--;
      this.#sums[oldBin] -= this.#energies[this.#index];
      this.#absoluteCount--;
      this.#absoluteEnergy -= this.#energies[this.#index];
      if (this.#counts[oldBin] === 0) this.#sums[oldBin] = 0;
    }
    const loudness = energyToLufs(energy);
    // Test the exact absolute gate before quantization. The last bin retains
    // over-range energies too (without clipping their contribution to the mean).
    const bin = loudness >= -70 ? Math.min(7_500, Math.floor((loudness + 70) * 100)) : -1;
    this.#bins[this.#index] = bin;
    this.#energies[this.#index] = energy;
    if (bin >= 0) {
      this.#counts[bin]++;
      this.#sums[bin] += energy;
      this.#absoluteCount++;
      this.#absoluteEnergy += energy;
    }
    this.#index = (this.#index + 1) % this.#energies.length;
    if (this.#absoluteCount === 0) this.#absoluteEnergy = 0;
  }

  value(): number {
    if (this.#absoluteCount === 0) return Number.NEGATIVE_INFINITY;
    const threshold = Math.max(-70, energyToLufs(this.#absoluteEnergy / this.#absoluteCount) - 10);
    // Only the bin containing the relative gate is approximate (0.01 LU).
    // Classify that bin by its actual mean energy to avoid systematic downward
    // gate bias. All bins above/below it and the absolute gate are exact.
    const first = Math.min(7_500, Math.floor((threshold + 70) * 100));
    const thresholdEnergy = 10 ** ((threshold + 0.691) / 10);
    let energy = 0, count = 0;
    for (let bin = first; bin < this.#counts.length; bin++) {
      if (bin === first && this.#counts[bin] > 0 && this.#sums[bin] / this.#counts[bin] < thresholdEnergy) continue;
      energy += this.#sums[bin];
      count += this.#counts[bin];
    }
    return count === 0 ? Number.NEGATIVE_INFINITY : energyToLufs(energy / count);
  }

  reset(): void {
    this.#bins.fill(-1);
    this.#counts.fill(0);
    this.#sums.fill(0);
    this.#index = this.#absoluteCount = this.#absoluteEnergy = 0;
  }
}

/**
 * Mono EBU Mode loudness meter. The project is fixed at 48 kHz / 10 ms blocks,
 * so the energy ring holds exactly 400 ms and 3 s rectangular windows.
 */
export class LoudnessMeter {
  readonly sampleRate: number;
  readonly blockSize: number;
  readonly value: LoudnessSnapshot = {
    momentary: Number.NEGATIVE_INFINITY,
    shortTerm: Number.NEGATIVE_INFINITY,
    integrated: Number.NEGATIVE_INFINITY,
  };
  readonly #filter = new KWeightingFilter();
  readonly #energyRing: Float64Array;
  readonly #integrated: IntegratedLoudnessHistogram | null;
  readonly #momentaryChunks: number;
  readonly #shortTermChunks: number;
  readonly #gateStrideChunks: number;
  #ringIndex = 0;
  #ringCount = 0;
  #chunksSinceGate = 0;
  #gatesSinceCalculation = 0;
  #cachedIntegrated = Number.NEGATIVE_INFINITY;

  constructor(
    sampleRate: number,
    blockSize: number,
    integrated = false,
    maxIntegratedHours = 6,
  ) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
    if (sampleRate !== 48_000) throw new Error("K-weighting coefficients are fixed for the 48 kHz project rate");
    const chunksPerSecond = sampleRate / blockSize;
    if (!Number.isInteger(chunksPerSecond)) throw new Error("LoudnessMeter requires an integral number of blocks per second");
    this.#momentaryChunks = Math.round(chunksPerSecond * 0.4);
    this.#shortTermChunks = Math.round(chunksPerSecond * 3);
    this.#gateStrideChunks = Math.round(chunksPerSecond * 0.1);
    this.#energyRing = new Float64Array(this.#shortTermChunks);
    this.#integrated = integrated
      ? new IntegratedLoudnessHistogram(Math.max(1, Math.round(maxIntegratedHours * 60 * 60 * 10)))
      : null;
  }

  process(buffer: Float32Array): LoudnessSnapshot {
    let energy = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      const weighted = this.#filter.process(buffer[index]);
      energy += weighted * weighted;
    }
    this.#energyRing[this.#ringIndex] = energy / Math.max(1, buffer.length);
    this.#ringIndex = (this.#ringIndex + 1) % this.#energyRing.length;
    this.#ringCount = Math.min(this.#energyRing.length, this.#ringCount + 1);

    if (this.#integrated && this.#ringCount >= this.#momentaryChunks) {
      this.#chunksSinceGate += 1;
      if (this.#chunksSinceGate >= this.#gateStrideChunks) {
        this.#chunksSinceGate = 0;
        this.#integrated.add(this.windowEnergy(this.#momentaryChunks));
        if (++this.#gatesSinceCalculation === 10) {
          this.#gatesSinceCalculation = 0;
          this.#cachedIntegrated = this.#integrated.value();
        }
      }
    }

    this.value.momentary = this.#ringCount >= this.#momentaryChunks
      ? energyToLufs(this.windowEnergy(this.#momentaryChunks))
      : Number.NEGATIVE_INFINITY;
    this.value.shortTerm = this.#ringCount >= this.#shortTermChunks
      ? energyToLufs(this.windowEnergy(this.#shortTermChunks))
      : Number.NEGATIVE_INFINITY;
    this.value.integrated = this.#cachedIntegrated;
    return this.value;
  }

  snapshot(): LoudnessSnapshot {
    return { ...this.value };
  }

  reset(): void {
    this.#filter.reset();
    this.#energyRing.fill(0);
    this.#ringIndex = 0;
    this.#ringCount = 0;
    this.value.momentary = Number.NEGATIVE_INFINITY;
    this.value.shortTerm = Number.NEGATIVE_INFINITY;
    this.resetIntegrated();
  }

  resetIntegrated(): void {
    this.#integrated?.reset();
    this.#chunksSinceGate = 0;
    this.#gatesSinceCalculation = 0;
    this.#cachedIntegrated = Number.NEGATIVE_INFINITY;
    this.value.integrated = Number.NEGATIVE_INFINITY;
  }

  private windowEnergy(chunks: number): number {
    let sum = 0;
    for (let offset = 0; offset < chunks; offset += 1) {
      const index = (this.#ringIndex - 1 - offset + this.#energyRing.length) % this.#energyRing.length;
      sum += this.#energyRing[index];
    }
    return sum / chunks;
  }

}

export class PeakRmsMeter {
  peak = 0;
  rms = 0;
  hold = 0;
  clip = false;
  voiceActive = false;
  #holdSamples = 0;

  process(buffer: Float32Array, sampleRate: number): void {
    let peak = 0;
    let sumSquares = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      const absolute = Math.abs(buffer[index]);
      if (absolute > peak) peak = absolute;
      sumSquares += buffer[index] * buffer[index];
    }
    this.peak = peak;
    this.rms = Math.sqrt(sumSquares / Math.max(1, buffer.length));
    this.clip = peak >= 1;
    this.voiceActive = this.rms >= dbToGain(-45);
    if (peak >= this.hold) {
      this.hold = peak;
      this.#holdSamples = Math.round(sampleRate * 1.5);
    } else if (this.#holdSamples > 0) {
      this.#holdSamples -= buffer.length;
    } else {
      this.hold *= 0.94;
    }
  }

  reset(): void { this.peak = 0; this.rms = 0; this.hold = 0; this.clip = false; this.voiceActive = false; this.#holdSamples = 0; }

  snapshot(channelId: string, stale = false, loudness?: LoudnessSnapshot) {
    const finiteOrFloor = (value: number | undefined) => Number.isFinite(value) ? value as number : -120;
    return {
      channelId,
      peak: this.peak,
      rms: this.rms,
      hold: this.hold,
      clip: this.clip,
      voiceActive: this.voiceActive,
      stale,
      loudnessMomentary: finiteOrFloor(loudness?.momentary),
      loudnessShortTerm: finiteOrFloor(loudness?.shortTerm),
      loudnessIntegrated: finiteOrFloor(loudness?.integrated),
    };
  }
}

export class HighPassFilter {
  #alpha = 0;
  #previousInput = 0;
  #previousOutput = 0;

  constructor(sampleRate: number, cutoffHz = 80) {
    this.configure(sampleRate, cutoffHz);
  }

  configure(sampleRate: number, cutoffHz: number): void {
    const timeConstant = 1 / (2 * Math.PI * cutoffHz);
    const interval = 1 / sampleRate;
    this.#alpha = timeConstant / (timeConstant + interval);
  }

  processInPlace(buffer: Float32Array): void {
    for (let index = 0; index < buffer.length; index += 1) {
      const input = buffer[index];
      const output = this.#alpha * (this.#previousOutput + input - this.#previousInput);
      buffer[index] = output;
      this.#previousInput = input;
      this.#previousOutput = output;
    }
  }

  reset(): void { this.#previousInput = 0; this.#previousOutput = 0; }
}

export class Compressor {
  thresholdDb = -18;
  ratio = 3;
  attackMs = 8;
  releaseMs = 100;
  makeupDb = 0;
  gainReductionDb = 0;
  #envelope = 0;

  processInPlace(buffer: Float32Array, sampleRate: number): void {
    const attack = Math.exp(-1 / (sampleRate * this.attackMs / 1000));
    const release = Math.exp(-1 / (sampleRate * this.releaseMs / 1000));
    const makeup = dbToGain(this.makeupDb);
    const threshold = dbToGain(this.thresholdDb);
    const compressionExponent = 1 - 1 / Math.max(1, this.ratio);
    for (let index = 0; index < buffer.length; index += 1) {
      const level = Math.abs(buffer[index]);
      const coefficient = level > this.#envelope ? attack : release;
      this.#envelope = coefficient * this.#envelope + (1 - coefficient) * level;
      if (this.#envelope <= threshold) {
        if (makeup !== 1) buffer[index] *= makeup;
        continue;
      }
      // Equivalent to the dB-domain gain curve, with one power operation per
      // compressed sample instead of log10 + power on the real-time path.
      buffer[index] *= Math.pow(threshold / this.#envelope, compressionExponent) * makeup;
    }
    this.gainReductionDb = this.#envelope > threshold
      ? (gainToDb(this.#envelope) - this.thresholdDb) * compressionExponent
      : 0;
  }

  reset(): void { this.#envelope = 0; this.gainReductionDb = 0; }
}

export class SafetyLimiter {
  enabled = true;
  ceilingDb = -1;
  releaseMs = 80;
  gainReductionDb = 0;
  #gain = 1;

  processInPlace(buffer: Float32Array, sampleRate: number): void {
    if (!this.enabled) {
      this.gainReductionDb = 0;
      return;
    }
    const ceiling = dbToGain(this.ceilingDb);
    const release = Math.exp(-1 / (sampleRate * this.releaseMs / 1000));
    let minimumGain = 1;
    for (let index = 0; index < buffer.length; index += 1) {
      const absolute = Math.abs(buffer[index]);
      const wanted = absolute > ceiling ? ceiling / absolute : 1;
      this.#gain = wanted < this.#gain ? wanted : release * this.#gain + (1 - release);
      if (this.#gain < minimumGain) minimumGain = this.#gain;
      buffer[index] *= this.#gain;
    }
    this.gainReductionDb = Math.max(0, -gainToDb(minimumGain));
  }

  reset(): void { this.#gain = 1; this.gainReductionDb = 0; }
}

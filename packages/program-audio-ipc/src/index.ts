/**
 * Offline-only Program Audio shadow transport.  This is deliberately separate
 * from management NDJSON and Discord IPC: PGM1 is a binary PCM contract.
 */
const MAGIC = Buffer.from("PGM1");

export const PROGRAM_AUDIO_IPC_VERSION = 1;
export const PROGRAM_AUDIO_FRAME_TYPE_PCM_F32_PLANAR = 1;
export const PROGRAM_AUDIO_HEADER_BYTES = 32;
export const PROGRAM_AUDIO_SAMPLE_RATE = 48_000;
export const PROGRAM_AUDIO_FRAMES = 480;
export const PROGRAM_AUDIO_MAX_CHANNELS = 64;
export const PROGRAM_AUDIO_MAX_PAYLOAD_BYTES = PROGRAM_AUDIO_FRAMES * PROGRAM_AUDIO_MAX_CHANNELS * 4;
export const PROGRAM_AUDIO_MAX_FRAME_BYTES = PROGRAM_AUDIO_HEADER_BYTES + PROGRAM_AUDIO_MAX_PAYLOAD_BYTES;

export interface ProgramAudioFrame {
  sequence: bigint;
  channels: number;
  /** One 10 ms block, output-major planar data from AudioEngine.outputs. */
  planar: readonly Float32Array[];
}

export interface DecodedProgramAudioFrame {
  sequence: bigint;
  channels: number;
  payload: Buffer;
}

function assertShape(channels: number, planarLength?: number): void {
  if (!Number.isInteger(channels) || channels < 1 || channels > PROGRAM_AUDIO_MAX_CHANNELS) {
    throw new RangeError(`Program Audio channels must be 1..${PROGRAM_AUDIO_MAX_CHANNELS}`);
  }
  if (planarLength !== undefined && planarLength !== channels) throw new RangeError("Program Audio planar channel count mismatch");
}

function frameBytes(channels: number): number {
  return PROGRAM_AUDIO_FRAMES * channels * 4;
}

function assertFinitePlanar(frame: ProgramAudioFrame): void {
  assertShape(frame.channels, frame.planar.length);
  if (typeof frame.sequence !== "bigint") throw new TypeError("Program Audio sequence must be a bigint");
  if (frame.sequence < 0n || frame.sequence > 0xffff_ffff_ffff_ffffn) throw new RangeError("Program Audio sequence is out of range");
  for (const channel of frame.planar) {
    if (channel.length !== PROGRAM_AUDIO_FRAMES) throw new RangeError(`Program Audio frame count must be ${PROGRAM_AUDIO_FRAMES}`);
    for (const sample of channel) if (!Number.isFinite(sample)) throw new RangeError("Program Audio sample must be finite");
  }
}

/**
 * Encodes planar graph outputs into one output-major planar PCM wire frame.
 * Buffer.writeFloatLE guarantees the wire byte order on every Node platform.
 */
export function encodeProgramAudioFrame(frame: ProgramAudioFrame): Buffer {
  assertFinitePlanar(frame);
  const payloadBytes = frameBytes(frame.channels);
  const output = Buffer.allocUnsafe(PROGRAM_AUDIO_HEADER_BYTES + payloadBytes);
  MAGIC.copy(output, 0);
  output[4] = PROGRAM_AUDIO_IPC_VERSION;
  output[5] = PROGRAM_AUDIO_FRAME_TYPE_PCM_F32_PLANAR;
  output[6] = frame.channels;
  output[7] = 0; // flags/reserved; must remain zero in v1.
  output.writeUInt32BE(PROGRAM_AUDIO_SAMPLE_RATE, 8);
  output.writeUInt16BE(PROGRAM_AUDIO_FRAMES, 12);
  output.writeUInt16BE(0, 14);
  output.writeBigUInt64BE(frame.sequence, 16);
  output.writeUInt32BE(payloadBytes, 24);
  output.writeUInt32BE(0, 28);
  for (let channel = 0; channel < frame.channels; channel += 1) {
    let offset = PROGRAM_AUDIO_HEADER_BYTES + channel * PROGRAM_AUDIO_FRAMES * 4;
    for (const sample of frame.planar[channel]) {
      output.writeFloatLE(sample, offset);
      offset += 4;
    }
  }
  return output;
}

function checkedLength(header: Uint8Array): number {
  const buffer = Buffer.from(header.buffer, header.byteOffset, header.byteLength);
  if (buffer.length < PROGRAM_AUDIO_HEADER_BYTES) throw new RangeError("incomplete Program Audio header");
  if (!buffer.subarray(0, 4).equals(MAGIC)) throw new Error("invalid Program Audio magic");
  if (buffer[4] !== PROGRAM_AUDIO_IPC_VERSION) throw new Error("unsupported Program Audio version");
  if (buffer[5] !== PROGRAM_AUDIO_FRAME_TYPE_PCM_F32_PLANAR) throw new Error("unknown Program Audio frame type");
  const channels = buffer[6];
  assertShape(channels);
  if (buffer[7] !== 0 || buffer.readUInt16BE(14) !== 0 || buffer.readUInt32BE(28) !== 0) throw new Error("invalid Program Audio reserved fields");
  if (buffer.readUInt32BE(8) !== PROGRAM_AUDIO_SAMPLE_RATE || buffer.readUInt16BE(12) !== PROGRAM_AUDIO_FRAMES) throw new RangeError("invalid Program Audio shape");
  const payloadBytes = buffer.readUInt32BE(24);
  if (payloadBytes !== frameBytes(channels)) throw new RangeError("invalid Program Audio payload length");
  const total = PROGRAM_AUDIO_HEADER_BYTES + payloadBytes;
  if (total > PROGRAM_AUDIO_MAX_FRAME_BYTES) throw new RangeError("Program Audio frame is too large");
  return total;
}

export function decodeProgramAudioFrame(bytes: Uint8Array): DecodedProgramAudioFrame {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = checkedLength(buffer);
  if (buffer.length !== total) throw new RangeError("invalid Program Audio frame length");
  const channels = buffer[6];
  for (let offset = PROGRAM_AUDIO_HEADER_BYTES; offset < total; offset += 4) {
    if (!Number.isFinite(buffer.readFloatLE(offset))) throw new RangeError("Program Audio sample must be finite");
  }
  return { sequence: buffer.readBigUInt64BE(16), channels, payload: buffer.subarray(PROGRAM_AUDIO_HEADER_BYTES) };
}

/** Fail-closed stream decoder; an invalid chunk clears retained partial bytes. */
export class ProgramAudioFrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): DecodedProgramAudioFrame[] {
    try {
      let input = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const result: DecodedProgramAudioFrame[] = [];
      while (input.length) {
        if (!this.#buffer.length && input.length >= PROGRAM_AUDIO_HEADER_BYTES) {
          const total = checkedLength(input);
          if (input.length >= total) {
            result.push(decodeProgramAudioFrame(input.subarray(0, total)));
            input = input.subarray(total);
            continue;
          }
        }
        const target = this.#buffer.length < PROGRAM_AUDIO_HEADER_BYTES ? PROGRAM_AUDIO_HEADER_BYTES : checkedLength(this.#buffer);
        const take = Math.min(target - this.#buffer.length, input.length);
        this.#buffer = Buffer.concat([this.#buffer, input.subarray(0, take)]);
        input = input.subarray(take);
        const completedLength = this.#buffer.length >= PROGRAM_AUDIO_HEADER_BYTES ? checkedLength(this.#buffer) : undefined;
        if (completedLength !== undefined && this.#buffer.length === completedLength) {
          result.push(decodeProgramAudioFrame(this.#buffer));
          this.#buffer = Buffer.alloc(0);
        }
      }
      return result;
    } catch (error) {
      this.#buffer = Buffer.alloc(0);
      throw error;
    }
  }

  get bufferedBytes(): number { return this.#buffer.length; }

  /** EOF must be explicit: retained partial bytes are never silently accepted. */
  finish(): void {
    if (!this.#buffer.length) return;
    this.#buffer = Buffer.alloc(0);
    throw new RangeError("truncated Program Audio frame at EOF");
  }
}

export interface ProgramAudioProjection {
  sequence: string;
  channels: number;
  frames: number;
  payloadBytes: number;
  payloadHash: string;
  peak: number;
}

export function projectProgramAudioFrame(frame: DecodedProgramAudioFrame): ProgramAudioProjection {
  let hashHigh = 0xcbf2_9ce4;
  let hashLow = 0x8422_2325;
  for (const byte of frame.payload) {
    hashLow = (hashLow ^ byte) >>> 0;
    const lowProduct = hashLow * 0x1b3;
    hashHigh = (Math.imul(hashHigh, 0x1b3) + Math.imul(hashLow, 0x100) + Math.floor(lowProduct / 0x1_0000_0000)) >>> 0;
    hashLow = lowProduct >>> 0;
  }
  let peak = 0;
  for (let offset = 0; offset < frame.payload.length; offset += 4) peak = Math.max(peak, Math.abs(frame.payload.readFloatLE(offset)));
  const payloadHash = hashHigh.toString(16).padStart(8, "0") + hashLow.toString(16).padStart(8, "0");
  return { sequence: frame.sequence.toString(), channels: frame.channels, frames: PROGRAM_AUDIO_FRAMES, payloadBytes: frame.payload.length, payloadHash, peak };
}

import { createRequire } from "node:module";

export const OPUS_SAMPLE_RATE = 48_000;
export const OPUS_CHANNELS = 1;
export const OPUS_FRAME_SAMPLES = 960;
// Fixed public 20 ms mono packet. It is used only to prove native load/create/decode.
export const OPUS_SELF_CHECK_PACKET = Buffer.from("f8b50deb39ee570e2554155760d4d1de797446c8a4bafca0e16063e498706f67af01a4a3ff81ef4b40fb274c05db302d05144f3525d17fd399a6912e03ca0ada756c6f7ee0eda9e3350815200cb5101ed43bbc16e27ae35abd56c693c18ba872cba872d9694386fce990666768873e88873e95ee02bd5225c8ea54c912985bf27bd60ad1a0abc4b70f59dfa6a3316955d2b4a74895396b8524eb90e7bea30cb1842535100dab7240f4722f06fecfef51fc8b0690f1cdd86847edae37699a0bec1afe48326e2d376d", "hex");

export interface OpusDecoder {
  decode(packet: Uint8Array): Buffer;
  /** @discordjs/opus has no native delete API; this releases our reference only. */
  dispose(): void;
}

export interface OpusDecoderFactory {
  readonly backend: "@discordjs/opus";
  create48kMono(): OpusDecoder;
}

export interface OpusDecoderGate {
  readonly state: "READY" | "UNAVAILABLE";
  readonly factory: OpusDecoderFactory | null;
  readonly reason: string | null;
}

interface NativeEncoder {
  decode(packet: Buffer): Buffer;
}

interface NativeModule {
  OpusEncoder: new (sampleRate: number, channels: number) => NativeEncoder;
}

/** Keeps the IPC Buffer on the production path; views retain their byte offset. */
export function nativePacketBuffer(packet: Uint8Array): Buffer {
  return Buffer.isBuffer(packet) ? packet : Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength);
}

class NativeDiscordOpusDecoder implements OpusDecoder {
  #native: NativeEncoder | null;

  constructor(native: NativeEncoder) {
    this.#native = native;
  }

  decode(packet: Uint8Array): Buffer {
    if (!this.#native) throw new Error("native Opus decoder is disposed");
    const pcm = this.#native.decode(nativePacketBuffer(packet));
    if (!Buffer.isBuffer(pcm) || pcm.length !== OPUS_FRAME_SAMPLES * 2) throw new Error("native Opus decoder returned an invalid frame");
    return pcm;
  }

  dispose(): void {
    // The binding intentionally exposes no delete/close method. Dropping the
    // reference is idempotent and lets V8 reclaim the native wrapper safely.
    this.#native = null;
  }
}

class NativeDiscordOpusFactory implements OpusDecoderFactory {
  readonly backend = "@discordjs/opus" as const;
  readonly #native: NativeModule;

  constructor(native: NativeModule) {
    this.#native = native;
  }

  create48kMono(): OpusDecoder {
    return new NativeDiscordOpusDecoder(new this.#native.OpusEncoder(OPUS_SAMPLE_RATE, OPUS_CHANNELS));
  }
}

let cachedGate: OpusDecoderGate | undefined;

/**
 * Loads and probes the production-only native backend once. No opusscript
 * fallback exists here: a failed gate leaves Discord RX silent and observable.
 */
export function openNativeOpusDecoderGate(): OpusDecoderGate {
  if (cachedGate) return cachedGate;
  try {
    const require = createRequire(import.meta.url);
    const native = require("@discordjs/opus") as NativeModule;
    const factory = new NativeDiscordOpusFactory(native);
    const probe = factory.create48kMono();
    try {
      probe.decode(OPUS_SELF_CHECK_PACKET);
    } finally {
      probe.dispose();
    }
    cachedGate = { state: "READY", factory, reason: null };
  } catch {
    cachedGate = { state: "UNAVAILABLE", factory: null, reason: "native Opus decoder unavailable" };
  }
  return cachedGate;
}

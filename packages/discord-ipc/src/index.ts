const MAGIC = Buffer.from("DBR1");

export const DISCORD_IPC_VERSION = 1;
export const DISCORD_IPC_HEADER_BYTES = 56;
export const DISCORD_IPC_MAX_FRAME_BYTES = 64 * 1024;

export const DiscordFrameType = {
  OPUS: 1,
  USER_META: 2,
  USER_LEFT: 3,
  ADAPTER_STATE: 4,
  PING: 5,
  VOICE_CHANNELS: 6,
  BOT_META: 7,
  TX_PCM: 8,
  TX_CONTROL: 9,
  BOT_CONTROL: 10,
} as const;

export type DiscordBotControlAction = "CONNECT" | "DISCONNECT";

export interface DiscordBotControlPayload {
  action: DiscordBotControlAction;
  profileId: string;
}

// OPUS-only metadata flags; absent means synthetic/unknown RTP provenance.
export const DiscordRxFlags = { REAL_RTP: 1, RTP_RESET: 2 } as const;

export const DiscordTxFlags = {
  START: 1,
  STEREO: 2,
  ASSIGN_VOICE_CHANNEL: 4,
} as const;

export type DiscordFrameTypeValue = (typeof DiscordFrameType)[keyof typeof DiscordFrameType];

export interface DiscordIpcFrame {
  type: DiscordFrameTypeValue;
  flags?: number;
  sequence?: number;
  rtpTimestamp?: number;
  /** DBR1 v1 header offset 20: source membership generation; 0 means legacy/no generation. */
  sourceGeneration?: number;
  botId?: string;
  guildId?: string;
  voiceChannelId?: string;
  userId?: string;
  payload?: Uint8Array;
}

function snowflake(value = "0"): bigint {
  if (!/^\d+$/.test(value)) throw new TypeError(`invalid Discord snowflake: ${value}`);
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > 0xffff_ffff_ffff_ffffn) throw new RangeError(`Discord snowflake is out of range: ${value}`);
  return parsed;
}

export function encodeDiscordFrame(frame: DiscordIpcFrame): Buffer {
  if (frame.sourceGeneration !== undefined && (!Number.isInteger(frame.sourceGeneration) || frame.sourceGeneration < 0 || frame.sourceGeneration > 0xffff_ffff)) {
    throw new RangeError("Discord participant generation must be a u32");
  }
  const payload = Buffer.from(frame.payload ?? []);
  const totalBytes = DISCORD_IPC_HEADER_BYTES + payload.length;
  if (totalBytes > DISCORD_IPC_MAX_FRAME_BYTES) throw new RangeError("Discord IPC frame is too large");

  const result = Buffer.allocUnsafe(totalBytes);
  MAGIC.copy(result, 0);
  result[4] = DISCORD_IPC_VERSION;
  result[5] = frame.type;
  result.writeUInt16BE(frame.flags ?? 0, 6);
  result.writeUInt32BE(totalBytes, 8);
  result.writeUInt32BE(frame.sequence ?? 0, 12);
  result.writeUInt32BE(frame.rtpTimestamp ?? 0, 16);
  result.writeUInt32BE(frame.sourceGeneration ?? 0, 20);
  result.writeBigUInt64BE(snowflake(frame.botId), 24);
  result.writeBigUInt64BE(snowflake(frame.guildId), 32);
  result.writeBigUInt64BE(snowflake(frame.voiceChannelId), 40);
  result.writeBigUInt64BE(snowflake(frame.userId), 48);
  payload.copy(result, DISCORD_IPC_HEADER_BYTES);
  return result;
}

export function decodeDiscordFrame(frame: Uint8Array): DiscordIpcFrame {
  const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  if (buffer.length < DISCORD_IPC_HEADER_BYTES) throw new RangeError("incomplete Discord IPC header");
  if (!buffer.subarray(0, 4).equals(MAGIC)) throw new Error("invalid Discord IPC magic");
  if (buffer[4] !== DISCORD_IPC_VERSION) throw new Error(`unsupported Discord IPC version: ${buffer[4]}`);
  const totalBytes = buffer.readUInt32BE(8);
  if (totalBytes !== buffer.length || totalBytes > DISCORD_IPC_MAX_FRAME_BYTES) throw new RangeError("invalid Discord IPC frame length");
  const type = buffer[5] as DiscordFrameTypeValue;
  if (!Object.values(DiscordFrameType).includes(type)) throw new Error(`unknown Discord IPC frame type: ${type}`);
  return {
    type,
    flags: buffer.readUInt16BE(6),
    sequence: buffer.readUInt32BE(12),
    rtpTimestamp: buffer.readUInt32BE(16),
    sourceGeneration: buffer.readUInt32BE(20),
    botId: buffer.readBigUInt64BE(24).toString(),
    guildId: buffer.readBigUInt64BE(32).toString(),
    voiceChannelId: buffer.readBigUInt64BE(40).toString(),
    userId: buffer.readBigUInt64BE(48).toString(),
    payload: buffer.subarray(DISCORD_IPC_HEADER_BYTES),
  };
}

export class DiscordFrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): DiscordIpcFrame[] {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const decoded: DiscordIpcFrame[] = [];
    while (this.#buffer.length >= DISCORD_IPC_HEADER_BYTES) {
      if (!this.#buffer.subarray(0, 4).equals(MAGIC)) throw new Error("invalid Discord IPC stream magic");
      if (this.#buffer[4] !== DISCORD_IPC_VERSION) throw new Error(`unsupported Discord IPC version: ${this.#buffer[4]}`);
      const totalBytes = this.#buffer.readUInt32BE(8);
      if (totalBytes < DISCORD_IPC_HEADER_BYTES || totalBytes > DISCORD_IPC_MAX_FRAME_BYTES) {
        throw new RangeError(`invalid Discord IPC stream frame length: ${totalBytes}`);
      }
      if (this.#buffer.length < totalBytes) break;
      decoded.push(decodeDiscordFrame(this.#buffer.subarray(0, totalBytes)));
      this.#buffer = this.#buffer.subarray(totalBytes);
    }
    return decoded;
  }

  get bufferedBytes(): number {
    return this.#buffer.length;
  }
}

export function defaultDiscordIpcEndpoint(): string {
  return process.platform === "win32"
    ? String.raw`\\.\pipe\discord-broadcast-router-opus`
    : "/tmp/discord-broadcast-router-opus.sock";
}

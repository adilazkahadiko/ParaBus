import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DISCORD_IPC_VERSION,
  DiscordFrameDecoder,
  decodeDiscordFrame,
  type DiscordIpcFrame,
} from "../../packages/discord-ipc/src/index.ts";

interface ExpectedFrame {
  type: number;
  flags: number;
  sequence: number;
  rtpTimestamp: number;
  sourceGeneration?: number;
  botId: string;
  guildId: string;
  voiceChannelId: string;
  userId: string;
  payloadHex: string;
}

interface Fixture {
  version: number;
  frames: Array<{ name: string; hex: string; expected: ExpectedFrame }>;
  streamChunks: string[];
}

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL("./fixtures/discord-ipc-v1.json", import.meta.url)),
  "utf8",
)) as Fixture;

function project(frame: DiscordIpcFrame): ExpectedFrame {
  return {
    type: frame.type,
    flags: frame.flags ?? 0,
    sequence: frame.sequence ?? 0,
    rtpTimestamp: frame.rtpTimestamp ?? 0,
    sourceGeneration: frame.sourceGeneration ?? 0,
    botId: frame.botId ?? "0",
    guildId: frame.guildId ?? "0",
    voiceChannelId: frame.voiceChannelId ?? "0",
    userId: frame.userId ?? "0",
    payloadHex: Buffer.from(frame.payload ?? []).toString("hex"),
  };
}

function expected(frame: ExpectedFrame): ExpectedFrame {
  return { ...frame, sourceGeneration: frame.sourceGeneration ?? 0 };
}

test("TypeScript decoder matches the shared Rust Discord IPC fixture", () => {
  assert.equal(fixture.version, DISCORD_IPC_VERSION);
  for (const item of fixture.frames) {
    assert.deepEqual(project(decodeDiscordFrame(Buffer.from(item.hex, "hex"))), expected(item.expected), item.name);
  }
});

test("TypeScript stream decoder matches shared split and coalesced chunks", () => {
  const decoder = new DiscordFrameDecoder();
  const decoded = fixture.streamChunks.flatMap((chunk) => decoder.push(Buffer.from(chunk, "hex")));
  const streamExpected = [...fixture.frames.slice(0, 3), fixture.frames[4], fixture.frames[3]];
  assert.deepEqual(decoded.map(project), streamExpected.map((item) => expected(item.expected)));
  assert.equal(decoder.bufferedBytes, 0);
});

import assert from "node:assert/strict";
import { Socket } from "node:net";
import test from "node:test";
import OpusScript from "opusscript";
import {
  DISCORD_IPC_HEADER_BYTES,
  DiscordFrameDecoder,
  DiscordFrameType,
  decodeDiscordFrame,
  encodeDiscordFrame,
} from "../packages/discord-ipc/src/index.ts";
import { MAX_DISCORD_RX_CHANNELS, MAX_LOCAL_INPUT_CHANNELS, MAX_RX_CHANNELS } from "../packages/shared-types/src/index.ts";
import { AudioChannel, AudioEngine, SilenceSource, VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";
import type { OpusDecoder, OpusDecoderFactory } from "../services/router-core-sim/src/opus-decoder.ts";

const ids = {
  botId: "100000000000000001",
  guildId: "100000000000000002",
  voiceChannelId: "100000000000000003",
  userId: "100000000000000004",
};

class SpyDecoder implements OpusDecoder {
  disposed = 0;
  decode(): Buffer { return Buffer.alloc(960 * 2); }
  dispose(): void { this.disposed += 1; }
}

class SpyDecoderFactory implements OpusDecoderFactory {
  readonly backend = "@discordjs/opus" as const;
  readonly decoders: SpyDecoder[] = [];
  create48kMono(): OpusDecoder {
    const decoder = new SpyDecoder();
    this.decoders.push(decoder);
    return decoder;
  }
}

test("RX diagnostics explain reconnect rejection without changing safe receive gates", () => {
  const engine = new AudioEngine(48_000, 480, 2);
  const ingest = new DiscordIngestServer(engine, "test-only", null, new SpyDecoderFactory());
  receiverReady(ingest);
  const membership = { ...ids, sourceGeneration: 1 };
  ingest.ingest({ type: DiscordFrameType.USER_META, ...membership, payload: Buffer.from("Guest") });
  const opus = (sequence: number, sourceGeneration = 1) => ingest.ingest({ type: DiscordFrameType.OPUS, ...membership, sequence, sourceGeneration, payload: Buffer.from([1]) });
  const state = (gatewayState: string) => ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...ids, payload: Buffer.from(JSON.stringify({ gatewayState, voiceState: "ready" })) });
  opus(1);
  state("reconnecting");
  for (let sequence = 2; sequence <= 45; sequence += 1) opus(sequence);
  assert.equal(ingest.snapshot().sources[0].packets, 1);
  state("ready");
  opus(46);
  opus(46);
  opus(47, 2);
  const snapshot = ingest.snapshot();
  assert.deepEqual(snapshot.rxDiagnostics?.rejectedOpus, { "health:RECONNECTING": 44, sequenceReordered: 1, sourceGeneration: 1 });
  assert.equal(snapshot.sources[0].sequenceGaps, 44);
  assert.equal(snapshot.sources[0].droppedSamples, 0);
  assert.equal([...engine.channels.values()][0].approvalGateOpen, false);
  snapshot.rxDiagnostics!.rejectedOpus["health:RECONNECTING"] = 0;
  assert.equal(ingest.snapshot().rxDiagnostics?.rejectedOpus["health:RECONNECTING"], 44, "snapshots do not mutate live counters");
});

test("RX diagnostics retain burst context and validate one IPC report per socket", async (t) => {
  const engine = new AudioEngine(48_000, 480, 2);
  const ingest = new DiscordIngestServer(engine, "test-only", null, new SpyDecoderFactory());
  t.after(() => ingest.close());
  const socket = new Socket(); // Unconnected in-memory data events only.
  (ingest as unknown as { accept(socket: Socket): void }).accept(socket);
  const status = { profileId: "RX", role: "RX", gatewayState: "ready", voiceState: "ready" };
  const rxIpc = { opusDroppedFrames: 3, backpressureWrites: 2, writableBytes: 0, maxWritableBytes: 1024 };
  const membership = { ...ids, sourceGeneration: 1 };
  const frames = [
    { type: DiscordFrameType.BOT_META, ...ids, payload: Buffer.from(JSON.stringify(status)) },
    { type: DiscordFrameType.ADAPTER_STATE, ...ids, payload: Buffer.from(JSON.stringify({ ...status, rxIpc })) },
    { type: DiscordFrameType.USER_META, ...membership, payload: Buffer.from("Guest") },
    ...Array.from({ length: 9 }, (_, index) => ({ type: DiscordFrameType.OPUS, ...membership, sequence: index + 1, payload: Buffer.from([1]) })),
  ];
  const chunk = Buffer.concat(frames.map(encodeDiscordFrame));
  socket.emit("data", chunk);
  const snapshot = ingest.snapshot();
  assert.equal(snapshot.sources[0].droppedSamples, 1920);
  assert.equal(snapshot.sources[0].rxTiming?.overflowEvents, 2);
  assert.equal(snapshot.sources[0].rxTiming?.maxQueuedMilliseconds, 140);
  assert.equal(snapshot.sources[0].rxTiming?.lastOverflow?.queuedBeforeMilliseconds, 140);
  assert.equal(snapshot.sources[0].rxTiming?.lastOverflow?.batchOpusFrames, 9);
  assert.equal(snapshot.sources[0].rxTiming?.lastOverflow?.batchBytes, chunk.length);
  assert.equal(snapshot.sources[0].rxTiming?.underruns, 0);
  assert.equal(snapshot.sources[0].rxTiming?.overflowsAfterUnderrun, 0);
  const source = [...ingest.runtimes.values()][0].source;
  source.timing!.silenceBlocksDropped = 3;
  source.timing!.compressedSamples = 25;
  for (const history of [false, true]) {
    const timing = ingest.snapshot(Date.now(), history).sources[0].rxTiming!;
    assert.equal(timing.silenceBlocksDropped, 3);
    assert.equal(timing.compressedSamples, 25);
  }
  // Filling is independent of approval/mute and exposes the actual RX ring waterline.
  for (let block = 0; block < 15; block++) engine.processBlock();
  assert.equal(ingest.snapshot().sources[0].rxTiming?.underruns, 1);
  assert.equal(ingest.snapshot().sources[0].rxTiming?.queueWindows?.[0].maxMs, 140);
  const totals = ingest.rxTimingTotals();
  assert.deepEqual(totals, { underruns: 1, overflows: 2 });
  assert.equal(snapshot.rxDiagnostics?.ipcBatches.maxOpusFrames, 9);
  assert.equal(snapshot.rxDiagnostics?.ipcBatches.maxBytes, chunk.length);
  assert.equal(snapshot.rxDiagnostics?.ipcBatches.count, 1);
  assert.deepEqual(snapshot.rxDiagnostics?.adapterIpc, [rxIpc]);
  for (const invalid of [null, { ...rxIpc, opusDroppedFrames: -1 }, { ...rxIpc, writableBytes: "token=do-not-copy" }, { ...rxIpc, maxWritableBytes: 1.5 }, { ...rxIpc, backpressureWrites: Number.MAX_SAFE_INTEGER + 1 }]) {
    socket.emit("data", encodeDiscordFrame({ type: DiscordFrameType.PING, ...ids, payload: Buffer.from(JSON.stringify({ ...status, rxIpc: invalid })) }));
    assert.deepEqual(ingest.snapshot().rxDiagnostics?.adapterIpc, [rxIpc]);
  }
  // A second Bot reports the same process-wide counters: do not double-count.
  const secondBot = { ...ids, botId: "100000000000000005" };
  socket.emit("data", Buffer.concat([
    encodeDiscordFrame({ type: DiscordFrameType.BOT_META, ...secondBot, payload: Buffer.from(JSON.stringify({ ...status, profileId: "TX", role: "TX" })) }),
    encodeDiscordFrame({ type: DiscordFrameType.PING, ...secondBot, payload: Buffer.from(JSON.stringify({ rxIpc })) }),
  ]));
  assert.deepEqual(ingest.snapshot().rxDiagnostics?.adapterIpc, [rxIpc]);
  assert.equal(ingest.snapshot().sources[0].sequenceGaps, 0, "bursting is not a local sequence gap");
  ingest.ingest({ type: DiscordFrameType.USER_LEFT, ...membership });
  assert.deepEqual(ingest.rxTimingTotals(), totals, "minute summaries do not lose events when a participant leaves");
});

function receiverReady(ingest: DiscordIngestServer): void {
  ingest.ingest({
    type: DiscordFrameType.BOT_META,
    ...ids,
    userId: ids.botId,
    payload: Buffer.from(JSON.stringify({
      profileId: "RX",
      role: "RX",
      gatewayState: "ready",
      voiceState: "ready",
      guildName: "Broadcast Server",
      voiceChannelName: "Interview Room",
    })),
  });
}

test("Discord IPC frame round-trips binary Opus payload", () => {
  const payload = Buffer.from([0xf8, 0xff, 0xfe]);
  const encoded = encodeDiscordFrame({ type: DiscordFrameType.OPUS, ...ids, sequence: 42, rtpTimestamp: 960, payload });
  assert.equal(encoded.length, DISCORD_IPC_HEADER_BYTES + payload.length);
  const decoded = decodeDiscordFrame(encoded);
  assert.equal(decoded.type, DiscordFrameType.OPUS);
  assert.equal(decoded.sequence, 42);
  assert.equal(decoded.rtpTimestamp, 960);
  assert.equal(decoded.userId, ids.userId);
  assert.deepEqual(Buffer.from(decoded.payload!), payload);
});

test("Discord IPC stream decoder handles split and coalesced frames", () => {
  const first = encodeDiscordFrame({ type: DiscordFrameType.PING, ...ids });
  const second = encodeDiscordFrame({ type: DiscordFrameType.USER_LEFT, ...ids });
  const decoder = new DiscordFrameDecoder();
  assert.deepEqual(decoder.push(first.subarray(0, 11)), []);
  const decoded = decoder.push(Buffer.concat([first.subarray(11), second]));
  assert.deepEqual(decoded.map((frame) => frame.type), [DiscordFrameType.PING, DiscordFrameType.USER_LEFT]);
  assert.equal(decoder.bufferedBytes, 0);
});

test("Router Core decodes Opus and creates a safe DiscordUser channel", (t) => {
  let now = 0; t.mock.method(performance, "now", () => now);
  const engine = new AudioEngine(48_000, 480, 2);
  engine.addBus(new VcBus("interview", "INTERVIEW VC", engine.blockSize, engine.sampleRate));
  const ingest = new DiscordIngestServer(engine, "test-only");
  receiverReady(ingest);
  const encoder = new OpusScript(48_000, 1, OpusScript.Application.VOIP);
  const pcm = Buffer.alloc(960 * 2);
  for (let index = 0; index < 960; index += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((index / 48_000) * 2 * Math.PI * 440) * 12_000), index * 2);
  }
  const packet = encoder.encode(pcm, 960);
  ingest.ingest({ type: DiscordFrameType.USER_META, ...ids, payload: Buffer.from("Interview Guest") });
  ingest.ingest({ type: DiscordFrameType.OPUS, ...ids, sequence: 1, rtpTimestamp: 960, payload: packet });
  now = 60; // A single-packet talkspurt is released by bounded RX prebuffering.
  engine.processBlock();
  engine.processBlock();

  const channel = [...engine.channels.values()][0];
  assert.equal(channel.kind, "DiscordUser");
  assert.equal(channel.label, "Interview Guest");
  const voiceBusId = `discord-vc:${ids.guildId}:${ids.voiceChannelId}`;
  assert.deepEqual(channel.vcSends.get(voiceBusId), { gainDb: -12, mute: false });
  assert.equal(engine.buses.get(voiceBusId)?.autoCreated, true);
  assert.ok(channel.inputMeter.peak > 0.05, "Discord RX metering remains available before approval");
  assert.equal(channel.approvalGateOpen, false);
  assert.equal(channel.outputMeter.peak, 0, "Discord audio fails closed without an approval session");
  const stats = ingest.snapshot();
  assert.equal(stats.packets, 1);
  assert.equal(stats.sources[0].decodedSamples, 960);
  assert.equal(stats.decodeErrors, 0);
  encoder.delete();
});

test("Discord adapter voice-channel metadata is exposed by Core", () => {
  const engine = new AudioEngine(48_000, 480, 2);
  const ingest = new DiscordIngestServer(engine, "test-only");
  receiverReady(ingest);
  ingest.ingest({
    type: DiscordFrameType.VOICE_CHANNELS,
    ...ids,
    payload: Buffer.from(JSON.stringify([{ id: "100000000000000010", name: "Interview Room" }])),
  });
  assert.deepEqual(ingest.snapshot().availableVoiceChannels, [
    { guildId: ids.guildId, id: "100000000000000010", name: "Interview Room" },
  ]);
  assert.equal(ingest.snapshot().bots[0]?.guildName, "Broadcast Server");
  assert.equal(ingest.snapshot().bots[0]?.voiceChannelName, "Interview Room");
});

test("generation-aware USER_LEFT disposes only its matching source and reclaims capacity", () => {
  const engine = new AudioEngine(48_000, 480, 2);
  const ingest = new DiscordIngestServer(engine, "test-only");
  receiverReady(ingest);
  const first = { ...ids, sourceGeneration: 1 };
  ingest.ingest({ type: DiscordFrameType.USER_META, ...first, payload: Buffer.from("Guest") });
  const channelId = `discord-user:${ids.guildId}:${ids.voiceChannelId}:${ids.userId}`;
  const source = ingest.runtimes.get(channelId)?.source;
  assert.ok(source);
  assert.equal(source.capacity, engine.blockSize * 14, "Discord RX transport reserve is bounded to fourteen graph blocks");
  source.pushInt16Le(Buffer.alloc(960));
  engine.monitorSourceId = channelId;
  engine.addMatrixRoute({ id: "guest-monitor", sourceId: channelId, output: 0, gainDb: 0, mute: false, tap: "POST" });

  ingest.ingest({ type: DiscordFrameType.USER_META, ...first, sourceGeneration: 2, payload: Buffer.from("Guest rejoined") });
  ingest.ingest({ type: DiscordFrameType.USER_LEFT, ...first }); // delayed generation 1 leave must not remove generation 2
  ingest.ingest({ type: DiscordFrameType.USER_META, ...first, sourceGeneration: 0, payload: Buffer.from("Legacy adapter") }); // mixed legacy frame must fail closed
  assert.equal(ingest.runtimes.get(channelId)?.sourceGeneration, 2);
  ingest.ingest({ type: DiscordFrameType.OPUS, ...first, sequence: 1, payload: Buffer.alloc(1) }); // old OPUS must not recreate or mix
  assert.equal(ingest.runtimes.get(channelId)?.packets, 0);

  ingest.ingest({ type: DiscordFrameType.USER_LEFT, ...first, sourceGeneration: 2 });
  ingest.ingest({ type: DiscordFrameType.USER_LEFT, ...first, sourceGeneration: 2 });
  assert.equal(ingest.runtimes.has(channelId), false);
  assert.equal(engine.channels.has(channelId), false);
  assert.equal(engine.matrixRoutes.has("guest-monitor"), false);
  assert.equal(engine.monitorSourceId, null);
  assert.equal(source.queuedSamples, 0);

  for (let index = 0; index < 96; index += 1) {
    const userId = (100000000000001000n + BigInt(index)).toString();
    const membership = { ...ids, userId, sourceGeneration: index + 10 };
    ingest.ingest({ type: DiscordFrameType.USER_META, ...membership, payload: Buffer.from("Guest") });
    ingest.ingest({ type: DiscordFrameType.USER_LEFT, ...membership });
  }
  assert.equal(ingest.runtimes.size, 0);
  assert.equal(engine.channels.size, 0);
});

test("decoder disposal is idempotent across USER_LEFT, authority conflict, and resync metadata", () => {
  const factory = new SpyDecoderFactory();
  const ingest = new DiscordIngestServer(new AudioEngine(48_000, 480, 2), "test-only", null, factory);
  const firstSocket = {} as Socket;
  const secondSocket = {} as Socket;
  const status = Buffer.from(JSON.stringify({ profileId: "RX", role: "RX", gatewayState: "ready", voiceState: "ready" }));
  const membership = { ...ids, sourceGeneration: 4 };
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload: status }, firstSocket);
  ingest.ingest({ type: DiscordFrameType.USER_META, ...membership, payload: Buffer.from("Guest") }, firstSocket);
  ingest.ingest({ type: DiscordFrameType.USER_META, ...membership, payload: Buffer.from("Guest") }, firstSocket);
  assert.equal(factory.decoders.length, 1, "resync metadata must not recreate the current decoder");
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload: status }, secondSocket);
  assert.equal(factory.decoders[0].disposed, 1, "duplicate authority releases the old decoder once");
  ingest.ingest({ type: DiscordFrameType.USER_META, ...membership, payload: Buffer.from("Guest") }, secondSocket);
  assert.equal(factory.decoders.length, 1, "conflicted authority cannot create another decoder");
  ingest.ingest({ type: DiscordFrameType.USER_LEFT, ...membership }, firstSocket);
  ingest.ingest({ type: DiscordFrameType.USER_LEFT, ...membership }, secondSocket);
  assert.equal(factory.decoders[0].disposed, 1, "late duplicate leave remains idempotent");
});

test("unavailable native decoder gate fails closed without creating a Discord source", () => {
  const ingest = new DiscordIngestServer(new AudioEngine(48_000, 480, 2), "test-only", null, null);
  receiverReady(ingest);
  ingest.ingest({ type: DiscordFrameType.USER_META, ...ids, sourceGeneration: 1, payload: Buffer.from("Guest") });
  ingest.ingest({ type: DiscordFrameType.OPUS, ...ids, sourceGeneration: 1, sequence: 1, payload: Buffer.from([1]) });
  const snapshot = ingest.snapshot();
  assert.equal(snapshot.decoderState, "UNAVAILABLE");
  assert.equal(snapshot.sources.length, 0);
  assert.ok(snapshot.decodeErrors >= 1);
});

test("Discord source sequences wrap safely, reject reordered packets, and reset with a new generation", () => {
  const ingest = new DiscordIngestServer(new AudioEngine(48_000, 480, 2), "test-only");
  receiverReady(ingest);
  const membership = { ...ids, sourceGeneration: 7 };
  ingest.ingest({ type: DiscordFrameType.USER_META, ...membership, payload: Buffer.from("Guest") });
  ingest.ingest({ type: DiscordFrameType.OPUS, ...membership, sequence: 0xffff_ffff, payload: Buffer.alloc(1) });
  ingest.ingest({ type: DiscordFrameType.OPUS, ...membership, sequence: 0, payload: Buffer.alloc(1) });
  ingest.ingest({ type: DiscordFrameType.OPUS, ...membership, sequence: 0xffff_fffe, payload: Buffer.alloc(1) });
  let source = ingest.snapshot().sources[0];
  assert.equal(source.packets, 2);
  assert.equal(source.sequenceGaps, 0);
  ingest.ingest({ type: DiscordFrameType.USER_LEFT, ...membership });
  ingest.ingest({ type: DiscordFrameType.USER_META, ...membership, sourceGeneration: 8, payload: Buffer.from("Guest") });
  ingest.ingest({ type: DiscordFrameType.OPUS, ...membership, sourceGeneration: 8, sequence: 1, payload: Buffer.alloc(1) });
  source = ingest.snapshot().sources[0];
  assert.equal(source.packets, 1);
  assert.equal(source.sequenceGaps, 0);
});

test("duplicate BOT_META sockets fail closed and a fresh authoritative reconnect rejects stale frames", () => {
  const ingest = new DiscordIngestServer(new AudioEngine(48_000, 480, 2), "test-only");
  const oldSocket = {} as Socket;
  const newSocket = {} as Socket;
  const status = Buffer.from(JSON.stringify({ profileId: "RX", role: "RX", gatewayState: "ready", voiceState: "ready" }));
  const membership = { ...ids, sourceGeneration: 1 };
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload: status }, oldSocket);
  ingest.ingest({ type: DiscordFrameType.USER_META, ...membership, payload: Buffer.from("Old") }, oldSocket);
  assert.equal(ingest.runtimes.size, 1);

  ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload: status }, newSocket);
  assert.equal(ingest.runtimes.size, 0, "duplicate authority clears old socket-owned sources");
  ingest.ingest({ type: DiscordFrameType.USER_META, ...membership, payload: Buffer.from("New") }, newSocket);
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload: status }, oldSocket);
  ingest.ingest({ type: DiscordFrameType.USER_LEFT, ...membership }, oldSocket);
  ingest.ingest({ type: DiscordFrameType.OPUS, ...membership, sequence: 1, payload: Buffer.alloc(1) }, oldSocket);
  ingest.ingest({ type: DiscordFrameType.OPUS, ...membership, sequence: 1, payload: Buffer.alloc(1) }, newSocket);
  assert.equal(ingest.runtimes.size, 0, "neither side of a duplicate authority can feed RX");

  const release = (socket: Socket) => (ingest as unknown as { releaseSocketAuthorities(socket: Socket): void }).releaseSocketAuthorities(socket);
  release(oldSocket);
  release(newSocket);
  const restoredSocket = {} as Socket;
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload: status }, restoredSocket);
  ingest.ingest({ type: DiscordFrameType.USER_META, ...membership, payload: Buffer.from("Restored") }, restoredSocket);
  ingest.ingest({ type: DiscordFrameType.OPUS, ...membership, sequence: 1, payload: Buffer.alloc(1) }, oldSocket);
  ingest.ingest({ type: DiscordFrameType.OPUS, ...membership, sequence: 1, payload: Buffer.alloc(1) }, newSocket);
  ingest.ingest({ type: DiscordFrameType.OPUS, ...membership, sequence: 1, payload: Buffer.alloc(1) }, restoredSocket);
  assert.equal(ingest.runtimes.size, 1, "fresh reconnect restores exactly one authoritative source");
  assert.equal(ingest.snapshot().sources[0].packets, 1, "only the restored authority can feed Opus");

  ingest.ingest({ type: DiscordFrameType.USER_LEFT, ...membership }, restoredSocket);
  for (let index = 0; index < 96; index += 1) {
    const item = { ...ids, userId: (100000000000002000n + BigInt(index)).toString(), sourceGeneration: index + 2 };
    ingest.ingest({ type: DiscordFrameType.USER_META, ...item, payload: Buffer.from("Guest") }, restoredSocket);
    ingest.ingest({ type: DiscordFrameType.USER_LEFT, ...item }, restoredSocket);
  }
  assert.deepEqual(ingest.ownershipTrackingCounts(), { sockets: 2, sources: 0 });
});

test("Discord accepts 112 participants plus 8 local inputs and rejects participant 113 without dropping IPC", async (t) => {
  const engine = new AudioEngine(48_000, 480, 2);
  for (let index = 0; index < MAX_LOCAL_INPUT_CHANNELS; index += 1) {
    engine.addChannel(new AudioChannel(`local:${index}`, `Local ${index}`, "LocalMonoInput", new SilenceSource(), 480, 48_000));
  }
  const ingest = new DiscordIngestServer(engine, "test-only", null, new SpyDecoderFactory());
  const warnings: string[] = [];
  ingest.setReceiverEventHandler((_level, message) => warnings.push(message));
  t.after(() => ingest.close());
  const socket = new Socket();
  (ingest as unknown as { accept(socket: Socket): void }).accept(socket);
  const status = Buffer.from(JSON.stringify({ profileId: "RX", role: "RX", gatewayState: "ready", voiceState: "ready" }));
  const members = Array.from({ length: MAX_DISCORD_RX_CHANNELS + 1 }, (_, index) => ({
    ...ids,
    userId: (100000000000010000n + BigInt(index)).toString(),
    sourceGeneration: 1,
  }));
  const frames = [
    { type: DiscordFrameType.BOT_META, ...ids, payload: status },
    ...members.map((member, index) => ({ type: DiscordFrameType.USER_META, ...member, payload: Buffer.from(`Guest ${index}`) })),
  ];
  socket.emit("data", Buffer.concat(frames.map(encodeDiscordFrame)));
  socket.emit("data", encodeDiscordFrame({ type: DiscordFrameType.USER_META, ...members.at(-1)!, payload: Buffer.from("Overflow retry") }));

  assert.equal(ingest.runtimes.size, MAX_DISCORD_RX_CHANNELS);
  assert.equal(engine.channels.size, MAX_RX_CHANNELS);
  assert.equal(ingest.runtimes.size, 112);
  assert.equal(engine.channels.size, 120);
  assert.equal(socket.destroyed, false, "one extra participant must not disconnect every Bot");
  assert.deepEqual(warnings, [`Discord receive capacity reached (${MAX_DISCORD_RX_CHANNELS}); additional participant audio ignored`]);
});

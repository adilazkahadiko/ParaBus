import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { RtpObserver, rtpHeader } from "../services/discord-adapter/src/rtp-observer.ts";
import { RxAdaptation } from "../services/router-core-sim/src/rx-adaptation.ts";
import { RtpTiming } from "../services/router-core-sim/src/rtp-timing.ts";
import { DiscordPcmSource } from "../services/router-core-sim/src/discord-pcm-source.ts";
import { DiscordPcmSource as Beta4 } from "./helpers/beta4-discord-pcm-source.ts";
import { AudioChannel, AudioEngine, PcmRingSource } from "../services/router-core-sim/src/audio-engine.ts";
import { RecorderManager } from "../services/router-core-sim/src/recorder.ts";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { abSchedule, SampleTrace, SilenceTrace } from "./rx-load/compare.ts";
import { VoiceReceiver, EndBehaviorType } from "@discordjs/voice";
import { createCipheriv } from "node:crypto";
import { DiscordFrameType, DiscordRxFlags, encodeDiscordFrame, decodeDiscordFrame } from "../packages/discord-ipc/src/index.ts";
import { DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";
import { DiscordBotConnection } from "../services/discord-adapter/src/bot-connection.ts";
import type { DiscordIpcClient } from "../services/discord-adapter/src/ipc-client.ts";
import type { DiscordIpcFrame } from "../packages/discord-ipc/src/index.ts";

const packet = Buffer.alloc(1920); for (let i = 0; i < 960; i++) packet.writeInt16LE(8192, i * 2);

test("fixed load probes preserve provenance through wrap and join fractional missing tails to the following silent blocks", () => {
  const samples = new SampleTrace();
  for (let i = 0; i < 200; i++) { samples.push(960, i * 20); samples.read(400); samples.drop(560); samples.emitted(i * 20 + 40); }
  assert.equal(samples.ages[40], 80000); assert.equal(samples.maxMs, 40);
  const silence = new SilenceTrace();
  silence.fill(480); silence.packet(1, 0, 0); silence.fill(0);
  assert.equal(silence.runs.startup.totalMs, 10);
  silence.fill(240); silence.fill(480); silence.packet(5, 3840, 80); silence.fill(0);
  assert.deepEqual(silence.runs.loss, { count: 1, totalMs: 15, maxMs: 15 });
  silence.fill(480); silence.packet(10, 13000, 1000); silence.fill(0);
  assert.deepEqual(silence.runs.lossWithPause, { count: 1, totalMs: 10, maxMs: 10 });
  assert.equal(silence.totalMs, 35);
});

test("passive UDP observer scopes headers to synchronous authenticated delivery, handles reconnect/fallback", async () => {
  const udp = new EventEmitter(), observer = new RtpObserver();
  const msg = Buffer.alloc(20); msg[0] = 0x80; msg[1] = 120; msg.writeUInt16BE(65535, 2); msg.writeUInt32BE(0xfffffc40, 4); msg.writeUInt32BE(42, 8);
  assert.equal(rtpHeader(Buffer.alloc(8)), null);
  let expected = true, found = 0;
  const receiver = { ssrcMap: new Map([[42, { userId: "user" }]]), onUdpMessage() {
    if (expected) { assert.equal(observer.take("other"), null); assert.equal(observer.take("user")?.sequence, 65535); found++; assert.equal(observer.take("user"), null); }
  } };
  udp.on("message", receiver.onUdpMessage);
  observer.bind({ state: { networking: { state: { udp } } }, receiver });
  udp.emit("message", msg); assert.equal(found, 1); assert.equal(observer.take("user"), null);
  await Promise.resolve(); assert.equal(observer.take("user"), null, "buffered data cannot inherit stale UDP metadata");
  observer.bind({}); expected = false; udp.emit("message", msg); assert.equal(observer.take("user"), null);
  assert.equal(udp.listenerCount("message"), 1, "no leaked passive listeners");
});

test("pinned VoiceReceiver decrypts a real UDP-format packet while passive observer binds the same RTP header", async () => {
  const udp = new EventEmitter(), observer = new RtpObserver();
  const receiver = new VoiceReceiver({ state: { status: "connecting" } } as any);
  receiver.ssrcMap.update({ userId: "user", audioSSRC: 42 });
  const key = Buffer.alloc(32, 7), nonce = Buffer.alloc(12);
  receiver.connectionData = { encryptionMode: "aead_aes256_gcm_rtpsize", secretKey: key, nonceBuffer: nonce } as any;
  udp.on("message", receiver.onUdpMessage);
  observer.bind({ state: { networking: { state: { udp } } }, receiver });
  const stream = receiver.subscribe("user", { end: { behavior: EndBehaviorType.Manual } });
  const received: number[] = [];
  stream.on("data", (data: Buffer) => { assert.equal(data.toString("hex"), "f8fffe"); received.push(observer.take("user")?.sequence ?? -1); });
  await new Promise<void>(done => setImmediate(done));
  const make = (sequence: number) => {
    const header = Buffer.alloc(12); header[0] = 0x80; header[1] = 120; header.writeUInt16BE(sequence, 2); header.writeUInt32BE(sequence * 960, 4); header.writeUInt32BE(42, 8);
    const cipher = createCipheriv("aes-256-gcm", key, Buffer.alloc(12)); cipher.setAAD(header);
    return Buffer.concat([header, cipher.update(Buffer.from("f8fffe", "hex")), cipher.final(), cipher.getAuthTag(), Buffer.alloc(4)]);
  };
  udp.emit("message", make(100)); udp.emit("message", make(101));
  assert.deepEqual(received, [100, 101]);
  observer.detach(); stream.destroy();
});

function firstPacketFixture(t: test.TestContext) {
  const udp = new EventEmitter();
  const receiver = new VoiceReceiver({ state: { status: "connecting" } } as any);
  receiver.ssrcMap.update({ userId: "user", audioSSRC: 42 });
  const key = Buffer.alloc(32, 7);
  receiver.connectionData = { encryptionMode: "aead_aes256_gcm_rtpsize", secretKey: key, nonceBuffer: Buffer.alloc(12) } as any;
  udp.on("message", receiver.onUdpMessage);
  t.after(() => { for (const stream of receiver.subscriptions.values()) stream.destroy(); });
  const make = (sequence: number) => {
    const header = Buffer.alloc(12); header[0] = 0x80; header[1] = 120;
    header.writeUInt16BE(sequence, 2); header.writeUInt32BE(sequence * 960, 4); header.writeUInt32BE(42, 8);
    const cipher = createCipheriv("aes-256-gcm", key, Buffer.alloc(12)); cipher.setAAD(header);
    return Buffer.concat([header, cipher.update(Buffer.from([1, 2, 3])), cipher.final(), cipher.getAuthTag(), Buffer.alloc(4)]);
  };
  return { udp, receiver, make };
}

test("speaking start subscribes through DiscordBotConnection and delivers the first same-tick packet as REAL_RTP", async t => {
  const { udp, receiver, make } = firstPacketFixture(t);
  const frames: DiscordIpcFrame[] = [];
  const bot = new DiscordBotConnection({ profileId: "RX", label: "Offline fixture", role: "RX", txSubtype: null,
    txAudioMode: null, tokenEnv: "UNUSED_OFFLINE", token: "", guildId: "1", voiceChannelId: "2" },
    { send: (frame: DiscordIpcFrame) => { frames.push(frame); } } as unknown as DiscordIpcClient, new Set());
  // No login, socket, player subscription, or physical I/O: only the real subscribeUser data path.
  bot.connection = { receiver, state: { networking: { state: { udp } } }, destroy() {} } as any;
  bot.sourceGenerations.set("user", 1);
  bot["bindRtpObserver"]();
  receiver.speaking.on("start", bot["subscribeUser"]);
  t.after(() => bot.close());

  // No await between listener registration and UDP delivery: subscribe happens inside this emit.
  udp.emit("message", make(100));
  assert.equal(frames.length, 1, "the first push must emit data before the UDP observer scope ends");
  assert.equal(frames[0].flags, DiscordRxFlags.REAL_RTP | DiscordRxFlags.RTP_RESET);
  assert.equal(frames[0].sequence, 100); assert.equal(frames[0].rtpTimestamp, 96000);
  assert.deepEqual(frames[0].payload, Buffer.from([1, 2, 3]));

  // AfterSilence recreates subscriptions at speech boundaries; their first packet must also be real.
  await once(bot.streams.get("user")!, "end");
  await new Promise<void>(done => setImmediate(done));
  assert.equal(bot.streams.has("user"), false);
  assert.equal(receiver.subscriptions.has("user"), false);
  udp.emit("message", make(101));
  assert.equal(frames.length, 2);
  assert.equal(frames[1].flags, DiscordRxFlags.REAL_RTP);
  assert.equal(frames[1].sequence, 101); assert.equal(frames[1].rtpTimestamp, 96960);
});

test("pinned VoiceReceiver buffered first data falls back without borrowing a later UDP header", async t => {
  const { udp, receiver, make } = firstPacketFixture(t);
  const observer = new RtpObserver();
  observer.bind({ state: { networking: { state: { udp } } }, receiver });
  t.after(() => observer.detach());
  const received: number[] = [];
  receiver.speaking.on("start", userId => {
    const stream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    // Deliberately leave Node Readable unprimed to exercise deferred/buffered delivery.
    stream.on("data", () => received.push(observer.take(userId)?.sequence ?? -1));
  });
  udp.emit("message", make(200));
  assert.deepEqual(received, []);
  await new Promise<void>(done => setImmediate(done));
  assert.deepEqual(received, [-1], "deferred data must retain the synthetic fallback");
  udp.emit("message", make(201));
  assert.deepEqual(received, [-1, 201], "only synchronous data may consume the current header");
});

test("RTP wraps, loss, sender pause and delayed batch evidence are distinct; synthetic is unknown", () => {
  const rtp = new RtpTiming(0);
  rtp.observe({ real: true, sequence: 65535, timestamp: 0xfffffc40 }, 0);
  rtp.observe({ real: true, sequence: 0, timestamp: 0 }, 20);
  assert.equal(rtp.observe({ real: true, sequence: 6, timestamp: 5760 }, 140).kind, "loss");
  assert.equal(rtp.observe({ real: true, sequence: 7, timestamp: 48000 }, 1000).kind, "senderPause");
  const delayed = rtp.observe({ real: true, sequence: 8, timestamp: 48960 }, 1080);
  assert.equal(delayed.kind, "unknown");
  assert.equal(rtp.observe({ real: true, sequence: 9, timestamp: 49920 }, 1080).confirmedSerial, delayed.serial);
  rtp.observe({ real: false, sequence: 10, timestamp: 50880 }, 1200);
  const state = rtp.snapshot(1200, true);
  assert.equal(state.missingPackets, 5);
  assert.deepEqual(state.counts, { loss: 1, senderPause: 1, delayed: 1, fillBurst: 0, unknown: 1 });
  assert.equal(state.gapWindows!.loss[0].maxMs, 120);
  assert.equal(state.syntheticPackets, 1);
});

test("an unconfirmed late gap enters the unknown distribution even when no further packet arrives", () => {
  const rtp = new RtpTiming(0);
  rtp.observe({ real: true, sequence: 1, timestamp: 0 }, 0);
  rtp.observe({ real: true, sequence: 2, timestamp: 960 }, 80);
  assert.equal(rtp.snapshot(84, true).counts.unknown, 1);
  const expired = rtp.snapshot(86, true);
  assert.equal(expired.counts.unknown, 1); assert.equal(expired.gapWindows!.unknown[0].maxMs, 80);
  rtp.observe({ real: true, sequence: 3, timestamp: 1920 }, 100);
  assert.equal(rtp.snapshot(100, true).counts.unknown, 1, "snapshot finalization must not double-count at the next packet");
});

test("RTP provenance survives IPC and receive gates handle wrap/reset/reorder and unknown fallback", async t => {
  const ingest = new DiscordIngestServer(new AudioEngine(48000, 480, 2), "offline-never-listen", null,
    { backend: "@discordjs/opus", create48kMono: () => ({ decode: () => packet, dispose() {} }) });
  t.after(() => ingest.close());
  const ids = { botId: "100000000000000001", guildId: "100000000000000002", voiceChannelId: "100000000000000003", userId: "100000000000000004", sourceGeneration: 1 };
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload: Buffer.from(JSON.stringify({ profileId: "RX", role: "RX", gatewayState: "ready", voiceState: "ready" })) });
  ingest.ingest({ type: DiscordFrameType.USER_META, ...ids, payload: Buffer.from("Synthetic") });
  const opus = (sequence: number, timestamp: number, flags: number = DiscordRxFlags.REAL_RTP) =>
    ingest.ingest(decodeDiscordFrame(encodeDiscordFrame({ type: DiscordFrameType.OPUS, ...ids, sequence, rtpTimestamp: timestamp, flags, payload: Buffer.from([1]) })));
  opus(65534, 0xfffff880); opus(65535, 0xfffffc40); opus(0, 0); opus(2, 1920);
  let source = ingest.snapshot().sources[0];
  assert.equal(source.packets, 4); assert.equal(source.sequenceGaps, 1); assert.equal(source.sequenceGapsKnown, true);
  assert.equal(source.rxTiming!.rtp!.missingPackets, 1);
  opus(2, 1920); opus(1, 960);
  assert.equal(ingest.snapshot().sources[0].packets, 4);
  assert.equal(ingest.snapshot().rxDiagnostics!.rejectedOpus.sequenceReordered, 2);
  opus(100, 96000, DiscordRxFlags.REAL_RTP | DiscordRxFlags.RTP_RESET);
  opus(6, 5760, 0); opus(101, 96960);
  source = ingest.snapshot().sources[0];
  assert.equal(source.packets, 7); assert.equal(source.sequenceGapsKnown, false);
  assert.equal(source.rxTiming!.rtp!.syntheticPackets, 1);
  assert.equal(source.rxTiming!.rtp!.missingPackets, 1, "mode/reset boundaries never invent a large missing span");
});

test("stable windows lower only at speech boundaries; catch-up reserve and shortage history survive them", () => {
  const adaptation = new RxAdaptation();
  for (let now = 0; now <= 16000; now += 10) { if (now % 20 === 0) adaptation.packet(now); adaptation.fill(now, 10); }
  assert.equal(adaptation.targetMs, 60);
  adaptation.boundary(true); assert.equal(adaptation.targetMs, 40);
  adaptation.shortage(); adaptation.boundary(false); assert.equal(adaptation.targetMs, 60);
  for (let now = 16010; now <= 22000; now += 40) { adaptation.packet(now); for (let i = 0; i < 4; i++) adaptation.fill(now, 10); }
  adaptation.boundary(true); assert.ok(adaptation.targetMs >= 60);
});

test("arrival reserve and its cap survive quiet windows without treating silence as stable packet delivery", () => {
  const adaptation = new RxAdaptation();
  for (let now = 0; now <= 5040; now += 80) { adaptation.packet(now); adaptation.fill(now, 10); }
  adaptation.boundary(true); assert.equal(adaptation.targetMs, 100); assert.equal(adaptation.hardCapMs, 130);
  for (let now = 5050; now <= 25000; now += 10) adaptation.fill(now, 10);
  adaptation.boundary(true); assert.equal(adaptation.targetMs, 100); assert.equal(adaptation.hardCapMs, 130);
});

test("short utterance waits at most 60ms, fades 3ms, and cannot replay after a long gap", () => {
  let now = 0;
  const source = new DiscordPcmSource(5760, 48000, 480, () => now), block = new Float32Array(480);
  source.pushInt16Le(packet); assert.equal(source.fill(block), false);
  now = 59; assert.equal(source.fill(block), false);
  now = 60; assert.equal(source.fill(block), true);
  assert.equal(block[0], 0); assert.equal(block[144], .25);
  now = 70; source.fill(block); now = 80; source.fill(block);
  assert.equal(block[0] < .25, true); assert.equal(block[143], 0);
  now = 300; source.fill(block); assert.ok(block.every(x => x === 0));
  source.pushInt16Le(Buffer.alloc(1920)); now = 360; source.fill(block); assert.ok(block.every(x => x === 0));
  assert.equal(source.playoutSnapshot().fadeMs, 3);
});

test("a 100ms adaptive target still releases a one-packet utterance at the 60ms time limit", () => {
  let now = 0;
  const source = new DiscordPcmSource(6240, 48000, 480, () => now), out = new Float32Array(480);
  // Sustained arrival variation, rather than a transient timer stall, may select 100ms.
  for (let i = 0; i < 65; i++) { now = i * 80; source.pushInt16Le(Buffer.alloc(2), now); source.clear(); }
  now = 5501; source.pushInt16Le(packet, now);
  assert.equal(source.playoutSnapshot().targetMs, 100);
  assert.equal(source.fill(out), false);
  now = 5560; assert.equal(source.fill(out), false);
  now = 5561; assert.equal(source.fill(out), true); assert.equal(out[144], .25);
  now = 5571; assert.equal(source.fill(out), true); assert.equal(out[479], .25);
  assert.equal(source.queuedSamples, 0, "all original speech samples were drained, not cut");
});

test("a bounded logical queue retains FIFO order across physical wrap and counts all ceiling drops", () => {
  class LimitedRing extends PcmRingSource { limit = 960; protected override get queueLimit() { return this.limit; } }
  const ring = new LimitedRing(1440), pcm = Buffer.alloc(1920), out = new Float32Array(480);
  const push = (base: number) => { for (let i = 0; i < 960; i++) pcm.writeInt16LE(base + i, i * 2); ring.pushInt16Le(pcm); };
  push(0); push(1000); ring.fill(out);
  for (let i = 0; i < 480; i++) assert.equal(out[i], (1000 + i) / 32768);
  ring.limit = 480; push(2000); ring.fill(out);
  for (let i = 0; i < 480; i++) assert.equal(out[i], (2480 + i) / 32768);
  assert.equal(ring.droppedSamples, 1920); assert.equal(ring.queuedSamples, 0);
});

test("fractional tail does not re-enter prefill or lose the following packet attack", () => {
  let now = 0; const source = new DiscordPcmSource(5760, 48000, 480, () => now), block = new Float32Array(480);
  const tiny = Buffer.alloc(18); tiny.fill(0);
  source.pushInt16Le(tiny); now = 60; source.fill(block); // empty short utterance
  now = 100; source.pushInt16Le(packet); now = 120; source.pushInt16Le(packet); now = 140; source.pushInt16Le(packet);
  for (let i = 0; i < 6; i++) { source.fill(block); now += 10; }
  source.pushInt16Le(tiny); source.fill(block);
  assert.ok(source.microShortages > 0);
  now += 1; source.pushInt16Le(packet); assert.equal(source.fill(block), true);
  assert.equal(block[144], .25, "next attack is retained without long refill");
});

test("uninterrupted PCM is the beta.4 sequence after aligning the deliberate 20ms initial delay and excluding fade", () => {
  let now = 0; const old = new Beta4(5760, 48000, 480, () => now), fresh = new DiscordPcmSource(5760, 48000, 480, () => now);
  const a = new Float32Array(480), b = new Float32Array(480), oldBlocks: Float32Array[] = [];
  for (let i = 0; i < 300; i++) {
    now = i * 10; if (i % 2 === 0) { old.pushInt16Le(packet); fresh.pushInt16Le(packet); }
    old.fill(a); fresh.fill(b); oldBlocks.push(a.slice());
    if (i > 10) assert.deepEqual(b, oldBlocks[i - 2]);
  }
  assert.equal(fresh.droppedSamples, 0); assert.equal(fresh.timing!.underruns, 0);
});

test("PRE recording captures the new playout including its prefill and fade", async t => {
  mkdirSync(resolve("target"), { recursive: true }); const root = mkdtempSync(join(resolve("target"), "rx-pre-"));
  let now = 0; const source = new DiscordPcmSource(5760, 48000, 480, () => now), engine = new AudioEngine(48000, 480, 2);
  const channel = new AudioChannel("rx", "Synthetic", "DiscordUser", source, 480, 48000); channel.approvalGateOpen = true; engine.addChannel(channel); engine.emergencyMuted = false;
  const recorder = new RecorderManager(engine, root); t.after(() => recorder.close());
  recorder.start({ matrixOutput: 0, includeUsers: true, includeBuses: false });
  const expected: number[] = [];
  for (let i = 0; i < 12; i++) { now = i * 10; if (i % 2 === 0) source.pushInt16Le(packet); engine.processBlock(); expected.push(...channel.processed); recorder.captureBlock(); }
  recorder.stop(); await recorder.waitForIdle();
  const track = recorder.tracks.find(x => x.kind === "DISCORD_USER") ?? recorder.tracks[1];
  const wav = readFileSync(track.writer.path);
  assert.equal(wav.length - 44, expected.length * 4);
  for (let i = 0; i < expected.length; i++) assert.equal(wav.readFloatLE(44 + i * 4), expected[i]);
});

test("hardware schedule drops packets permanently with independent seeded loss, never releases loss as a batch", () => {
  const packets = abSchedule(0, 900000, "hardware", 20261029);
  assert.deepEqual(packets, abSchedule(0, 900000, "hardware", 20261029));
  let losses = 0;
  for (let i = 1; i < packets.length; i++) {
    if (packets[i].sequence > packets[i - 1].sequence + 1) { losses++; assert.ok(packets[i].at - packets[i - 1].at >= 99); }
  }
  assert.ok(losses > 10);
});

test("three-minute burst regression reproduces fractional beta.4 shortages and removes them without overflow or stale replay", () => {
  let now = 0;
  const sources = [new Beta4(5760, 48000, 480, () => now), new DiscordPcmSource(6240, 48000, 480, () => now)];
  const arrivals = abSchedule(0, 180000, "hardware", 20261029), block = new Float32Array(480);
  let nextBlock = 0, wake = 0, cycle = 0, index = 0;
  while (now < 180000) {
    if (wake <= (arrivals[index]?.at ?? Infinity)) {
      now = wake;
      while (nextBlock <= now) { for (const source of sources) { source.fill(block); assert.ok(block.every(Number.isFinite)); } nextBlock += 10; }
      wake += [20, 43, 20, 20, 43, 17, 20, 43, 17][cycle++ % 9];
    } else {
      const arrival = arrivals[index++]; now = arrival.at;
      for (const source of sources) {
        source.timing!.observePacket(now, source.queuedSamples, { real: true, sequence: arrival.sequence & 65535, timestamp: arrival.timestamp });
        source.pushInt16Le(packet, now); source.timing!.observeQueued(source.queuedSamples);
      }
    }
  }
  assert.ok(sources[0].timing!.microInSpeechUnderruns >= 3);
  assert.equal(sources[1].timing!.microInSpeechUnderruns, 0);
  assert.equal(sources[1].timing!.inSpeechByKind.fillBurst, 0);
  assert.equal(sources[1].droppedSamples, 0);
  assert.ok(sources[1].timing!.rtp.counts.loss > 0, "permanent loss remains visible");
  assert.equal(sources[1].playoutSnapshot().targetMs, 80);
  sources[1].clear(); assert.equal(sources[1].playoutSnapshot().targetMs, 80, "clear retains adaptation memory");
  now += 300; sources[1].fill(block); assert.ok(block.every(x => x === 0));
});

test("new steady playout preserves individual PCM samples outside the explicit boundary fade", () => {
  let now = 0, written = 0, read = 0;
  const source = new DiscordPcmSource(6240, 48000, 480, () => now), out = new Float32Array(480), pcm = Buffer.alloc(1920);
  const sample = (n: number) => (n % 15000 - 7500) / 32768;
  for (let block = 0; block < 1000; block++) {
    now = block * 10;
    if (block % 2 === 0) {
      for (let i = 0; i < 960; i++) pcm.writeInt16LE((written++ % 15000) - 7500, i * 2);
      source.pushInt16Le(pcm, now);
    }
    if (source.fill(out)) {
      for (let i = read === 0 ? 144 : 0; i < out.length; i++) assert.equal(out[i], sample(read + i));
      read += 480;
    }
  }
  assert.equal(source.expandedFrames, 0); assert.equal(source.compressedFrames, 0);
  assert.equal(source.droppedSamples, 0); assert.equal(source.timing!.underruns, 0);
});

test("adaptive playout keeps bounded clock correction over an hour at +/-200ppm without overflow or shortages", () => {
  for (const ppm of [-200, 200]) {
    let now = 0, nextPacket = 0;
    const source = new DiscordPcmSource(6240, 48000, 480, () => now), out = new Float32Array(480);
    for (let block = 0; block < 360000; block++) {
      now = block * 10;
      const delay = block % 100 < 10 ? 20 : block % 100 < 30 ? 10 : 0;
      while (nextPacket + delay <= now) { source.pushInt16Le(packet, now); nextPacket += 20 / (1 + ppm / 1e6); }
      source.fill(out);
      if (block > 20) { assert.equal(out[0], .25); assert.equal(out[479], .25); }
    }
    assert.equal(source.droppedSamples, 0); assert.equal(source.timing!.underruns, 0);
    assert.ok(source.compressedFrames + source.expandedFrames > 0);
  }
});

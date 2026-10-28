import assert from "node:assert/strict";
import test from "node:test";
import { RxQueueTiming } from "../services/router-core-sim/src/audio-timing.ts";
import { DiscordPcmSource } from "../services/router-core-sim/src/discord-pcm-source.ts";
import { rxPcmTrace } from "./helpers/rx-pcm-trace.ts";
import { deliveryMs, patterns } from "./rx-load/run.ts";
import { DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { DiscordFrameType } from "../packages/discord-ipc/src/index.ts";
import { OPUS_SELF_CHECK_PACKET } from "../services/router-core-sim/src/opus-decoder.ts";

test("instrumented Discord playout keeps the beta.4 whole-mix PCM bit-identical", () => {
  // Golden generated from untouched discord-pcm-source.ts at ee56dfee4544b853f99b0520ca66d310817164ab.
  const trace = rxPcmTrace(DiscordPcmSource);
  assert.equal(trace.sha256, "3a3fc5bb5b339dcd3c45060daabb6ca8570c532e37a1fe686ff310e9177738f4");
  assert.ok(trace.sources.some(x => x.expandedFrames > 0));
  assert.ok(trace.sources.some(x => x.compressedFrames > 0));
  assert.ok(trace.sources.some(x => x.dropped > 0));
});

test("offline arrival patterns preserve packets and have the intended +40/+100ms p95 late gap", () => {
  for (const pattern of patterns) {
    const arrivals = Array.from({ length: 101 }, (_, i) => deliveryMs(i, pattern));
    const late = arrivals.slice(1).map((time, i) => Math.max(0, time - arrivals[i] - 20)).sort((a, b) => a - b);
    assert.equal(late[94], pattern === "steady" ? 0 : pattern === "measured-like" ? 40 : 100);
    assert.ok(arrivals.every((time, i) => !i || time >= arrivals[i - 1]));
    assert.equal(arrivals.at(-1), 2000);
  }
});

test("real ingress observes one arrival per packet, not duplicate PCM notifications", async t => {
  let now = 0; t.mock.method(performance, "now", () => now);
  const engine = new AudioEngine(48000, 480, 2), ingest = new DiscordIngestServer(engine);
  t.after(() => ingest.close());
  const ids = { botId: "100000000000000001", guildId: "100000000000000002", voiceChannelId: "100000000000000003", userId: "100000000000000004", sourceGeneration: 1 };
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload: Buffer.from(JSON.stringify({ profileId: "RX", role: "RX", gatewayState: "ready", voiceState: "ready" })) });
  ingest.ingest({ type: DiscordFrameType.USER_META, ...ids, payload: Buffer.from("Synthetic") });
  for (let i = 0; i < 5; i++) { now = i * 20; ingest.ingest({ type: DiscordFrameType.OPUS, ...ids, sequence: i + 1, payload: OPUS_SELF_CHECK_PACKET }); engine.processBlock(); }
  const timing = ingest.snapshot().sources[0].rxTiming!;
  assert.equal(ingest.snapshot().decodeErrors, 0);
  assert.equal(timing.packetJitterWindows![0].samples, 4);
  assert.equal(timing.packetJitterWindows![0].maxMs, 0);
  assert.equal(timing.fillJitterWindows![0].samples, 4);
  now = 90; [...ingest.runtimes.values()][0].source.timing!.fill(0, 480);
  now = 100; ingest.ingest({ type: DiscordFrameType.OPUS, ...ids, sequence: 6, payload: OPUS_SELF_CHECK_PACKET });
  assert.equal(ingest.snapshot().rxDiagnostics!.inSpeechUnderruns, 1);
  ingest.ingest({ type: DiscordFrameType.USER_LEFT, ...ids });
  assert.equal(ingest.snapshot().sources.length, 0);
  assert.equal(ingest.snapshot().rxDiagnostics!.inSpeechUnderruns, 1, "retired sources remain counted even before the next health observation");
});

test("RX shortages wait for the next packet, include both 200ms boundaries, and expire tails", () => {
  let now = 0;
  const rx = new RxQueueTiming(48_000, 120, () => now);
  rx.observePacket(now, 0); rx.packet(now);
  now = 200; rx.fill(240, 480);
  assert.equal(rx.snapshot().pendingUnderruns, 1);
  now = 400; rx.observePacket(now, 0); rx.packet(now); rx.observeQueued(960);
  let state = rx.snapshot();
  assert.equal(state.inSpeechUnderruns, 1); assert.equal(state.endOfSpeechUnderruns, 0);
  assert.deepEqual(state.recentInSpeechUnderruns.map(({ at, ...event }) => event), [{ previousPacketAgeMs: 200, nextPacketDelayMs: 200, queuedBeforeMs: 5, queuedAfterPacketMs: 20 }]);
  assert.ok(Number.isFinite(Date.parse(state.recentInSpeechUnderruns[0].at)));
  now = 600; rx.fill(0, 480);
  now = 800; assert.equal(rx.snapshot().pendingUnderruns, 1);
  now = 801; rx.observePacket(now, 0); rx.packet(now);
  state = rx.snapshot();
  assert.equal(state.inSpeechUnderruns, 1); assert.equal(state.endOfSpeechUnderruns, 1);
  now = 1002; rx.fill(0, 480);
  assert.equal(rx.underruns, 2, "old 200ms counting semantics are retained");
});

test("RX recent events and pending storage are bounded; excess measurements are explicit", () => {
  let now = 0;
  const rx = new RxQueueTiming(48_000, 120, () => now);
  for (let i = 0; i < 100; i++) {
    rx.observePacket(now, 0); rx.packet(now); now += 10; rx.fill(0, 480);
    now += 10; rx.observePacket(now, 0); rx.observeQueued(960);
  }
  const state = rx.snapshot();
  assert.equal(state.inSpeechUnderruns, 100); assert.equal(state.recentInSpeechUnderruns.length, 50);
  state.recentInSpeechUnderruns[0].queuedBeforeMs = 999;
  assert.equal(rx.snapshot().recentInSpeechUnderruns[0].queuedBeforeMs, 0);
  rx.packet(now);
  for (let i = 0; i < 300; i++) rx.fill(0, 480);
  assert.equal(rx.snapshot().pendingUnderruns, 256); assert.equal(rx.unclassifiedUnderruns, 44);
  now += 201; const expired = rx.snapshot();
  assert.equal(expired.endOfSpeechUnderruns, 256);
  assert.equal(expired.underruns, expired.inSpeechUnderruns + expired.endOfSpeechUnderruns + expired.pendingUnderruns + expired.unclassifiedUnderruns);
});

test("RX jitter has per-minute p50/p95/p99/max, excludes talkspurt gaps and counts burst arrivals", () => {
  let now = 0;
  const rx = new RxQueueTiming(48_000, 120, () => now);
  rx.observePacket(now, 0);
  for (let i = 1; i <= 100; i++) { now += 20 + i; rx.observePacket(now, 0); }
  const window = rx.snapshot().packetJitterWindows[0];
  assert.deepEqual([window.samples, window.p50Ms, window.p95Ms, window.p99Ms, window.maxMs], [100, 50, 95, 99, 100]);
  now += 201; rx.observePacket(now, 0);
  assert.equal(rx.packetJitterExcludedGaps, 1);
  rx.observePacket(now, 0); // A distinct packet in the same IPC burst is a zero interval.
  assert.equal(rx.snapshot().packetJitterWindows[0].samples, 101);
  now = 60_000; rx.observeFill(now, 10);
  now += 10; rx.observeFill(now, 10);
  now += 60; rx.observeFill(now, 10);
  now += 0; rx.observeFill(now, 10); // Timer catch-up is observable too.
  const fill = rx.snapshot().fillJitterWindows[0];
  assert.deepEqual([fill.samples, fill.p50Ms, fill.p95Ms, fill.p99Ms, fill.maxMs], [3, 10, 50, 50, 50]);
  for (let i = 2; i < 34; i++) { now = i * 60_000; rx.observePacket(now, 0); now += 20; rx.observePacket(now, 0); rx.observeFill(now, 10); }
  assert.equal(rx.snapshot().packetJitterWindows.length, 30);
  assert.equal(rx.snapshot().fillJitterWindows.length, 30);
  assert.equal(rx.snapshot().packetJitterWindows.at(-1)!.maxMs, 0, "reused windows cannot retain old bins");
});

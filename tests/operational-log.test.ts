import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import type { DiscordIngestSnapshot, RouterSnapshot } from "../packages/shared-types/src/index.ts";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { OperationalHealthTracker, OperationalLog } from "../services/router-core-sim/src/operational-log.ts";

test("operational log writes sanitized daily JSONL and prunes expired files", async () => {
  const root = mkdtempSync(join(tmpdir(), "dbr-operational-log-"));
  const now = new Date(2026, 8, 26, 12, 0, 0);
  try {
    mkdirSync(join(root, "logs"));
    writeFileSync(join(root, "logs", "operational-2026-09-19.jsonl"), "old\n");
    const log = new OperationalLog(root, 7, () => now);
    log.append({ level: "WARNING", message: "token=secret-value 123456789012345678", at: now.toISOString() });
    await log.close();
    assert.equal(existsSync(join(root, "logs", "operational-2026-09-19.jsonl")), false);
    const line = readFileSync(log.pathFor(), "utf8");
    assert.match(line, /WARNING/);
    assert.doesNotMatch(line, /secret-value|123456789012345678/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operational log rotates asynchronous appends by date and warns once on write failure", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dbr-operational-log-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = new Date(2026, 9, 5, 23, 59);
  const log = new OperationalLog(root, 7, () => now);
  const firstPath = log.pathFor();
  log.append({ at: now.toISOString(), level: "INFO", message: "before midnight" });
  now = new Date(2026, 9, 6, 0, 1);
  const secondPath = log.pathFor();
  log.append({ at: now.toISOString(), level: "INFO", message: "after midnight" });
  await log.close();
  assert.match(readFileSync(firstPath, "utf8"), /before midnight/);
  assert.doesNotMatch(readFileSync(firstPath, "utf8"), /after midnight/);
  assert.match(readFileSync(secondPath, "utf8"), /after midnight/);

  now = new Date(2026, 9, 7);
  const broken = new OperationalLog(root, 7, () => now);
  mkdirSync(broken.pathFor());
  const warning = t.mock.method(console, "error", () => {});
  broken.append({ at: now.toISOString(), level: "INFO", message: "fails asynchronously" });
  broken.append({ at: now.toISOString(), level: "INFO", message: "fails again" });
  await broken.close();
  assert.equal(warning.mock.callCount(), 1);
});

test("log queue overflow is bounded and recovery records the exact dropped count once", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dbr-operational-log-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = new OperationalLog(root);
  const event = { at: "2026-10-06T00:00:00.000Z", level: "INFO" as const, message: "event ".repeat(35).trim() };
  const bytes = Buffer.byteLength(`${JSON.stringify(event)}\n`);
  const accepted = Math.floor(1024 * 1024 / bytes);
  const warning = t.mock.method(console, "error", () => {});
  for (let i = 0; i < 6000; i++) log.append(event);
  let size = 0;
  for (let i = 0; i < 200 && size < accepted * bytes; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    size = await readFile(log.pathFor()).then((buffer) => buffer.length).catch(() => 0);
  }
  assert.equal(size, accepted * bytes);
  log.append({ ...event, message: "recovered" });
  log.append({ ...event, message: "normal" });
  await log.close();
  const records = readFileSync(log.pathFor(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const notices = records.filter((record) => record.message.includes("events dropped"));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].message, `Operational log queue recovered: ${6000 - accepted} events dropped`);
  assert.equal(records.at(-2).message, "recovered");
  assert.equal(warning.mock.callCount(), 1);
});

function discordSnapshot(): DiscordIngestSnapshot {
  return {
    endpoint: "ipc", connectedAdapters: 1, adapterState: "READY", configuredBots: 1, readyBots: 1,
    staleBots: 0, reconnectingBots: 0, packets: 1, bytes: 1, decodeErrors: 0, decoderState: "READY",
    tx: { state: "READY", active: false, sourceOutput: 0, profileId: "RX01", label: "RX 01", botId: "1", guildId: "1", voiceChannelId: "1", voiceChannelName: "VC", subtype: null, audioMode: "MONO", framesSent: 0, droppedFrames: 0, peak: 0, lastFrameAgoMs: null },
    txStems: [],
    bots: [{ key: "bot", profileId: "RX01", label: "RX 01", role: "DUPLEX", txSubtype: null, txAudioMode: "MONO", botId: "1", guildId: "1", guildName: "Guild", voiceChannelId: "1", voiceChannelName: "VC", gatewayState: "ready", voiceState: "ready", health: "READY", wsPingMs: 20, udpPingMs: 20, reconnectCount: 0, lastAudioAgoMs: 0, txEnabled: false, txFrames: 0, txDroppedFrames: 0, lastTxFrameAgoMs: null, lastHeartbeatAgoMs: 0, message: null }],
    receiverOwnership: [], availableVoiceChannels: [],
    sources: [{ channelId: "ch-1", botId: "1", guildId: "1", voiceChannelId: "1", userId: "2", packets: 1, decodedSamples: 960, decodeErrors: 0, sequenceGaps: 0, queuedMilliseconds: 20, droppedSamples: 0, lastPacketAgoMs: 0 }],
  };
}

function queueHealthFixture() {
  const tracker = new OperationalHealthTracker();
  const state = { ...new ControlPlane(AudioEngine.createDemo(0)).snapshot(), discord: discordSnapshot() } as RouterSnapshot;
  const source = state.discord!.sources[0];
  source.playout = { targetMs: 80, hardCapMs: 140, backlogEwmaMs: 80, prebufferBlocks: 8,
    expandedFrames: 0, compressedFrames: 0, staleDiscardedSamples: 0 };
  assert.deepEqual(tracker.observe(state, 0), []);
  const queue = (milliseconds: number, now: number) => {
    source.queuedMilliseconds = milliseconds;
    return tracker.observe(state, now);
  };
  return { tracker, state, source, queue };
}

test("adaptive RX queues at 65-118ms remain normal for 22 minutes with an 80ms target", () => {
  const { queue } = queueHealthFixture();
  const normal = [65, 80, 100, 118, 90, 70, 110];
  for (let second = 1; second <= 22 * 60; second++) {
    assert.deepEqual(queue(normal[second % normal.length], second * 1000), []);
  }
});

test("RX queue warnings require both the current target envelope and selected hard-cap proximity", () => {
  for (const [targetMs, hardCapMs, normal, high] of [
    [40, 140, 90, 130], [60, 140, 129.9, 130], [80, 140, 120, 130],
    [80, 130, 120, 120.1], [100, 140, 140, 140.1],
  ]) {
    const { source, queue } = queueHealthFixture();
    Object.assign(source.playout!, { targetMs, hardCapMs });
    assert.deepEqual(queue(normal, 1000), [], `normal: target=${targetMs}, cap=${hardCapMs}`);
    assert.equal(queue(high, 2000)[0]?.level, "WARNING", `high: target=${targetMs}, cap=${hardCapMs}`);
  }
});

test("RX queue warnings aggregate sustained highs every 60 seconds and retain suppression across recovery", () => {
  const { queue } = queueHealthFixture();
  assert.deepEqual(queue(130, 1000), [{ level: "WARNING", message: "Discord participant: receive queue high (130 ms)" }]);
  for (let second = 2; second <= 60; second++) assert.deepEqual(queue(135, second * 1000), []);
  assert.deepEqual(queue(135, 60_999), []);
  assert.deepEqual(queue(135, 61_000), [{ level: "WARNING", message: "Discord participant: receive queue high (135 ms); suppressed=60" }]);
  assert.deepEqual(queue(90, 62_000), [{ level: "INFO", message: "Discord participant: receive queue recovered (90 ms)" }]);
  assert.deepEqual(queue(135, 63_000), []);
  assert.deepEqual(queue(80, 64_000), [{ level: "INFO", message: "Discord participant: receive queue recovered (80 ms)" }]);
  assert.deepEqual(queue(80, 120_000), [], "quiet periods do not emit a warning summary");
  assert.deepEqual(queue(135, 121_000), [{ level: "WARNING", message: "Discord participant: receive queue high (135 ms); suppressed=1" }]);
});

test("RX queue recovery holds hysteresis until current target+10ms, including target changes", () => {
  const { source, queue } = queueHealthFixture();
  assert.equal(queue(130, 1000)[0]?.level, "WARNING");
  assert.deepEqual(queue(100, 2000), []);
  assert.deepEqual(queue(91, 3000), []);
  assert.deepEqual(queue(90, 4000), [{ level: "INFO", message: "Discord participant: receive queue recovered (90 ms)" }]);
  assert.deepEqual(queue(89, 5000), []);
  assert.equal(queue(130, 61_000)[0]?.level, "WARNING");
  source.playout!.targetMs = 100;
  assert.deepEqual(queue(110, 62_000), [{ level: "INFO", message: "Discord participant: receive queue recovered (110 ms)" }]);
});

test("legacy RX queues retain fixed 60ms warning and 40ms recovery thresholds", () => {
  const { source, queue } = queueHealthFixture();
  delete source.playout;
  assert.deepEqual(queue(60, 1000), []);
  assert.equal(queue(60.1, 2000)[0]?.level, "WARNING");
  assert.deepEqual(queue(50, 3000), []);
  assert.deepEqual(queue(40.1, 4000), []);
  assert.deepEqual(queue(40, 5000), [{ level: "INFO", message: "Discord participant: receive queue recovered (40 ms)" }]);
  assert.deepEqual(queue(39, 6000), []);
});

test("RX queue warning budgets are per source and discarded when a source leaves", () => {
  const { state, source, queue, tracker } = queueHealthFixture();
  const second = { ...structuredClone(source), channelId: "ch-2" };
  state.discord!.sources.push(second);
  tracker.observe(state, 500);
  assert.equal(queue(130, 1000)[0]?.level, "WARNING");
  second.queuedMilliseconds = 135;
  const events = queue(135, 2000);
  assert.equal(events.length, 1, "one source's warning does not consume the other's budget");
  assert.equal(events[0].level, "WARNING");
  assert.deepEqual(queue(135, 3000), []);
  state.discord!.sources = [];
  tracker.observe(state, 4000);
  state.discord!.sources = [source];
  assert.deepEqual(tracker.observe(state, 5000), [], "a newly observed source establishes its baseline");
  const next = queue(135, 6000);
  assert.equal(next.length, 1);
  assert.doesNotMatch(next[0].message, /suppressed=/, "departed source counters are not retained");
});

test("in-speech RX logs aggregate at most once a minute and retain departures without personal text", () => {
  const tracker = new OperationalHealthTracker();
  const state = { ...new ControlPlane(AudioEngine.createDemo(0)).snapshot(), discord: discordSnapshot() } as RouterSnapshot;
  const source = state.discord!.sources[0];
  state.discord!.rxDiagnostics = { inSpeechUnderruns: 0, rejectedOpus: {}, ipcBatches: { count: 0, maxOpusFrames: 0, maxBytes: 0, maxProcessingMs: 0 }, adapterIpc: [] };
  source.rxTiming = { maxPacketGapMs: 20, maxQueuedMilliseconds: 40, overflowEvents: 0, lastOverflow: null, inSpeechUnderruns: 0 };
  assert.deepEqual(tracker.observe(state, 0), []);
  source.rxTiming.inSpeechUnderruns = 3;
  state.discord!.rxDiagnostics.inSpeechUnderruns = 3;
  assert.deepEqual(tracker.observe(state, 1000), []);
  source.rxTiming.inSpeechUnderruns = 5;
  state.discord!.rxDiagnostics.inSpeechUnderruns = 5;
  assert.deepEqual(tracker.observe(state, 59_999), []);
  state.discord!.sources = [];
  state.discord!.rxDiagnostics.inSpeechUnderruns = 6; // Another source joined and left between observations.
  assert.deepEqual(tracker.observe(state, 60_000), [{ level: "INFO", message: "RX in-speech underruns: count=6" }]);
  assert.deepEqual(tracker.observe(state, 60_001), []);
  assert.deepEqual(tracker.observe(state, 120_000), [], "quiet minutes and speech tails produce no new summary");
  state.discord!.sources = [source]; source.rxTiming.inSpeechUnderruns = 1;
  state.discord!.rxDiagnostics.inSpeechUnderruns = 7;
  tracker.observe(state, 121_000);
  assert.deepEqual(tracker.observe(state, 180_000), [{ level: "INFO", message: "RX in-speech underruns: count=1" }]);
});

test("operational health tracker records transitions and counter increases only", () => {
  const tracker = new OperationalHealthTracker();
  const control = new ControlPlane(AudioEngine.createDemo(0));
  const base = { ...control.snapshot(), discord: discordSnapshot() } as RouterSnapshot;
  assert.deepEqual(tracker.observe(base), []);

  const changed = structuredClone(base);
  changed.discord!.bots[0].health = "RECONNECTING";
  changed.discord!.bots[0].reconnectCount = 1;
  changed.discord!.bots[0].udpPingMs = 320;
  changed.discord!.sources[0].sequenceGaps = 2;
  changed.discord!.sources[0].queuedMilliseconds = 75;
  changed.xruns = 1;
  const messages = tracker.observe(changed).map((event) => event.message);
  assert(messages.some((message) => message.includes("READY → RECONNECTING")));
  assert(messages.some((message) => message.includes("reconnect +1")));
  assert(messages.some((message) => message.includes("Voice UDP ping high")));
  assert(messages.some((message) => message.includes("packet sequence gaps +2")));
  assert(messages.some((message) => message.includes("receive queue high")));
  assert(messages.some((message) => message.includes("Audio engine xruns +1")));
  assert.deepEqual(tracker.observe(changed), []);
});

test("RX diagnostic logs distinguish rejected, queued and overflow audio without repeated events", () => {
  const tracker = new OperationalHealthTracker();
  const base = { ...new ControlPlane(AudioEngine.createDemo(0)).snapshot(), discord: discordSnapshot() } as RouterSnapshot;
  base.discord!.rxDiagnostics = {
    rejectedOpus: {}, ipcBatches: { count: 0, maxOpusFrames: 0, maxBytes: 0, maxProcessingMs: 0 },
    adapterIpc: [{ opusDroppedFrames: 0, backpressureWrites: 0, writableBytes: 0, maxWritableBytes: 0 }],
  };
  assert.deepEqual(tracker.observe(base), []);
  const changed = structuredClone(base);
  changed.discord!.rxDiagnostics!.rejectedOpus = { "health:RECONNECTING": 44 };
  changed.discord!.rxDiagnostics!.adapterIpc[0].opusDroppedFrames = 3;
  changed.discord!.rxDiagnostics!.adapterIpc[0].backpressureWrites = 2;
  changed.discord!.sources[0].droppedSamples = 5760;
  changed.discord!.sources[0].queuedMilliseconds = 135;
  changed.discord!.sources[0].playout = { targetMs: 80, hardCapMs: 140, backlogEwmaMs: 80, prebufferBlocks: 8,
    expandedFrames: 0, compressedFrames: 0, staleDiscardedSamples: 0 };
  changed.discord!.sources[0].rxTiming = {
    maxPacketGapMs: 200, maxQueuedMilliseconds: 80, overflowEvents: 6,
    lastOverflow: { at: "2026-10-02T18:03:09.591Z", queuedBeforeMilliseconds: 80, incomingSamples: 960, droppedSamples: 960, packetGapMs: 0, batchOpusFrames: 10, batchBytes: 570, batchElapsedMs: 1 },
  };
  const messages = tracker.observe(changed).map((event) => event.message);
  assert(messages.includes("Discord RX rejected (health:RECONNECTING) +44"));
  assert(messages.includes("Discord RX IPC Opus dropped +3"));
  assert(messages.includes("Discord RX IPC backpressure writes (queued, not dropped) +2"));
  const context = messages.find((message) => message.includes("RX overflow"));
  assert.match(context!, /q=80.0ms.*batch=10.*bytes=570/);
  assert(context!.length <= 240, "overflow context fits the existing sanitized log limit");
  assert.deepEqual(tracker.observe(changed), []);
  changed.discord!.sources[0].droppedSamples += 960;
  const repeated = tracker.observe(changed).map(event => event.message);
  assert(repeated.includes("Discord participant: audio samples dropped +960"));
  assert(repeated.some(message => message.includes("RX overflow")), "overflow remains visible while queue warnings are suppressed");
  assert(!repeated.some(message => message.includes("receive queue high")));
});

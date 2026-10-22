import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { DiscordFrameType } from "../packages/discord-ipc/src/index.ts";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { AudioOutputManager } from "../services/router-core-sim/src/audio-output.ts";
import { AudioRuntimeTiming } from "../services/router-core-sim/src/audio-runtime-timing.ts";
import { OutputWriteTiming } from "../services/router-core-sim/src/audio-timing.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";
import { broadcastWebSocket, MAX_WEBSOCKET_PENDING_BYTES } from "../services/router-core-sim/src/snapshot-delivery.ts";
import { TabletControlServer, TabletProjection } from "../services/router-core-sim/src/tablet-server.ts";

class Peer {
  destroyed = false;
  writableLength = 0;
  count = 0;
  largest = 0;
  last: Buffer | undefined;
  write(frame: Buffer) { this.count++; this.writableLength += frame.length; this.largest = Math.max(this.largest, frame.length); this.last = frame; }
}

test("an oversized state frame reaches idle peers once but never queues behind pending audio UI data", () => {
  const idle = new Peer(), busy = new Peer(); busy.writableLength = 1;
  const large = () => ({ type: "state", payload: "x".repeat(MAX_WEBSOCKET_PENDING_BYTES + 1) });
  broadcastWebSocket([idle, busy], large);
  assert.equal(idle.count, 1); assert.equal(busy.count, 0);
  const pending = idle.writableLength;
  assert.ok(pending > MAX_WEBSOCKET_PENDING_BYTES);
  broadcastWebSocket([idle], large); assert.equal(idle.count, 1); assert.equal(idle.writableLength, pending);
  idle.writableLength = 0; broadcastWebSocket([idle], large); assert.equal(idle.count, 2);
});

const mergeMeterSnapshot = runInNewContext(readFileSync(new URL("../services/router-core-sim/public/meter-snapshot.js", import.meta.url), "utf8").replace("export function", "function") + "\nmergeMeterSnapshot;");

test("64 receivers with 30-minute histories keep 20Hz frames below 100KB and bound each of three clients independently", t => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  // Window time advances independently of Bot heartbeat/liveness in this fixture.
  t.mock.method(Date, "now", () => 1_800_000_000_000);
  const engine = new AudioEngine(48_000, 480, 64);
  const output = new AudioOutputManager(48_000, 480, 64, null);
  const control = new ControlPlane(engine, output);
  const ingest = new DiscordIngestServer(engine, "test-only", null, { backend: "@discordjs/opus", create48kMono: () => ({ decode: () => Buffer.alloc(1920), dispose() {} }) });
  t.after(() => ingest.close());
  const ids = { botId: "100000000000000001", guildId: "100000000000000002", voiceChannelId: "100000000000000003", userId: "100000000000000001" };
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload: Buffer.from(JSON.stringify({ profileId: "RX01", role: "RX", gatewayState: "ready", voiceState: "ready" })) });
  for (let i = 0; i < 64; i++) {
    const member = { ...ids, userId: String(100000000000001000n + BigInt(i)), sourceGeneration: 1 };
    ingest.ingest({ type: DiscordFrameType.USER_META, ...member, payload: Buffer.from(`Guest ${i}`) });
    ingest.ingest({ type: DiscordFrameType.OPUS, ...member, sequence: 1, payload: Buffer.from([1]) });
  }
  const writeTiming = new OutputWriteTiming(0);
  for (let minute = 0; minute < 30; minute++) {
    clock = minute * 60_000;
    for (const runtime of ingest.runtimes.values()) runtime.source.timing!.fill(480 * (minute % 12), 480);
    for (let window = 0; window < 6; window++) writeTiming.observeInFlight(window % 3, clock + window * 10_000);
  }
  const full = { ...control.snapshot(), discord: ingest.snapshot() };
  full.output!.writeTiming = writeTiming.snapshot(0, 0, clock + 50_000);
  assert.equal(full.discord.sources.length, 64);
  assert.ok(full.discord.sources.every(source => source.rxTiming!.queueWindows!.length === 30));
  assert.equal(full.output!.writeTiming.windows.length, 60);
  assert.ok(Buffer.byteLength(JSON.stringify(full)) > 100_000, "fixture actually includes substantial diagnostic history");
  const meters = control.meterSnapshot();
  assert.doesNotMatch(JSON.stringify(meters), /queueWindows|writeTiming|sceneParameters/);
  assert.equal(ingest.snapshot(Date.now(), false).sources[0].rxTiming!.queueWindows, undefined);
  assert.equal(control.snapshot(false).output!.writeTiming, undefined);
  const healthy = new Peer(), other = new Peer(), slow = new Peer();
  let builds = 0;
  for (let frame = 0; frame < 600; frame++) {
    healthy.writableLength = other.writableLength = 0;
    broadcastWebSocket([healthy, slow, other], () => { builds++; return { type: "meters", payload: { ...meters, revision: frame } }; });
    assert.ok(slow.writableLength <= MAX_WEBSOCKET_PENDING_BYTES);
  }
  assert.equal(builds, 600, "one serialization per broadcast, not per client");
  assert.equal(healthy.count, 600); assert.equal(other.count, 600);
  assert.ok(slow.count < 600); assert.ok(healthy.largest < 100_000);
  slow.writableLength = 0;
  broadcastWebSocket([slow], () => ({ type: "meters", payload: { ...meters, revision: 601 } }));
  assert.match(slow.last!.toString(), /"revision":601/, "a recovered peer receives current state, not queued stale snapshots");
  const unexpected = () => { throw new Error("must not construct a snapshot without eligible clients"); };
  broadcastWebSocket([], unexpected);
  slow.writableLength = MAX_WEBSOCKET_PENDING_BYTES;
  broadcastWebSocket([slow], unexpected);
  slow.destroyed = true; slow.writableLength = 0;
  broadcastWebSocket([slow], unexpected);
  t.diagnostic(`64 RX / 30-minute histories: full=${Buffer.byteLength(JSON.stringify(full))} bytes, 20Hz frame=${healthy.largest} bytes, slow maximum <= ${MAX_WEBSOCKET_PENDING_BYTES} bytes`);
});

test("direct Tablet projection preserves the full projection without constructing Desktop snapshots, and idle broadcasts build nothing", t => {
  t.mock.method(Date, "now", () => 1_800_000_000_000);
  const control = new ControlPlane(AudioEngine.createDemo(2));
  const ingest = new DiscordIngestServer(control.engine);
  t.after(() => ingest.close());
  for (const number of [2, 1]) ingest.ingest({ type: DiscordFrameType.BOT_META, botId: String(100000000000000000n + BigInt(number)), guildId: "100000000000000010", voiceChannelId: "100000000000000020", userId: "100000000000000030", payload: Buffer.from(JSON.stringify({ profileId: `RX0${number}`, label: `Bot ${number}`, role: "RX", gatewayState: "ready", voiceState: "ready" })) });
  control.recordExternalEvent("INFO", "First"); control.recordExternalEvent("INFO", "Second");
  const expected = new TabletProjection().snapshot({ ...control.snapshot(), discord: ingest.snapshot() });
  t.mock.method(control, "snapshot", () => { throw new Error("Desktop snapshot should not run for Tablet"); });
  t.mock.method(ingest, "snapshot", () => { throw new Error("RX history should not be built for Tablet"); });
  assert.deepEqual(new TabletProjection().snapshot({ ...control.tabletSnapshot(), discord: ingest.tabletSnapshot() }), expected);
  const server = new TabletControlServer({ enabled: true, port: 0, snapshot: () => { throw new Error("idle Tablet snapshot"); }, execute: command => control.execute(command) });
  server.running = true;
  server.broadcast();
});

test("meter merging retains configuration/diagnostic history and Stage 3 observers leave output PCM unchanged", () => {
  const observed = AudioEngine.createDemo(2), reference = AudioEngine.createDemo(2);
  const control = new ControlPlane(observed);
  let full = control.snapshot();
  const oldLabel = full.channels[0].label;
  const history = { windows: [{ p99LateMs: 1 }] };
  Object.assign(full, { diagnosticFixture: history });
  const before = JSON.stringify(full);
  const meters = control.meterSnapshot();
  meters.channels[0].faderDb = -12;
  const merged = mergeMeterSnapshot(full, meters);
  assert.equal(merged.channels[0].label, oldLabel);
  assert.equal(merged.channels[0].faderDb, -12);
  assert.equal(merged.diagnosticFixture, history);
  assert.equal(JSON.stringify(full), before, "merging never mutates earlier snapshots");
  assert.equal(mergeMeterSnapshot(full, { ...meters, revision: -1 }), full);
  for (let block = 0; block < 200; block++) {
    observed.processBlock(); reference.processBlock();
    full = mergeMeterSnapshot(full, control.meterSnapshot());
    control.snapshot(); new TabletProjection().snapshot(control.tabletSnapshot());
    assert.deepEqual(observed.outputs, reference.outputs, `identical PCM in block ${block}`);
  }
});

test("TX meter updates merge by profile without losing routing or other Bot levels", () => {
  const base = { revision: 10, channels: [], buses: [], discord: { txStems: [
    { profileId: "one", label: "返し", sourceInputChannelId: "local-input:1", masterDb: 0, active: false, peak: 0 },
    { profileId: "two", label: "司会", sourceInputChannelId: "local-input:2", masterDb: 0, active: false, peak: 0 },
  ] } };
  const result = mergeMeterSnapshot(base, { revision: 10, channels: [], buses: [], txMeters: [
    { profileId: "two", masterDb: -6, active: true, peak: 0.2, state: "SENDING" },
  ] });
  assert.equal(result.discord.txStems[1].label, "司会");
  assert.equal(result.discord.txStems[1].sourceInputChannelId, "local-input:2");
  assert.equal(result.discord.txStems[1].masterDb, -6);
  assert.equal(result.discord.txStems[1].peak, 0.2);
  assert.equal(result.discord.txStems[0].active, false);
  assert.equal(base.discord.txStems[1].masterDb, 0);
});

test("runtime windows measure processBlock maxima and event-loop p99/max, reset per minute and retain 30 windows", t => {
  let clock = 0, enabled = 0, disabled = 0;
  t.mock.method(performance, "now", () => clock);
  const histogram = { count: 10, max: 42_000_000, percentile: (percentile: number) => { assert.equal(percentile, 99); return 31_000_000; }, reset() { this.count = 0; }, enable() { enabled++; return true; }, disable() { disabled++; return true; } };
  const timing = new AudioRuntimeTiming(histogram);
  timing.recordBlock(0.3); timing.recordBlock(2.4); timing.recordBlock(0.1);
  clock = 60_000;
  const first = timing.finishWindow();
  assert.equal(first.durationMs, 60_000); assert.equal(first.processBlockMaxMs, 2.4); assert.equal(first.processBlocks, 3);
  assert.equal(first.eventLoopP99Ms, 31); assert.equal(first.eventLoopMaxMs, 42);
  assert.equal(timing.snapshot().current.processBlockMaxMs, 0); assert.equal(timing.snapshot().current.eventLoopP99Ms, 0);
  for (let minute = 2; minute <= 35; minute++) { clock = minute * 60_000; timing.recordBlock(minute / 10); timing.finishWindow(); }
  assert.equal(timing.snapshot().windows.length, 30);
  assert.equal(timing.snapshot().windows.at(-1)!.processBlockMaxMs, 3.5);
  timing.close(); assert.equal(enabled, 1); assert.equal(disabled, 1);
});

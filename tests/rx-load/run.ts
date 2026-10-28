// Manual, offline real-time load test. Never opens an IPC listener, Bot or audio device.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { DiscordFrameType } from "../../packages/discord-ipc/src/index.ts";
import { AudioEngine } from "../../services/router-core-sim/src/audio-engine.ts";
import { DiscordIngestServer } from "../../services/router-core-sim/src/discord-ingest.ts";
import { openNativeOpusDecoderGate, type OpusDecoderFactory } from "../../services/router-core-sim/src/opus-decoder.ts";

export const patterns = ["steady", "measured-like", "burst-100ms"] as const;
type Pattern = typeof patterns[number];
export function deliveryMs(packet: number, pattern: Pattern): number {
  const offsets = pattern === "measured-like" ? [0, 20, 40, 100, 100, 100, 120, 140, 160, 180]
    : pattern === "burst-100ms" ? [0, 20, 40, 160, 160, 160, 160, 160, 160, 180] : null;
  return offsets ? Math.floor(packet / 10) * 200 + offsets[packet % 10] : packet * 20;
}
function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  const p = (fraction: number) => values[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0;
  return { samples: values.length, p50Ms: p(.5), p95Ms: p(.95), p99Ms: p(.99), maxMs: values.at(-1) ?? 0 };
}
function options() {
  const seconds = Number(process.argv.find(x => x.startsWith("--seconds="))?.split("=")[1] ?? 65);
  assert.ok(Number.isInteger(seconds) && seconds >= 5 && seconds <= 300, "--seconds=5..300 (default 65)");
  const output = process.argv.find(x => x.startsWith("--output="))?.slice(9);
  if (output) assert.ok(resolve(output).startsWith(resolve("target") + "/") || resolve(output).startsWith(resolve("target") + "\\"), "Output must be under target");
  return { seconds, output };
}
async function runCase(people: number, pattern: Pattern, seconds: number) {
  assert.ok([1, 5, 10, 20].includes(people)); assert.ok(patterns.includes(pattern));
  const gate = openNativeOpusDecoderGate();
  assert.ok(gate.factory, "Native decoder unavailable; do not substitute a fake decoder");
  const decodeMs: number[] = [], processMs: number[] = [];
  const factory: OpusDecoderFactory = { backend: "@discordjs/opus", create48kMono() {
    const decoder = gate.factory!.create48kMono();
    return { decode(packet) { const start = performance.now(); try { return decoder.decode(packet); } finally { decodeMs.push(performance.now() - start); } }, dispose() { decoder.dispose(); } };
  } };
  const engine = new AudioEngine(48_000, 480, 2);
  const ingest = new DiscordIngestServer(engine, "offline-never-listen", null, factory);
  const ids = { botId: "100000000000000001", guildId: "100000000000000002", voiceChannelId: "100000000000000003" };
  const status = Buffer.from(JSON.stringify({ profileId: "RX", role: "RX", gatewayState: "ready", voiceState: "ready" }));
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload: status });
  const members = Array.from({ length: people }, (_, i) => ({ ...ids, userId: (100000000000001000n + BigInt(i)).toString(), sourceGeneration: 1 }));
  for (const member of members) ingest.ingest({ type: DiscordFrameType.USER_META, ...member, payload: Buffer.from("Synthetic") });
  for (const channel of engine.channels.values()) {
    channel.approvalGateOpen = true;
    for (const send of channel.vcSends.values()) { send.gainDb = -24; send.mute = false; }
  }
  const bus = [...engine.buses.values()][0];
  engine.addMatrixRoute({ id: "out", sourceId: bus.id, output: 0, gainDb: 0, mute: false, tap: "POST" });
  engine.emergencyMuted = false;
  const fixture = JSON.parse(readFileSync(new URL("../core-ipc/fixtures/opus-48k-mono-20ms.json", import.meta.url), "utf8")) as { payloadHex: string };
  const payload = Buffer.from(fixture.payloadHex, "hex");
  // Native/JIT warmup uses separate packets before the measured real-time run.
  for (let i = 0; i < 100; i++) for (const runtime of ingest.runtimes.values()) runtime.decoder.decode(payload);
  decodeMs.length = 0;
  const loop = monitorEventLoopDelay({ resolution: 1 }); loop.enable();
  const start = performance.now(), durationMs = seconds * 1_000;
  let nextBlock = start, packet = 0, heartbeatAt = start, peak = 0;
  try {
    while (performance.now() - start < durationMs) {
      const now = performance.now();
      if (now - heartbeatAt >= 1_000) { ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...ids, payload: status }); heartbeatAt = now; }
      while (deliveryMs(packet, pattern) <= now - start) {
        for (const member of members) ingest.ingest({ type: DiscordFrameType.OPUS, ...member, sequence: packet + 1, payload });
        packet++;
      }
      let blocks = 0;
      while (now >= nextBlock && blocks < 12) {
        const before = performance.now(); engine.processBlock(); processMs.push(performance.now() - before);
        for (const sample of engine.outputs[0]) peak = Math.max(peak, Math.abs(sample));
        nextBlock += 10; blocks++;
      }
      if (blocks === 12 && now >= nextBlock) nextBlock = now + 10;
      await new Promise<void>(done => setTimeout(done, Math.max(0, Math.min(nextBlock, start + deliveryMs(packet, pattern)) - performance.now())));
    }
    loop.disable();
    // Resolve end-of-speech candidates without feeding more audio or measuring this idle tail.
    await new Promise<void>(done => setTimeout(done, 201));
    const snapshot = ingest.snapshot();
    assert.equal(snapshot.sources.length, people); assert.equal(snapshot.decodeErrors, 0);
    assert.equal(decodeMs.length, packet * people, "Every generated packet must reach the native decoder");
    assert.ok(snapshot.sources.every(source => source.packets === packet));
    assert.ok(snapshot.sources.every(source => source.rxTiming?.unclassifiedUnderruns === 0));
    assert.ok(peak > 0 && Number.isFinite(peak), "Real PCM must reach the output mix");
    assert.equal(engine.topologyMutationFaults, 0);
    return { people, pattern, seconds, packetsPerPerson: packet, decodedPackets: decodeMs.length,
      eventLoop: { p99Ms: loop.percentile(99) / 1e6, maxMs: loop.max / 1e6 }, decode: distribution(decodeMs), processBlock: distribution(processMs),
      inSpeechUnderruns: snapshot.sources.reduce((sum, x) => sum + (x.rxTiming?.inSpeechUnderruns ?? 0), 0),
      endOfSpeechUnderruns: snapshot.sources.reduce((sum, x) => sum + (x.rxTiming?.endOfSpeechUnderruns ?? 0), 0),
      unclassifiedUnderruns: snapshot.sources.reduce((sum, x) => sum + (x.rxTiming?.unclassifiedUnderruns ?? 0), 0),
      droppedSamples: snapshot.sources.reduce((sum, x) => sum + x.droppedSamples, 0), decodeErrors: snapshot.decodeErrors, peak,
      timings: snapshot.sources.map(x => ({ rxTiming: x.rxTiming, playout: x.playout })) };
  } finally { loop.disable(); await ingest.close(); }
}
async function main() {
  assert.equal(process.versions.node, "22.23.4", "Run this evidence on the required Node version");
  const { seconds, output } = options();
  const selected = process.argv.find(x => x.startsWith("--case="))?.slice(7);
  if (selected) {
    const [count, pattern] = selected.split(":");
    console.log(JSON.stringify(await runCase(Number(count), pattern as Pattern, seconds))); return;
  }
  const results = [];
  for (const people of [1, 5, 10, 20]) for (const pattern of patterns) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--seconds=${seconds}`, `--case=${people}:${pattern}`], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (child.status !== 0) throw new Error(child.stderr || "RX load child failed");
    const result = JSON.parse(child.stdout); results.push(result);
    console.log(JSON.stringify({ ...result, timings: undefined }));
    if (output) { mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, JSON.stringify({ node: process.versions.node, platform: process.platform, seconds, results }, null, 2) + "\n"); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

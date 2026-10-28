// Manual, real-time/offline: no IPC listener, Bot login, audio device or recording starts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { DiscordFrameType } from "../../packages/discord-ipc/src/index.ts";
import { openNativeOpusDecoderGate, type OpusDecoderFactory } from "../../services/router-core-sim/src/opus-decoder.ts";
import { offlineState } from "./state.ts";
import { deliveryMs, periodicPatterns, matrixPatterns, schedule, type Pattern } from "./schedule.ts";
export { deliveryMs, periodicPatterns as patterns };

function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  const p = (fraction: number) => values[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0;
  return { samples: values.length, p50Ms: p(.5), p95Ms: p(.95), p99Ms: p(.99), maxMs: values.at(-1) ?? 0 };
}
function byteDistribution(values: number[]) {
  return { min: Math.min(...values), mean: values.reduce((a, b) => a + b, 0) / values.length, max: Math.max(...values) };
}
function jsonSamples() {
  const total: number[] = [], stringify: number[] = [], bytes: number[] = [];
  return { record(value: { totalMs: number; stringifyMs: number; bytes: number }) { total.push(value.totalMs); stringify.push(value.stringifyMs); bytes.push(value.bytes); },
    result() { return { totalMs: distribution(total), stringifyMs: distribution(stringify), bytes: byteDistribution(bytes) }; } };
}
const argument = (name: string) => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
function options() {
  const seconds = Number(argument("seconds") ?? 65), seed = Number(argument("seed") ?? 20261029);
  assert.ok(Number.isInteger(seconds) && seconds >= 5 && seconds <= 900, "--seconds=5..900");
  assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, "--seed=uint32");
  const mode = argument("state-mode") ?? "periodic";
  assert.ok(mode === "periodic" || mode === "previous", "--state-mode=periodic|previous");
  const output = argument("output");
  if (output) assert.ok(resolve(output).startsWith(resolve("target") + sep), "Output must be under target");
  return { seconds, seed, mode, output };
}
async function runCase(people: number, pattern: Pattern, seconds: number, seed: number, mode: string) {
  assert.ok([1, 5, 10, 20].includes(people));
  assert.ok([...periodicPatterns, ...matrixPatterns].includes(pattern));
  const gate = openNativeOpusDecoderGate(); assert.ok(gate.factory, "Native decoder required");
  const decodeMs: number[] = [], processMs: number[] = [];
  const factory: OpusDecoderFactory = { backend: "@discordjs/opus", create48kMono() {
    const decoder = gate.factory!.create48kMono();
    return { decode(packet) { const at = performance.now(); try { return decoder.decode(packet); } finally { decodeMs.push(performance.now() - at); } }, dispose() { decoder.dispose(); } };
  } };
  const state = offlineState(factory), { engine, ingest, runtime, scheduler } = state;
  const ids = { botId: "100000000000000001", guildId: "100000000000000002", voiceChannelId: "100000000000000003" };
  const status = Buffer.from(JSON.stringify({ profileId: "RX", role: "RX", gatewayState: "ready", voiceState: "ready" }));
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload: status });
  const members = Array.from({ length: people }, (_, i) => ({ ...ids, userId: (100000000000001000n + BigInt(i)).toString(), sourceGeneration: 1 }));
  for (const member of members) ingest.ingest({ type: DiscordFrameType.USER_META, ...member, payload: Buffer.from("Synthetic") });
  for (const channel of engine.channels.values()) {
    channel.approvalGateOpen = true;
    for (const send of channel.vcSends.values()) { send.gainDb = -24; send.mute = false; }
  }
  engine.addMatrixRoute({ id: "out", sourceId: [...engine.buses.values()][0].id, output: 0, gainDb: 0, mute: false, tap: "POST" });
  engine.emergencyMuted = false;
  const fixture = JSON.parse(readFileSync(new URL("../core-ipc/fixtures/opus-48k-mono-20ms.json", import.meta.url), "utf8")) as { payloadHex: string };
  const payload = Buffer.from(fixture.payloadHex, "hex");
  for (let i = 0; i < 100; i++) for (const source of ingest.runtimes.values()) source.decoder.decode(payload);
  decodeMs.length = 0;
  const schedules = members.map((_, person) => schedule(person, seconds * 1000, pattern, seed)), indices = new Uint32Array(people);
  const samples = jsonSamples();
  const measureState = (details: boolean) => {
    const at = performance.now(), value = state.state(details), builtAt = performance.now();
    const text = JSON.stringify(value), end = performance.now();
    return { totalMs: end - at, stringifyMs: end - builtAt, bytes: Buffer.byteLength(text) };
  };
  const loop = monitorEventLoopDelay({ resolution: 1 }); loop.enable();
  const start = performance.now(), durationMs = seconds * 1000;
  let nextBlock = start, nextState = start + 1000, heartbeat = start, nextMinute = start + 60_000, peak = 0;
  try {
    while (performance.now() - start < durationMs) {
      const now = performance.now();
      if (now - heartbeat >= 1000) { ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...ids, payload: status }); heartbeat = now; }
      for (let person = 0; person < people; person++) {
        const arrivals = schedules[person].arrivals;
        while (indices[person] < arrivals.length && arrivals[indices[person]].at <= now - start) {
          const arrival = arrivals[indices[person]++];
          ingest.ingest({ type: DiscordFrameType.OPUS, ...members[person], sequence: arrival.sequence, payload });
        }
      }
      let blocks = 0;
      const lateness = now - nextBlock;
      while (now >= nextBlock && blocks < 12) {
        const at = performance.now(); engine.processBlock(); const elapsed = performance.now() - at;
        processMs.push(elapsed); runtime.recordBlock(elapsed);
        for (const sample of engine.outputs[0]) peak = Math.max(peak, Math.abs(sample));
        nextBlock += 10; blocks++;
      }
      if (blocks === 12 && now >= nextBlock) nextBlock = now + 10;
      scheduler.record(lateness, blocks, now);
      if (now >= nextMinute) {
        runtime.finishWindow(now); nextMinute += 60_000;
        if (process.argv.includes("--progress")) console.error(JSON.stringify({ progressSeconds: Math.floor((now - start) / 1000),
          inSpeechUnderruns: ingest.snapshot(Date.now(), false).rxDiagnostics?.inSpeechUnderruns, eventLoopMaxMs: loop.max / 1e6 }));
      }
      if (now >= nextState) { samples.record(measureState(mode === "previous")); nextState += 1000; }
      let next = Math.min(nextBlock, nextState);
      for (let person = 0; person < people; person++) next = Math.min(next, start + (schedules[person].arrivals[indices[person]]?.at ?? durationMs));
      await new Promise<void>(done => setTimeout(done, Math.max(0, next - performance.now())));
    }
    loop.disable();
    await new Promise<void>(done => setTimeout(done, 201));
    const snapshot = ingest.snapshot(Date.now(), true);
    assert.equal(snapshot.sources.length, people); assert.equal(snapshot.decodeErrors, 0);
    assert.equal(decodeMs.length, indices.reduce((a, b) => a + b, 0));
    assert.ok(snapshot.sources.every((source, i) => source.packets === indices[i] && source.rxTiming?.unclassifiedUnderruns === 0));
    assert.ok(peak > 0 && Number.isFinite(peak)); assert.equal(engine.topologyMutationFaults, 0);
    // Paired end-of-run A/B: identical live data, alternating order, outside real-time statistics.
    for (let i = 0; i < 10; i++) { measureState(true); measureState(false); }
    const previous = jsonSamples(), periodic = jsonSamples();
    for (let i = 0; i < 100; i++) for (const details of i % 2 ? [true, false] : [false, true]) (details ? previous : periodic).record(measureState(details));
    const inSpeech = snapshot.sources.reduce((sum, x) => sum + (x.rxTiming?.inSpeechUnderruns ?? 0), 0);
    return { people, pattern, seconds, seed, stateMode: mode, decodedPackets: decodeMs.length,
      scheduledPackets: schedules.reduce((sum, x) => sum + x.arrivals.length, 0), speechMs: schedules.reduce((sum, x) => sum + x.speechMs, 0), talkspurts: schedules.reduce((sum, x) => sum + x.talkspurts, 0),
      eventLoop: { p99Ms: loop.percentile(99) / 1e6, maxMs: loop.max / 1e6 }, decode: distribution(decodeMs), processBlock: distribution(processMs),
      stateJson: samples.result(), pairedStateJson: { previous: previous.result(), periodic: periodic.result() },
      inSpeechUnderruns: inSpeech, inSpeechPerPerson15Min: inSpeech * 900 / people / seconds,
      endOfSpeechUnderruns: snapshot.sources.reduce((sum, x) => sum + (x.rxTiming?.endOfSpeechUnderruns ?? 0), 0),
      unclassifiedUnderruns: snapshot.sources.reduce((sum, x) => sum + (x.rxTiming?.unclassifiedUnderruns ?? 0), 0),
      droppedSamples: snapshot.sources.reduce((sum, x) => sum + x.droppedSamples, 0), decodeErrors: snapshot.decodeErrors, peak,
      timings: snapshot.sources.map(x => ({ rxTiming: x.rxTiming, playout: x.playout })) };
  } finally { loop.disable(); await state.close(); }
}
async function main() {
  assert.equal(process.versions.node, "22.23.4");
  const { seconds, seed, mode, output } = options(), selected = argument("case"), childMode = process.argv.includes("--child");
  const results: Array<Awaited<ReturnType<typeof runCase>>> = [];
  const save = () => { if (output) { mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, JSON.stringify({ node: process.versions.node, platform: process.platform, seed, results }, null, 2) + "\n"); } };
  if (selected) {
    const [people, pattern] = selected.split(":");
    const result = await runCase(Number(people), pattern as Pattern, seconds, seed, mode);
    results.push(result); if (!childMode) save(); console.log(JSON.stringify(childMode ? result : { ...result, timings: undefined })); return;
  }
  assert.ok(output, "Matrix runs require --output=target/.../results.json");
  for (const people of [1, 5, 10, 20]) for (const pattern of matrixPatterns) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--seconds=${seconds}`, `--seed=${seed}`, `--state-mode=${mode}`, `--case=${people}:${pattern}`, "--child"], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    if (child.status !== 0) throw new Error(child.stderr || "RX child failed");
    const result = JSON.parse(child.stdout); results.push(result); save(); console.log(JSON.stringify({ ...result, timings: undefined }));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

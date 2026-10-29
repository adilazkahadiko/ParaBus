// Paired real-time offline A/B, shared arrivals and scheduler; no Bot/device/stream.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { DiscordFrameType, DiscordRxFlags } from "../../packages/discord-ipc/src/index.ts";
import { DiscordPcmSource } from "../../services/router-core-sim/src/discord-pcm-source.ts";
import { DiscordPcmSource as LegacySource } from "../helpers/beta4-discord-pcm-source.ts";
import { openNativeOpusDecoderGate } from "../../services/router-core-sim/src/opus-decoder.ts";
import { DeliveryWait } from "./wait.ts";
import { offlineState } from "./state.ts";
import { schedule, random } from "./schedule.ts";

export const abPatterns = ["steady", "realistic", "hardware", "severe"] as const;
type AbPattern = typeof abPatterns[number];
const kinds = ["loss", "senderPause", "delayed", "fillBurst", "unknown"] as const;
const arg = (key: string) => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3);
export function abSchedule(person: number, milliseconds: number, pattern: AbPattern, seed: number) {
  if (pattern !== "hardware") return schedule(person, milliseconds, pattern, seed).arrivals.map(p => ({ ...p, timestamp: Math.round(p.sentAt / 20) * 960 >>> 0 }));
  const base = schedule(person, milliseconds, "steady", seed).arrivals;
  const rng = random(seed ^ Math.imul(person + 1, 0x27d4eb2d));
  let nextLoss = 10_000 + rng() * 20_000, lossEnd = -1, losses = 0;
  return base.flatMap(p => {
    if (p.sentAt >= nextLoss) { lossEnd = p.sentAt + 80 + rng() * 120; nextLoss = p.sentAt + 10_000 + rng() * 20_000; losses++; }
    if (p.sentAt < lossEnd) return [];
    return [{ ...p, at: Math.max(0, p.at + rng() * 3), timestamp: Math.round(p.sentAt / 20) * 960 >>> 0 }];
  });
}

export class SampleTrace {
  #samples = new Uint32Array(64);
  #at = new Float64Array(64);
  #head = 0;
  #count = 0;
  #pendingSamples = new Uint32Array(64);
  #pendingAt = new Float64Array(64);
  #pendingCount = 0;
  ages = new Uint32Array(2001);
  maxMs = 0;
  push(samples: number, at = performance.now()) {
    assert.ok(this.#count < 64, "bounded provenance queue");
    const slot = (this.#head + this.#count++) % 64; this.#samples[slot] = samples; this.#at[slot] = at;
  }
  private consume(samples: number, output: boolean) {
    while (samples > 0) {
      assert.ok(this.#count, "provenance accounting");
      const take = Math.min(samples, this.#samples[this.#head]);
      if (output) {
        assert.ok(this.#pendingCount < 64);
        this.#pendingSamples[this.#pendingCount] = take; this.#pendingAt[this.#pendingCount++] = this.#at[this.#head];
      }
      samples -= take; this.#samples[this.#head] -= take;
      if (!this.#samples[this.#head]) { this.#head = (this.#head + 1) % 64; this.#count--; }
    }
  }
  read(samples: number) { this.consume(samples, true); }
  drop(samples: number) { this.consume(samples, false); }
  clear() { this.#head = 0; this.#count = 0; }
  emitted(now: number) {
    for (let i = 0; i < this.#pendingCount; i++) {
      const age = Math.max(0, now - this.#pendingAt[i]); this.maxMs = Math.max(this.maxMs, age);
      this.ages[Math.min(2000, Math.ceil(age))] += this.#pendingSamples[i];
    }
    this.#pendingCount = 0;
  }
}
export class SilenceTrace {
  totalMs = 0;
  runs: Record<string, { count: number; totalMs: number; maxMs: number }> = {};
  #samples = 0;
  #kind: string | null = null;
  #lastAt = -Infinity;
  #lastSequence = 0;
  #lastTimestamp = 0;
  #everOutput = false;
  packet(sequence: number, timestamp: number, at: number) {
    if (this.#samples && this.#kind === null && Number.isFinite(this.#lastAt)) {
      const delta = (sequence - this.#lastSequence + 65536) % 65536, timeDelta = (timestamp - this.#lastTimestamp) >>> 0;
      this.#kind = delta > 1 ? timeDelta > delta * 960 ? "lossWithPause" : "loss"
        : timeDelta > 960 ? "senderPause" : at - this.#lastAt > 30 ? "arrivalDelay" : "fillBurst";
    }
    this.#lastAt = at; this.#lastSequence = sequence; this.#lastTimestamp = timestamp;
  }
  fill(missingSamples: number) {
    // Real PCM at the start ends the previous run. Any missing tail starts a
    // NEW run continuing into the next block (critical for fractional tails).
    if (missingSamples < 480) { this.finish(); this.#everOutput = true; }
    this.#samples += missingSamples; this.totalMs += missingSamples / 48;
  }
  finish() {
    if (this.#samples) {
      const entry = this.runs[this.#everOutput ? this.#kind ?? "unknown" : "startup"] ??= { count: 0, totalMs: 0, maxMs: 0 };
      const ms = this.#samples / 48; entry.count++; entry.totalMs += ms; entry.maxMs = Math.max(entry.maxMs, ms);
    }
    this.#samples = 0; this.#kind = null;
  }
}
function weighted(histogram: Uint32Array, maximum: number) {
  const total = histogram.reduce((a, b) => a + b, 0);
  const p = (q: number) => { let n = 0; for (let i = 0; i < histogram.length; i++) { n += histogram[i]; if (n >= total * q) return i; } return 0; };
  return { samples: total, p50Ms: p(.5), p95Ms: p(.95), p99Ms: p(.99), maxMs: maximum };
}

async function compare(people: number, pattern: AbPattern, seconds: number, seed: number) {
  const gate = openNativeOpusDecoderGate(); assert.ok(gate.factory);
  const states = [
    offlineState(gate.factory, (c, r, b) => new LegacySource(b * 12, r, b) as unknown as DiscordPcmSource),
    offlineState(gate.factory),
  ];
  const traces: SampleTrace[][] = [[], []];
  const silenceTraces = [Array.from({ length: people }, () => new SilenceTrace()), Array.from({ length: people }, () => new SilenceTrace())];
  const missingSamples = [new Uint32Array(people), new Uint32Array(people)];
  const silence = [0, 0], activeSilence = [0, 0];
  const ids = { botId: "100000000000000001", guildId: "100000000000000002", voiceChannelId: "100000000000000003" };
  const members = Array.from({ length: people }, (_, i) => ({ ...ids, userId: String(100000000000001000n + BigInt(i)), sourceGeneration: 1 }));
  const payload = Buffer.from(JSON.parse(readFileSync(new URL("../core-ipc/fixtures/opus-48k-mono-20ms.json", import.meta.url), "utf8")).payloadHex, "hex");
  const status = Buffer.from(JSON.stringify({ profileId: "RX", role: "RX", gatewayState: "ready", voiceState: "ready" }));
  for (const [variant, state] of states.entries()) {
    state.ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload: status });
    for (const member of members) state.ingest.ingest({ type: DiscordFrameType.USER_META, ...member, payload: Buffer.from("Synthetic") });
    for (const channel of state.engine.channels.values()) {
      channel.approvalGateOpen = true;
      for (const send of channel.vcSends.values()) { send.gainDb = -24; send.mute = false; }
    }
    state.engine.addMatrixRoute({ id: "out", sourceId: [...state.engine.buses.values()][0].id, output: 0, gainDb: 0, mute: false, tap: "POST" });
    state.engine.emergencyMuted = false;
    for (const [person, source] of [...state.ingest.runtimes.values()].entries()) {
      for (let i = 0; i < 100; i++) source.decoder.decode(payload);
      const trace = new SampleTrace(); source.source.sampleTrace = trace; traces[variant].push(trace);
      const original = source.source.fill.bind(source.source);
      source.source.fill = target => {
        const queued = source.source.queuedSamples, result = original(target);
        const missing = result ? Math.max(0, target.length - queued) : target.length;
        missingSamples[variant][person] = missing; silenceTraces[variant][person].fill(missing);
        return result;
      };
    }
  }
  const schedules = members.map((_, p) => abSchedule(p, seconds * 1000, pattern, seed)), indices = new Uint32Array(people);
  const waiter = new DeliveryWait(); await waiter.sleep(0);
  const loop = monitorEventLoopDelay({ resolution: 1 }); loop.enable();
  const start = performance.now(); let blockAt = start, wakeAt = start, stateAt = start + 1000, nextMinute = start + 60000, wake = 0;
  const outputBlocks = [0, 0], jsonTimes: number[][] = [[], []];
  try {
    while (performance.now() - start < seconds * 1000) {
      const now = performance.now();
      for (let person = 0; person < people; person++) while (indices[person] < schedules[person].length && schedules[person][indices[person]].at <= now - start) {
        const packet = schedules[person][indices[person]++];
        for (const [variant, state] of states.entries()) {
          silenceTraces[variant][person].packet(packet.sequence & 65535, packet.timestamp, performance.now());
          state.ingest.ingest({ type: DiscordFrameType.OPUS, ...members[person], flags: DiscordRxFlags.REAL_RTP,
            sequence: packet.sequence & 65535, rtpTimestamp: packet.timestamp, payload });
        }
      }
      if (now >= wakeAt) {
        let blocks = 0;
        while (now >= blockAt && blocks++ < 12) {
          for (const [variant, state] of states.entries()) {
            state.engine.processBlock();
            const end = performance.now(); traces[variant].forEach(x => x.emitted(end)); outputBlocks[variant]++;
            for (let p = 0; p < people; p++) {
              // Count underfilled blocks (including prefill), excluding scheduled silence for activeSilence.
              const missing = missingSamples[variant][p];
              silence[variant] += missing / 48;
              const previous = indices[p] ? schedules[p][indices[p] - 1] : undefined;
              const next = schedules[p][indices[p]];
              if (previous && next && next.sentAt - previous.sentAt <= 260) activeSilence[variant] += missing / 48;
            }
          }
          blockAt += 10;
        }
        if (blocks >= 12 && now >= blockAt) blockAt = now + 10;
        wakeAt = pattern === "hardware" ? wakeAt + [20, 43, 20, 20, 43, 17, 20, 43, 17][wake++ % 9] : blockAt;
      }
      if (now >= stateAt) {
        for (const [i, state] of states.entries()) {
          state.ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...ids, payload: status });
          const at = performance.now(); JSON.stringify(state.state(false)); jsonTimes[i].push(performance.now() - at);
        }
        stateAt += 1000;
      }
      if (now >= nextMinute) { console.error(JSON.stringify({ people, pattern, progressSeconds: Math.round((now - start) / 1000) })); nextMinute += 60000; }
      let next = Math.min(wakeAt, stateAt, start + seconds * 1000);
      for (let p = 0; p < people; p++) next = Math.min(next, start + (schedules[p][indices[p]]?.at ?? seconds * 1000));
      await waiter.sleep(next - performance.now());
    }
    loop.disable(); await new Promise<void>(done => setTimeout(done, 201));
    const results = states.map((state, variant) => {
      silenceTraces[variant].forEach(x => x.finish());
      const snapshot = state.ingest.snapshot(Date.now(), true);
      assert.equal(snapshot.decodeErrors, 0); assert.equal(state.engine.topologyMutationFaults, 0);
      const histogram = new Uint32Array(2001); let max = 0;
      for (const trace of traces[variant]) { trace.ages.forEach((n, i) => histogram[i] += n); max = Math.max(max, trace.maxMs); }
      const classification = Object.fromEntries(kinds.map(k => [k, snapshot.sources.reduce((sum, x) => sum + (x.rxTiming?.inSpeechByKind?.[k] ?? 0), 0)]));
      const inSpeech = snapshot.sources.reduce((sum, x) => sum + (x.rxTiming?.inSpeechUnderruns ?? 0), 0);
      return { variant: variant ? "adaptive" : "beta4", inSpeech, classification,
        perPerson15Min: Object.fromEntries(Object.entries(classification).map(([k, n]) => [k, n * 900 / people / seconds])),
        microInSpeech: snapshot.sources.reduce((s, x) => s + (x.rxTiming?.microInSpeechUnderruns ?? 0), 0),
        endOfSpeech: snapshot.sources.reduce((s, x) => s + (x.rxTiming?.endOfSpeechUnderruns ?? 0), 0),
        silenceMs: silence[variant], activeSilenceMs: activeSilence[variant],
        silenceRuns: silenceTraces[variant].map(x => x.runs),
        hardCapDroppedSamples: snapshot.sources.reduce((s, x) => s + x.droppedSamples, 0),
        latency: weighted(histogram, max), outputBlocks: outputBlocks[variant],
        targetBlocks: variant ? snapshot.sources.reduce((bins, x) => { (x.playout?.targetBlocks ?? []).forEach((n, i) => bins[i] += n); return bins; }, [0, 0, 0, 0]) : [outputBlocks[variant] * people, 0, 0, 0],
        finalTargets: snapshot.sources.map(x => x.playout?.targetMs),
        finalHardCaps: snapshot.sources.map(x => x.playout?.hardCapMs ?? 120),
        rtp: snapshot.sources.map(x => x.rxTiming?.rtp),
        timings: snapshot.sources.map(x => x.rxTiming),
      };
    });
    return { people, pattern, seconds, seed, decodedPacketsPerVariant: indices.reduce((a, b) => a + b, 0),
      eventLoop: { p99Ms: loop.percentile(99) / 1e6, maxMs: loop.max / 1e6 }, results };
  } finally { loop.disable(); await waiter.close(); for (const state of states) await state.close(); }
}
export async function mainAb() {
  assert.equal(process.versions.node, "22.23.4");
  const seconds = Number(arg("seconds") ?? 65), seed = Number(arg("seed") ?? 20261029), output = arg("output");
  assert.ok(Number.isInteger(seconds) && seconds >= 5 && seconds <= 900);
  assert.ok(output && resolve(output).startsWith(resolve("target") + sep));
  const cases = arg("case") ? [arg("case")!] : [1, 5, 10, 20].flatMap(n => abPatterns.map(p => `${n}:${p}`));
  const results: unknown[] = [];
  for (const selected of cases) {
    const [n, p] = selected.split(":"); assert.ok([1, 5, 10, 20].includes(Number(n))); assert.ok(abPatterns.includes(p as AbPattern));
    if (process.argv.includes("--ab-child")) {
      const result = await compare(Number(n), p as AbPattern, seconds, seed); console.log(JSON.stringify(result)); return;
    }
    const child: ReturnType<typeof spawnSync> = spawnSync(process.execPath, [process.argv[1], "--ab", "--ab-child", `--seconds=${seconds}`, `--seed=${seed}`, `--case=${selected}`, `--output=${output}`], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(child.status, 0, String(child.stderr));
    const result = JSON.parse(String(child.stdout)); results.push(result);
    mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, JSON.stringify({ node: process.versions.node, seed, paired: true, results }, null, 2));
    console.log(JSON.stringify({ people: result.people, pattern: result.pattern, seconds, eventLoop: result.eventLoop,
      results: result.results.map(({ timings, rtp, ...x }: any) => x) }));
  }
}

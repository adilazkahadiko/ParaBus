import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { openNativeOpusDecoderGate } from "../services/router-core-sim/src/opus-decoder.ts";

const durationArg = process.argv.find((value) => value.startsWith("--duration-ms="));
const durationMs = durationArg ? Number(durationArg.slice("--duration-ms=".length)) : 3_000;
if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 60_000) throw new RangeError("--duration-ms must be an integer from 100 to 60000");
const fixture = JSON.parse(readFileSync(new URL("../tests/core-ipc/fixtures/opus-48k-mono-20ms.json", import.meta.url), "utf8")) as { payloadHex: string };
const packet = Buffer.from(fixture.payloadHex, "hex");
const gate = openNativeOpusDecoderGate();
if (!gate.factory) throw new Error(gate.reason ?? "native Opus decoder unavailable");

function percentile(values: number[], ratio: number): number {
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * ratio))] ?? 0;
}

function run(decoderCount: number) {
  const decoders = Array.from({ length: decoderCount }, () => gate.factory!.create48kMono());
  const rssBefore = process.memoryUsage().rss;
  const timings: number[] = [];
  let packets = 0;
  let decodeErrors = 0;
  const start = performance.now();
  while (performance.now() - start < durationMs) {
    const batchStart = performance.now();
    for (const decoder of decoders) {
      try { decoder.decode(packet); packets += 1; } catch { decodeErrors += 1; }
    }
    timings.push(performance.now() - batchStart);
  }
  for (const decoder of decoders) decoder.dispose();
  timings.sort((a, b) => a - b);
  const elapsedMs = performance.now() - start;
  return { decoders: decoderCount, packetsPerSecond: Math.round(packets / (elapsedMs / 1_000)), p95Ms: percentile(timings, .95), p99Ms: percentile(timings, .99), maxMs: timings.at(-1) ?? 0, deadlineMisses: timings.filter((ms) => ms > 10).length, rssDeltaBytes: process.memoryUsage().rss - rssBefore, decodeErrors };
}

console.log(JSON.stringify({ benchmark: "native-opus-decoder", durationMs, results: [run(20), run(80)] }));

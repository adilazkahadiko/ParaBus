// Supplementary functional reference: exact model clocks, real Opus and mixer.
// NOT a wall-clock latency benchmark. No Bot, IPC listener, audio endpoint or recording.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { DiscordFrameType, DiscordRxFlags } from "../../packages/discord-ipc/src/index.ts";
import { DiscordPcmSource } from "../../services/router-core-sim/src/discord-pcm-source.ts";
import { DiscordPcmSource as Beta4 } from "../helpers/beta4-discord-pcm-source.ts";
import { openNativeOpusDecoderGate } from "../../services/router-core-sim/src/opus-decoder.ts";
import { offlineState } from "./state.ts";
import { abSchedule } from "./compare.ts";

const argument = (key: string) => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3);
assert.equal(process.versions.node, "22.23.4");
const output = argument("output"), seconds = Number(argument("seconds") ?? 65), selected = argument("people");
const realtime = process.argv.includes("--realtime");
assert.ok(output && resolve(output).startsWith(resolve("target") + sep));
assert.ok(Number.isInteger(seconds) && seconds >= 5 && seconds <= 900);
const peopleCases = selected ? [Number(selected)] : [1, 5, 10, 20];
assert.ok(peopleCases.every(x => [1, 5, 10, 20].includes(x)));
const realNow = performance.now.bind(performance), descriptor = Object.getOwnPropertyDescriptor(performance, "now");
const payload = Buffer.from(JSON.parse(readFileSync(new URL("../core-ipc/fixtures/opus-48k-mono-20ms.json", import.meta.url), "utf8")).payloadHex, "hex");
const gate = openNativeOpusDecoderGate(), factory = gate.factory; assert.ok(factory);
const results = [];
for (const people of peopleCases) {
  let modelNow = 0;
  Object.defineProperty(performance, "now", { configurable: true, value: () => modelNow });
  const states: Array<ReturnType<typeof offlineState>> = [offlineState(factory, (_c, r, b) => new Beta4(12 * b, r, b) as unknown as DiscordPcmSource), offlineState(factory)];
  try {
    const ids = { botId: "100000000000000001", guildId: "100000000000000002", voiceChannelId: "100000000000000003" };
    const members = Array.from({ length: people }, (_, i) => ({ ...ids, userId: String(100000000000001000n + BigInt(i)), sourceGeneration: 1 }));
    const status = Buffer.from(JSON.stringify({ profileId: "RX", role: "RX", gatewayState: "ready", voiceState: "ready" }));
    for (const state of states) {
      state.ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload: status });
      for (const member of members) state.ingest.ingest({ type: DiscordFrameType.USER_META, ...member, payload: Buffer.from("Synthetic") });
      for (const channel of state.engine.channels.values()) {
        channel.approvalGateOpen = true;
        for (const send of channel.vcSends.values()) { send.gainDb = -24; send.mute = false; }
      }
      state.engine.addMatrixRoute({ id: "out", sourceId: [...state.engine.buses.values()][0].id, output: 0, gainDb: 0, mute: false, tap: "POST" });
      state.engine.emergencyMuted = false;
      for (const source of state.ingest.runtimes.values()) for (let i = 0; i < 100; i++) source.decoder.decode(payload);
    }
    const schedules = members.map((_, p) => abSchedule(p, seconds * 1000, "steady", 20261029)), indices = new Uint32Array(people);
    const start = realNow(), peaks = [0, 0]; let block = 0;
    while (block < seconds * 100) {
      const now = realNow(); let batch = 0;
      while (block < seconds * 100 && (!realtime || start + block * 10 <= now) && batch++ < 12) {
        modelNow = block * 10;
        for (let p = 0; p < people; p++) while (indices[p] < schedules[p].length && schedules[p][indices[p]].at <= modelNow) {
          const packet = schedules[p][indices[p]++];
          for (const state of states) state.ingest.ingest({ type: DiscordFrameType.OPUS, ...members[p], flags: DiscordRxFlags.REAL_RTP,
            sequence: packet.sequence & 65535, rtpTimestamp: packet.timestamp, payload });
        }
        for (const [variant, state] of states.entries()) {
          state.engine.processBlock();
          for (const sample of state.engine.outputs[0]) { assert.ok(Number.isFinite(sample)); peaks[variant] = Math.max(peaks[variant], Math.abs(sample)); }
          if (block % 100 === 0) { state.ingest.ingest({ type: DiscordFrameType.ADAPTER_STATE, ...ids, payload: status }); JSON.stringify(state.state(false)); }
        }
        block++;
      }
      if (realtime) await new Promise<void>(done => setTimeout(done, Math.max(0, start + block * 10 - realNow())));
      else await new Promise<void>(done => setImmediate(done));
    }
    modelNow = seconds * 1000 + 201;
    const variants = states.map((state, variant) => {
      const snapshot = state.ingest.snapshot();
      assert.equal(snapshot.decodeErrors, 0); assert.ok(peaks[variant] > 0);
      const shortages = snapshot.sources.reduce((sum, s) => sum + (s.rxTiming?.inSpeechUnderruns ?? 0), 0);
      const dropped = snapshot.sources.reduce((sum, s) => sum + s.droppedSamples, 0);
      assert.equal(shortages, 0); assert.equal(dropped, 0);
      const targets = snapshot.sources.map(s => s.playout!.targetMs);
      if (seconds >= 30) assert.ok(targets.every(x => x === 40));
      return { variant: variant ? "adaptive" : "beta4", shortages, dropped, targets, peak: peaks[variant] };
    });
    results.push({ people, audioSeconds: seconds, wallSeconds: (realNow() - start) / 1000, realtime, variants });
    mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, JSON.stringify({ node: process.versions.node, clock: "exact-model-not-wall-latency", results }, null, 2));
    console.log(JSON.stringify(results.at(-1)));
  } finally {
    if (descriptor) Object.defineProperty(performance, "now", descriptor); else Reflect.deleteProperty(performance, "now");
    for (const state of states) await state.close();
  }
}

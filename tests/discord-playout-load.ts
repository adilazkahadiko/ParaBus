import { AudioEngine, AudioChannel, VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { DiscordPcmSource } from "../services/router-core-sim/src/discord-pcm-source.ts";

// Synthetic full RX path after decoding. No native device/network/Opus cost.
let now = 0;
const engine = new AudioEngine(), sources: DiscordPcmSource[] = [];
for (let i = 0; i < 20; i++) engine.addBus(new VcBus(`vc${i}`, `VC ${i}`, 480, 48000));
for (let i = 0; i < 112; i++) {
  const source = new DiscordPcmSource(5760, 48000, 480, () => now);
  sources.push(source);
  const channel = new AudioChannel(`user${i}`, `Guest ${i}`, "DiscordUser", source, 480, 48000);
  channel.approvalGateOpen = true;
  channel.vcSends.set(`vc${i % 20}`, { gainDb: -12, mute: false });
  engine.addChannel(channel);
}
for (let g = 0; g < 2; g++) {
  engine.addBus(new VcBus(`group${g}`, `Group ${g}`, 480, 48000));
  engine.setGroupSources(`group${g}`, Array.from({ length: 10 }, (_, i) => `vc${g * 10 + i}`));
  engine.addMatrixRoute({ id: `out${g}`, sourceId: `group${g}`, output: g, gainDb: 0, mute: false, tap: "POST" });
}
engine.emergencyMuted = false;
const pcm = Buffer.alloc(1920);
for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 20) * 1000), i * 2);
const timings = new Float64Array(2000);
let peak = 0;
for (let i = 0; i < 2200; i++) {
  now = i * 10;
  const start = performance.now();
  if (i % 2 === 0) for (const source of sources) source.pushInt16Le(pcm, now);
  engine.processBlock();
  if (i >= 200) timings[i - 200] = performance.now() - start;
  peak = Math.max(peak, Math.abs(engine.outputs[0][100]));
}
timings.sort();
const report = { rx: 112, buses: 20, groups: 2, blocks: timings.length, p99Ms: timings[1980], maxMs: timings.at(-1),
  deadlineMisses: timings.filter(value => value > 10).length, droppedSamples: sources.reduce((sum, source) => sum + source.droppedSamples, 0), peak,
  limitation: "Includes PCM enqueue, RX interpolation and approved-channel DSP; excludes Opus, native I/O and network." };
console.log(JSON.stringify(report, null, 2));
if (report.deadlineMisses || report.droppedSamples || !Number.isFinite(peak) || peak === 0) process.exitCode = 1;

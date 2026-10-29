import { createHash } from "node:crypto";
import { AudioChannel, AudioEngine, VcBus } from "../../services/router-core-sim/src/audio-engine.ts";
import type { DiscordPcmSource } from "./beta4-discord-pcm-source.ts";

/** Deterministic whole-mix trace, also run against the untouched beta.4 source for the golden. */
export function rxPcmTrace(Source: typeof DiscordPcmSource) {
  let now = 0;
  const engine = new AudioEngine(48_000, 480, 2);
  const sources = Array.from({ length: 3 }, () => new Source(5760, 48000, 480, () => now));
  engine.addBus(new VcBus("vc", "VC", 480, 48000));
  engine.addMatrixRoute({ id: "main", sourceId: "vc", output: 0, gainDb: -3, mute: false, tap: "POST" });
  engine.addMatrixRoute({ id: "cue", sourceId: "vc", output: 1, gainDb: -6, mute: false, tap: "PRE" });
  engine.emergencyMuted = false;
  for (const [index, source] of sources.entries()) {
    const channel = new AudioChannel(`guest${index}`, "Guest", "DiscordUser", source, 480, 48000);
    channel.approvalGateOpen = true; channel.vcSends.set("vc", { gainDb: -12, mute: false }); engine.addChannel(channel);
  }
  const pcm = Buffer.alloc(1920), quiet = Buffer.alloc(1920);
  const digest = createHash("sha256");
  const next = [0, 0, 0];
  for (let block = 0; block < 12_000; block++) {
    now = block * 10;
    for (let person = 0; person < 3; person++) {
      const source = sources[person];
      const push = (data: Buffer) => {
        source.timing?.observePacket(now, source.queuedSamples);
        source.pushInt16Le(data, now);
        source.timing?.observeQueued(source.queuedSamples);
      };
      // Steady slow clock, quiet persistent high water, burst jitter + silence/clear/overflow.
      const delay = person === 2 && block % 400 < 12 ? 100 : 0;
      if (person === 2 && block % 1000 === 500) source.clear();
      if (person === 1 && block % 200 === 0) for (let j = 0; j < 5; j++) push(quiet);
      while (next[person] + delay <= now) {
        if (!(person === 2 && block % 1000 >= 700)) {
          for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(Math.sin((i + block * 7 + person) / 17) * 5000), i * 2);
          push(person === 1 ? quiet : pcm);
        }
        next[person] += person === 0 ? 20.004 : 20;
      }
    }
    engine.processBlock();
    for (const output of engine.outputs) digest.update(new Uint8Array(output.buffer, output.byteOffset, output.byteLength));
  }
  return { sha256: digest.digest("hex"), sources: sources.map(source => ({ dropped: source.droppedSamples, ...source.playoutSnapshot() })) };
}

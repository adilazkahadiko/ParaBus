import assert from "node:assert/strict";
import test from "node:test";
import { DiscordPcmSource } from "../services/router-core-sim/src/discord-pcm-source.ts";
import { PcmRingSource } from "../services/router-core-sim/src/audio-engine.ts";

const pcm = Buffer.alloc(960 * 2);
for (let i = 0; i < 960; i++) pcm.writeInt16LE(8192, i * 2);

for (const ppm of [0, 500]) test(`30 minute voiced RX with 60/80/100ms transport stalls and ${ppm}ppm meets the 80ms queue budget`, t => {
  let now = 0, nextPacket = 0, heldUntil = 0, peakMs = 0, firstFiveMinutes = 0, lastFiveMinutes = 0;
  const source = new DiscordPcmSource(5760, 48000, 480, () => now), target = new Float32Array(480);
  const histogram = new Uint32Array(121), delays = [60, 80, 100];
  const blocks = 180_000;
  for (let block = 0; block < blocks; block++) {
    now = block * 10;
    // Once a minute, transport holds ordered packets and releases the batch.
    // Constant voiced PCM prevents a quiet-cut shortcut from hiding slow recovery.
    if (now % 60_000 === 2_000) heldUntil = now + delays[Math.floor(now / 60_000) % delays.length];
    if (now >= heldUntil) while (nextPacket <= now) {
      source.pushInt16Le(pcm, now);
      nextPacket += 20 / (1 + ppm / 1e6);
    }
    const queueMs = source.queuedSamples / 48;
    histogram[Math.ceil(queueMs)]++;
    peakMs = Math.max(peakMs, queueMs);
    if (block < 30_000) firstFiveMinutes += queueMs;
    if (block >= blocks - 30_000) lastFiveMinutes += queueMs;
    source.fill(target);
  }
  let count = 0, p95Ms = 0;
  for (let bin = 0; bin < histogram.length; bin++) {
    count += histogram[bin];
    if (count >= blocks * 0.95) { p95Ms = bin; break; }
  }
  t.diagnostic(JSON.stringify({ ppm, p95Ms, peakMs, droppedSamples: source.droppedSamples, underruns: source.timing!.underruns, compressedSamples: source.compressedFrames }));
  assert.equal(source.droppedSamples, 0);
  assert.ok(p95Ms <= 80, `queue p95 ${p95Ms}ms exceeds the requested 80ms budget`);
  assert.ok(lastFiveMinutes / 30_000 <= firstFiveMinutes / 30_000 + 10, "queue must not accumulate across the session");
});

test("variable compression is bounded, endpoint-preserving and remains latched down to the target", () => {
  let now = 0, written = 0, read = 0, previousEnd: number | null = null;
  const source = new DiscordPcmSource(5760, 48000, 480, () => now), target = new Float32Array(480);
  const packet = Buffer.alloc(1920), seen = new Set<number>();
  const sample = (index: number) => Math.round(Math.sin(index * Math.PI / 60) * 8192) / 32768 || 0;
  const push = () => {
    for (let i = 0; i < 960; i++) packet.writeInt16LE(Math.round(sample(written++) * 32768), i * 2);
    source.pushInt16Le(packet);
  };
  for (let i = 0; i < 5; i++) push();
  let started = false, stopped = false;
  for (let block = 0; block < 4000; block++) {
    now = block * 10;
    if (block && block % 2 === 0) push();
    const queueBefore = source.queuedSamples, before = source.compressedFrames;
    const expanded = source.expandedFrames;
    source.fill(target);
    const adjustment = source.compressedFrames - before;
    assert.ok(adjustment >= 0 && adjustment <= 5);
    if (adjustment) {
      assert.equal(stopped, false, "one recovery episode must not chatter on/off");
      started = true; seen.add(adjustment);
    } else if (started && !stopped) {
      stopped = true;
      assert.ok(queueBefore <= 1920, "compression stops on reaching the 40ms target");
    }
    const consumed = 480 + adjustment - (source.expandedFrames - expanded);
    assert.equal(target[0], sample(read));
    assert.equal(target[479], sample(read + consumed - 1));
    if (previousEnd !== null) assert.ok(Math.abs(target[0] - previousEnd) < 0.014, "no splice at block boundaries");
    for (let i = 1; i < 480; i++) assert.ok(Math.abs(target[i] - target[i - 1]) < 0.014, "interpolation never creates a new impulse");
    previousEnd = target[479]; read += consumed;
  }
  assert.ok(started && stopped);
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5]);
  assert.equal(source.timing!.silenceBlocksDropped, 0);
  assert.equal(source.timing!.compressedSamples, source.compressedFrames);
  assert.equal(source.droppedSamples, 0);
});

test("quiet trimming respects the RMS threshold and does not splice a voiced attack", () => {
  class QuietProbe extends PcmRingSource { cut() { return this.discardQuietBlock(480, 1e-5); } }
  const ring = new QuietProbe(5760), data = Buffer.alloc(1920), target = new Float32Array(480);
  for (let i = 0; i < 960; i++) data.writeInt16LE(32, i * 2); // about -60dBFS
  ring.pushInt16Le(data); assert.equal(ring.cut(), true); ring.fill(target);
  assert.ok(target.every(value => value === 32 / 32768));
  ring.clear();
  for (let i = 0; i < 960; i++) data.writeInt16LE(128, i * 2); // about -48dBFS
  ring.pushInt16Le(data); assert.equal(ring.cut(), false);
  ring.clear(); data.fill(0); data.writeInt16LE(8192, 480 * 2);
  ring.pushInt16Le(data); assert.equal(ring.cut(), false, "quiet-to-voiced seam must use interpolation instead");
  assert.equal(ring.droppedSamples, 0);
});

test("transient high water does not trigger correction, and capture/compensation allocates no per-block buffers", t => {
  let now = 0;
  const source = new DiscordPcmSource(5760, 48000, 480, () => now), target = new Float32Array(480);
  const quiet = Buffer.alloc(1920);
  for (const name of ["from", "alloc", "allocUnsafe"] as const) t.mock.method(Buffer, name, () => { throw new Error("per-block Buffer allocation"); });
  t.mock.method(Float32Array.prototype, "subarray", () => { throw new Error("per-block typed-array view allocation"); });
  for (let i = 0; i < 5; i++) source.pushInt16Le(pcm);
  for (let block = 0; block < 20; block++) { now = block * 10; source.fill(target); }
  assert.equal(source.compressedFrames, 0);
  assert.equal(source.timing!.silenceBlocksDropped, 0);
  for (let block = 20; block < 200; block++) {
    now = block * 10;
    if (block === 20) for (let i = 0; i < 5; i++) source.pushInt16Le(pcm);
    else if (block % 2 === 0) source.pushInt16Le(block < 100 ? pcm : quiet);
    source.fill(target);
  }
  assert.ok(source.compressedFrames > 0 && source.timing!.silenceBlocksDropped > 0);
});

test("RX uses a 40ms target and starts/restarts after 30ms prefill without stretching a speech tail", () => {
  let now = 0;
  const source = new DiscordPcmSource(5760, 48000, 480, () => now), target = new Float32Array(480);
  assert.equal(source.playoutSnapshot().targetMs, 40);
  source.pushInt16Le(pcm);
  assert.equal(source.fill(target), false);
  now = 20; source.pushInt16Le(pcm);
  assert.equal(source.fill(target), true);
  for (let i = 0; i < 3; i++) { now += 10; assert.equal(source.fill(target), true); }
  now += 10; assert.equal(source.fill(target), false);
  now += 10; source.pushInt16Le(pcm); assert.equal(source.fill(target), false);
  now += 20; source.pushInt16Le(pcm); assert.equal(source.fill(target), true);
  for (let i = 0; i < 3; i++) { now += 10; assert.equal(source.fill(target), true); }
  for (let i = 0; i < 30; i++) { now += 10; assert.equal(source.fill(target), false); assert.ok(target.every(value => value === 0)); }
  assert.equal(source.expandedFrames, 0, "never synthesize extra tail samples");
});

test("RX sustained excess queue waits 200ms, cuts only quiet audio and returns toward 40ms", () => {
  let now = 0;
  const source = new DiscordPcmSource(5760, 48000, 480, () => now), target = new Float32Array(480);
  const quiet = Buffer.alloc(1920);
  for (let i = 0; i < 5; i++) source.pushInt16Le(quiet);
  for (let block = 0; block < 20; block++) {
    now = block * 10;
    if (block && block % 2 === 0) source.pushInt16Le(quiet);
    source.fill(target);
    assert.equal(source.timing!.silenceBlocksDropped, 0);
  }
  now = 200; source.pushInt16Le(quiet); source.fill(target);
  assert.equal(source.timing!.silenceBlocksDropped, 1);
  for (let block = 21; block < 50; block++) {
    now = block * 10; if (block % 2 === 0) source.pushInt16Le(quiet); source.fill(target);
  }
  assert.ok(source.queuedSamples <= 1920);
  assert.ok(source.timing!.silenceBlocksDropped >= 5);
  assert.equal(source.droppedSamples, 0, "latency cuts are not hard-cap overflow");
  assert.equal(source.timing!.snapshot().queueWindows[0].samples, 50, "quiet cuts record exactly one waterline per graph block");
});

test("Discord playout absorbs packet jitter and independent +/-200ppm clocks for an hour at the same hard cap", () => {
  for (const ppm of [-200, 200]) {
    let now = 0, nextPacket = 0, low = Infinity, high = 0;
    const source = new DiscordPcmSource(5760, 48000, 480, () => now), target = new Float32Array(480);
    for (let block = 0; block < 360_000; block++) {
      now = block * 10;
      // A repeatable 0/10/20ms transport delay, with in-order burst delivery.
      const delay = block % 100 < 10 ? 20 : block % 100 < 30 ? 10 : 0;
      while (nextPacket + delay <= now) { source.pushInt16Le(pcm, now); nextPacket += 20 / (1 + ppm / 1e6); }
      const received = source.fill(target);
      if (block > 10) {
        assert.equal(received, true);
        assert.equal(target[0], 0.25); assert.equal(target[479], 0.25);
        low = Math.min(low, source.queuedSamples); high = Math.max(high, source.queuedSamples);
      }
    }
    assert.equal(source.droppedSamples, 0);
    assert.equal(source.timing!.underruns, 0);
    assert.ok(high < 5760 && low >= 0);
    assert.ok(source.compressedFrames + source.expandedFrames > 0);
  }
});

test("short talkspurt drains after 30ms, silence cannot replay old samples, clear resets playout", () => {
  let now = 0;
  const source = new DiscordPcmSource(5760, 48000, 480, () => now), target = new Float32Array(480);
  source.pushInt16Le(pcm);
  assert.equal(source.fill(target), false);
  assert.equal(source.timing!.underruns, 0, "intentional prebuffering is not an underrun");
  now = 30; assert.equal(source.fill(target), true); assert.equal(target[0], .25);
  now = 40; source.fill(target);
  now = 300; source.fill(target); assert.ok(target.every(sample => sample === 0));
  source.pushInt16Le(pcm); source.clear();
  assert.equal(source.queuedSamples, 0); source.fill(target); assert.ok(target.every(sample => sample === 0));
  assert.equal(source.playoutSnapshot().backlogEwmaMs, 40);
});

test("sender-clock correction stops when a talkspurt ends and stale queued speech expires without another packet", () => {
  let now = 0, nextPacket = 0;
  const source = new DiscordPcmSource(5760, 48000, 480, () => now), target = new Float32Array(480);
  for (let block = 0; block < 30_000; block++) {
    now = block * 10;
    while (nextPacket <= now) { source.pushInt16Le(pcm, now); nextPacket += 20 / (1 - 200 / 1e6); }
    source.fill(target);
  }
  assert.ok(source.expandedFrames > 0);
  const expanded = source.expandedFrames, tailBlocks = Math.ceil(source.queuedSamples / 480);
  for (let block = 0; block < tailBlocks; block++) { now += 10; assert.equal(source.fill(target), true); }
  for (let block = 0; block < 50; block++) { now += 10; assert.equal(source.fill(target), false); assert.ok(target.every(sample => sample === 0)); }
  assert.equal(source.expandedFrames, expanded, "stopping packets cannot create more tail samples");
  source.pushInt16Le(pcm); now += 250;
  assert.equal(source.fill(target), false);
  assert.ok(target.every(sample => sample === 0));
  assert.equal(source.queuedSamples, 0);
  assert.equal(source.staleDiscardedSamples, 960);
  source.pushInt16Le(pcm); assert.equal(source.fill(target), false, "next talkspurt prefills afresh");
});

test("uncorrected RX samples remain exact, physical input ring keeps immediate PCM behavior", () => {
  let now = 0;
  const source = new DiscordPcmSource(5760, 48000, 480, () => now), target = new Float32Array(480);
  const ramp = Buffer.alloc(960 * 2); for (let i = 0; i < 960; i++) ramp.writeInt16LE(i, 2 * i);
  source.pushInt16Le(ramp); now = 20; source.pushInt16Le(ramp); now = 40; source.pushInt16Le(ramp); source.fill(target);
  for (let i = 0; i < 480; i++) assert.equal(target[i], i / 32768);
  assert.equal(source.compressedFrames + source.expandedFrames, 0);
  const input = new PcmRingSource(5760); input.pushInt16Le(ramp); input.fill(target);
  for (let i = 0; i < 480; i++) assert.equal(target[i], i / 32768);
});

test("long stalls discard stale speech and burst overflow retains the original bounded queue", () => {
  let now = 0;
  const source = new DiscordPcmSource(5760, 48000, 480, () => now), target = new Float32Array(480);
  source.pushInt16Le(pcm); now = 250;
  const quiet = Buffer.alloc(1920); source.pushInt16Le(quiet);
  assert.equal(source.staleDiscardedSamples, 960);
  now = 290; source.fill(target); assert.ok(target.every(sample => sample === 0));
  for (let i = 0; i < 12; i++) source.pushInt16Le(pcm);
  assert.equal(source.queuedSamples, 5760); assert.ok(source.droppedSamples > 0);
  for (let i = 0; i < 20; i++) { now += 10; source.fill(target); }
  assert.ok(target.every(sample => sample === 0));
  assert.equal(source.queuedSamples, 0);
});

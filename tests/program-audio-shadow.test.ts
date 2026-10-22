import assert from "node:assert/strict";
import test from "node:test";
import { PROGRAM_AUDIO_FRAMES } from "../packages/program-audio-ipc/src/index.ts";
import { ProgramAudioShadow } from "../services/router-core-sim/src/program-audio-shadow.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for Program Audio shadow state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function nodeShadowArgs(): string[] {
  const moduleUrl = new URL("../packages/program-audio-ipc/src/index.ts", import.meta.url).href;
  const script = "const m=await import(process.argv[1]);const d=new m.ProgramAudioFrameDecoder();process.stdin.on('data',c=>{for(const f of d.push(c))console.log(JSON.stringify(m.projectProgramAudioFrame(f)))});process.stdin.on('end',()=>d.finish())";
  return ["--input-type=module", "--eval", script, moduleUrl];
}

test("Program Audio shadow uses a bounded preallocated handoff and compares copied PCM", async (t) => {
  const drains: Array<() => void> = [];
  const shadow = new ProgramAudioShadow({
    enabled: true,
    channels: 64,
    command: process.execPath,
    args: nodeShadowArgs(),
    maxBufferedFrames: 2,
    scheduleDrain: (callback) => { drains.push(callback); },
  });
  t.after(() => shadow.close());
  shadow.start();
  await waitFor(() => shadow.snapshot().status === "READY");

  const planar = Array.from({ length: 64 }, (_, channel) => new Float32Array(PROGRAM_AUDIO_FRAMES).fill(channel === 0 ? 0.25 : -0.125));
  shadow.capture(planar);
  shadow.capture(planar);
  shadow.capture(planar);
  planar[0].fill(1);

  assert.deepEqual(shadow.snapshot(), {
    enabled: true, status: "READY", capturedFrames: 3, mirroredFrames: 0, comparedFrames: 0,
    matchedFrames: 0, mismatchFrames: 0, droppedFrames: 1, pendingFrames: 0,
    bufferedFrames: 2, unexpectedFrames: 0, processErrors: 0, peak: 0,
    lastMismatch: null, lastError: null,
  });
  drains.shift()?.();
  await waitFor(() => {
    drains.shift()?.();
    return shadow.snapshot().comparedFrames === 2;
  });

  const snapshot = shadow.snapshot();
  assert.equal(snapshot.matchedFrames, 2);
  assert.equal(snapshot.mismatchFrames, 0);
  assert.equal(snapshot.bufferedFrames, 0);
  assert.equal(snapshot.pendingFrames, 0);
  assert.equal(snapshot.peak, 0.25, "the preallocated copy is independent of later graph mutation");
});

test("Program Audio shadow failure never throws into the production audio path", async (t) => {
  const shadow = new ProgramAudioShadow({ enabled: true, channels: 1, command: `${process.execPath}.missing` });
  t.after(() => shadow.close());
  shadow.start();
  assert.doesNotThrow(() => shadow.capture([new Float32Array(PROGRAM_AUDIO_FRAMES)]));
  await waitFor(() => shadow.snapshot().status === "FAULT");
  assert.equal(shadow.snapshot().processErrors, 1);
});

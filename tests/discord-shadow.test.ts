import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DiscordFrameType } from "../packages/discord-ipc/src/index.ts";
import { DiscordShadowComparator, projectDiscordFrame } from "../services/router-core-sim/src/discord-shadow.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for Discord shadow state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("Discord shadow pending comparisons stay bounded and drop only shadow frames", async (t) => {
  const shadow = new DiscordShadowComparator({
    enabled: true,
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    maxPendingFrames: 4,
  });
  t.after(() => shadow.close());
  shadow.start();
  await waitFor(() => shadow.snapshot().status === "READY");

  for (let sequence = 0; sequence < 10; sequence += 1) {
    shadow.mirror({ type: DiscordFrameType.PING, sequence, payload: Buffer.from("metadata") });
  }
  shadow.mirror({ type: DiscordFrameType.OPUS, payload: Buffer.from("audio-is-not-shadowed") });

  const snapshot = shadow.snapshot();
  assert.equal(snapshot.mirroredFrames, 4);
  assert.equal(snapshot.pendingFrames, 4);
  assert.equal(snapshot.droppedFrames, 6);
  assert.equal(snapshot.processErrors, 0);
});

test("Discord shadow process failure does not throw into the TypeScript reference path", async (t) => {
  const missingBinary = join(tmpdir(), `dbr-missing-shadow-${process.pid}-${Date.now()}.exe`);
  const shadow = new DiscordShadowComparator({ enabled: true, command: missingBinary });
  t.after(() => shadow.close());
  shadow.start();
  shadow.mirror({ type: DiscordFrameType.PING, payload: Buffer.from("metadata") });
  await waitFor(() => shadow.snapshot().status === "FAULT");

  const snapshot = shadow.snapshot();
  assert.equal(snapshot.processErrors, 1);
  assert.equal(snapshot.mismatchFrames, 0);
  assert.ok(snapshot.lastError);
});

test("Discord shadow child receives no Bot token or unrelated parent environment", async (t) => {
  const frame = { type: DiscordFrameType.PING, payload: Buffer.from("metadata") } as const;
  const expected = projectDiscordFrame(frame);
  const script = "const expected=JSON.parse(process.argv[1]);process.stdin.once('data',()=>{if(process.env.DBR_SHADOW_TEST_SECRET)expected.payloadHash='leaked';console.log(JSON.stringify(expected))});setInterval(()=>{},1000)";
  const previous = process.env.DBR_SHADOW_TEST_SECRET;
  process.env.DBR_SHADOW_TEST_SECRET = "must-not-cross-process-boundary";
  const shadow = new DiscordShadowComparator({
    enabled: true,
    command: process.execPath,
    args: ["-e", script, JSON.stringify(expected)],
  });
  t.after(() => shadow.close());
  try {
    shadow.start();
  } finally {
    if (previous === undefined) delete process.env.DBR_SHADOW_TEST_SECRET;
    else process.env.DBR_SHADOW_TEST_SECRET = previous;
  }
  await waitFor(() => shadow.snapshot().status === "READY");
  shadow.mirror(frame);
  await waitFor(() => shadow.snapshot().comparedFrames === 1);

  const snapshot = shadow.snapshot();
  assert.equal(snapshot.matchedFrames, 1);
  assert.equal(snapshot.mismatchFrames, 0);
  assert.equal(snapshot.processErrors, 0);
});

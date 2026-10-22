import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AudioEngine } from "../../services/router-core-sim/src/audio-engine.ts";
import { DiscordIngestServer } from "../../services/router-core-sim/src/discord-ingest.ts";
import { DiscordShadowComparator } from "../../services/router-core-sim/src/discord-shadow.ts";

interface Fixture {
  frames: Array<{ expected: { type: number } }>;
  streamChunks: string[];
}

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL("./fixtures/discord-ipc-v1.json", import.meta.url)),
  "utf8",
)) as Fixture;

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for Discord shadow comparison");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("live Discord IPC metadata is mirrored to Rust without taking production ownership", async (t) => {
  const endpoint = process.platform === "win32"
    ? String.raw`\\.\pipe\dbr-rust-shadow-${process.pid}-${Date.now()}`
    : join(tmpdir(), `dbr-rust-shadow-${process.pid}-${Date.now()}.sock`);
  const shadow = new DiscordShadowComparator({ enabled: true, maxPendingFrames: 32 });
  const ingest = new DiscordIngestServer(new AudioEngine(48_000, 480, 2), endpoint, shadow);
  await ingest.start();
  const socket = createConnection(endpoint);
  t.after(async () => {
    socket.destroy();
    await ingest.close();
  });
  await once(socket, "connect");

  for (const chunk of fixture.streamChunks) socket.write(Buffer.from(chunk, "hex"));
  await waitFor(() => (ingest.snapshot().shadow?.comparedFrames ?? 0) === fixture.frames.length);

  const snapshot = ingest.snapshot();
  assert.equal(snapshot.shadow?.status, "READY");
  assert.equal(snapshot.shadow?.mirroredFrames, fixture.frames.length);
  assert.equal(snapshot.shadow?.matchedFrames, fixture.frames.length);
  assert.equal(snapshot.shadow?.mismatchFrames, 0);
  assert.equal(snapshot.shadow?.droppedFrames, 0);
  assert.equal(snapshot.shadow?.pendingFrames, 0);
  assert.equal(snapshot.shadow?.processErrors, 0);
  assert.equal(snapshot.packets, 0, "fixture contains metadata only, so Rust never becomes the Opus owner");
  assert.ok(snapshot.bots.length >= 1, "TypeScript reference still ingests the mirrored metadata");
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { RecorderManager } from "../services/router-core-sim/src/recorder.ts";

test("Recorder settles failed or already closed streams and can restart while healthy tracks finalize", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dbr-recorder-io-error-"));
  const engine = AudioEngine.createDemo(1);
  const recorder = new RecorderManager(engine, root);
  const bounded = async (work: Promise<void>) => {
    let timer: NodeJS.Timeout;
    try { await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("recorder shutdown hung")), 1500); })]); }
    finally { clearTimeout(timer!); }
  };
  t.after(async () => { await bounded(recorder.close()).catch(() => {}); rmSync(root, { recursive: true, force: true }); });
  for (const mode of ["error", "close", "write-error"]) {
    recorder.start({ matrixOutput: 0, includeUsers: true, includeBuses: false });
    await Promise.all(recorder.tracks.map(track => once(track.writer.stream, "open")));
    await Promise.all(recorder.tracks.map(track => new Promise<void>((resolve, reject) => track.writer.stream.write(Buffer.alloc(0), error => error ? reject(error) : resolve()))));
    const failed = recorder.tracks[0].writer.stream;
    const closed = new Promise<void>(resolve => failed.once("close", resolve));
    if (mode === "write-error") {
      t.mock.method(failed, "_write", (_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) => {
        queueMicrotask(() => callback(new Error("injected write failure")));
      });
      engine.processBlock(); recorder.captureBlock();
    } else failed.destroy(mode === "error" ? new Error("injected disk failure") : undefined);
    await closed;
    if (mode === "close") recorder.stop();
    await bounded(recorder.waitForIdle());
    assert.equal(recorder.state, "FAULT");
    for (const track of recorder.tracks.slice(1)) {
      const wav = readFileSync(track.writer.path);
      assert.equal(wav.readUInt32LE(40), wav.length - 44);
      assert.equal(track.writer.stream.closed, true);
    }
  }
  recorder.start({ matrixOutput: 0, includeUsers: false, includeBuses: false });
  engine.processBlock(); recorder.captureBlock(); recorder.stop();
  await bounded(recorder.waitForIdle());
  assert.equal(recorder.state, "IDLE");
  const wav = readFileSync(recorder.tracks[0].writer.path);
  assert.equal(wav.readUInt32LE(40), engine.blockSize * 4);
  await bounded(recorder.close());
});

test("Recorder writes bounded 48 kHz float WAV tracks outside the audio engine", async () => {
  const root = mkdtempSync(join(tmpdir(), "dbr-recorder-"));
  const folder = join(root, "recordings");
  const engine = AudioEngine.createDemo(1);
  const recorder = new RecorderManager(engine, folder);
  try {
    recorder.start({ matrixOutput: 63, includeUsers: true, includeBuses: true });
    for (let block = 0; block < 10; block += 1) {
      engine.processBlock();
      recorder.captureBlock();
    }
    recorder.stop();
    await recorder.waitForIdle();

    const snapshot = recorder.snapshot();
    assert.equal(snapshot.state, "IDLE");
    assert.equal(snapshot.tracks.length, 3);
    assert.equal(snapshot.droppedBlocks, 0);
    const files = readdirSync(folder).filter((name) => name.endsWith(".wav"));
    assert.equal(files.length, 3);
    for (const file of files) {
      const wav = readFileSync(join(folder, file));
      assert.equal(wav.toString("ascii", 0, 4), "RIFF");
      assert.equal(wav.toString("ascii", 8, 12), "WAVE");
      assert.equal(wav.readUInt16LE(20), 3);
      assert.equal(wav.readUInt16LE(22), 1);
      assert.equal(wav.readUInt32LE(24), 48_000);
      assert.equal(wav.readUInt16LE(34), 32);
      assert.equal(wav.readUInt32LE(40), engine.blockSize * 4 * 10);
      assert.equal(wav.length, 44 + engine.blockSize * 4 * 10);
    }
    recorder.start({ matrixOutput: 0, includeUsers: false, includeBuses: false });
    engine.processBlock();
    recorder.captureBlock();
    recorder.stop();
    await recorder.waitForIdle();
    assert.equal(recorder.snapshot().state, "IDLE");
    assert.equal(recorder.snapshot().tracks.length, 1);
  } finally {
    await recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Recorder queue overflow faults recording without stopping audio processing", async () => {
  const root = mkdtempSync(join(tmpdir(), "dbr-recorder-slow-"));
  const engine = AudioEngine.createDemo(1);
  const recorder = new RecorderManager(engine, join(root, "recordings"), {
    maxQueuedBlocks: 10,
    scheduleDrain: (callback) => setTimeout(callback, 30),
  });
  try {
    recorder.start({ matrixOutput: 63, includeUsers: false, includeBuses: false });
    for (let block = 0; block < 11; block += 1) {
      engine.processBlock();
      recorder.captureBlock();
    }
    assert.equal(recorder.snapshot().state, "FAULT");
    assert.equal(recorder.snapshot().droppedBlocks, 1);
    const before = engine.blocksProcessed;
    engine.processBlock();
    assert.equal(engine.blocksProcessed, before + 1);
    await recorder.waitForIdle();
  } finally {
    await recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit recording selection writes only checked sources, rejects invalid targets before files, and stays fixed", async () => {
  const root = mkdtempSync(join(tmpdir(), "dbr-recorder-selection-"));
  const engine = AudioEngine.createDemo(2);
  const folder = join(root, "recordings");
  const recorder = new RecorderManager(engine, folder);
  const control = new ControlPlane(engine, undefined, undefined, undefined, recorder);
  const command = { type: "START_RECORDING" as const, matrixOutput: 0, includeUsers: false, includeBuses: false, confirmed: true };
  try {
    const invalid = [
      null, {}, { outputs: ["0"], busIds: [], channelIds: [] },
      { outputs: new Array(1), busIds: [], channelIds: [] },
      { outputs: [0, 0], busIds: [], channelIds: [] },
      { outputs: [64], busIds: [], channelIds: [] },
      { outputs: [], busIds: [], channelIds: [] },
      { outputs: [0], busIds: ["missing"], channelIds: [] },
      { outputs: [0], busIds: [], channelIds: ["missing"] },
      { outputs: [], busIds: [], channelIds: ["user-01", "user-01"] },
      { outputs: [], busIds: [], channelIds: Array.from({ length: 81 }, (_, index) => `user-${index}`) },
    ];
    for (const selection of invalid) {
      assert.equal(control.execute({ ...command, selection } as never).ok, false);
      assert.equal(recorder.state, "IDLE");
      assert.equal(recorder.tracks.length, 0);
    }
    assert.deepEqual(readdirSync(root), [], "bad selections never create a recording folder");
    const selection = { outputs: [0, 63], busIds: ["interview"], channelIds: ["user-01"] };
    assert.equal(control.execute({ ...command, selection, confirmed: false }).confirmationRequired, true);
    assert.equal(control.execute({ ...command, selection }).ok, true);
    selection.channelIds.push("user-02");
    assert.deepEqual(recorder.snapshot().selection?.channelIds, ["user-01"], "caller mutation cannot broaden the session");
    engine.addChannel(AudioEngine.createDemo(3).channels.get("user-03")!);
    engine.buses.get("interview")!.mute = true;
    engine.buses.get("interview")!.masterDb = -60;
    engine.channels.get("user-01")!.mute = true;
    engine.channels.get("user-01")!.faderDb = -60;
    engine.processBlock();
    recorder.captureBlock();
    assert.equal(recorder.snapshot().tracks.length, 4, "later channels are not added");
    assert.deepEqual(recorder.snapshot().tracks.map((track) => track.sourceId), ["matrix-1", "matrix-64", "interview", "user-01"]);
    assert.ok(engine.buses.get("interview")!.buffer.every((sample) => sample === 0), "muted VC MIX is silent after its master");
    assert.ok(engine.channels.get("user-01")!.post.every((sample) => sample === 0), "muted User is silent after its fader");
    const expected = [engine.outputs[0], engine.outputs[63], engine.buses.get("interview")!.preMaster, engine.channels.get("user-01")!.processed].map((samples) => Buffer.from(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength)));
    assert.ok(expected[2].some((byte) => byte !== 0), "VC MIX recording remains active before master mute");
    assert.ok(expected[3].some((byte) => byte !== 0), "User recording remains active before channel mute");
    recorder.stop();
    await recorder.waitForIdle();
    for (const [index, track] of recorder.snapshot().tracks.entries()) {
      const wav = readFileSync(join(folder, track.fileName));
      assert.equal(wav.readUInt16LE(22), 1, "each selected channel is a mono WAV");
      assert.deepEqual(wav.subarray(44), expected[index]);
    }
    assert.equal(control.execute({ ...command, selection: { outputs: [], busIds: [], channelIds: ["user-02"] } }).ok, true);
    assert.deepEqual(recorder.snapshot().tracks.map((track) => track.sourceId), ["user-02"], "User-only recording has no mandatory Main track");
    engine.processBlock();
    recorder.captureBlock();
    recorder.stop();
    await recorder.waitForIdle();
    assert.equal(control.snapshot().state, "SETUP", "recording does not change the application state");
  } finally {
    await recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Recorder control requires confirmation and folder failure remains recorder-local", async () => {
  const root = mkdtempSync(join(tmpdir(), "dbr-recorder-fault-"));
  const unavailable = join(root, "not-a-folder");
  writeFileSync(unavailable, "occupied");
  const engine = AudioEngine.createDemo(1);
  const recorder = new RecorderManager(engine, unavailable);
  const control = new ControlPlane(engine, undefined, undefined, undefined, recorder);
  try {
    const confirmation = control.execute({ type: "START_RECORDING", matrixOutput: 63, includeUsers: false, includeBuses: false });
    assert.equal(confirmation.confirmationRequired, true);
    const failed = control.execute({ type: "START_RECORDING", matrixOutput: 63, includeUsers: false, includeBuses: false, confirmed: true });
    assert.equal(failed.ok, false);
    assert.equal(recorder.snapshot().state, "FAULT");
    assert.equal(control.snapshot().state, "SETUP");
  } finally {
    await recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Emergency Mute discards queued recorder PCM and captures silence until explicit release", async () => {
  const root = mkdtempSync(join(tmpdir(), "dbr-recorder-emergency-"));
  const engine = AudioEngine.createDemo(1);
  const scheduled: Array<() => void> = [];
  const recorder = new RecorderManager(engine, join(root, "recordings"), { scheduleDrain: (callback) => scheduled.push(callback) });
  const control = new ControlPlane(engine, undefined, undefined, undefined, recorder);
  try {
    recorder.start({ matrixOutput: 63, includeUsers: false, includeBuses: false });
    engine.processBlock();
    recorder.captureBlock();
    assert.equal(recorder.queue.length, 1);
    assert.ok(recorder.queue[0].buffers[0].some((byte) => byte !== 0));

    assert.equal(control.execute({ type: "EMERGENCY_MUTE", active: true }).ok, true);
    assert.equal(recorder.queue.length, 0, "pre-emergency queued recorder PCM is discarded");
    recorder.captureBlock();
    assert.equal(recorder.queue.length, 1);
    assert.ok(recorder.queue[0].buffers[0].every((byte) => byte === 0), "even a capture before the next engine tick is silence");

    recorder.stop();
    while (scheduled.length) scheduled.shift()!();
    await recorder.waitForIdle();
  } finally {
    await recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

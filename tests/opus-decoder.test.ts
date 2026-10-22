import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import OpusScript from "opusscript";
import { nativePacketBuffer, OPUS_FRAME_SAMPLES, openNativeOpusDecoderGate } from "../services/router-core-sim/src/opus-decoder.ts";

const fixture = JSON.parse(readFileSync(new URL("./core-ipc/fixtures/opus-48k-mono-20ms.json", import.meta.url), "utf8")) as {
  payloadHex: string; nativeReferenceHash: string; opusscriptReferenceHash: string;
};

test("native Opus gate self-checks and decodes the checked-in 48 kHz mono fixture", () => {
  const gate = openNativeOpusDecoderGate();
  assert.equal(gate.state, "READY", gate.reason ?? "native decoder must be available in this test environment");
  const decoder = gate.factory!.create48kMono();
  const pcm = decoder.decode(Buffer.from(fixture.payloadHex, "hex"));
  assert.equal(pcm.length / 2, OPUS_FRAME_SAMPLES);
  for (let offset = 0; offset < pcm.length; offset += 2) assert.ok(Number.isFinite(pcm.readInt16LE(offset)));
  assert.equal(createHash("sha256").update(pcm).digest("hex"), fixture.nativeReferenceHash);
  decoder.dispose();
  decoder.dispose();
  assert.throws(() => decoder.decode(Buffer.from(fixture.payloadHex, "hex")));
});

test("opusscript remains an offline fixture encoder/decoder reference, not a production fallback", () => {
  const decoder = new OpusScript(48_000, 1, OpusScript.Application.VOIP);
  try {
    const pcm = decoder.decode(Buffer.from(fixture.payloadHex, "hex"));
    assert.equal(pcm.length / 2, OPUS_FRAME_SAMPLES);
    assert.equal(createHash("sha256").update(pcm).digest("hex"), fixture.opusscriptReferenceHash);
  } finally {
    decoder.delete();
  }
});

test("native packet conversion keeps Buffer payloads zero-copy and preserves Uint8Array offsets", () => {
  const payload = Buffer.from(fixture.payloadHex, "hex");
  assert.strictEqual(nativePacketBuffer(payload), payload);
  const wrapped = Buffer.concat([Buffer.from([0, 1]), payload, Buffer.from([2])]);
  const view = new Uint8Array(wrapped.buffer, wrapped.byteOffset + 2, payload.length);
  const converted = nativePacketBuffer(view);
  assert.equal(converted.byteOffset, wrapped.byteOffset + 2);
  assert.deepEqual(converted, payload);
});

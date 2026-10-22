import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const lock = JSON.parse(readFileSync(resolve(import.meta.dirname, "../release/upstream-source-lock.json"), "utf8")) as {
  schemaVersion: number; sources: { url: string; sha256: string }[];
};
assert.equal(lock.schemaVersion, 1);
const hashes = new Map(lock.sources.map(source => {
  assert.match(source.sha256, /^[a-f0-9]{64}$/);
  assert.ok(source.url.startsWith("https://"));
  return [source.url, source.sha256];
}));

/** A cached download must satisfy the same reviewed digest as a new download. */
export function verifyPinnedSource(url: string, bytes: Uint8Array): void {
  const expected = hashes.get(url);
  assert.ok(expected, `Unreviewed source URL; review and update upstream-source-lock.json: ${url}`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, `Fixed source checksum mismatch: ${url}`);
}

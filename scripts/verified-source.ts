import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const DAVE_LOCK_SHA256 = "cf9bc6884056b8e20ee6835ac0ffca237f8b869d5ca14cddf25f548fa15ceb50";

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

/** Required derived sources must be present even if an inventory omitted them. */
export function verifyCollectedSources(root: string): void {
  const inventory = JSON.parse(readFileSync(join(root, "SOURCE_DOWNLOADS.json"), "utf8"));
  assert.equal(inventory.schemaVersion, 1, "Unsupported collected source inventory");
  assert.ok(Array.isArray(inventory.records), "Missing collected source records");
  const supplemental = JSON.parse(readFileSync(join(root, "SUPPLEMENTAL_NOTICES.json"), "utf8"));
  assert.ok(Array.isArray(supplemental), "Missing supplemental source records");
  const required = inventory.records.filter((record: { path?: unknown }) => record.path === "davey/Cargo.lock");
  assert.equal(required.length, 1, "Missing collected source record: davey/Cargo.lock");
  assert.equal(required[0].sha256, DAVE_LOCK_SHA256, "Unreviewed collected source hash: davey/Cargo.lock");
  for (const record of [...inventory.records, ...supplemental]) {
    assert.ok(typeof record.path === "string" && /^[A-Za-z0-9_@.+/-]+$/.test(record.path)
      && !record.path.startsWith("/") && !record.path.split("/").some((part: string) => !part || part === "." || part === ".."), "Invalid collected source path");
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
    const file = join(root, record.path);
    assert.ok(existsSync(file), `Missing collected source: ${record.path}`);
    assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), record.sha256, `Source changed after verification: ${record.path}`);
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overlayJavaScriptUpdates } from "../scripts/release-js-overlays.ts";

function fixture(t: any, native = false) {
  const root = mkdtempSync(join(tmpdir(), "parabus-js-overlay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, "app"), sources = join(root, "sources"), input = join(root, "input");
  for (const p of [join(app, "node_modules/undici"), join(sources, "npm"), join(input, "package")]) mkdirSync(p, { recursive: true });
  writeFileSync(join(app, "node_modules/undici/package.json"), JSON.stringify({ name: "undici", version: "6.29.0" }));
  writeFileSync(join(input, "package/package.json"), JSON.stringify({ name: "undici", version: "6.29.1" }));
  writeFileSync(join(input, native ? "package/unsafe.node" : "package/index.js"), "test fixture");
  const archive = join(sources, "npm/undici-6.29.1.tgz");
  execFileSync("tar", ["-czf", archive, "-C", input, "package"]);
  const integrity = "sha512-" + createHash("sha512").update(readFileSync(archive)).digest("base64");
  const lock = { packages: { "node_modules/undici": { version: "6.29.1", integrity } } };
  return { app, sources, archive, lock };
}

test("reviewed JS overlay replaces the old package and retains package notices/files", t => {
  const f = fixture(t);
  assert.deepEqual(overlayJavaScriptUpdates(f.app, f.sources, f.lock), ["undici@6.29.1"]);
  assert.equal(JSON.parse(readFileSync(join(f.app, "node_modules/undici/package.json"), "utf8")).version, "6.29.1");
  assert.equal(readFileSync(join(f.app, "node_modules/undici/index.js"), "utf8"), "test fixture");
});

test("changed archives and native files are rejected before replacing dependencies", t => {
  const f = fixture(t);
  writeFileSync(f.archive, "corrupted");
  assert.throws(() => overlayJavaScriptUpdates(f.app, f.sources, f.lock), /Changed package archive/);
  assert.equal(JSON.parse(readFileSync(join(f.app, "node_modules/undici/package.json"), "utf8")).version, "6.29.0");
  const n = fixture(t, true);
  assert.throws(() => overlayJavaScriptUpdates(n.app, n.sources, n.lock), /Native code in JavaScript overlay/);
});

test("unreviewed package versions cannot bypass native reuse review", t => {
  const f = fixture(t); f.lock.packages["node_modules/undici"].version = "7.0.0";
  assert.throws(() => overlayJavaScriptUpdates(f.app, f.sources, f.lock), /Unreviewed runtime package update/);
});

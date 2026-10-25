import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { verifyNativeInputs, verifyArtifactSourceInputs, assertNativeReuseCompatibility } from "../scripts/native-inputs.ts";
import { execFileSync } from "node:child_process";
import { collectSources } from "../scripts/collect-corresponding-source.ts";

test("native reuse verifies source bytes without looking up legacy Git commits", () => {
  const repo = resolve(import.meta.dirname, "..");
  const verified = verifyNativeInputs(repo);
  assert.ok(verified.binaries.every(input => !input.path.startsWith("runtime/")), "Node has its own version/source validation, independent of old native artifacts");
  const changed = verified.sourceInputs[0].path;
  assert.throws(() => verifyNativeInputs(repo, path => {
    const bytes = readFileSync(join(repo, path));
    return path === changed ? Buffer.concat([bytes, Buffer.from("\n// changed input")]) : bytes;
  }), /Native input changed/);
});

test("a corrupted cached fixed-commit archive is rejected before extraction or fetching dependencies", async t => {
  const directory = mkdtempSync(join(tmpdir(), "parabus-source-cache-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "davey"));
  writeFileSync(join(directory, "davey/davey-js-0.1.12.tar.gz"), "not the reviewed source archive");
  await assert.rejects(collectSources(resolve(import.meta.dirname, ".."), directory, directory), /Fixed source checksum mismatch/);
});

test("original native sources and manifests remain independently pinned after JS updates", () => {
  const repo = resolve(import.meta.dirname, "..");
  const lock = verifyNativeInputs(repo);
  assert.ok(lock.artifactSourceCommit);
  const original = (path: string) => execFileSync("git", ["show", `${lock.artifactSourceCommit}:${path}`], { cwd: repo });
  verifyArtifactSourceInputs(lock, original);
  assert.throws(() => verifyArtifactSourceInputs(lock, path => path === "scripts/build-windows-asio.ps1" ? Buffer.from("changed") : original(path)), /Original native source changed/);
  assert.throws(() => verifyArtifactSourceInputs(lock, path => path === "package-lock.json" ? Buffer.from('{"packages":{"":{}}}') : original(path)), /Original dependency manifest changed/);
  const retaken = structuredClone(lock);
  retaken.artifactSourceInputs![0].sha256 = "0".repeat(64); retaken.sourceInputs[0].sha256 = "0".repeat(64);
  assert.throws(() => verifyArtifactSourceInputs(retaken, original), /Original native source inventory changed/);
});

test("retaking current hashes cannot authorize changes to Rust or launcher inputs", () => {
  const lock = verifyNativeInputs(resolve(import.meta.dirname, ".."));
  for (const input of lock.sourceInputs) {
    const changed = structuredClone(lock);
    changed.sourceInputs.find(p => p.path === input.path)!.sha256 = "0".repeat(64);
    assert.throws(() => assertNativeReuseCompatibility(changed), /Native source differs from original artifact/, input.path);
  }
  const missing = structuredClone(lock); missing.sourceInputs.pop();
  assert.throws(() => assertNativeReuseCompatibility(missing), /input set changed/);
  const added = structuredClone(lock); added.sourceInputs.push({ path: "crates/new/src/lib.rs", sha256: "0".repeat(64) });
  assert.throws(() => assertNativeReuseCompatibility(added), /input set changed/);
});

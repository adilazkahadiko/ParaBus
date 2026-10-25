import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
export interface NativeInputLock {
  schemaVersion: number; artifactCommit: string; workflowRun: string;
  sourceInputs: { path: string; sha256: string }[];
  binaries: { path: string; sha256: string }[];
  dependencyManifests: { path: string; canonicalSha256: string }[];
  artifactSourceCommit?: string;
  artifactSourceInputs?: { path: string; sha256: string }[];
  artifactDependencyManifests?: { path: string; canonicalSha256: string }[];
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Updating current lock hashes must never silently authorize different native code. */
export function assertNativeReuseCompatibility(lock: NativeInputLock): void {
  if (!lock.artifactSourceInputs) return;
  const current = new Map(lock.sourceInputs.map(input => [input.path, input.sha256]));
  const original = new Map(lock.artifactSourceInputs.map(input => [input.path, input.sha256]));
  assert.equal(current.size, lock.sourceInputs.length, "Duplicate current native input");
  assert.equal(original.size, lock.artifactSourceInputs.length, "Duplicate original native input");
  assert.deepEqual([...current.keys()].sort(), [...original.keys()].sort(), "Native source input set changed; rebuild and review provenance");
  // This one reviewed change only moves README generation; compiled inputs stay fixed.
  const documentationOnly = { path: "scripts/build-windows-asio.ps1", before: "ef435d823669e48b2e2f8ba22a32df0c7baeeb8e7e0e0bc8852a9c3de8746bd8", after: "6c6723a8c1a6673f96c3d6dd28c89b096d853f7f4b830c5553e8d97954f9df80" };
  for (const [path, checksum] of original) {
    if (path === documentationOnly.path && checksum === documentationOnly.before && current.get(path) === documentationOnly.after) continue;
    assert.equal(current.get(path), checksum, `Native source differs from original artifact; rebuild and review provenance: ${path}`);
  }
}

export function verifyNativeInputs(repo: string, readSource = (path: string) => readFileSync(join(repo, path))): NativeInputLock {
  const lock = JSON.parse(readFileSync(join(repo, "release/native-input-lock.json"), "utf8")) as NativeInputLock;
  assert.equal(lock.schemaVersion, 1);
  assertNativeReuseCompatibility(lock);
  for (const input of lock.sourceInputs) {
    // Git attributes may check out Windows scripts as CRLF; original Git blobs are LF.
    const bytes = Buffer.from(readSource(input.path).toString("utf8").replaceAll("\r\n", "\n"));
    assert.equal(hash(bytes), input.sha256, `Native input changed; rebuild and review provenance: ${input.path}`);
  }
  for (const input of lock.dependencyManifests) {
    const value = JSON.parse(readSource(input.path).toString("utf8"));
    if (input.path === "package.json") delete value.engines;
    else delete value.packages[""].engines;
    assert.equal(hash(Buffer.from(JSON.stringify(value))), input.canonicalSha256, `Dependency change requires a native review: ${input.path}`);
  }
  return lock;
}

/** Keep the original native build sources separate from reviewed later app changes. */
export function verifyArtifactSourceInputs(lock: NativeInputLock, readSource: (path: string) => Buffer): void {
  if (lock.artifactSourceCommit) {
    const anchor = JSON.parse(readSource("release/native-input-lock.json").toString("utf8")) as NativeInputLock;
    assert.deepEqual(lock.artifactSourceInputs, anchor.sourceInputs, "Original native source inventory changed");
    assert.deepEqual(lock.artifactDependencyManifests, anchor.dependencyManifests, "Original native manifest inventory changed");
    assert.deepEqual(lock.binaries, anchor.binaries, "Original native binary inventory changed");
  }
  for (const input of lock.artifactSourceInputs ?? lock.sourceInputs) {
    assert.equal(hash(Buffer.from(readSource(input.path).toString("utf8").replaceAll("\r\n", "\n"))), input.sha256, `Original native source changed: ${input.path}`);
  }
  for (const input of lock.artifactDependencyManifests ?? lock.dependencyManifests) {
    const value = JSON.parse(readSource(input.path).toString("utf8"));
    if (input.path === "package.json") delete value.engines;
    else delete value.packages[""].engines;
    assert.equal(hash(Buffer.from(JSON.stringify(value))), input.canonicalSha256, `Original dependency manifest changed: ${input.path}`);
  }
}

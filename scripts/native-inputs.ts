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
export function verifyNativeInputs(repo: string, readSource = (path: string) => readFileSync(join(repo, path))): NativeInputLock {
  const lock = JSON.parse(readFileSync(join(repo, "release/native-input-lock.json"), "utf8")) as NativeInputLock;
  assert.equal(lock.schemaVersion, 1);
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

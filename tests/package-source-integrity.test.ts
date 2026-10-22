import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { verifyNativeInputs } from "../scripts/native-inputs.ts";
import { collectSources } from "../scripts/collect-corresponding-source.ts";

test("native reuse verifies source bytes without looking up legacy Git commits", () => {
  const repo = resolve(import.meta.dirname, "..");
  const verified = verifyNativeInputs(repo);
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

// Run against a fresh packaging directory, never an in-use application folder.
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { omitNaudiodonCrashHandler, patchNaudiodonSource } from "./patch-naudiodon.ts";

export function omitCrashDiagnostics(root: string): void {
  const directory = realpathSync(root);
  const packagePath = join(directory, "node_modules/naudiodon2/package.json");
  if (!existsSync(packagePath)) return;
  assert.equal(JSON.parse(readFileSync(packagePath, "utf8")).version, "2.5.0");
  const index = join(directory, "node_modules/naudiodon2/index.js");
  writeFileSync(index, omitNaudiodonCrashHandler(patchNaudiodonSource(readFileSync(index, "utf8"))));
  const unused = join(directory, "node_modules/segfault-handler");
  if (existsSync(unused)) {
    assert.equal(realpathSync(unused).toLowerCase(), unused.toLowerCase(), "Refusing reparse point");
    rmSync(unused, { recursive: true });
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 3, "Usage: node scripts/omit-crash-diagnostics.ts <fresh-package-folder>");
  omitCrashDiagnostics(resolve(process.argv[2]));
}

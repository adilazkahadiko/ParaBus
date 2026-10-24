// Only reviewed JavaScript package updates may be overlaid on reused native inputs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export function overlayJavaScriptUpdates(app: string, sources: string, packageLock: any): string[] {
  const updated: string[] = [];
  const allowed = new Map([["node_modules/undici", "6.29.1"], ["node_modules/brace-expansion", "1.1.21"]]);
  for (const [path, entry] of Object.entries(packageLock.packages) as [string, any][]) {
    if (!path || !existsSync(join(app, path, "package.json"))) continue;
    const previous = JSON.parse(readFileSync(join(app, path, "package.json"), "utf8"));
    if (previous.version === entry.version) continue;
    assert.equal(allowed.get(path), entry.version, `Unreviewed runtime package update: ${path}`);
    const archive = join(sources, "npm", path.replaceAll("node_modules/", "").replaceAll("/", "__") + `-${entry.version}.tgz`);
    const [algorithm, expected] = entry.integrity.split("-");
    assert.equal(algorithm, "sha512");
    assert.equal(createHash(algorithm).update(readFileSync(archive)).digest("base64"), expected, `Changed package archive: ${path}`);
    const names = execFileSync("tar", ["-tf", archive], { encoding: "utf8" }).trim().split(/\r?\n/);
    for (const name of names) {
      assert.ok(name.startsWith("package/") && !name.includes("\\") && !name.split("/").includes(".."), `Unsafe archive path: ${path}`);
      assert.ok(!/\.(exe|dll|node|lib)$/i.test(name) && !name.endsWith("binding.gyp"), `Native code in JavaScript overlay: ${path}`);
    }
    const staging = mkdtempSync(join(resolve(app, ".."), "js-update-"));
    execFileSync("tar", ["-xf", archive, "-C", staging]);
    const next = JSON.parse(readFileSync(join(staging, "package/package.json"), "utf8"));
    assert.equal(next.name, previous.name); assert.equal(next.version, entry.version);
    for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) assert.deepEqual(next[key], previous[key], `Dependency graph changed: ${path}`);
    for (const hook of ["preinstall", "install", "postinstall"]) assert.ok(!next.scripts?.[hook], `Lifecycle script in overlay: ${path}`);
    const destination = resolve(app, path);
    assert.ok(destination.startsWith(resolve(app, "node_modules") + sep), "Overlay must stay inside staged dependencies");
    rmSync(destination, { recursive: true });
    cpSync(join(staging, "package"), destination, { recursive: true, errorOnExist: true });
    rmSync(staging, { recursive: true });
    updated.push(`${next.name}@${next.version}`);
  }
  return updated;
}

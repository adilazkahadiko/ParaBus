import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveTool } from "../scripts/archive-tool.ts";
import { auditRuntimeDependencies, overlayJavaScriptUpdates, prepareJavaScriptArchive, runtimePackagePaths, type PackageLock } from "../scripts/release-js-overlays.ts";
import { writeArchive } from "./archive-fixtures.ts";

const integrity = "sha512-EvRlUt/QqAEvXdQeRMYUfwOQsfzpDztykrG2owGEE/rBOBoYv9uF39ZzsNDh4lTFHhTr2XOZjKkYgueD12ZmGA==";
function fixture(t: TestContext, metadata: Record<string, any> = {}, entries: Parameters<typeof writeArchive>[1] = []) {
  const root = mkdtempSync(join(tmpdir(), "parabus-js-overlay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, "app"), sources = join(root, "sources");
  mkdirSync(join(app, "node_modules/undici"), { recursive: true }); mkdirSync(join(sources, "npm"), { recursive: true });
  const previous = { name: "undici", version: "6.29.0" };
  writeFileSync(join(app, "node_modules/undici/package.json"), JSON.stringify(previous));
  const archive = join(sources, "npm/undici-6.29.1.tgz");
  writeArchive(archive, [
    { path: "package/package.json", bytes: JSON.stringify({ name: "undici", version: "6.29.1", ...metadata }) },
    { path: "package/LICENSE", bytes: "Test-only notice retained verbatim" },
    { path: "package/index.js", bytes: "export const fixture = true;" }, ...entries,
  ]);
  const lock: PackageLock = { packages: { "": { version: "0.1.0", dependencies: { undici: "6.29.1" } }, "node_modules/undici": { version: "6.29.1", integrity } } };
  return { root, app, sources, archive, previous, lock };
}

test("Windows archive tool is absolute, and archive inspection ignores a conflicting PATH", t => {
  assert.equal(archiveTool("win32", "C:\\Windows"), "C:\\Windows\\System32\\tar.exe");
  assert.equal(archiveTool("linux"), "tar");
  const f = fixture(t), originalPath = process.env.PATH;
  if (process.platform === "win32") process.env.PATH = "C:\\path-that-does-not-exist";
  try {
    const prepared = prepareJavaScriptArchive(f.archive, f.previous, f.root);
    assert.equal(readFileSync(join(prepared.root, "LICENSE"), "utf8"), "Test-only notice retained verbatim");
    prepared.cleanup();
  } finally { process.env.PATH = originalPath; }
});

test("archive inspection explicitly rejects links and special entries before extraction", t => {
  for (const type of ["1", "2", "3", "6"]) {
    const f = fixture(t, {}, [{ path: "package/linked.js", type, link: "../../outside" }]);
    assert.throws(() => prepareJavaScriptArchive(f.archive, f.previous, f.root), /Only regular files/);
    assert.ok(!readdirSync(f.root).some(p => p.startsWith("js-update-")));
  }
});

test("unsafe paths, duplicate Windows names, native extensions and disguised binaries are rejected", t => {
  const cases = [
    [{ path: "package/../../outside", bytes: "x" }], [{ path: "/outside", bytes: "x" }],
    [{ path: "package/file:stream", bytes: "x" }], [{ path: "package/INDEX.js", bytes: "x" }],
    [{ path: "package/trailing-space ", bytes: "x" }],
    [{ path: "package/extension.pyd", bytes: "x" }],
    [{ path: "package/disguised.js", bytes: Buffer.from("MZ executable") }],
    [{ path: "package/disguised.js", bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]) }],
  ];
  for (const entries of cases) {
    const f = fixture(t, {}, entries);
    assert.throws(() => prepareJavaScriptArchive(f.archive, f.previous, f.root), /Unsafe archive|Duplicate archive|Native code|Executable binary/);
    assert.ok(!readdirSync(f.root).some(p => p.startsWith("js-update-")));
  }
});

test("install hooks, bin additions and dependency changes are rejected and staging is cleaned", t => {
  for (const metadata of [{ scripts: { install: "unexpected command" } }, { scripts: { prepare: "new preparation command" } }, { bin: "index.js" }, { dependencies: { extra: "1.0.0" } }, { name: "changed-name" }]) {
    const f = fixture(t, metadata);
    assert.throws(() => prepareJavaScriptArchive(f.archive, f.previous, f.root), /Lifecycle script|Preparation script changed|installation metadata|Package name changed/);
    assert.ok(!readdirSync(f.root).some(p => p.startsWith("js-update-")));
  }
});

test("both the reviewed integrity and actual archive bytes are required before replacement", t => {
  const f = fixture(t);
  f.lock.packages["node_modules/undici"].integrity = "sha512-changed";
  assert.throws(() => overlayJavaScriptUpdates(f.app, f.sources, f.lock), /Unreviewed package integrity/);
  f.lock.packages["node_modules/undici"].integrity = integrity;
  assert.throws(() => overlayJavaScriptUpdates(f.app, f.sources, f.lock), /Changed package archive/);
  assert.equal(JSON.parse(readFileSync(join(f.app, "node_modules/undici/package.json"), "utf8")).version, "6.29.0");
  assert.ok(!readdirSync(f.root).some(p => p.startsWith("js-update-")));
});

test("unreviewed package versions are rejected even when the old package is recognized", t => {
  const f = fixture(t); f.lock.packages["node_modules/undici"].version = "7.0.0";
  assert.throws(() => overlayJavaScriptUpdates(f.app, f.sources, f.lock), /Unreviewed runtime package update/);
});

test("dependency audit detects missing, wrong-version and unexpected packages", t => {
  const f = fixture(t);
  assert.throws(() => auditRuntimeDependencies(f.app, f.lock), /version mismatch/);
  f.lock.packages[""].dependencies!.required = "1.0.0"; f.lock.packages["node_modules/required"] = { version: "1.0.0" };
  assert.throws(() => overlayJavaScriptUpdates(f.app, f.sources, f.lock), /Runtime dependency missing/);
  delete f.lock.packages[""].dependencies!.required; delete f.lock.packages["node_modules/required"];
  mkdirSync(join(f.app, "node_modules/extra")); writeFileSync(join(f.app, "node_modules/extra/package.json"), '{"name":"extra","version":"1.0.0"}');
  assert.throws(() => auditRuntimeDependencies(f.app, f.lock, true), /Unexpected runtime dependency/);
});

test("missing package versions cannot accidentally match an undefined permitted version", t => {
  const f = fixture(t); writeFileSync(join(f.app, "node_modules/undici/package.json"), '{"name":"undici"}');
  assert.throws(() => auditRuntimeDependencies(f.app, f.lock), /version mismatch/);
});

test("nested dependencies are never silently removed by an overlay", t => {
  const f = fixture(t), nested = "node_modules/undici/node_modules/child";
  f.lock.packages["node_modules/undici"].dependencies = { child: "1.0.0" }; f.lock.packages[nested] = { version: "1.0.0" };
  mkdirSync(join(f.app, nested), { recursive: true }); writeFileSync(join(f.app, nested, "package.json"), '{"name":"child","version":"1.0.0"}');
  assert.throws(() => overlayJavaScriptUpdates(f.app, f.sources, f.lock), /Nested dependencies/);
  assert.ok(existsSync(join(f.app, nested, "package.json")));
});

test("platform-specific optional branches are skipped with their transitive dependencies", () => {
  const lock: PackageLock = { packages: {
    "": { version: "1", optionalDependencies: { platform: "1" } },
    "node_modules/platform": { version: "1", os: ["linux"], dependencies: { child: "1" } },
    "node_modules/child": { version: "1" },
  } };
  assert.equal(runtimePackagePaths(lock, "win32", "x64").size, 0);
  assert.equal(runtimePackagePaths(lock, "linux", "x64").size, 2);
});

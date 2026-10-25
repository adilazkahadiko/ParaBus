// Only exact reviewed npm archives may be overlaid on reused native inputs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { archiveTool } from "./archive-tool.ts";

interface PackageEntry {
  version: string; integrity?: string; dev?: boolean; optional?: boolean; os?: string[]; cpu?: string[];
  dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
}
export interface PackageLock { packages: Record<string, PackageEntry> }
const reviewed = new Map([
  ["node_modules/undici", { from: "6.29.0", version: "6.29.1", integrity: "sha512-EvRlUt/QqAEvXdQeRMYUfwOQsfzpDztykrG2owGEE/rBOBoYv9uF39ZzsNDh4lTFHhTr2XOZjKkYgueD12ZmGA==" }],
  ["node_modules/brace-expansion", { from: "1.1.18", version: "1.1.21", integrity: "sha512-9zeA+KLZNNzglF2TPKRQEDyx6Yby7daAkuy8MiPzpXPsYDWi/DRM8jmwUDxokQjYqBpv5DgPiwD4h4ZZSy1Ujw==" }],
]);
const omitted = (path: string) => path.split("/").includes("segfault-handler");
const supported = (values: string[] | undefined, value: string) => !values || (!values.includes(`!${value}`) && (!values.some(v => !v.startsWith("!")) || values.includes(value)));

/** Follow production dependencies; unsupported optional platform branches are excluded. */
export function runtimePackagePaths(lock: PackageLock, platform = process.platform, arch = process.arch): Set<string> {
  const expected = new Set<string>();
  assert.ok(lock.packages[""], "Missing root dependency manifest");
  const visit = (parent: string) => {
    const pkg = lock.packages[parent];
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      const optional = Object.hasOwn(pkg.optionalDependencies ?? {}, name);
      let ancestor = parent, path: string;
      while (true) {
        path = ancestor ? `${ancestor}/node_modules/${name}` : `node_modules/${name}`;
        if (lock.packages[path]) break;
        assert.ok(ancestor, `Dependency missing from lockfile: ${parent || "root"} -> ${name}`);
        const index = ancestor.lastIndexOf("/node_modules/");
        ancestor = index < 0 ? "" : ancestor.slice(0, index);
      }
      const entry = lock.packages[path];
      if (omitted(path)) continue;
      if (!supported(entry.os, platform) || !supported(entry.cpu, arch)) {
        assert.ok(optional, `Required dependency does not support target platform: ${path}`);
        continue;
      }
      assert.ok(!entry.dev, `Production dependency marked development-only: ${path}`);
      if (!expected.has(path)) { expected.add(path); visit(path); }
    }
  };
  visit("");
  return expected;
}

function installedPackages(app: string, directory = "node_modules", result = new Set<string>()): Set<string> {
  assert.ok(existsSync(join(app, directory)), `Missing dependency directory: ${directory}`);
  const stat = lstatSync(join(app, directory));
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Dependency directory must not be a link");
  for (const entry of readdirSync(join(app, directory), { withFileTypes: true })) {
    if (entry.name === ".bin" || entry.name === ".package-lock.json") continue;
    const path = `${directory}/${entry.name}`;
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), `Unexpected dependency entry: ${path}`);
    if (entry.name.startsWith("@")) { installedPackages(app, path, result); continue; }
    assert.ok(existsSync(join(app, path, "package.json")), `Missing package metadata: ${path}`);
    result.add(path);
    if (existsSync(join(app, path, "node_modules"))) installedPackages(app, `${path}/node_modules`, result);
  }
  return result;
}

export function auditRuntimeDependencies(app: string, lock: PackageLock, allowReviewedOldVersions = false): number {
  // Audit the Windows x64 distribution, independently of the assembly host.
  const expected = runtimePackagePaths(lock, "win32", "x64"), installed = installedPackages(app);
  // The legacy input retains nan headers after removing the optional crash hook.
  // Permit only that known leftover, and still verify its locked name/version.
  if (installed.has("node_modules/nan") && lock.packages["node_modules/nan"]?.optional && !lock.packages["node_modules/nan"].dev) expected.add("node_modules/nan");
  for (const path of expected) {
    assert.ok(installed.has(path), `Runtime dependency missing: ${path}`);
    const pkg = JSON.parse(readFileSync(join(app, path, "package.json"), "utf8"));
    assert.equal(pkg.name, path.slice(path.lastIndexOf("node_modules/") + 13), `Wrong package name: ${path}`);
    const oldVersion = allowReviewedOldVersions ? reviewed.get(path)?.from : undefined;
    assert.ok(typeof pkg.version === "string" && (pkg.version === lock.packages[path].version || (oldVersion !== undefined && pkg.version === oldVersion)), `Runtime dependency version mismatch: ${path}`);
  }
  for (const path of installed) assert.ok(expected.has(path) || omitted(path), `Unexpected runtime dependency: ${path}`);
  return expected.size;
}

/** Inspect entry types before extraction, then verify the filesystem and file signatures. */
export function prepareJavaScriptArchive(archive: string, previous: Record<string, any>, parent: string): { root: string; cleanup: () => void } {
  const tar = archiveTool();
  const lines = (text: string) => text.replace(/\r?\n$/, "").split(/\r?\n/);
  const names = lines(execFileSync(tar, ["-tf", archive], { encoding: "utf8" }));
  const verbose = lines(execFileSync(tar, ["-tvf", archive], { encoding: "utf8" }));
  assert.equal(verbose.length, names.length, "Ambiguous archive listing");
  const seen = new Set<string>();
  for (const [index, name] of names.entries()) {
    assert.match(verbose[index], /^[-d][rwxstST-]{9}\s/, "Only regular files and directories are permitted; links are forbidden");
    assert.ok(name.startsWith("package/") && !/[\\:\x00-\x1f\x7f]/.test(name), "Unsafe archive path");
    const parts = name.replace(/\/$/, "").split("/");
    assert.ok(parts.every(p => p && p !== "." && p !== ".." && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), "Unsafe archive path");
    assert.ok(!parts.includes("node_modules"), "Bundled dependencies are not permitted in JavaScript updates");
    const key = name.replace(/\/$/, "").toLowerCase(); assert.ok(!seen.has(key), "Duplicate archive path"); seen.add(key);
    assert.ok(!/\.(exe|dll|node|lib|pyd|so|dylib|o|a|wasm)$/i.test(name) && !name.endsWith("binding.gyp"), "Native code in JavaScript overlay");
  }
  const staging = mkdtempSync(join(resolve(parent), "js-update-"));
  const cleanup = () => rmSync(staging, { recursive: true, force: true });
  try {
    execFileSync(tar, ["-xf", archive, "-C", staging]);
    const walk = (directory: string) => {
      for (const item of readdirSync(directory)) {
        const file = join(directory, item), stat = lstatSync(file);
        assert.ok(!stat.isSymbolicLink() && (stat.isDirectory() || (stat.isFile() && stat.nlink === 1)), "Links and special files are forbidden");
        if (stat.isDirectory()) { walk(file); continue; }
        const bytes = readFileSync(file), magic = bytes.subarray(0, 4).toString("hex");
        assert.ok(!bytes.subarray(0, 2).equals(Buffer.from("MZ")) && !["7f454c46", "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "0061736d"].includes(magic), "Executable binary content in JavaScript overlay");
      }
    };
    walk(staging);
    const root = join(staging, "package"), next = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(next.name, previous.name, "Package name changed");
    for (const key of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bundledDependencies", "bundleDependencies", "bin", "gypfile", "os", "cpu"]) assert.deepEqual(next[key], previous[key], `Package installation metadata changed: ${key}`);
    for (const hook of ["preinstall", "install", "postinstall"]) assert.ok(!next.scripts?.[hook], `Lifecycle script in overlay: ${hook}`);
    // Published undici already has a prepare script; copying an archive never runs it.
    assert.deepEqual(next.scripts?.prepare, previous.scripts?.prepare, "Preparation script changed");
    return { root, cleanup };
  } catch (error) { cleanup(); throw error; }
}

export function overlayJavaScriptUpdates(app: string, sources: string, lock: PackageLock): string[] {
  auditRuntimeDependencies(app, lock, true);
  const prepared: { path: string; root: string; cleanup: () => void; version: string; name: string; backup?: string }[] = [];
  let committed = false;
  try {
    for (const path of runtimePackagePaths(lock, "win32", "x64")) {
      const entry = lock.packages[path], destination = resolve(app, path);
      assert.ok(destination.startsWith(resolve(app, "node_modules") + sep), "Overlay must stay inside staged dependencies");
      const previous = JSON.parse(readFileSync(join(destination, "package.json"), "utf8"));
      if (previous.version === entry.version) continue;
      const policy = reviewed.get(path);
      assert.ok(policy && policy.version === entry.version, `Unreviewed runtime package update: ${path}`);
      assert.equal(entry.integrity, policy.integrity, `Unreviewed package integrity: ${path}`);
      assert.ok(!existsSync(join(destination, "node_modules")), `Nested dependencies cannot be replaced by an overlay: ${path}`);
      const archive = join(sources, "npm", path.replaceAll("node_modules/", "").replaceAll("/", "__") + `-${entry.version}.tgz`);
      assert.equal("sha512-" + createHash("sha512").update(readFileSync(archive)).digest("base64"), policy.integrity, `Changed package archive: ${path}`);
      const update = prepareJavaScriptArchive(archive, previous, resolve(app, ".."));
      prepared.push({ ...update, path, version: entry.version, name: previous.name });
      assert.equal(JSON.parse(readFileSync(join(update.root, "package.json"), "utf8")).version, entry.version, "Wrong archive version");
    }
    for (const item of prepared) {
      item.backup = join(resolve(item.root, ".."), "original");
      renameSync(join(app, item.path), item.backup);
      renameSync(item.root, join(app, item.path));
    }
    auditRuntimeDependencies(app, lock);
    committed = true;
    return prepared.map(p => `${p.name}@${p.version}`);
  } catch (error) {
    for (const item of [...prepared].reverse()) if (item.backup && existsSync(item.backup)) {
      const destination = resolve(app, item.path);
      assert.ok(destination.startsWith(resolve(app, "node_modules") + sep));
      rmSync(destination, { recursive: true, force: true }); renameSync(item.backup, destination);
    }
    throw error;
  } finally {
    // Preserve an original backup if a filesystem failure prevented rollback.
    for (const item of prepared) if (committed || !item.backup || !existsSync(item.backup)) item.cleanup();
  }
}

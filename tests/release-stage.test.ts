import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { auditReleaseEntries, stageRelease } from "../scripts/release-stage.ts";
import { runtimeInfo } from "../services/router-core-sim/src/runtime-info.ts";
import { crc32 } from "node:zlib";

const buildCommit = "0123456789abcdef0123456789abcdef01234567";

function fakeRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "dbr-release-stage-"));
  mkdirSync(join(root, "release"), { recursive: true });
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(join(root, "release", "release-manifest.json"), JSON.stringify({ schemaVersion: 1, files: ["README.md"], prefixes: ["app"] }));
  writeFileSync(join(root, "README.md"), "public readme\n");
  writeFileSync(join(root, "app", "main.ts"), "export {};\n");
  writeFileSync(join(root, "router-core.exe"), "fake read-only management binary\n");
  writeFileSync(join(root, ".env"), "fake-secret-for-negative-test\n");
  return root;
}

function releaseOptions(root: string, options: { trackedFiles: string[]; unstagedFiles: string[] }) {
  return { ...options, buildCommit, rustBinaryPath: join(root, "router-core.exe"), platform: "win32" as const };
}

function removeFakeRepository(root: string): void {
  const temporaryRoot = resolve(tmpdir());
  const candidate = resolve(root);
  const prefix = `${join(temporaryRoot, "dbr-release-stage-")}`;
  assert.ok(candidate.startsWith(prefix) && candidate.slice(prefix.length).length > 0 && !candidate.slice(prefix.length).includes(sep));
  rmSync(candidate, { recursive: true, force: true });
}

test("release stage embeds the repository HEAD at build time", () => {
  const root = fakeRepository();
  try {
    const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git(["init", "--quiet"]);
    git(["add", "README.md", "app/main.ts", "release/release-manifest.json"]);
    git(["-c", "user.name=Release Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "test release source"]);
    const result = stageRelease(root, { rustBinaryPath: join(root, "router-core.exe"), platform: "win32" });
    assert.equal(runtimeInfo(result.stageDirectory, []).buildCommit, git(["rev-parse", "HEAD"]).trim());
    writeFileSync(join(root, "README.md"), "changed source\n");
    git(["add", "README.md"]);
    assert.throws(() => stageRelease(root, { rustBinaryPath: join(root, "router-core.exe"), platform: "win32" }), /staged changes/);
  } finally {
    removeFakeRepository(root);
  }
});

test("release manifest includes canonical desktop entry and its complete asset graph after rename", () => {
  const root = fakeRepository();
  try {
    const prefix = "services/router-core-sim/public";
    const source = new URL("../services/router-core-sim/public/", import.meta.url);
    const files = readdirSync(source, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name);
    mkdirSync(join(root, prefix), { recursive: true });
    for (const file of files) copyFileSync(new URL(file, source), join(root, prefix, file));
    copyFileSync(new URL("../release/release-manifest.json", import.meta.url), join(root, "release/release-manifest.json"));
    const result = stageRelease(root, releaseOptions(root, { trackedFiles: ["README.md", "release/release-manifest.json", ...files.map(file => `${prefix}/${file}`)], unstagedFiles: [] }));
    const included = (file: string) => assert.ok(result.entries.includes(`${prefix}/${file}`), `missing release asset: ${file}`);
    for (const file of ["index.html", "app.js", "styles.css"]) included(file);
    assert.equal(result.entries.some(file => /\/minimal\.(?:html|js|css)$/.test(file)), false);
    const html = readFileSync(join(result.stageDirectory, prefix, "index.html"), "utf8");
    for (const [, file] of html.matchAll(/(?:src|href)="\/([^"?]+\.(?:js|css))"/g)) included(file);
    for (const file of files.filter(file => file.endsWith(".js"))) {
      const script = readFileSync(join(result.stageDirectory, prefix, file), "utf8");
      for (const [, dependency] of script.matchAll(/from ["']\.\/([^"']+)["']/g)) included(dependency);
    }
  } finally { removeFakeRepository(root); }
});

test("release stage copies only manifest allowlist entries and omits fake ignored secrets", () => {
  const root = fakeRepository();
  try {
    const result = stageRelease(root, releaseOptions(root, { trackedFiles: [".env", "README.md", "app/main.ts", "release/release-manifest.json"], unstagedFiles: [".env"] }));
    assert.deepEqual(result.entries, ["README.md", "app/main.ts", "bin/router-core.exe", "release-audit.json", "release-build-info.json", "release-manifest-lock.json", "release/release-manifest.json"]);
    assert.equal(result.entries.some((entry) => entry === ".env"), false);
    assert.equal(readFileSync(join(result.stageDirectory, "bin", "router-core.exe"), "utf8"), "fake read-only management binary\n");
    assert.doesNotMatch(result.stageDirectory, /-pending$/);
    const audit = JSON.parse(readFileSync(join(result.stageDirectory, "release-audit.json"), "utf8")) as { entries: string[] };
    assert.deepEqual(audit.entries, result.entries, "audit includes its own final entry");
    const lock = JSON.parse(readFileSync(join(result.stageDirectory, "release-manifest-lock.json"), "utf8")) as { files: Array<{ path: string }> };
    assert.equal(lock.files.some((file) => file.path === "bin/router-core.exe"), true, "generated management binary is integrity-locked");
    const metadata = readFileSync(join(result.stageDirectory, "release-build-info.json"));
    assert.deepEqual(JSON.parse(metadata.toString()), { schemaVersion: 1, buildCommit });
    assert.equal(runtimeInfo(result.stageDirectory, []).buildCommit, buildCommit, "release runtime reads the embedded commit without a Git repository");
    assert.equal((lock.files.find((file) => file.path === "release-build-info.json") as { sha256?: string })?.sha256, createHash("sha256").update(metadata).digest("hex"));
    assert.ok(result.archivePath);
    const zip = readFileSync(result.archivePath);
    const archived = new Map<string, Buffer>();
    let offset = 0;
    while (zip.readUInt32LE(offset) === 0x04034b50) {
      assert.equal(zip.readUInt16LE(offset + 8), 0);
      const size = zip.readUInt32LE(offset + 18), nameBytes = zip.readUInt16LE(offset + 26);
      const name = zip.subarray(offset + 30, offset + 30 + nameBytes).toString();
      const payload = zip.subarray(offset + 30 + nameBytes, offset + 30 + nameBytes + size);
      assert.equal(crc32(payload), zip.readUInt32LE(offset + 14));
      archived.set(name, payload);
      offset += 30 + nameBytes + size;
    }
    assert.deepEqual([...archived.keys()], result.entries);
    assert.deepEqual(archived.get("release-build-info.json"), metadata, "the update ZIP always replaces the runtime SHA");
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
    assert.equal(zip.readUInt16LE(zip.length - 12), result.entries.length);
  } finally {
    removeFakeRepository(root);
  }
});

test("release stage permits tracked public dotfiles and runtime event-log names", () => {
  const root = fakeRepository();
  try {
    writeFileSync(join(root, "release", "release-manifest.json"), JSON.stringify({ schemaVersion: 1, files: [".env.example", ".nvmrc", "README.md"], prefixes: ["app"] }));
    writeFileSync(join(root, ".env.example"), "PUBLIC_EXAMPLE=1\n");
    writeFileSync(join(root, ".nvmrc"), "22.18.0\n");
    writeFileSync(join(root, "app", "event-log.ts"), "export {};\n");
    const result = stageRelease(root, releaseOptions(root, { trackedFiles: [".env.example", ".nvmrc", "README.md", "app/event-log.ts", "release/release-manifest.json"], unstagedFiles: [] }));
    assert.ok(result.entries.includes(".env.example"));
    assert.ok(result.entries.includes(".nvmrc"));
    assert.ok(result.entries.includes("app/event-log.ts"));
    assert.doesNotMatch(result.stageDirectory, /-pending$/);
  } finally {
    removeFakeRepository(root);
  }
});

test("release stage rejects an unstaged allowlisted source before copy", () => {
  const root = fakeRepository();
  try {
    assert.throws(
      () => stageRelease(root, releaseOptions(root, { trackedFiles: ["README.md", "app/main.ts", "release/release-manifest.json"], unstagedFiles: ["README.md"] })),
      /allowlisted release source has unstaged changes/,
    );
  } finally {
    removeFakeRepository(root);
  }
});

test("release artifact audit rejects sensitive paths while permitting public DEVLOG", () => {
  assert.throws(() => auditReleaseEntries([".env"]));
  assert.throws(() => auditReleaseEntries(["logs/router.log"]));
  assert.throws(() => auditReleaseEntries(["../discord-bots.json"]));
  assert.doesNotThrow(() => auditReleaseEntries(["services/router-core-sim/src/event-log.ts", "docs/DEVLOG.md"]));
});

test("source stage keeps build inputs, omits private material, never needs a binary, and rejects binary contents", () => {
  const root = fakeRepository();
  try {
    const manifestPath = join(root, "release", "release-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.throws(() => stageRelease(root, { sourceOnly: true, trackedFiles: ["release/release-manifest.json"], unstagedFiles: [] }), /source manifest is missing/);
    manifest.source = { files: ["README.md", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml"], prefixes: ["app"] };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    for (const name of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"]) writeFileSync(join(root, name), "synthetic build input\n");
    const trackedFiles = ["README.md", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "app/main.ts", ".env", "docs/DEVLOG.md", "release/release-manifest.json"];
    const options = { sourceOnly: true, buildCommit, trackedFiles, unstagedFiles: [], rustBinaryPath: join(root, "nonexistent.exe") };
    const result = stageRelease(root, options);
    assert.deepEqual(result.entries, ["Cargo.lock", "Cargo.toml", "README.md", "app/main.ts", "release-audit.json", "release-build-info.json", "release-manifest-lock.json", "release/release-manifest.json", "rust-toolchain.toml"]);
    assert.match(result.stageDirectory, /source-stage/);
    assert.throws(() => stageRelease(root, { ...options, trackedFiles: trackedFiles.filter((entry) => entry !== "Cargo.toml") }), /required file is not tracked/);
    assert.throws(() => stageRelease(root, { ...options, unstagedFiles: ["README.md"] }), /unstaged changes/);
    for (const name of ["driver.dll", "module.node", "program.exe", "sdk.zip", "audio.wav"]) {
      assert.throws(() => stageRelease(root, { ...options, trackedFiles: [...trackedFiles, `app/${name}`] }), /binary or unsupported/);
    }
    for (const name of ["user-profiles.json", "receiver-owners.json", "scenes.json"]) assert.throws(() => auditReleaseEntries([`app/${name}`], true));
    for (const bytes of [Buffer.from([0]), Buffer.from([0xff])]) {
      writeFileSync(join(root, "app", "main.ts"), bytes);
      assert.throws(() => stageRelease(root, options), /binary content|encoded data/);
    }
  } finally {
    removeFakeRepository(root);
  }
});

test("GPLv3 metadata agrees and release stage retains license and third-party inventory", () => {
  const repository = resolve(import.meta.dirname, "..");
  const read = (entry: string) => readFileSync(join(repository, entry), "utf8");
  assert.equal(JSON.parse(read("package.json")).license, "GPL-3.0-only");
  assert.equal(JSON.parse(read("package-lock.json")).packages[""].license, "GPL-3.0-only");
  assert.match(read("Cargo.toml"), /^license = "GPL-3\.0-only"$/m);
  const license = read("LICENSE");
  assert.match(license, /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
  const notices = read("THIRD_PARTY_NOTICES.md");
  assert.match(notices, /unicode-ident/);
  const nativeLicenses = read("docs/THIRD_PARTY_LICENSES.md");
  assert.match(nativeLicenses, /UNICODE LICENSE V3/);
  assert.match(nativeLicenses, /Copyright 2001-2011 Xiph\.Org/);
  assert.match(nativeLicenses, /Steinberg Media Technologies/);
  for (const [heading, hash] of [
    ["@snazzah/davey 0.1.12", "90760006b6e6c76a67476de39bee25e42e584679eac5d608765355d5d54e8afa"],
    ["segfault-handler 1.3.0", "4e4a87cea8c920a3d39ffbcdfd3fcbca1134caecfc85f942d69f88104ecc77dc"],
  ]) {
    // Preserve checked upstream originals without requiring native packages or network in tests.
    const section = nativeLicenses.replaceAll("\r\n", "\n").split(`## ${heading}\n`)[1]?.split("\n## ")[0];
    const original = section?.match(/```text\n([\s\S]*?)\n```/)?.[1];
    assert.ok(original, `missing license original: ${heading}`);
    assert.equal(createHash("sha256").update(original.trim()).digest("hex"), hash, heading);
  }
  const asioBuild = read("docs/ASIO_BUILD.md");
  assert.match(asioBuild, /D5EBF0C20DD2C5F43771FD0C1418F4B361BF52434EE670097CFA6B3A335E2ECA/);
  const manifest = read("release/release-manifest.json");
  const files = JSON.parse(manifest).files as string[];
  for (const entry of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) assert.ok(files.includes(entry));
  const root = fakeRepository();
  try {
    writeFileSync(join(root, "release", "release-manifest.json"), manifest);
    writeFileSync(join(root, "LICENSE"), license);
    writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), notices);
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "THIRD_PARTY_LICENSES.md"), nativeLicenses);
    writeFileSync(join(root, "docs", "ASIO_BUILD.md"), asioBuild);
    const result = stageRelease(root, releaseOptions(root, {
      trackedFiles: ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "release/release-manifest.json", "docs/THIRD_PARTY_LICENSES.md", "docs/ASIO_BUILD.md"],
      unstagedFiles: [],
    }));
    assert.equal(readFileSync(join(result.stageDirectory, "LICENSE"), "utf8"), license);
    assert.equal(readFileSync(join(result.stageDirectory, "THIRD_PARTY_NOTICES.md"), "utf8"), notices);
    assert.equal(readFileSync(join(result.stageDirectory, "docs", "THIRD_PARTY_LICENSES.md"), "utf8"), nativeLicenses);
    assert.equal(readFileSync(join(result.stageDirectory, "docs", "ASIO_BUILD.md"), "utf8"), asioBuild);
  } finally {
    removeFakeRepository(root);
  }
});

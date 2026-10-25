import { archiveTool } from "./archive-tool.ts";
// Fetch source archives only; never execute downloaded package/build scripts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyPinnedSource } from "./verified-source.ts";

const DAVE_COMMIT = "a1e2e741bea06bc3b7167a5c3792844b8975993c";
const HPKE_COMMIT = "f3463e7530771d7f7116635335c25e7d2d11e861";
type RecordEntry = { path: string; url: string; sha256: string; integrity?: string };
export function parseRegistryCrates(lock: string): { name: string; version: string; checksum: string }[] {
  return lock.split("[[package]]").slice(1).filter(s => /^source = "registry\+/m.test(s)).map(s => {
    const value = (key: string) => { const match = s.match(new RegExp(`^${key} = "([^"]+)"`, "m")); assert.ok(match, `Missing ${key}`); return match[1]; };
    const item = { name: value("name"), version: value("version"), checksum: value("checksum") };
    assert.match(item.name, /^[a-zA-Z0-9_-]+$/); assert.match(item.version, /^[a-zA-Z0-9.+_-]+$/); assert.match(item.checksum, /^[a-f0-9]{64}$/);
    return item;
  });
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function collectSources(repo: string, nativeBase: string, output: string) {
  mkdirSync(output, { recursive: true });
  const records: RecordEntry[] = [];
  async function download(path: string, url: string, integrity?: string) {
    const destination = join(output, path);
    let bytes: Buffer | undefined;
    if (existsSync(destination)) bytes = readFileSync(destination);
    for (let attempt = 0; !bytes && attempt < 4; attempt++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`${response.status}: ${url}`);
        bytes = Buffer.from(await response.arrayBuffer());
      } catch (error) { if (attempt === 3) throw error; }
    }
    assert.ok(bytes);
    if (integrity) {
      const [algorithm, expected] = integrity.split("-");
      assert.ok(["sha256", "sha512", "sha1"].includes(algorithm));
      const actual = createHash(algorithm).update(bytes).digest(algorithm === "sha256" ? "hex" : "base64");
      assert.equal(actual, expected, `Source checksum mismatch: ${path}`);
    } else verifyPinnedSource(url, bytes);
    mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, bytes);
    records.push({ path, url, sha256: sha256(bytes), ...(integrity ? { integrity } : {}) });
    return destination;
  }
  const tarRead = (archive: string, entry: string) => execFileSync(archiveTool(), ["-xOf", archive, entry], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const dave = await download("davey/davey-js-0.1.12.tar.gz", `https://codeload.github.com/Snazzah/davey/tar.gz/${DAVE_COMMIT}`);
  const daveLock = tarRead(dave, `davey-${DAVE_COMMIT}/Cargo.lock`);
  assert.equal(sha256(Buffer.from(daveLock)), "cf9bc6884056b8e20ee6835ac0ffca237f8b869d5ca14cddf25f548fa15ceb50");
  writeFileSync(join(output, "davey/Cargo.lock"), daveLock);
  await download("davey/hpke-rs-f3463e75.tar.gz", `https://codeload.github.com/cryspen/hpke-rs/tar.gz/${HPKE_COMMIT}`);
  const jobs: (() => Promise<unknown>)[] = [];
  for (const [group, lock] of [["davey/crates", daveLock], ["parabus-crates", readFileSync(join(repo, "Cargo.lock"), "utf8")]]) {
    for (const item of parseRegistryCrates(lock)) jobs.push(() => download(`${group}/${item.name}-${item.version}.crate`, `https://static.crates.io/crates/${item.name}/${item.name}-${item.version}.crate`, `sha256-${item.checksum}`));
  }
  const lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
  for (const [path, value] of Object.entries(lock.packages) as [string, { resolved?: string; integrity?: string; version: string }][]) {
    if (!path || path.split("/").includes("segfault-handler") || !existsSync(join(nativeBase, path, "package.json"))) continue;
    assert.ok(value.resolved?.startsWith("https://registry.npmjs.org/") && value.integrity);
    const filename = path.replaceAll("node_modules/", "").replaceAll("/", "__") + `-${value.version}.tgz`;
    jobs.push(() => download(`npm/${filename}`, value.resolved!, value.integrity));
  }
  let completed = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (jobs.length) { await jobs.shift()!(); if (++completed % 25 === 0) console.log(`Verified source archives: ${completed}`); }
  }));
  // Upstream crates omit these texts; retrieve at their crate-recorded VCS commits.
  const additional = [
    ["openmls/openmls", "openmls", "0.8.1", "LICENSE"],
    ["openmls/openmls", "openmls_rust_crypto", "0.5.1", "LICENSE"],
    ["openmls/openmls", "openmls_basic_credential", "0.5.0", "LICENSE"],
    ["openmls/openmls", "openmls_memory_storage", "0.5.0", "LICENSE"],
    ["openmls/openmls", "openmls_traits", "0.5.0", "LICENSE"],
    ["napi-rs/napi-rs", "napi", "3.8.4", "LICENSE"],
    ["napi-rs/napi-rs", "napi-derive", "3.5.3", "LICENSE"],
    ["napi-rs/napi-rs", "napi-build", "2.3.1", "LICENSE"],
  ];
  for (const [github, name, version, filename] of additional) {
    const archive = join(output, `davey/crates/${name}-${version}.crate`);
    const vcs = JSON.parse(tarRead(archive, `${name}-${version}/.cargo_vcs_info.json`));
    assert.match(vcs.git.sha1, /^[a-f0-9]{40}$/);
    await download(`upstream-notices/${name}-${version}-LICENSE`, `https://raw.githubusercontent.com/${github}/${vcs.git.sha1}/${filename}`);
  }
  await download("upstream-notices/MPL-2.0.txt", "https://www.mozilla.org/media/MPL/2.0/index.txt");
  await download("upstream-notices/Unicode-DATA-LICENSE.txt", "https://www.unicode.org/license.txt");
  const sums = await download("node/SHASUMS256.txt", "https://nodejs.org/dist/v22.23.4/SHASUMS256.txt");
  const nodeHash = readFileSync(sums, "utf8").match(/^([a-f0-9]{64})\s+node-v22\.23\.4\.tar\.xz$/m)?.[1];
  assert.ok(nodeHash);
  await download("node/node-v22.23.4.tar.xz", "https://nodejs.org/dist/v22.23.4/node-v22.23.4.tar.xz", `sha256-${nodeHash}`);
  records.sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(join(output, "SOURCE_DOWNLOADS.json"), JSON.stringify({ schemaVersion: 1, daveCommit: DAVE_COMMIT, hpkeCommit: HPKE_COMMIT, records }, null, 2) + "\n");
  console.log(JSON.stringify({ archives: records.length, output }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 4, "Usage: node scripts/collect-corresponding-source.ts <clean-native-base> <new-source-output>");
  await collectSources(resolve(import.meta.dirname, ".."), resolve(process.argv[2]), resolve(process.argv[3]));
}

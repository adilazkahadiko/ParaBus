// Assemble in a new directory from clean tracked source and an unused CI input.
// The app used for field testing (which now contains settings/recordings) is never read.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { stageRelease, auditReleaseEntries } from "./release-stage.ts";
import { omitCrashDiagnostics } from "./omit-crash-diagnostics.ts";
import { verifyNativeInputs, verifyArtifactSourceInputs } from "./native-inputs.ts";
import { overlayJavaScriptUpdates } from "./release-js-overlays.ts";

const repo = resolve(import.meta.dirname, "..");
assert.ok(process.argv.length === 5 || process.argv.length === 6, "Usage: node scripts/assemble-review-package.ts <clean-ci-base> <collected-sources> <new-output-root> [vX.Y.Z-beta.N]");
assert.equal(process.versions.node, "22.23.4");
const base = resolve(process.argv[2]), sources = resolve(process.argv[3]), output = resolve(process.argv[4]);
assert.ok(!existsSync(output), "Output already exists; choose a new directory");
const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
assert.equal(git(["status", "--porcelain"]), "", "Commit reviewed changes before assembly");
const commit = git(["rev-parse", "HEAD"]);
const nativeLock = verifyNativeInputs(repo, path => execFileSync("git", ["show", `HEAD:${path}`], { cwd: repo }));
const baseCommit = nativeLock.artifactCommit;
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function files(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => {
    const relative = prefix ? `${prefix}/${e.name}` : e.name;
    assert.ok(!e.isSymbolicLink() && !lstatSync(join(root, relative)).isSymbolicLink(), "Unexpected reparse point");
    return e.isDirectory() ? files(root, relative) : [relative];
  });
}
const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const sourceInventory = JSON.parse(readFileSync(join(sources, "SOURCE_DOWNLOADS.json"), "utf8"));
for (const record of [...sourceInventory.records, ...JSON.parse(readFileSync(join(sources, "SUPPLEMENTAL_NOTICES.json"), "utf8"))]) {
  assert.equal(hash(join(sources, record.path)), record.sha256, `Source changed after verification: ${record.path}`);
}
const licenses = JSON.parse(readFileSync(join(sources, "DEPENDENCY_LICENSE_INVENTORY.json"), "utf8"));
assert.ok(licenses.every((p: { licenseFiles: string[]; supplemental?: string[] }) => p.licenseFiles.length || p.supplemental?.length), "Unresolved notice");
const node = join(repo, "runtime/node.exe"), nodeLicense = join(repo, "runtime/LICENSE");
assert.equal(hash(node), "dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f");
assert.ok(existsSync(nodeLicense));
const nodeSourceLicense = execFileSync("tar", ["-xOf", join(sources, "node/node-v22.23.4.tar.xz"), "node-v22.23.4/LICENSE"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
assert.equal(readFileSync(nodeLicense, "utf8").replaceAll("\r\n", "\n"), nodeSourceLicense.replaceAll("\r\n", "\n"));
const version = process.argv[5];
if (version) {
  assert.match(version, /^v\d+\.\d+\.\d+-beta\.[1-9]\d*$/);
  assert.equal(version.split("-")[0], `v${JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version}`, "Beta version must match the application base version");
}
const name = version ? `ParaBus-windows-x64-${version}` : `ParaBus-review-windows-x64-${commit.slice(0, 12)}`;
mkdirSync(output, { recursive: true });
const handoff = join(output, name), app = join(handoff, "ParaBus"), source = join(output, "corresponding-source");
mkdirSync(handoff); mkdirSync(source);
// The clean CI input may live outside a newly initialized public-source checkout.
// Verify before copying into an isolated, repository-local staging directory.
const rustSource = join(base, "bin/router-core.exe");
assert.equal(hash(rustSource), nativeLock.binaries.find(entry => entry.path === "bin/router-core.exe")?.sha256);
mkdirSync(join(repo, "target"), { recursive: true });
const rustStage = mkdtempSync(join(repo, "target/native-reuse-"));
cpSync(rustSource, join(rustStage, "router-core.exe"));
const stage = stageRelease(repo, { rustBinaryPath: join(rustStage, "router-core.exe") });
cpSync(stage.stageDirectory, app, { recursive: true, errorOnExist: true });
for (const path of ["node_modules", "native-source", "ParaBus.exe"]) cpSync(join(base, path), join(app, path), { recursive: true, errorOnExist: true });
const packageLock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
const javaScriptUpdates = overlayJavaScriptUpdates(app, sources, packageLock);
rmSync(join(app, "node_modules/.package-lock.json"), { force: true });
cpSync(join(repo, "docs/ASIO_PACKAGE.txt"), join(app, "native-source/README-ASIO.txt"));
omitCrashDiagnostics(app);
mkdirSync(join(app, "runtime")); cpSync(node, join(app, "runtime/node.exe")); cpSync(nodeLicense, join(app, "runtime/NODE_LICENSE"));
const nodeInfo = { version: "22.23.4", abi: 127, sourceArchiveUrl: "https://nodejs.org/dist/v22.23.4/node-v22.23.4-win-x64.zip", archiveSha256: "cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20", executableSha256: hash(node), licenseSha256: hash(nodeLicense) };
json(join(app, "runtime/node-provenance.json"), nodeInfo);
json(join(app, "release-build-info.json"), { schemaVersion: 1, buildCommit: commit, ...(version ? { releaseVersion: version } : {}), nodeVersion: "22.23.4", nativeBuildCommit: baseCommit, assembly: version ? "public-beta-package" : "individual-review-package" });
const binaries = files(app).filter(path => /\.(exe|dll|node|lib)$/i.test(path));
for (const path of binaries.filter(p => p !== "runtime/node.exe")) assert.equal(hash(join(app, path)), hash(join(base, path)), `Unexpected binary change: ${path}`);
for (const entry of nativeLock.binaries) assert.equal(hash(join(app, entry.path)), entry.sha256, `Unreviewed native artifact: ${entry.path}`);
const asio = JSON.parse(readFileSync(join(app, "native-source/asio-build-info.json"), "utf8"));
for (const [path, checksum] of [["native-source/asiosdk.zip", asio.sdkSha256], ["native-source/portaudio-source.zip", asio.portAudioSourceSha256], ["native-source/patched_asiolist.cpp", asio.patchedAsioListSha256], ["node_modules/naudiodon2/build/Release/portaudio_x64.dll", asio.dllSha256], ["node_modules/naudiodon2/build/Release/naudiodon.node", asio.bindingSha256]]) assert.equal(hash(join(app, path)), checksum);
const davePath = "node_modules/@snazzah/davey-win32-x64-msvc/davey.win32-x64-msvc.node";
assert.equal(hash(join(app, davePath)), "42928bfbee406f747e67cceb0bdb493f7a56b1f63101bf13d084527576dd84a5");
const daveNpm = join(sources, "npm/@snazzah__davey-win32-x64-msvc-0.1.12.tgz");
const daveBytes = execFileSync("tar", ["-xOf", daveNpm, "package/davey.win32-x64-msvc.node"], { maxBuffer: 32 * 1024 * 1024 });
assert.equal(createHash("sha256").update(daveBytes).digest("hex"), hash(join(app, davePath)));
const binaryOrigin = (path: string) => {
  if (path === "runtime/node.exe") return { kind: "official-node-runtime", upstreamVersion: "22.23.4" };
  const packagePath = path.startsWith("node_modules/@discordjs/opus/") ? "node_modules/@discordjs/opus"
    : path.startsWith("node_modules/@snazzah/davey-win32-x64-msvc/") ? "node_modules/@snazzah/davey-win32-x64-msvc" : null;
  if (packagePath) {
    const entry = packageLock.packages[packagePath];
    return { kind: "upstream-native-package", retrievedFromArtifactCommit: baseCommit,
      package: { name: packagePath.slice(13), version: entry.version, sourceArchiveUrl: entry.resolved, sourceArchiveIntegrity: entry.integrity },
      note: "Archived upstream package sources supplied; this is not a ParaBus source commit or proof of bit-reproducible build." };
  }
  return { kind: "ci-built-native", retrievedFromArtifactCommit: baseCommit, sourceInputs: "corresponding-source.zip:corresponding-source/binary-origin/native-input-lock.json" };
};
json(join(app, "component-provenance.json"), { schemaVersion: 2, applicationSourceCommit: commit, javaScriptUpdates, assembledAt: new Date().toISOString(), node: nodeInfo, nativeOrigin: { artifactCommit: baseCommit, workflowRun: nativeLock.workflowRun, workflowRunVisibility: "private", note: "Archived CI link requires private-repository access. Unchanged native components reused; not rebuilt on this PC. Supplied source bytes are verified after normalizing CRLF to LF, without requiring access to legacy Git history. Node ABI 127 retained." }, omitted: ["segfault-handler", "StackWalker crash hook"], binaries: binaries.map(path => ({ path, sha256: hash(join(app, path)), ...binaryOrigin(path) })) });
cpSync(join(sources, "THIRD_PARTY_ARCHIVE_NOTICES.txt"), join(app, "THIRD_PARTY_ARCHIVE_NOTICES.txt"));
cpSync(join(sources, "DEPENDENCY_LICENSE_INVENTORY.json"), join(app, "DEPENDENCY_LICENSE_INVENTORY.json"));
cpSync(join(repo, "docs/WINDOWS_BETA.txt"), join(handoff, "README-FIRST.txt"));
cpSync(join(repo, "docs/WINDOWS_BETA.txt"), join(app, "README-FIRST.txt"));
const appSource = stageRelease(repo, { sourceOnly: true });
cpSync(appSource.stageDirectory, join(source, "app"), { recursive: true });
cpSync(sources, source, { recursive: true });
cpSync(join(app, "native-source"), join(source, "native-source"), { recursive: true });
cpSync(join(app, "component-provenance.json"), join(source, "component-provenance.json"));
const nativeSourceCommit = nativeLock.artifactSourceCommit ?? "HEAD";
if (nativeSourceCommit !== "HEAD") assert.match(nativeSourceCommit, /^[a-f0-9]{40}$/);
verifyArtifactSourceInputs(nativeLock, path => execFileSync("git", ["show", `${nativeSourceCommit}:${path}`], { cwd: repo }));
const priorFiles = [...(nativeLock.artifactSourceInputs ?? nativeLock.sourceInputs).map(entry => entry.path), ...(nativeLock.artifactDependencyManifests ?? nativeLock.dependencyManifests).map(entry => entry.path), "LICENSE"];
auditReleaseEntries(priorFiles, true);
mkdirSync(join(source, "binary-origin"));
execFileSync("git", ["archive", "--format=zip", `--output=${join(source, "binary-origin", "verified-native-source-inputs.zip")}`, nativeSourceCommit, "--", ...priorFiles], { cwd: repo });
writeFileSync(join(source, "binary-origin/native-input-lock.json"), execFileSync("git", ["show", `${nativeSourceCommit}:release/native-input-lock.json`], { cwd: repo }));
writeFileSync(join(source, "binary-origin/README.txt"), "Legacy private native artifact commit: " + baseCommit + "\nThe archive contains build inputs from the public baseline 28d27a491d21eee718237af1bcbf7c334ed9447f verified against the original CI sources. Current application dependencies and packaging documentation are supplied separately in app/. Normalize CRLF line endings to LF before computing source text SHA-256 values in native-input-lock.json; Windows script entries may be archived with CRLF. The archived CI URL requires private-repository access; all required source inputs are supplied here without that access. The original private Git history is not required or supplied. This is source correspondence, not an independent native rebuild.\n");
cpSync(join(repo, "docs/CORRESPONDING_SOURCE.txt"), join(source, "README.txt"));
json(join(source, "SOURCE_INVENTORY.json"), { applicationSourceCommit: commit, binaryOriginCommit: baseCommit, files: files(source).map(path => ({ path, sha256: hash(join(source, path)) })) });
const forbidden = /(^|\/)(?:\.env|discord-bots\.json|user-profiles\.json|receiver-owners\.json|scenes\.json|tokens\.json|secrets\.json|credentials\.json|\.git|logs|recordings|support|segfault-handler)(\/|$)/i;
for (const path of [...files(app), ...files(source)]) assert.ok(!forbidden.test(path), `Private/omitted runtime data in artifact: ${path}`);
const textExtensions = /\.(?:ts|js|json|txt|md|html|ps1|cmd|command|sh|yml|toml|lock)$/i;
let scanned = 0;
for (const [folder, paths] of [[app, files(app)], [join(source, "app"), files(join(source, "app"))]] as const) for (const path of paths.filter(p => textExtensions.test(p))) {
  const text = readFileSync(join(folder, path), "utf8"); scanned++;
  // Do not print matches: a failed audit must never log a discovered credential.
  assert.ok(!/-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----|(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}|\b(?:mfa\.[\w-]{40,}|[\w-]{24,30}\.[\w-]{6}\.[\w-]{27,})\b/.test(text), `Credential-shaped content found in ${path}`);
}
// Replace the source-stage-only inventories after adding runtime components.
for (const path of ["release-manifest-lock.json", "release-audit.json"]) rmSync(join(app, path));
json(join(app, "release-manifest-lock.json"), { files: files(app).map(path => ({ path, sha256: hash(join(app, path)) })) });
json(join(app, "release-audit.json"), { schemaVersion: 1, entries: files(app), credentialsScannedFiles: scanned, omittedCrashDiagnostics: true });
function zip(directory: string, destination: string) { execFileSync("tar", ["-a", "-cf", destination, "-C", dirname(directory), basename(directory)], { stdio: "inherit" }); }
zip(source, join(handoff, "corresponding-source.zip"));
writeFileSync(join(handoff, "SHA256SUMS.txt"), `${hash(join(handoff, "corresponding-source.zip"))}  corresponding-source.zip\n` + files(app).map(path => `${hash(join(app, path))}  ParaBus/${path}`).join("\n") + "\n");
const archive = join(output, `${name}.zip`); zip(handoff, archive);
writeFileSync(join(output, "SHA256SUMS.txt"), `${hash(archive)}  ${basename(archive)}\n`);
json(join(output, "package-info.json"), { commit, nativeCommit: baseCommit, name, app, handoff, archive, sha256: hash(archive), javaScriptUpdates, sourceFiles: files(source).length, runtimeFiles: files(app).length, credentialsScannedFiles: scanned });
console.log(readFileSync(join(output, "package-info.json"), "utf8"));

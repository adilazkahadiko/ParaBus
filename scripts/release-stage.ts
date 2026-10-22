import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32 } from "node:zlib";

export interface ReleaseManifest {
  schemaVersion: 1;
  files: string[];
  prefixes: string[];
  source?: { files: string[]; prefixes: string[] };
}

export interface ReleaseStageResult {
  stageDirectory: string;
  entries: string[];
  archivePath?: string;
}

interface StageOptions {
  buildCommit?: string;
  sourceOnly?: boolean;
  trackedFiles?: readonly string[];
  unstagedFiles?: readonly string[];
  stagedFiles?: readonly string[];
  rustBinaryPath?: string;
  platform?: NodeJS.Platform;
}

const MANIFEST_PATH = "release/release-manifest.json";
const ENV_EXAMPLE = ".env.example";
const OPTIONAL_PUBLIC_FILES = new Set(["LICENSE", "LICENSE.md", "LICENSE.txt"]);
const FORBIDDEN_DIRECTORIES = new Set([".git", "logs", "recordings", "node_modules", "target"]);
const FORBIDDEN_SECRET_FILES = new Set([
  ".env", "discord-bots.json", "tokens.json", "secrets.json", "credentials.json", "id_rsa", "id_ed25519",
  "user-profiles.json", "receiver-owners.json", "scenes.json",
]);
const FORBIDDEN_SECRET_EXTENSIONS = new Set([".key", ".pem", ".pfx", ".p12", ".crt", ".cer", ".log"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".js", ".css", ".html", ".json", ".md", ".toml", ".lock", ".rs", ".cmd", ".command", ".ps1", ".sh", ".txt", ".yml"]);
const SOURCE_ROOT_FILES = new Set([".env.example", ".gitattributes", ".gitignore", ".nvmrc", "LICENSE"]);

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.includes(`..${sep}`));
}

function validateRelativePath(value: string): void {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") || value.includes("//")) {
    throw new Error("release manifest contains an invalid relative path");
  }
  const parts = value.split("/");
  if (parts.some((part) => (
    part === "." || part === ".." || part.endsWith(".") || part.endsWith(" ")
    || /[<>:"|?*\0]/.test(part) || !/^[A-Za-z0-9._-]+$/.test(part)
  ))) {
    throw new Error("release manifest contains a traversal or unsafe path segment");
  }
}

function assertSafeEntryName(relativePath: string): void {
  const parts = relativePath.split("/");
  const name = basename(relativePath).toLowerCase();
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (FORBIDDEN_DIRECTORIES.has(parts[index].toLowerCase())) {
      throw new Error("release artifact contains a forbidden directory entry");
    }
  }
  if (FORBIDDEN_SECRET_FILES.has(name) || (name.startsWith(".env.") && name !== ENV_EXAMPLE)) {
    throw new Error("release artifact contains a forbidden environment or secret entry");
  }
  if (FORBIDDEN_SECRET_EXTENSIONS.has(name.slice(name.lastIndexOf(".")))) {
    throw new Error("release artifact contains a forbidden secret extension");
  }
}

function sourcePath(root: string, relativePath: string): string {
  validateRelativePath(relativePath);
  const candidate = resolve(root, relativePath);
  if (!inside(root, candidate)) throw new Error("release source escapes the repository");
  const stats = lstatSync(candidate);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("release source must be a regular non-reparse file");
  const real = realpathSync(candidate);
  if (!inside(root, real)) throw new Error("release source realpath escapes the repository");
  return candidate;
}

function destinationPath(stage: string, relativePath: string): string {
  validateRelativePath(relativePath);
  assertSafeEntryName(relativePath);
  const candidate = resolve(stage, relativePath);
  if (!inside(stage, candidate)) throw new Error("release destination escapes the stage");
  return candidate;
}

function trackedFiles(root: string): string[] {
  const output = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "buffer" });
  return output.toString("utf8").split("\0").filter(Boolean);
}

function unstagedFiles(root: string): string[] {
  const output = execFileSync("git", ["-C", root, "diff", "--name-only", "-z", "--"], { encoding: "buffer" });
  return output.toString("utf8").split("\0").filter(Boolean);
}

export function readReleaseManifest(root: string): ReleaseManifest {
  const manifestPath = sourcePath(root, MANIFEST_PATH);
  const candidate = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<ReleaseManifest>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.files) || !Array.isArray(candidate.prefixes)) {
    throw new Error("release manifest schema is invalid");
  }
  for (const path of [...candidate.files, ...candidate.prefixes]) validateRelativePath(path);
  if (candidate.source !== undefined) {
    if (!candidate.source || !Array.isArray(candidate.source.files) || !Array.isArray(candidate.source.prefixes)) {
      throw new Error("source manifest schema is invalid");
    }
    for (const path of [...candidate.source.files, ...candidate.source.prefixes]) validateRelativePath(path);
  }
  return { schemaVersion: 1, files: [...candidate.files], prefixes: [...candidate.prefixes], source: candidate.source };
}

function allowlisted(manifest: Pick<ReleaseManifest, "files" | "prefixes">, relativePath: string): boolean {
  return relativePath === MANIFEST_PATH
    || manifest.files.includes(relativePath)
    || OPTIONAL_PUBLIC_FILES.has(relativePath)
    || manifest.prefixes.some((prefix) => relativePath.startsWith(`${prefix}/`));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function rejectUnstagedAllowedFiles(allowed: readonly string[], unstaged: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (unstaged.some((entry) => allowedSet.has(entry))) {
    throw new Error("allowlisted release source has unstaged changes");
  }
}

/** Standard stored ZIP: built-in CRC32, no external archiver or runtime dependency. */
function writeReleaseZip(directory: string, entries: string[], path: string): void {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0, centralBytes = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry, "utf8"), bytes = readFileSync(resolve(directory, entry));
    if (offset + bytes.length + name.length + 30 > 0xffffffff || name.length > 0xffff) throw new Error("release exceeds standard ZIP capacity");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); // DOS date: 1980-01-01, deterministic archive headers.
    header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(33, 14); record.writeUInt32LE(crc32(bytes), 16); record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, name); centralBytes += record.length + name.length;
    offset += header.length + name.length + bytes.length;
  }
  if (entries.length > 0xffff || offset + centralBytes > 0xffffffff) throw new Error("release exceeds standard ZIP capacity");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(`${path}-pending`, Buffer.concat([...local, ...central, end]));
  renameSync(`${path}-pending`, path);
}

function rustManagementBinary(root: string, options: StageOptions): { source: string; entry: string } {
  const platform = options.platform ?? process.platform;
  const executable = platform === "win32" ? "router-core.exe" : "router-core";
  if (!options.rustBinaryPath) {
    execFileSync("cargo", ["build", "--release", "--bin", "router-core"], { cwd: root, stdio: "inherit" });
  }
  const candidate = resolve(options.rustBinaryPath ?? resolve(root, "target", "release", executable));
  if (!inside(root, candidate)) throw new Error("Rust management binary must be built inside the repository");
  const stats = lstatSync(candidate);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Rust management binary must be a regular non-reparse file");
  const real = realpathSync(candidate);
  if (!inside(root, real)) throw new Error("Rust management binary realpath escapes the repository");
  return { source: candidate, entry: `bin/${executable}` };
}

function stageEntries(directory: string, prefix = ""): string[] {
  const entries: string[] = [];
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.isSymbolicLink()) throw new Error("release stage contains a symlink or reparse point");
    if (child.isFile()) entries.push(relativePath);
    else if (child.isDirectory()) entries.push(...stageEntries(resolve(directory, child.name), relativePath));
    else throw new Error("release stage contains an unsupported entry");
  }
  return entries;
}

export function auditReleaseEntries(entries: readonly string[], sourceOnly = false): void {
  for (const entry of entries) {
    validateRelativePath(entry);
    assertSafeEntryName(entry);
    if (sourceOnly && !SOURCE_ROOT_FILES.has(entry) && !SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")).toLowerCase())) {
      throw new Error("source artifact contains a binary or unsupported source entry");
    }
  }
}

export function stageRelease(root = resolve(import.meta.dirname, ".."), options: StageOptions = {}): ReleaseStageResult {
  const repository = realpathSync(root);
  const tracked = options.trackedFiles ? [...options.trackedFiles] : trackedFiles(repository);
  if (!tracked.includes(MANIFEST_PATH)) throw new Error("release manifest is not tracked");
  const manifest = readReleaseManifest(repository);
  const selection = options.sourceOnly ? manifest.source : manifest;
  if (!selection) throw new Error("source manifest is missing");
  if (options.sourceOnly && selection.files.some((entry) => !tracked.includes(entry))) {
    throw new Error("source manifest required file is not tracked");
  }
  const allowed = tracked.filter((entry) => allowlisted(selection, entry)).sort();
  auditReleaseEntries(allowed, options.sourceOnly);
  rejectUnstagedAllowedFiles(allowed, options.unstagedFiles ?? unstagedFiles(repository));
  const staged = options.stagedFiles ?? (options.trackedFiles ? [] : execFileSync("git", ["-C", repository, "diff", "--cached", "--name-only", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean));
  if (staged.some((entry) => allowed.includes(entry))) throw new Error("allowlisted release source has staged changes; commit before release");
  const buildCommit = options.buildCommit ?? execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(buildCommit)) throw new Error("release build commit is invalid");
  const managementBinary = options.sourceOnly ? null : rustManagementBinary(repository, options);
  const stageParent = resolve(repository, "target", options.sourceOnly ? "source-stage" : "release-stage");
  if (!inside(repository, stageParent)) throw new Error("release stage must remain inside the repository");
  mkdirSync(stageParent, { recursive: true });
  const stageId = `stage-${process.pid}-${Date.now()}-${randomUUID()}`;
  const pending = resolve(stageParent, `${stageId}-pending`);
  const stage = resolve(stageParent, stageId);
  if (!inside(stageParent, pending) || !inside(stageParent, stage)) throw new Error("release stage path is invalid");
  mkdirSync(pending);
  const hashes: Array<{ path: string; sha256: string }> = [];
  for (const entry of allowed) {
    const source = sourcePath(repository, entry);
    if (options.sourceOnly) {
      const bytes = readFileSync(source);
      // ponytail: UTF-8 text gate, not a secret scanner; contents still require pre-publication review.
      if (bytes.includes(0)) throw new Error("source artifact contains binary content");
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    const destination = destinationPath(pending, entry);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    hashes.push({ path: entry, sha256: sha256(destination) });
  }
  if (managementBinary) {
    const binaryDestination = destinationPath(pending, managementBinary.entry);
    mkdirSync(dirname(binaryDestination), { recursive: true });
    copyFileSync(managementBinary.source, binaryDestination);
    hashes.push({ path: managementBinary.entry, sha256: sha256(binaryDestination) });
  }
  const buildInfoPath = resolve(pending, "release-build-info.json");
  writeFileSync(buildInfoPath, `${JSON.stringify({ schemaVersion: 1, buildCommit }, null, 2)}\n`, "utf8");
  hashes.push({ path: "release-build-info.json", sha256: sha256(buildInfoPath) });
  writeFileSync(resolve(pending, "release-manifest-lock.json"), `${JSON.stringify({ manifest: MANIFEST_PATH, files: hashes }, null, 2)}\n`, "utf8");
  const expectedEntries = [...stageEntries(pending), "release-audit.json"].sort();
  auditReleaseEntries(expectedEntries, options.sourceOnly);
  writeFileSync(resolve(pending, "release-audit.json"), `${JSON.stringify({ schemaVersion: 1, entries: expectedEntries }, null, 2)}\n`, "utf8");
  const auditedEntries = stageEntries(pending).sort();
  if (JSON.stringify(auditedEntries) !== JSON.stringify(expectedEntries)) throw new Error("release audit entry list is incomplete");
  auditReleaseEntries(auditedEntries, options.sourceOnly);
  rejectUnstagedAllowedFiles(allowed, options.unstagedFiles ?? unstagedFiles(repository));
  if (options.sourceOnly && hashes.some((file) => file.path !== "release-build-info.json" && sha256(sourcePath(repository, file.path)) !== file.sha256)) {
    throw new Error("source changed while preparing the artifact");
  }
  renameSync(pending, stage);
  if (options.sourceOnly) return { stageDirectory: stage, entries: auditedEntries };
  const archivePath = resolve(stageParent, `ParaBus-${options.platform ?? process.platform}-${process.arch}-${buildCommit.slice(0, 12)}-${stageId}.zip`);
  writeReleaseZip(stage, auditedEntries, archivePath);
  return { stageDirectory: stage, entries: auditedEntries, archivePath };
}

function invokedDirectly(): boolean {
  return process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (invokedDirectly()) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--source-only")) throw new Error("unknown release stage option");
  const result = stageRelease(undefined, { sourceOnly: arguments_.includes("--source-only") });
  console.log(JSON.stringify({ ...result, entryCount: result.entries.length }, null, 2));
}

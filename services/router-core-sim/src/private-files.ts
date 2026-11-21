import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const PRIVATE_FILE_WARNING = "設定ファイルの保存またはアクセス権の保護に失敗しました。保存先の権限を確認してください。音声と運用は継続します。";
export class PrivateFileError extends Error {
  constructor() { super("設定ファイルのアクセス権を保護できないため、保存を中止しました。保存先の権限を確認してください。"); }
}
const windowsTool = (name: string) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
const powershell = () => windowsTool("WindowsPowerShell/v1.0/powershell.exe");
// Never inherit Bot credentials into permission helpers, or put contents/hashes in arguments.
function helperEnvironment(path?: string): NodeJS.ProcessEnv {
  return { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", PATH: windowsTool(""),
    ...(path ? { PARABUS_PERMISSION_PATH: path } : {}) };
}
const sidScript = "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value";
const aclScript = "$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:PARABUS_PERMISSION_PATH; "
  + "ConvertTo-Json -Compress -InputObject @($a.Access | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value })";
function psArgs(script: string) { return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]; }
let currentSid: string | undefined;
function validSid(value: string): string { const sid = value.trim(); if (!/^S-\d+(?:-\d+)+$/.test(sid)) throw new PrivateFileError(); return sid; }
function ownerSid(): string {
  return currentSid ??= validSid(execFileSync(powershell(), psArgs(sidScript), { encoding: "utf8", windowsHide: true, env: helperEnvironment(), stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }));
}
async function ownerSidAsync(): Promise<string> {
  if (currentSid) return currentSid;
  const { stdout } = await execute(powershell(), psArgs(sidScript), { windowsHide: true, env: helperEnvironment(), timeout: 10_000 });
  return currentSid = validSid(stdout);
}
function aclArguments(path: string, sid: string, directory: boolean, remove: string[] = []) {
  return [path, "/inheritance:r", "/grant:r", `*${sid}:${directory ? "(OI)(CI)F" : "F"}`,
    ...(remove.length ? ["/remove:g", ...remove.map(s => `*${validSid(s)}`)] : [])];
}
function assertNoReparseParents(path: string): void {
  if (process.platform !== "win32") return;
  for (let current = resolve(path); ; current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw new PrivateFileError(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (dirname(current) === current) return;
  }
}

/** A newly created empty temporary file has no explicit grants to preserve. */
export function restrictPrivatePathSync(path: string, directory = false): void {
  if (process.platform !== "win32") return;
  assertNoReparseParents(path);
  if (lstatSync(path).isSymbolicLink()) throw new PrivateFileError();
  execFileSync(windowsTool("icacls.exe"), aclArguments(path, ownerSid(), directory),
    { windowsHide: true, env: helperEnvironment(), stdio: "ignore", timeout: 10_000 });
}
export async function restrictPrivatePath(path: string, directory = false): Promise<void> {
  if (process.platform !== "win32") return;
  assertNoReparseParents(path);
  if ((await lstat(path)).isSymbolicLink()) throw new PrivateFileError();
  await execute(windowsTool("icacls.exe"), aclArguments(path, await ownerSidAsync(), directory),
    { windowsHide: true, env: helperEnvironment(), timeout: 10_000 });
}

export function writePrivateFileSync(path: string, content: string, restrict = restrictPrivatePathSync): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    assertNoReparseParents(dirname(path));
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
    restrict(temporary); // Restrict while still empty, before writing any secret.
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } catch { throw new PrivateFileError(); }
  finally { rmSync(temporary, { force: true }); }
}
export async function writePrivateFile(path: string, content: string, restrict = restrictPrivatePath): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    assertNoReparseParents(dirname(path));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
    await restrict(temporary);
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch { throw new PrivateFileError(); }
  finally { await rm(temporary, { force: true }); }
}

async function allowedSids(path: string): Promise<string[]> {
  const { stdout } = await execute(powershell(), psArgs(aclScript), { windowsHide: true, env: helperEnvironment(path), timeout: 10_000 });
  const values: unknown = JSON.parse(stdout);
  if (!Array.isArray(values) || values.some(v => typeof v !== "string" || !/^S-\d+(?:-\d+)+$/.test(v))) throw new PrivateFileError();
  return values as string[];
}

/** Repair an existing path; explicit grants as well as inherited broad grants are removed. */
export async function protectPrivatePath(path: string): Promise<void> {
  if (process.platform !== "win32") return;
  assertNoReparseParents(path);
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new PrivateFileError();
  const allows = await allowedSids(path);
  const sid = await ownerSidAsync();
  // Directories need OI/CI even when an older owner-only ACE did not propagate.
  if (stat.isDirectory() || !allows.includes(sid) || allows.some(s => s !== sid)) {
    await execute(windowsTool("icacls.exe"), aclArguments(path, sid, stat.isDirectory(), [...new Set(allows.filter(s => s !== sid))]),
      { windowsHide: true, env: helperEnvironment(), timeout: 10_000 });
    const after = await allowedSids(path);
    if (!after.includes(sid) || after.some(s => s !== sid)) throw new PrivateFileError();
  }
}

/** Check existing data without following reparse points or traversing the source tree. */
export async function protectSettingsLocations(root: string, recordingFolder: string, warn: (message: string) => void): Promise<void> {
  if (process.platform !== "win32") return;
  try { assertNoReparseParents(root); assertNoReparseParents(recordingFolder); }
  catch { warn(PRIVATE_FILE_WARNING); return; }
  const check = async (path: string, recursive = false) => {
    let stat;
    try { stat = await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    await protectPrivatePath(path);
    if (recursive && stat.isDirectory()) for (const child of await readdir(path)) {
      try { await check(join(path, child), true); } catch { warn(PRIVATE_FILE_WARNING); }
    }
  };
  try { await mkdir(root, { recursive: true, mode: 0o700 }); await check(root); } catch { warn(PRIVATE_FILE_WARNING); }
  for (const name of [".env", "discord-bots.json", "user-profiles.json", "scenes.json", "receiver-owners.json", "external-control.json"]) {
    try { await check(join(root, name)); } catch { warn(PRIVATE_FILE_WARNING); }
  }
  for (const directory of new Set([join(root, "logs"), join(root, "support"), recordingFolder])) {
    try { await mkdir(directory, { recursive: true, mode: 0o700 }); await check(directory, true); } catch { warn(PRIVATE_FILE_WARNING); }
  }
}

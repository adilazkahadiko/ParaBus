import { lstat, readdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const OPERATIONAL_FILE = /^operational-\d{4}-\d{2}-\d{2}\.jsonl$/;
export const SUPPORT_FILE = /^ParaBus-support-(?:RX|TX|MIXED|UNCONFIGURED)-(?:[a-f0-9]{12}|unknown)-\d{8}T\d{6}Z-[a-f0-9]{8}\.zip$/;

/** Fixed folders, direct regular files only. Reject junction/symlink ancestors;
 * never recurse or interpret a filename as a caller-supplied path. */
export async function deleteDirectFiles(directory: string, allowed: RegExp): Promise<number> {
  const root = resolve(directory);
  for (let current = root; ; current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("保存先の種類を確認してください"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
    if (dirname(current) === current) break;
  }
  let count = 0;
  for (const name of await readdir(root)) {
    if (!allowed.test(name)) continue;
    const path = join(root, name);
    if (dirname(resolve(path)) !== root) throw new Error("削除対象の範囲が不正です");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    await unlink(path); count++;
  }
  return count;
}

import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const marker = "// ParaBus (2026-10-13): schedule audio with a monotonic clock; retain upstream Apache-2.0 notices.\n";
const replacements = [
  ["nextTime = Date.now();", "nextTime = performance.now();"],
  ["nextTime - Date.now()", "nextTime - performance.now()"],
] as const;

export function patchDiscordVoiceSource(source: string): string {
  const alreadyPatched = source.startsWith(marker);
  for (const [original, fixed] of replacements) {
    const expected = alreadyPatched ? fixed : original;
    const forbidden = alreadyPatched ? original : fixed;
    if (source.split(expected).length !== 2 || source.includes(forbidden)) {
      throw new Error("@discordjs/voice scheduler differs from the reviewed version; patch refused");
    }
  }
  if (alreadyPatched) return source;
  for (const [original, fixed] of replacements) source = source.replace(original, fixed);
  return marker + source;
}

export function patchDiscordVoice(root = resolve(import.meta.dirname, "..")): void {
  const directory = resolve(root, "node_modules/@discordjs/voice");
  const version = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")).version;
  if (version !== "0.19.2") throw new Error("Discord audio clock patch requires @discordjs/voice 0.19.2");
  // Validate both entry points before writing either. Never patch the global Date clock.
  const files = ["index.js", "index.mjs"].map(name => {
    const path = resolve(directory, "dist", name);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Expected a regular voice entry point");
    const source = readFileSync(path, "utf8");
    return { path, source, patched: patchDiscordVoiceSource(source) };
  });
  for (const file of files) if (file.source !== file.patched) writeFileSync(file.path, file.patched);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  patchDiscordVoice();
  console.log("Discord voice monotonic audio clock ready (CJS and ESM; no device or network access)");
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const original = `  ioStream.quit = async cb => {
    await audioIOAdon.quit('WAIT');
    if (typeof cb === 'function')
      cb();
  }

  ioStream.abort = cb => {
    audioIOAdon.quit('ABORT', () => {
      if (typeof cb === 'function')
        cb();
    });
  }`;
const fixed = `  // ParaBus: one native stop, one argument, await actual device release.
  let stopPromise;
  ioStream.quit = async cb => {
    await (stopPromise ??= audioIOAdon.quit('WAIT'));
    if (typeof cb === 'function') cb();
  }
  ioStream.abort = async cb => {
    await (stopPromise ??= audioIOAdon.quit('ABORT'));
    if (typeof cb === 'function') cb();
  }`;

export function patchNaudiodonSource(source: string): string {
  const normalized = source.replaceAll("\r\n", "\n");
  if (normalized.includes(fixed)) return source;
  if (normalized.split(original).length !== 2) throw new Error("naudiodon2の停止処理が想定と違います。適用を中止しました");
  return normalized.replace(original, fixed);
}

const crashHandler = `var SegfaultHandler = require('segfault-handler');
SegfaultHandler.registerHandler("crash.log");`;
const withoutCrashHandler = "// ParaBus (2026-10-22): omit the optional segfault-handler/StackWalker crash hook.";

export function omitNaudiodonCrashHandler(source: string): string {
  const normalized = source.replaceAll("\r\n", "\n");
  if (normalized.includes(withoutCrashHandler) && !normalized.includes("require('segfault-handler')")) return source;
  if (normalized.split(crashHandler).length !== 2) throw new Error("Unexpected naudiodon2 crash hook; refusing to patch");
  return normalized.replace(crashHandler, withoutCrashHandler);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  // Optional dependency may be missing after npm ci; check:audio-native remains the gate.
  const path = resolve("node_modules/naudiodon2/index.js");
  if (existsSync(path)) {
    const version = JSON.parse(readFileSync(resolve("node_modules/naudiodon2/package.json"), "utf8")).version;
    if (version !== "2.5.0") throw new Error("停止修正はnaudiodon2 2.5.0専用です");
    const source = readFileSync(path, "utf8");
    const patched = omitNaudiodonCrashHandler(patchNaudiodonSource(source));
    if (patched !== source) writeFileSync(path, patched);
    console.log("naudiodon2 stop fix ready; optional native crash hook omitted (JS only; audio DLL unchanged)");
  }
}

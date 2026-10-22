import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkAudioNative } from "./audio-native-check.ts";

/** CI-only check: initializes PortAudio to enumerate host APIs, never starts a stream.
 * Keep this out of the normal dependency gate: enumeration may load real ASIO drivers. */
export function checkAsioHostApis(audio: { getHostAPIs(): unknown }): string[] {
  const result = audio.getHostAPIs() as { HostAPIs?: Array<{ name?: string; type?: string }> } | null;
  assert.ok(Array.isArray(result?.HostAPIs), "PortAudio host API inventory is invalid");
  assert.ok(result.HostAPIs.some((api) => api.name === "ASIO" && api.type === "ASIO"), "PortAudio ASIO backend is missing");
  assert.ok(result.HostAPIs.some((api) => api.name === "Windows WASAPI" && api.type === "WASAPI"), "PortAudio WASAPI backend is missing");
  return result.HostAPIs.map((api) => api.name ?? "unknown");
}

export function normalizedNativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return normalized.startsWith("//?/") ? normalized.slice(4) : normalized;
}

export function checkAsioLoadedDll(expectedPath: string, sharedObjects: string[]): void {
  const loaded = sharedObjects.filter((path) => /[\\/]portaudio[^\\/]*\.dll$/i.test(path));
  assert.equal(loaded.length, 1, "Expected exactly one loaded PortAudio DLL");
  assert.equal(normalizedNativePath(loaded[0]), normalizedNativePath(expectedPath), "Loaded PortAudio DLL is not the packaged ASIO build");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.platform, "win32", "Run ASIO package checks on Windows only");
  assert.equal(process.arch, "x64", "Run ASIO package checks with x64 Node.js");
  const gate = checkAudioNative();
  assert.equal(gate.state, "READY", gate.reason ?? "Native audio gate failed");
  const root = resolve(import.meta.dirname, "..");
  const moduleRoot = join(root, "node_modules/naudiodon2");
  const metadata = JSON.parse(readFileSync(join(moduleRoot, "asio-build-info.json"), "utf8"));
  assert.equal(metadata.schemaVersion, 1);
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const dll = join(moduleRoot, "build/Release/portaudio_x64.dll");
  assert.equal(hash(dll), metadata.dllSha256, "ASIO DLL checksum mismatch");
  assert.equal(hash(join(moduleRoot, "portaudio/bin/portaudio_x64.dll")), metadata.dllSha256, "Vendor DLL would revert the ASIO build on rebuild");
  assert.equal(hash(join(moduleRoot, "build/Release/naudiodon.node")), metadata.bindingSha256, "ASIO binding checksum mismatch");
  const audio = createRequire(import.meta.url)("naudiodon2");
  const hostApis = checkAsioHostApis(audio);
  const report = process.report.getReport() as { sharedObjects: string[] };
  checkAsioLoadedDll(dll, report.sharedObjects);
  console.log(JSON.stringify({ state: "READY", hostApis, loadedDllMatches: true, dllSha256: metadata.dllSha256, node: process.version }));
}

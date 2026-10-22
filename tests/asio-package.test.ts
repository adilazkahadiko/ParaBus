import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkAsioHostApis, checkAsioLoadedDll, normalizedNativePath } from "../scripts/asio-native-check.ts";

test("ASIO CI gate requires both real host API types, without opening an audio stream", () => {
  let enumerations = 0;
  const audio = {
    getHostAPIs: () => { enumerations++; return { HostAPIs: [{ name: "ASIO", type: "ASIO" }, { name: "Windows WASAPI", type: "WASAPI" }] }; },
    getDevices: () => assert.fail("device list must not be requested"),
    AudioIO: () => assert.fail("streams must not be opened"),
  };
  assert.deepEqual(checkAsioHostApis(audio), ["ASIO", "Windows WASAPI"]);
  assert.equal(enumerations, 1);
  for (const result of [null, {}, { HostAPIs: [] }, { HostAPIs: [{ name: "ASIO", type: "MME" }, { name: "Windows WASAPI", type: "WASAPI" }] }, { HostAPIs: [{ name: "ASIO", type: "ASIO" }] }]) {
    assert.throws(() => checkAsioHostApis({ getHostAPIs: () => result }));
  }
});

test("ASIO gate identifies the exact packaged DLL, accepting Windows path normalization only", () => {
  const dll = String.raw`C:\stage\node_modules\naudiodon2\build\Release\portaudio_x64.dll`;
  assert.equal(normalizedNativePath(dll), "c:/stage/node_modules/naudiodon2/build/release/portaudio_x64.dll");
  assert.equal(normalizedNativePath(String.raw`\\?\C:\stage\test.dll`), "c:/stage/test.dll");
  checkAsioLoadedDll(dll, [String.raw`\\?\C:\STAGE\node_modules\naudiodon2\build\Release\portaudio_x64.dll`, "C:/Windows/system32/kernel32.dll"]);
  assert.throws(() => checkAsioLoadedDll(dll, []));
  assert.throws(() => checkAsioLoadedDll(dll, ["C:/other/portaudio_x64.dll"]));
  assert.throws(() => checkAsioLoadedDll(dll, [dll, "C:/other/portaudio.dll"]));
  assert.throws(() => checkAsioLoadedDll(dll, ["C:/stage/portaudio_x64Xdll"]));
});

test("Windows packages build fixed ASIO inputs, re-link the binding and ship corresponding source", () => {
  const build = readFileSync(new URL("../scripts/build-windows-asio.ps1", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../.github/workflows/test-packages.yml", import.meta.url), "utf8");
  const overlay = readFileSync(new URL("../.github/workflows/windows-audio-native.yml", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../release/release-manifest.json", import.meta.url), "utf8"));
  for (const fixed of ["17967f32de95f2179e7f7caa9632a79c5d59a2ea", "ASIO-SDK_2.3.4_2025-10-15.zip", "d5ebf0c20dd2c5f43771fd0c1418f4b361bf52434ee670097cfa6b3a335e2eca", "61e56814f24b32216884b2db0b4dcc317111a5ab354d54d19dd9fc13d71b1c7a"]) assert.ok(build.includes(fixed));
  for (const part of ["-DPA_USE_ASIO=ON", "-DPA_USE_WASAPI=ON", "-DCMAKE_RELEASE_POSTFIX=_x64", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded", "common/asio.cpp.obj", "host/asiodrivers.cpp.obj", "patched_asiolist.cpp.obj", "rebuild --release --arch=x64", "portaudio-source.zip", "COPYING-GPL-3.0"]) assert.ok(build.includes(part), part);
  assert.ok(build.indexOf("Copy-Item -LiteralPath $dll, $lib") < build.indexOf("rebuild --release --arch=x64"), "import library is installed before rebuilding the binding");
  assert.match(workflow, /name: Build Windows ASIO backend\s+if: runner\.os == 'Windows'/);
  assert.equal((workflow.match(/scripts\/asio-native-check\.ts/g) ?? []).length, 2, "check before and after self-contained package assembly");
  assert.match(workflow, /cp -R target\/windows-asio\/source-bundle "\$dist\/native-source"/);
  assert.match(overlay, /run: \.\/scripts\/build-windows-asio\.ps1/);
  assert.match(overlay, /node\.exe scripts\/asio-native-check\.ts/);
  assert.match(overlay, /naudiodon2\\asio-build-info\.json/);
  for (const entry of [String.raw`naudiodon2\portaudio\bin\portaudio_x64.dll`, String.raw`naudiodon2\portaudio\bin\portaudio_x64.lib`, String.raw`naudiodon2\portaudio\include\portaudio.h`]) assert.ok(overlay.includes(entry), "overlay must not restore the old vendor library");
  assert.match(overlay, /source-bundle.*-Destination.*native-source/);
  for (const entry of ["scripts/asio-native-check.ts", "scripts/build-windows-asio.ps1"]) assert.ok(manifest.files.includes(entry));
});

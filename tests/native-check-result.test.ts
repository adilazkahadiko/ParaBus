import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyNativeFailure, nativeCheckGuidance } from "../scripts/native-check-result.ts";
import { checkAudioNative } from "../scripts/audio-native-check.ts";
import { checkOpusNative } from "../scripts/opus-native-check.ts";

test("native failure classification prioritizes Win32 codes and recognizes localized fallback text", () => {
  for (const error of [{ code: "ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION" }, { errno: 4551 }, { win32Code: "4551" }, { hresult: 0x800711c7 | 0 }, { cause: { nativeErrorCode: "0x11c7" } }]) {
    assert.deepEqual(classifyNativeFailure(error, "win32"), { classification: "APP_CONTROL_BLOCKED", classificationSource: "WINDOWS_ERROR_CODE" });
  }
  for (const message of ["An Application Control policy has blocked this file.\r\nC:\\private\\binding.node", "アプリケーション制御ポリシーによってこのファイルがブロックされました。"] ) {
    assert.deepEqual(classifyNativeFailure(Object.assign(new Error(message), { code: "ERR_DLOPEN_FAILED" }), "win32"), { classification: "APP_CONTROL_BLOCKED", classificationSource: "MESSAGE" });
  }
  assert.equal(classifyNativeFailure(Object.assign(new Error("An Application Control policy has blocked this file."), { errno: 4551 }), "win32").classificationSource, "WINDOWS_ERROR_CODE");
  for (const message of ["DLL not found", "Access denied", "not a valid Win32 application", "The specified module could not be found"]) assert.equal(classifyNativeFailure(new Error(message), "win32").classification, "NATIVE_LOAD_FAILED");
  assert.equal(classifyNativeFailure({ errno: 4551 }, "linux").classification, "NATIVE_LOAD_FAILED");
  assert.equal(classifyNativeFailure({ errno: 2 ** 32 + 4551 }, "win32").classification, "NATIVE_LOAD_FAILED");
  const manifest = JSON.parse(readFileSync(new URL("../release/release-manifest.json", import.meta.url), "utf8"));
  assert.ok(manifest.files.includes("scripts/native-check-result.ts"), "bundled CLI checks need their classification helper");
});

test("audio and Opus checks retain classification and guidance for blocked, ordinary failure and success", () => {
  const forbidden = () => assert.fail("no device enumeration or streams");
  const audio = { getDevices: forbidden, getHostAPIs: forbidden, SampleFormatFloat32: 1, AudioIO: () => {
    // ParaBus: one native stop
    forbidden();
  } };
  const opus = { OpusEncoder: class { constructor(rate: number, channels: number) { assert.equal(rate, 48000); assert.equal(channels, 1); } decode() { return Buffer.alloc(1920); } } };
  for (const [check, module] of [[checkAudioNative, audio], [checkOpusNative, opus]] as const) {
    const ready = check(() => module, "win32");
    assert.equal(ready.state, "READY"); assert.equal(ready.classification, null); assert.equal(nativeCheckGuidance(ready.classification), null);
    const ordinary = check(() => { throw new Error("missing DLL"); }, "win32");
    assert.equal(ordinary.classification, "NATIVE_LOAD_FAILED"); assert.match(nativeCheckGuidance(ordinary.classification)!, /ZIP版.*新しいフォルダー/);
    const blocked = check(() => { throw new Error("An Application Control policy has blocked this file."); }, "win32");
    assert.equal(blocked.classification, "APP_CONTROL_BLOCKED"); assert.equal(blocked.classificationSource, "MESSAGE");
    assert.match(nativeCheckGuidance(blocked.classification)!, /再導入では解決しません/);
    assert.doesNotMatch(nativeCheckGuidance(blocked.classification)!, /SOURCE_RELEASE/);
  }
});

test("tray chooses a dedicated block notification, ZIP guidance for ordinary failures and none for success", { skip: process.platform !== "win32" }, () => {
  const tray = readFileSync(new URL("../scripts/router-tray.ps1", import.meta.url), "utf8");
  const helper = tray.match(/function Get-DependencyFailureNotification \{[\s\S]*?\r?\n\}/)![0];
  const invoke = (code: number, output: string) => {
    const command = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${helper}\nGet-DependencyFailureNotification ${code} '${output.replaceAll("'", "''")}' | ConvertTo-Json -Compress`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  };
  assert.equal(invoke(0, '{"state":"READY","classification":null}'), null);
  const ordinary = invoke(1, '{"state":"UNAVAILABLE","classification":"NATIVE_LOAD_FAILED"}');
  assert.equal(ordinary.Title, "音声部品を読み込めません"); assert.match(ordinary.Message, /ZIP版/); assert.doesNotMatch(ordinary.Message, /SOURCE_RELEASE/);
  const blocked = invoke(1, 'not JSON\n{"state":"READY","classification":null}\n{"state":"UNAVAILABLE","classification":"APP_CONTROL_BLOCKED"}');
  assert.equal(blocked.Title, "Windowsのアプリ制御が音声部品をブロックしました"); assert.match(blocked.Message, /再導入では解決しません/); assert.match(blocked.Message, /保護設定は変更しないでください/);
  assert.equal(invoke(1, "unknown failure").Title, ordinary.Title);
});

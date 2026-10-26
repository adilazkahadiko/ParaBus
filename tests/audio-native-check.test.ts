import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkAudioNative } from "../scripts/audio-native-check.ts";

test("native audio gate rejects missing/invalid bindings and never enumerates or opens devices", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(pkg.devDependencies["node-gyp"], "12.1.0");
  assert.equal(lock.packages["node_modules/node-gyp"].version, "12.1.0");
  const forbidden = () => { assert.fail("the dependency check must not touch devices"); };
  const audio = { getDevices: forbidden, getHostAPIs: forbidden, AudioIO: () => {
    // ParaBus: one native stop
    forbidden();
  }, SampleFormatFloat32: 1 };
  assert.deepEqual(checkAudioNative((name) => {
    assert.equal(name, "naudiodon2");
    return audio;
  }), { state: "READY", reason: null, classification: null, classificationSource: null });
  assert.equal(checkAudioNative(() => { throw new Error("missing native DLL"); }).state, "UNAVAILABLE");
  assert.equal(checkAudioNative(() => ({ ...audio, AudioIO: forbidden })).state, "UNAVAILABLE", "unpatched abort is rejected before device access");
  for (const invalid of [null, {}, { ...audio, AudioIO: null }, { ...audio, SampleFormatFloat32: 2 }]) {
    assert.equal(checkAudioNative(() => invalid).state, "UNAVAILABLE");
  }
});

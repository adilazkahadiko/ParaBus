import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { patchDiscordVoice, patchDiscordVoiceSource } from "../scripts/patch-discord-voice.ts";

const fixture = "nextTime = Date.now();\nsetTimeout(step, Math.max(1, nextTime - Date.now()));\nconst heartbeat = Date.now();\n";

test("install and release paths retain the fixed-version clock patch", () => {
  const read = (path: string) => readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  const manifest = JSON.parse(read("release/release-manifest.json"));
  assert.equal(pkg.dependencies["@discordjs/voice"], "0.19.2");
  assert.equal(lock.packages[""].dependencies["@discordjs/voice"], "0.19.2");
  assert.match(pkg.scripts.postinstall, /node scripts\/patch-discord-voice.ts/);
  assert(manifest.files.includes("scripts/patch-discord-voice.ts"));
  assert(manifest.source.prefixes.includes("scripts"));
  assert(manifest.source.files.includes(".github/workflows/test-packages.yml"));
  assert.match(read(".github/workflows/test-packages.yml"), /node --test tests\/patch-discord-voice.test.ts/);
});

test("voice patch is idempotent, preserves non-audio clocks, and rejects partial or changed source", () => {
  const patched = patchDiscordVoiceSource(fixture);
  assert.equal(patchDiscordVoiceSource(patched), patched);
  assert.match(patched, /const heartbeat = Date.now\(\)/);
  for (const invalid of ["unexpected", fixture + fixture, fixture.replace("nextTime = Date.now()", "nextTime = performance.now()"), patched.replace("nextTime - performance.now()", "nextTime - Date.now()")]) {
    assert.throws(() => patchDiscordVoiceSource(invalid), /patch refused/);
  }
});

test("installer verifies version and both formats before changing files", () => {
  const root = mkdtempSync(resolve(tmpdir(), "parabus-voice-clock-"));
  const directory = resolve(root, "node_modules/@discordjs/voice");
  mkdirSync(resolve(directory, "dist"), { recursive: true });
  const pkg = resolve(directory, "package.json");
  const cjs = resolve(directory, "dist/index.js"), esm = resolve(directory, "dist/index.mjs");
  writeFileSync(pkg, '{"version":"0.19.2"}');
  writeFileSync(cjs, fixture); writeFileSync(esm, "changed upstream");
  assert.throws(() => patchDiscordVoice(root));
  assert.equal(readFileSync(cjs, "utf8"), fixture);
  writeFileSync(esm, fixture); patchDiscordVoice(root); patchDiscordVoice(root);
  assert.equal(readFileSync(cjs, "utf8"), patchDiscordVoiceSource(fixture));
  assert.equal(readFileSync(esm, "utf8"), patchDiscordVoiceSource(fixture));
  writeFileSync(pkg, '{"version":"0.20.0"}');
  assert.throws(() => patchDiscordVoice(root), /requires/);
});

for (const format of ["js", "mjs"]) {
  test(`installed voice ${format} scheduler ignores backward/forward wall-clock steps`, () => {
    const installed = readFileSync(resolve(import.meta.dirname, `../node_modules/@discordjs/voice/dist/index.${format}`), "utf8");
    const patched = patchDiscordVoiceSource(installed);
    const begin = patched.indexOf("var FRAME_LENGTH = 20;");
    const end = patched.indexOf("// src/networking/Networking.ts", begin);
    assert(begin >= 0 && end > begin, "review upstream scheduler extraction if layout changes");
    const schedule = patched.slice(begin, end);
    for (const skew of [-1514, 60000]) {
      let mono = 1000, wall = 100000, delay = 0, callback = () => {}, cancelled = false;
      const context = {
        Date: { now: () => wall }, performance: { now: () => mono }, __name: () => {},
        setImmediate: (fn: () => void) => fn(),
        setTimeout: (fn: () => void, ms: number) => { callback = fn; delay = ms; return 1; },
        clearTimeout: () => { cancelled = true; },
      };
      const harness = runInNewContext(schedule + "\n({addAudioPlayer, deleteAudioPlayer})", context);
      const player = { checkPlayable: () => true, _stepDispatch() {}, _stepPrepare() {} };
      harness.addAudioPlayer(player); assert.equal(delay, 20);
      wall += skew;
      for (let n = 0; n < 10; n++) {
        mono += 20; wall += 20; callback(); assert.equal(delay, 20);
      }
      harness.deleteAudioPlayer(player); assert.equal(cancelled, true);
      // Regression control: the old scheduler must fail this same clock-step scenario.
      mono = 1000; wall = 100000;
      const original = schedule.replaceAll("performance.now()", "Date.now()");
      const before = runInNewContext(original + "\n({addAudioPlayer})", context);
      before.addAudioPlayer(player); mono += 20; wall += 20 + skew; callback();
      assert.notEqual(delay, 20);
    }
  });
}

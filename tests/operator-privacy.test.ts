import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { stageRelease } from "../scripts/release-stage.ts";
const root = resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

test("operator guide is reachable from both HTTP and file manual, and ships in runtime and corresponding source", () => {
  assert.match(read("docs/manual.html"), /href="OPERATOR_PRIVACY\.ja\.md"/);
  assert.match(read("services/router-core-sim/src/server.ts"), /documentationFiles = new Set\([^;]*"OPERATOR_PRIVACY\.ja\.md"/);
  const manifest = JSON.parse(read("release/release-manifest.json"));
  assert.ok(manifest.files.includes("docs/OPERATOR_PRIVACY.ja.md"));
  assert.ok(manifest.source.files.includes("docs/OPERATOR_PRIVACY.ja.md"));
  assert.ok(manifest.files.includes("scripts/restrict-private-path.ts"));
  const assembly = read("scripts/assemble-review-package.ts");
  assert.ok(assembly.indexOf('app/docs/OPERATOR_PRIVACY.ja.md') < assembly.indexOf('json(join(source, "SOURCE_INVENTORY.json")'));
});

test("operator notices describe actual deletion and ID disclosure limits", () => {
  const guide = read("docs/OPERATOR_PRIVACY.ja.md");
  for (const item of ["Developer Portal", "［運用者名］", "［連絡先］", "［保存期間］", "user-profiles.json", "discordUserId", "BitLocker", "Reset Token", "バックアップ", "法律上の助言"]) assert.ok(guide.includes(item));
  assert.match(guide, /必ずParaBusを停止してから/);
  assert.match(read("docs/manual.html"), /画面で作成したVC BusのID.*名前の一部.*DiscordのユーザーID/);
});

test("runtime ZIP and corresponding-source stage include the real guide and its integrity lock", t => {
  const fixture = mkdtempSync(join(tmpdir(), "parabus-privacy-package-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const manifest = JSON.parse(read("release/release-manifest.json"));
  const entries: string[] = [...new Set<string>([...manifest.source.files, "release/release-manifest.json", "services/router-core-sim/src/private-files.ts", "scripts/restrict-private-path.ts"])];
  for (const file of entries) {
    mkdirSync(dirname(join(fixture, file)), { recursive: true });
    copyFileSync(join(root, file), join(fixture, file));
  }
  const stage = stageRelease(fixture, { sourceOnly: true, buildCommit: "b".repeat(40), trackedFiles: entries, unstagedFiles: [], stagedFiles: [] });
  assert.ok(stage.entries.includes("docs/OPERATOR_PRIVACY.ja.md"));
  assert.equal(readFileSync(join(stage.stageDirectory, "docs/OPERATOR_PRIVACY.ja.md"), "utf8"), read("docs/OPERATOR_PRIVACY.ja.md"));
  const lock = JSON.parse(readFileSync(join(stage.stageDirectory, "release-manifest-lock.json"), "utf8"));
  assert.ok(lock.files.some((f: { path: string }) => f.path === "docs/OPERATOR_PRIVACY.ja.md"));
  const fakeBinary = join(fixture, "dummy-router.exe");
  writeFileSync(fakeBinary, "fixture only; never executable");
  const runtime = stageRelease(fixture, { platform: "win32", rustBinaryPath: fakeBinary, buildCommit: "b".repeat(40), trackedFiles: entries, unstagedFiles: [], stagedFiles: [] });
  assert.ok(runtime.archivePath?.endsWith(".zip"));
  const archive = readFileSync(runtime.archivePath!);
  assert.ok(archive.includes(Buffer.from("docs/OPERATOR_PRIVACY.ja.md")));
  assert.ok(archive.includes(Buffer.from(read("docs/OPERATOR_PRIVACY.ja.md"))), "stored ZIP must contain the complete guide");
});

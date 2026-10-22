import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, symlink, writeFile, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildMacApp } from "../scripts/build-macos-app.ts";
import { smokeApp } from "../scripts/app-smoke-test.ts";

test("Mac app structure, API shutdown and TERM/HUP forwarding work through the real packaged entry script", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ParaBus 日本語 app "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts")); await mkdir(join(root, "runtime"));
  for (const name of ["start-router.ts", "start-router-macos.sh"]) await cp(resolve("scripts", name), join(root, "scripts", name));
  await symlink(resolve("services"), join(root, "services"), "dir");
  await symlink(process.execPath, join(root, "runtime/node"));
  await writeFile(join(root, "release-build-info.json"), '{"buildCommit":"test"}');
  // Do not change quarantine attributes on developer machines or test symlinks.
  await writeFile(join(root, ".parabus-quarantine-cleared"), "");
  assert.equal(buildMacApp(root), join(root, "ParaBus.app"));
  assert.throws(() => buildMacApp(root), /already exists/);
  const script = await readFile(join(root, "scripts/start-router-macos.sh"), "utf8");
  assert.match(script, /xattr -drs com\.apple\.quarantine "\$package_root"/);
  assert.doesNotMatch(script, /spctl|sudo/);
  const ci = await readFile(resolve(".github/workflows/test-packages.yml"), "utf8");
  assert.match(ci, /node scripts\/build-macos-app\.ts "\$dist"/);
  assert.match(ci, /scripts\/app-smoke-test\.ts/);
  assert.match(ci, /zipinfo -l.*ParaBus\.app\/Contents\/MacOS\/ParaBus/);
  await smokeApp(root);
  await smokeApp(root, "SIGTERM");
  await smokeApp(root, "SIGHUP");
  await smokeApp(root, "SIGKILL");
});

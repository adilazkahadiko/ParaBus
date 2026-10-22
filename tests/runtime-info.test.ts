import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperationalLog } from "../services/router-core-sim/src/operational-log.ts";
import { runtimeInfo } from "../services/router-core-sim/src/runtime-info.ts";

test("runtime identity classifies enabled Bot roles and retains the full release commit in startup logs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dbr-runtime-info-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const startedAt = new Date("2026-10-05T00:00:00.000Z");
  const buildCommit = "0123456789abcdef0123456789abcdef01234567";
  writeFileSync(join(root, "release-build-info.json"), JSON.stringify({ schemaVersion: 1, buildCommit }));
  const role = (bots: Parameters<typeof runtimeInfo>[1]) => runtimeInfo(root, bots, startedAt).pcRole;
  assert.equal(role([{ role: "RX", enabled: true }, { role: "TX", enabled: false }]), "RX");
  assert.equal(role([{ role: "TX", enabled: true }, { role: "RX", enabled: false }]), "TX");
  assert.equal(role([{ role: "RX", enabled: true }, { role: "TX", enabled: true }]), "MIXED");
  assert.equal(role([{ role: "DUPLEX", enabled: true }]), "MIXED");
  assert.equal(role([{ role: "SPARE", enabled: true }]), "RX");
  assert.equal(role([]), "UNCONFIGURED");
  assert.equal(runtimeInfo(root, { bots: [{ role: "TX" }, { role: "RX", enabled: false }] }).pcRole, "TX");
  const info = runtimeInfo(root, [{ role: "TX", enabled: true }], startedAt);
  const log = new OperationalLog(root);
  log.append({ at: info.startedAt, level: "INFO", message: "ParaBus startup", runtimeInfo: info });
  await log.close();
  assert.deepEqual(JSON.parse(readFileSync(log.pathFor(), "utf8")).runtimeInfo, { buildCommit, pcRole: "TX", startedAt: startedAt.toISOString() });
});

test("missing or malformed release metadata displays an unknown commit without requiring Git", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dbr-runtime-info-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(runtimeInfo(root, []).buildCommit, null);
  for (const content of ["not JSON", "null", JSON.stringify({ schemaVersion: 1, buildCommit: "secret-value" }), JSON.stringify({ schemaVersion: 2, buildCommit: "a".repeat(40) })]) {
    writeFileSync(join(root, "release-build-info.json"), content);
    assert.equal(runtimeInfo(root, []).buildCommit, null);
  }
});

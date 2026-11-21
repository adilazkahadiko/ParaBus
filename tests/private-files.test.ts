import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PrivateFileError, PRIVATE_FILE_WARNING, protectSettingsLocations, writePrivateFile, writePrivateFileSync } from "../services/router-core-sim/src/private-files.ts";
import { SettingsStore } from "../services/router-core-sim/src/settings-store.ts";
import { ExternalDeviceStore } from "../services/router-core-sim/src/external-device-store.ts";
import { SceneStore } from "../services/router-core-sim/src/scene-store.ts";
import { ReceiverOwnershipStore } from "../services/router-core-sim/src/receiver-ownership-store.ts";
import { UserProfileStore } from "../services/router-core-sim/src/user-profile-store.ts";
import { AudioChannel, SineSource } from "../services/router-core-sim/src/audio-engine.ts";

const windows = process.platform === "win32";
const broad = ["S-1-1-0", "S-1-5-11", "S-1-5-32-545"];
const tool = (name: string) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "private-settings-"));
  assert.ok(resolve(root).startsWith(resolve("target") + (process.platform === "win32" ? "\\" : "/")), "fixtures must stay under a new target directory");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function acl(path: string) {
  const script = "$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:ACL_TEST_PATH; "
    + "@{ owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules=@($a.Access | ForEach-Object { @{ sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; allow=($_.AccessControlType -eq 'Allow'); rights=[int]$_.FileSystemRights; flags=[int]$_.InheritanceFlags; inherited=$_.IsInherited } }) } | ConvertTo-Json -Depth 5 -Compress";
  return JSON.parse(execFileSync(tool("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, env: { SystemRoot: process.env.SystemRoot, ACL_TEST_PATH: path }, stdio: ["ignore", "pipe", "ignore"] })) as { owner: string; rules: { sid: string; allow: boolean; rights: number; flags: number; inherited: boolean }[] };
}
function assertOwnerOnly(path: string, directory = false) {
  const result = acl(path), allows = result.rules.filter(r => r.allow);
  assert.ok(allows.length > 0);
  assert.ok(allows.every(r => r.sid === result.owner && !broad.includes(r.sid)));
  assert.ok(allows.some(r => r.sid === result.owner && (r.rights & 2032127) === 2032127));
  if (directory) assert.ok(allows.some(r => (r.flags & 3) === 3), "directory must propagate OI and CI");
}

test("all configuration stores publish owner-only files on Windows", { skip: !windows }, async t => {
  const root = fixture(t);
  const warnings: string[] = [];
  await protectSettingsLocations(root, join(root, "recordings"), m => warnings.push(m));
  new SettingsStore(root, {}).save({ bots: [] });
  new SceneStore(root).save([], null);
  new ReceiverOwnershipStore(root).set("1".repeat(18), "2".repeat(18), "fixture");
  assert.ok(new ExternalDeviceStore(root).available);
  const profiles = new UserProfileStore(root, m => warnings.push(m));
  const channel = new AudioChannel("fixture", "Fixture", "DiscordUser", new SineSource(1000, -12), 480, 48000);
  profiles.restoreOrCreate(channel, "3".repeat(18), "Fixture");
  await profiles.flush();
  for (const file of [".env", "discord-bots.json", "user-profiles.json", "scenes.json", "receiver-owners.json", "external-control.json"]) assertOwnerOnly(join(root, file));
  assert.deepEqual(warnings, []);
});

test("startup removes explicit and inherited broad grants from existing files, logs and recording descendants", { skip: !windows }, async t => {
  const root = fixture(t), recordings = join(root, "recordings");
  for (const dir of ["logs", "support", "recordings/nested"]) mkdirSync(join(root, dir), { recursive: true });
  const files = [".env", "discord-bots.json", "user-profiles.json", "scenes.json", "receiver-owners.json", "external-control.json", "logs/old.jsonl", "support/fixture.zip", "recordings/nested/fixture.wav"];
  for (const file of files) writeFileSync(join(root, file), "fixture");
  execFileSync(tool("icacls.exe"), [root, "/grant:r", ...broad.map(s => `*${s}:(OI)(CI)M`)], { windowsHide: true, stdio: "ignore" });
  execFileSync(tool("icacls.exe"), [join(root, ".env"), "/grant:r", "*S-1-1-0:R"], { windowsHide: true, stdio: "ignore" });
  assert.ok(acl(join(root, ".env")).rules.some(r => r.allow && broad.includes(r.sid)));
  const warnings: string[] = [];
  await protectSettingsLocations(root, recordings, m => warnings.push(m));
  assert.deepEqual(warnings, []);
  for (const file of files) assertOwnerOnly(join(root, file));
  for (const dir of [root, join(root, "logs"), recordings, join(recordings, "nested")]) assertOwnerOnly(dir, true);
  const next = join(root, "logs/new.jsonl"); writeFileSync(next, "fixture"); assertOwnerOnly(next);
});

test("ACL failure never publishes new contents and removes the empty temporary file", async t => {
  const root = fixture(t), path = join(root, ".env");
  writePrivateFileSync(path, "previous fixture");
  const fail = () => { throw new Error("simulated permission failure"); };
  assert.throws(() => writePrivateFileSync(path, "new fixture", fail), PrivateFileError);
  await assert.rejects(writePrivateFile(path, "new fixture", async () => fail()), PrivateFileError);
  assert.equal(readFileSync(path, "utf8"), "previous fixture");
  assert.deepEqual(readdirSync(root), [".env"]);
});

test("tray permission helper restricts a copied first-run env without launching the tray", { skip: !windows }, t => {
  const root = fixture(t), path = join(root, ".env");
  writeFileSync(path, "fixture");
  execFileSync(tool("icacls.exe"), [path, "/grant:r", "*S-1-1-0:R"], { windowsHide: true, stdio: "ignore" });
  execFileSync(process.execPath, [resolve("scripts/restrict-private-path.ts"), path],
    { windowsHide: true, stdio: "ignore", env: { SystemRoot: process.env.SystemRoot } });
  assertOwnerOnly(path);
});

test("profile flush warns without throwing, preserves memory and retries a failed save", async t => {
  const root = fixture(t), warnings: string[] = []; let failed = true;
  const store = new UserProfileStore(root, m => warnings.push(m), async (path, content) => {
    if (failed) throw new PrivateFileError();
    await writePrivateFile(path, content);
  });
  const channel = new AudioChannel("fixture", "Fixture", "DiscordUser", new SineSource(1000, -12), 480, 48000);
  store.restoreOrCreate(channel, "3".repeat(18), "Fixture");
  await store.flush(); await store.flush();
  assert.deepEqual(warnings, [PRIVATE_FILE_WARNING]);
  assert.equal(store.snapshot().length, 1); assert.equal(existsSync(store.path), false);
  failed = false; await store.flush();
  assert.equal(new UserProfileStore(root).snapshot().length, 1);
});

test("overlapping profile flushes retain changes arriving during an asynchronous permission check", async t => {
  const root = fixture(t); let release!: () => void;
  const gate = new Promise<void>(done => { release = done; }); let writes = 0;
  const store = new UserProfileStore(root, () => assert.fail("unexpected warning"), async (path, content) => {
    if (writes++ === 0) await gate;
    await writePrivateFile(path, content);
  });
  const channel = new AudioChannel("fixture", "Fixture", "DiscordUser", new SineSource(1000, -12), 480, 48000);
  store.restoreOrCreate(channel, "3".repeat(18), "First");
  const first = store.flush(); store.restoreOrCreate(channel, "3".repeat(18), "Latest");
  const second = store.flush(); release(); await Promise.all([first, second]);
  assert.equal(new UserProfileStore(root).snapshot()[0].displayName, "Latest");
});

test("startup permission errors warn and do not reject startup", { skip: !windows }, async t => {
  const root = fixture(t), blocked = join(root, "not-a-directory"), warnings: string[] = [];
  writeFileSync(blocked, "fixture");
  await protectSettingsLocations(blocked, join(root, "recordings"), m => warnings.push(m));
  assert.ok(warnings.length > 0); assert.ok(warnings.every(m => m === PRIVATE_FILE_WARNING));
});

test("permission migration does not follow junctions outside the selected data tree", { skip: !windows }, async t => {
  const root = fixture(t), other = fixture(t), warnings: string[] = [];
  const before = acl(other);
  const junction = join(root, "redirected"); symlinkSync(other, junction, "junction");
  t.after(() => rmSync(junction, { force: true }));
  await protectSettingsLocations(junction, join(root, "recordings"), m => warnings.push(m));
  assert.deepEqual(acl(other), before); assert.ok(warnings.length > 0);
});

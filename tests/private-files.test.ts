import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PrivateFileError, PRIVATE_FILE_WARNING, RECORDING_FOLDER_WARNING, protectSettingsLocations, writePrivateFile, writePrivateFileSync } from "../services/router-core-sim/src/private-files.ts";
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
function assertPrivateAcl(path: string, directory = false) {
  const result = acl(path), allows = result.rules.filter(r => r.allow);
  const allowed = new Set([result.owner, "S-1-5-18", "S-1-5-32-544"]);
  assert.ok(allows.every(r => allowed.has(r.sid) && !broad.includes(r.sid)));
  for (const sid of allowed) {
    assert.ok(allows.some(r => r.sid === sid && (r.rights & 2032127) === 2032127));
    if (directory) assert.ok(allows.some(r => r.sid === sid && (r.flags & 3) === 3), "directory must propagate OI and CI");
  }
}

test("all configuration stores permit only the current user, SYSTEM and Administrators", { skip: !windows }, async t => {
  const root = fixture(t);
  const warnings: string[] = [];
  await protectSettingsLocations(root, join(root, "recordings"), m => warnings.push(m));
  new SettingsStore(root, {}).save({ bots: [] });
  await new SceneStore(root).save([], null);
  const owners = new ReceiverOwnershipStore(root);
  owners.set("1".repeat(18), "2".repeat(18), "fixture");
  await owners.flush();
  assert.ok(new ExternalDeviceStore(root).available);
  const profiles = new UserProfileStore(root, m => warnings.push(m));
  const channel = new AudioChannel("fixture", "Fixture", "DiscordUser", new SineSource(1000, -12), 480, 48000);
  profiles.restoreOrCreate(channel, "3".repeat(18), "Fixture");
  await profiles.flush();
  for (const file of [".env", "discord-bots.json", "user-profiles.json", "scenes.json", "receiver-owners.json", "external-control.json"]) assertPrivateAcl(join(root, file));
  assert.deepEqual(warnings, []);
});

test("startup limits scope to selected files and dedicated folders without inspecting children", { skip: !windows }, async t => {
  const root = fixture(t), recordings = join(root, "recordings");
  for (const dir of ["logs", "support", "recordings/nested"]) mkdirSync(join(root, dir), { recursive: true });
  const files = [".env", "discord-bots.json", "user-profiles.json", "scenes.json", "receiver-owners.json", "external-control.json", "logs/old.jsonl", "support/fixture.zip", "recordings/nested/fixture.wav"];
  for (const file of files) writeFileSync(join(root, file), "fixture");
  execFileSync(tool("icacls.exe"), [root, "/grant:r", ...broad.map(s => `*${s}:(OI)(CI)M`)], { windowsHide: true, stdio: "ignore" });
  execFileSync(tool("icacls.exe"), [join(root, ".env"), "/grant:r", "*S-1-1-0:R"], { windowsHide: true, stdio: "ignore" });
  mkdirSync(join(root, "node_modules"));
  const unrelated = join(root, "node_modules", "dummy.txt"); writeFileSync(unrelated, "fixture");
  const otherFile = join(root, "unrelated.txt"); writeFileSync(otherFile, "fixture");
  const before = [root, join(root, "node_modules"), unrelated, otherFile].map(acl);
  const explicitChild = join(root, "logs", "explicit.jsonl"); writeFileSync(explicitChild, "fixture");
  execFileSync(tool("icacls.exe"), [explicitChild, "/grant:r", "*S-1-1-0:R"], { windowsHide: true, stdio: "ignore" });
  assert.ok(acl(join(root, ".env")).rules.some(r => r.allow && broad.includes(r.sid)));
  const warnings: string[] = [];
  await protectSettingsLocations(root, recordings, m => warnings.push(m));
  assert.deepEqual(warnings, []);
  for (const file of files) assertPrivateAcl(join(root, file));
  for (const dir of [join(root, "logs"), recordings, join(recordings, "nested")]) assertPrivateAcl(dir, true);
  assert.deepEqual([root, join(root, "node_modules"), unrelated, otherFile].map(acl), before);
  assert.ok(acl(explicitChild).rules.some(r => r.allow && r.sid === "S-1-1-0"), "option A leaves explicit child grants to the operator");
  const next = join(root, "logs/new.jsonl"); writeFileSync(next, "fixture"); assertPrivateAcl(next);
});

test("custom recording folders and existing files retain their exact ACLs and only warn", { skip: !windows }, async t => {
  const root = fixture(t), custom = join(root, "custom-recordings");
  mkdirSync(custom); const file = join(custom, "existing.wav"); writeFileSync(file, "fixture");
  execFileSync(tool("icacls.exe"), [custom, "/grant:r", "*S-1-1-0:(OI)(CI)R"], { windowsHide: true, stdio: "ignore" });
  const before = [custom, file].map(acl), warnings: string[] = [];
  await protectSettingsLocations(root, custom, message => warnings.push(message));
  assert.deepEqual([custom, file].map(acl), before);
  assert.deepEqual(warnings, [RECORDING_FOLDER_WARNING]);
});

test("custom recordings nested in a managed folder are not changed through inheritance", { skip: !windows }, async t => {
  const root = fixture(t), parent = join(root, "recordings"), custom = join(parent, "operator-managed");
  mkdirSync(custom, { recursive: true });
  execFileSync(tool("icacls.exe"), [parent, "/grant:r", "*S-1-1-0:(OI)(CI)R"], { windowsHide: true, stdio: "ignore" });
  const file = join(custom, "existing.wav"); writeFileSync(file, "fixture");
  const before = [parent, custom, file].map(acl), warnings: string[] = [];
  await protectSettingsLocations(root, custom, message => warnings.push(message));
  assert.deepEqual([parent, custom, file].map(acl), before);
  assert.deepEqual(warnings, [RECORDING_FOLDER_WARNING]);
});

test("HTTP readiness does not wait for background permission checks", { skip: !windows }, async t => {
  const root = fixture(t), warnings: string[] = [];
  const source = readFileSync(resolve("services/router-core-sim/src/server.ts"), "utf8");
  assert.ok(source.indexOf("void protectSettingsLocations(") > source.indexOf("server.listen("));
  assert.doesNotMatch(source, /await protectSettingsLocations\(/);
  const server = createServer((_request, response) => response.end("ready"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let done = false;
  const protection = protectSettingsLocations(root, join(root, "recordings"), m => warnings.push(m)).then(() => { done = true; });
  try {
    const port = (server.address() as { port: number }).port;
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "ready");
    assert.equal(done, false);
    await protection; assert.deepEqual(warnings, []);
  } finally { await protection; await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("a missing custom recording folder is not created or permission-modified", { skip: !windows }, async t => {
  const root = fixture(t), custom = join(root, "operator-managed-missing"), warnings: string[] = [];
  await protectSettingsLocations(root, custom, message => warnings.push(message));
  assert.equal(existsSync(custom), false); assert.deepEqual(warnings, []);
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
  assertPrivateAcl(path);
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

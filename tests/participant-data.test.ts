import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import test from "node:test";
import { AudioEngine, AudioChannel, SilenceSource } from "../services/router-core-sim/src/audio-engine.ts";
import { UserProfileStore } from "../services/router-core-sim/src/user-profile-store.ts";
import { UserSessionRegistry } from "../services/router-core-sim/src/user-session-registry.ts";
import { SceneStore } from "../services/router-core-sim/src/scene-store.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";
import { OperationalLog } from "../services/router-core-sim/src/operational-log.ts";
import { ParticipantDataManager, ParticipantDataError, PARTICIPANT_CONNECTED, PARTICIPANT_STALE } from "../services/router-core-sim/src/participant-data.ts";
import { createParticipantDataHandler } from "../services/router-core-sim/src/participant-data-api.ts";
import { assertDesktopControlAuthorized, createDesktopSessionNonce, isLocalDesktopAddress } from "../services/router-core-sim/src/desktop-control-auth.ts";
import { writePrivateFile } from "../services/router-core-sim/src/private-files.ts";
import { DiscordFrameType } from "../packages/discord-ipc/src/index.ts";
import { ExternalControlServer } from "../services/router-core-sim/src/external-control.ts";
import { ExternalDeviceStore } from "../services/router-core-sim/src/external-device-store.ts";

const person = "7".repeat(18), other = person + "8";
const parameter = (id: string, field = "label", guild = "g", vc = "v") => `channel.discord-user:${guild}:${vc}:${id}.${field}`;
const bundleName = "ParaBus-support-UNCONFIGURED-unknown-20261121T010203Z-abcdef12.zip";
function root(t: test.TestContext, cleanup = true) {
  const base = resolve("target/participant-deletion-20261121"); mkdirSync(base, { recursive: true });
  const path = mkdtempSync(join(base, "fixture-"));
  assert.ok(path.startsWith(base));
  if (cleanup) t.after(() => rmSync(path, { recursive: true, force: true })); return path;
}
async function fixture(t: test.TestContext, options: { sceneWrite?: typeof writePrivateFile; profileWrite?: typeof writePrivateFile } = {}) {
  const directory = root(t, false), engine = new AudioEngine(48000, 480, 2), warnings: string[] = [];
  const profiles = new UserProfileStore(directory, m => warnings.push(m), options.profileWrite);
  const sessions = new UserSessionRegistry(profiles), scenes = new SceneStore(directory, m => warnings.push(m), options.sceneWrite);
  const log = new OperationalLog(directory), events: string[] = [];
  const control = new ControlPlane(engine, undefined, undefined, undefined, undefined, sessions, event => { events.push(event.message); log.append(event); });
  const ingest = new DiscordIngestServer(engine, "fixture", null, null, sessions);
  let bundleBusy = false;
  const manager = new ParticipantDataManager({ root: directory, profiles, sessions, scenes, control, ingest, log, bundleBusy: () => bundleBusy });
  const channels = [person, other].map((id, index) => {
    const channel = new AudioChannel(`discord-user:g:v:${id}`, `Fixture ${index}`, "DiscordUser", new SilenceSource(), 480, 48000);
    profiles.restoreOrCreate(channel, id, `Fixture ${index}`); profiles.setTrusted(channel, true); profiles.setRecallSafe(channel, "mute", true); return channel;
  });
  await profiles.flush();
  for (const id of ["first", "second"]) control.scenes.set(id, { id, name: id, createdAt: "2026-11-21T00:00:00Z", values: {
    [parameter(person)]: "Fixture target", [parameter(person, "mute", "g2", "v2")]: true,
    [parameter(other)]: "Fixture other", "bus.fixture.label": "Fixture bus", "matrix.fixture.gainDb": -6,
  } });
  control.currentSceneId = "first"; await scenes.save([...control.scenes.values()], "first");
  t.after(async () => { await profiles.flush(); await scenes.flush(); await log.close(); rmSync(directory, { recursive: true, force: true }); });
  return { root: directory, engine, profiles, sessions, scenes, log, events, control, ingest, manager, channels, warnings, setBundleBusy(value: boolean) { bundleBusy = value; } };
}

test("one complete ID removes profile, all matching scene values and offline approvals after durable saves", async t => {
  const f = await fixture(t);
  f.sessions.join(f.channels[0], person, "v", "Fixture target"); f.sessions.leave(f.channels[0]);
  f.control.recallSafe.add(parameter(person, "mute")); f.control.recallSafe.add(parameter(other, "mute"));
  const before = new SceneStore(f.root).snapshot();
  const otherProfile = JSON.stringify(f.profiles.profiles.get(other));
  await f.manager.deleteParticipant(person);
  assert.equal(f.profiles.profiles.has(person) || f.sessions.sessions.has(person), false);
  assert.equal(new UserProfileStore(f.root).profiles.has(person), false);
  assert.equal(new UserProfileStore(f.root).profiles.has(other), true);
  assert.equal(JSON.stringify(new UserProfileStore(f.root).profiles.get(other)) === otherProfile, true);
  assert.equal(readdirSync(f.root).some(name => name.endsWith(".tmp")), false);
  for (const scene of new SceneStore(f.root).snapshot().scenes) {
    assert.equal(Object.keys(scene.values).some(key => key.includes(`:${person}.`)), false);
    assert.equal(scene.values[parameter(other)] === "Fixture other", true);
    assert.equal(scene.values["bus.fixture.label"] === "Fixture bus" && scene.values["matrix.fixture.gainDb"] === -6, true);
  }
  assert.equal(f.scenes.snapshot().currentSceneId, before.currentSceneId);
  assert.equal(f.control.recallSafe.has(parameter(person, "mute")), false);
  assert.equal(f.control.recallSafe.has(parameter(other, "mute")), true);
  assert.equal(f.events.at(-1), "参加者データを1件削除しました");
  assert.equal(f.manager.list().some(row => row.discordUserId === person), false);
  f.sessions.join(f.channels[0], person, "v", "Fixture new visit");
  assert.equal(f.sessions.sessions.get(person)?.sessionApproval === "PENDING" && !f.profiles.isTrusted(person), true);
});

test("scene-only participants left by manual deletion remain searchable and deletable", async t => {
  const f = await fixture(t); await f.profiles.deleteConfirmed(person);
  const row = f.manager.list().find(item => item.discordUserId === person);
  assert.equal(row?.displayName === "Fixture target" && row.updatedAt === null, true);
  await f.manager.deleteParticipant(person);
  assert.equal(f.manager.list().some(item => item.discordUserId === person), false);
});

test("online silent and stale participants are refused without changing saved files", async t => {
  const f = await fixture(t); const before = readFileSync(f.scenes.path, "utf8");
  f.sessions.join(f.channels[0], person, "v", "Fixture target"); f.channels[0].stale = true;
  try { await f.manager.deleteParticipant(person); assert.fail("must reject online participant"); }
  catch (error) { assert.equal(error instanceof ParticipantDataError && error.status === 409 && error.message === PARTICIPANT_CONNECTED, true); }
  f.sessions.leave(f.channels[0]); f.engine.addChannel(f.channels[0]);
  try { await f.manager.deleteParticipant(person); assert.fail("must reject retained strip"); }
  catch (error) { assert.equal(error instanceof ParticipantDataError && error.message === PARTICIPANT_STALE, true); }
  assert.equal(readFileSync(f.scenes.path, "utf8") === before, true);
  assert.equal(f.profiles.profiles.has(person), true);
});

for (const location of ["scene", "profile"] as const) test(`${location} save failure returns failure, keeps a retry row and never logs success`, async t => {
  let fail = false;
  const write: typeof writePrivateFile = async (path, content) => { if (fail) throw new Error("simulated write failure"); await writePrivateFile(path, content); };
  const f = await fixture(t, location === "scene" ? { sceneWrite: write } : { profileWrite: write });
  fail = true;
  try { await f.manager.deleteParticipant(person); assert.fail("must report persistence failure"); }
  catch (error) { assert.equal(error instanceof ParticipantDataError && error.status === 500, true); }
  assert.equal(f.manager.list().some(row => row.discordUserId === person), true);
  assert.equal(f.events.includes("参加者データを1件削除しました"), false);
  fail = false; await f.manager.deleteParticipant(person);
  assert.equal(new UserProfileStore(f.root).profiles.has(person), false);
  assert.equal(new SceneStore(f.root).snapshot().scenes.some(scene => parameter(person) in scene.values), false);
});

test("deletion waits for disk and preserves scene saves arriving during the write", async t => {
  let hold = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { sceneWrite: async (path, content) => { if (hold) await gate; await writePrivateFile(path, content); } });
  hold = true; let done = false;
  const deletion = f.manager.deleteParticipant(person).then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  f.control.scenes.get("second")!.values["bus.fixture.masterDb"] = -9;
  const saving = f.scenes.save([...f.control.scenes.values()], f.control.currentSceneId);
  release(); await Promise.all([deletion, saving]);
  assert.equal(new SceneStore(f.root).snapshot().scenes.find(scene => scene.id === "second")?.values["bus.fixture.masterDb"], -9);
});

for (const stage of ["scene", "profile"] as const) test(`rejoin during the ${stage} write is retained and never reported as successful deletion`, async t => {
  let hold = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writer: typeof writePrivateFile = async (path, content) => { if (hold) await gate; await writePrivateFile(path, content); };
  const f = await fixture(t, stage === "scene" ? { sceneWrite: writer } : { profileWrite: writer });
  hold = true;
  const deletion = f.manager.deleteParticipant(person);
  if (stage === "profile") {
    for (let i = 0; i < 100 && f.profiles.profiles.has(person); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.profiles.profiles.has(person), false);
  }
  f.sessions.join(f.channels[0], person, "v", "Fixture rejoin");
  release();
  await assert.rejects(deletion, error => error instanceof ParticipantDataError && error.status === 409 && error.message === PARTICIPANT_CONNECTED);
  assert.equal(f.sessions.sessions.get(person)?.online && f.profiles.profiles.has(person), true);
  assert.equal(f.events.includes("参加者データを1件削除しました"), false);
  f.sessions.leave(f.channels[0]); hold = false; await f.manager.deleteParticipant(person);
  assert.equal(new UserProfileStore(f.root).profiles.has(person), false);
});

test("log and ZIP purge is direct, typed and bounded, and current log handles close before deletion", async t => {
  const f = await fixture(t); const logs = join(f.root, "logs"), support = join(f.root, "support");
  mkdirSync(support); mkdirSync(join(logs, "nested")); mkdirSync(join(support, "nested")); mkdirSync(join(f.root, "recordings"));
  const retained = ["logs/router.log", "logs/notes.txt", "logs/nested/operational-2026-11-21.jsonl", "support/other.zip", `support/${bundleName}.pending`, `support/nested/${bundleName}`, "recordings/fixture.wav"];
  for (const file of retained) writeFileSync(join(f.root, file), "fixture");
  writeFileSync(join(logs, "operational-2026-11-20.jsonl"), "fixture"); writeFileSync(join(support, bundleName), "fixture");
  f.log.append({ at: new Date().toISOString(), level: "INFO", message: "Before purge marker" });
  await f.manager.deleteDiagnostics();
  assert.equal(readdirSync(logs).some(file => /^operational-.*\.jsonl$/.test(file)), false);
  assert.equal(existsSync(join(support, bundleName)), false);
  assert.equal(retained.every(file => readFileSync(join(f.root, file), "utf8") === "fixture"), true);
  f.log.append({ at: new Date().toISOString(), level: "INFO", message: "After purge marker" }); await f.log.close();
  const after = readFileSync(f.log.pathFor(), "utf8");
  assert.equal(after.includes("After purge marker") && !after.includes("Before purge marker"), true);
});

test("log events arriving during deletion are recreated as new events rather than writing an unlinked handle", async t => {
  const f = await fixture(t);
  f.log.append({ at: new Date().toISOString(), level: "INFO", message: "Old marker" });
  const clearing = f.log.clearFiles();
  f.log.append({ at: new Date().toISOString(), level: "INFO", message: "New marker" });
  await clearing; await f.log.close();
  const text = readFileSync(f.log.pathFor(), "utf8"); assert.equal(text.includes("New marker") && !text.includes("Old marker"), true);
});

test("bundle creation and locked operation states reject destructive actions", async t => {
  const f = await fixture(t); f.setBundleBusy(true);
  await assert.rejects(f.manager.deleteDiagnostics(), error => error instanceof ParticipantDataError && error.status === 409);
  f.setBundleBusy(false); f.control.state = "ON_AIR";
  await assert.rejects(f.manager.deleteParticipant(person), error => error instanceof ParticipantDataError && error.status === 409);
  await assert.rejects(f.manager.deleteDiagnostics(), error => error instanceof ParticipantDataError && error.status === 409);
});

test("diagnostic folder junctions cannot delete files outside the fixed directory", async t => {
  const f = await fixture(t), outside = root(t);
  writeFileSync(join(outside, bundleName), "outside fixture");
  symlinkSync(outside, join(f.root, "support"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.manager.deleteDiagnostics(), error => error instanceof ParticipantDataError && error.status === 500);
  assert.equal(readFileSync(join(outside, bundleName), "utf8") === "outside fixture", true);
});

test("desktop privacy HTTP routes require local source, exact Origin, nonce and explicit confirmation", async t => {
  const f = await fixture(t), nonce = createDesktopSessionNonce(); let origin = "";
  const authorize = (request: Parameters<typeof createParticipantDataHandler>[1] extends (request: infer R) => void ? R : never) => {
    if (!isLocalDesktopAddress(request.socket.remoteAddress)) throw new Error("local required");
    assertDesktopControlAuthorized(request.headers, origin, nonce);
  };
  const handle = createParticipantDataHandler(f.manager, authorize);
  const server = createServer((request, response) => { void handle(request, response, request.url!).then(handled => { if (!handled) { response.writeHead(404); response.end(); } }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const post = (headers: Record<string, string>, path = "list", body: unknown = {}) => fetch(`${origin}/api/participant-data/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const denied: Record<string, string>[] = [{}, { origin }, { "x-dbr-session-nonce": nonce }, { origin: "http://example.invalid", "x-dbr-session-nonce": nonce }, { origin, authorization: "Bearer fixture" }];
  for (const headers of denied) assert.equal((await post(headers)).status, 403);
  const headers = { origin, "x-dbr-session-nonce": nonce };
  assert.equal((await post(headers)).status, 200);
  assert.equal((await post(headers, "delete", { discordUserId: person })).status, 400);
  assert.equal((await post(headers, "delete", { discordUserId: "not-an-id", confirmed: true })).status, 400);
  let status = 0;
  await handle({ headers, socket: { remoteAddress: "192.0.2.1" }, method: "POST" } as never, { writeHead(code: number) { status = code; }, end() {} } as never, "/api/participant-data/delete");
  assert.equal(status, 403);
  assert.equal((await post(headers, "delete", { discordUserId: person, confirmed: true })).status, 200);
  assert.equal(f.profiles.profiles.has(person), false);
});

test("external API credentials cannot invoke desktop deletion or a deletion operation", async t => {
  const f = await fixture(t), reserve = createServer(); await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const store = new ExternalDeviceStore(f.root); store.setPort(port);
  const device = store.register("Fixture device");
  const external = new ExternalControlServer({ store, control: f.control, ingest: () => f.ingest.snapshot(), execute: command => f.control.execute(command), version: "fixture", log() {} });
  await external.start(); store.setEnabled(true); t.after(() => external.close());
  const headers = { "content-type": "application/json", authorization: `Bearer ${device.token}` };
  const path = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(path + "/external/v1/state", { headers })).status, 200);
  assert.equal((await fetch(path + "/api/participant-data/delete", { method: "POST", headers, body: JSON.stringify({ discordUserId: person, confirmed: true }) })).status >= 400, true);
  const response = await fetch(path + "/external/v1/actions", { method: "POST", headers, body: JSON.stringify({ requestId: randomUUID(), operation: "participant.delete", args: { discordUserId: person } }) });
  assert.equal(response.status >= 400, true); assert.equal(f.profiles.profiles.has(person), true);
});

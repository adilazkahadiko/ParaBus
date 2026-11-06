import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ExternalDeviceStore } from "../services/router-core-sim/src/external-device-store.ts";
import { ExternalControlServer } from "../services/router-core-sim/src/external-control.ts";
import { ExternalState } from "../services/router-core-sim/src/external-state.ts";
import { VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { fixture, testRoot } from "./helpers/external-control-fixture.ts";
import { connectWs } from "./helpers/external-ws.ts";

const FIRST = "discord-vc:717171717171717171:828282828282828282", SECOND = "discord-vc:717171717171717171:838383838383838383";
const read = (store: ExternalDeviceStore) => JSON.parse(readFileSync(store.path, "utf8"));
const unavailable = (fn: () => unknown) => assert.throws(fn, (error: any) => error.code === "UNAVAILABLE");

test("Bus alias uses full domain-separated HMAC-SHA256, a protected 32-byte key and no unkeyed digest", () => {
  const root = testRoot(), store = new ExternalDeviceStore(root), saved = read(store), key = Buffer.from(saved.busAliasKey, "base64url");
  assert.equal(saved.version, 2); assert.equal(key.length, 32); assert.equal(store.enabled, false);
  const alias = store.busAlias(FIRST), digest = alias.slice("external-bus:".length);
  assert.match(alias, /^external-bus:[A-Za-z0-9_-]{43}$/); assert.equal(Buffer.from(digest, "base64url").length, 32);
  const expected = createHmac("sha256", key).update("ParaBus external bus alias v1\0", "utf8").update(FIRST, "utf8").digest("base64url");
  assert.equal(digest === expected, true);
  assert.equal(digest === createHash("sha256").update(FIRST).digest("base64url"), false);
  for (const marker of [FIRST, "717171717171717171", "828282828282828282", saved.busAliasKey]) assert.equal(alias.includes(marker), false);
  assert.equal(Buffer.from(digest, "base64url").includes(Buffer.from(FIRST)), false);
  assert.equal(readdirSync(root).some(name => name.endsWith(".tmp")), false);
  if (process.platform === "win32") {
    const acl = execFileSync("icacls.exe", [store.path], { encoding: "utf8", windowsHide: true });
    assert.equal(acl.includes("(I)"), false); assert.equal(acl.includes(`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`), true);
    assert.equal((acl.match(/\([A-Z,]+\)/g) ?? []).length, 1);
  } else assert.equal(statSync(store.path).mode & 0o077, 0);
});

test("recreating both store and ExternalState keeps aliases and resolves saved button settings; another key changes them", async t => {
  const f = await fixture(t); f.engine.addBus(new VcBus(FIRST, "Private Bus", 480, 48000));
  const initial = f.api.state.publicBusId(FIRST), bytes = readFileSync(f.store.path, "utf8");
  const restarted = new ExternalDeviceStore(f.root), state = new ExternalState(f.control, f.api.options.ingest, f.api.options.txIdentities, [], restarted);
  assert.equal(state.publicBusId(FIRST) === initial, true); assert.equal(state.resolveBusId(initial) === FIRST, true);
  assert.equal(state.instanceId === f.api.state.instanceId, false); assert.equal(restarted.enabled, false);
  assert.equal(readFileSync(restarted.path, "utf8") === bytes, true);
  const other = new ExternalDeviceStore(testRoot()); assert.equal(other.busAlias(FIRST) === initial, false);
  assert.equal(restarted.busAlias(SECOND) === initial, false);
});

test("legacy version-1 registration migrates atomically without losing devices, tokens, permissions, port or its stored enabled flag", () => {
  const root = testRoot(), initial = new ExternalDeviceStore(root), device = initial.register("Device");
  initial.change(device.deviceId, "permissions", true, ["bus.fader.set"]); initial.setPort(4199); initial.setEnabled(true);
  const old = read(initial); old.version = 1; delete old.busAliasKey; writeFileSync(initial.path, JSON.stringify(old));
  const migrated = new ExternalDeviceStore(root), saved = read(migrated);
  assert.equal(migrated.available, true); assert.equal(migrated.enabled, false); assert.equal(migrated.port, 4199);
  assert.equal(saved.version, 2); assert.equal(saved.enabled, true); assert.equal(Buffer.from(saved.busAliasKey, "base64url").length, 32);
  assert.equal(JSON.stringify(saved.devices) === JSON.stringify(old.devices), true);
  assert.equal(Boolean(migrated.authenticate(device.token)), true); assert.deepEqual(migrated.authenticate(device.token)!.allowedTierBOperations, ["bus.fader.set"]);
  const alias = migrated.busAlias(FIRST); assert.equal(new ExternalDeviceStore(root).busAlias(FIRST) === alias, true);
});

test("failed legacy migration never exposes a volatile alias or overwrites the old file; a later launch can retry", t => {
  const root = testRoot(), initial = new ExternalDeviceStore(root), old = read(initial); old.version = 1; delete old.busAliasKey;
  const bytes = JSON.stringify(old); writeFileSync(initial.path, bytes);
  const failure = t.mock.method(ExternalDeviceStore.prototype as any, "save", () => { throw Error("Injected disk failure"); });
  const failed = new ExternalDeviceStore(root); assert.equal(failed.available, false); unavailable(() => failed.busAlias(FIRST));
  assert.equal(readFileSync(initial.path, "utf8") === bytes, true); failure.mock.restore();
  const retried = new ExternalDeviceStore(root); assert.equal(retried.available, true); assert.match(retried.busAlias(FIRST), /^external-bus:[A-Za-z0-9_-]{43}$/);
  assert.equal(read(retried).version, 2);
});

test("missing, malformed, noncanonical or unreadable version-2 keys fail closed without regeneration or overwriting", () => {
  const root = testRoot(), initial = new ExternalDeviceStore(root), original = read(initial);
  const malformed = [null, 42, "", "invalid", "A".repeat(42), "A".repeat(44), "A".repeat(42) + "B"];
  for (const value of [undefined, ...malformed]) {
    const raw = { ...original }; if (value === undefined) delete raw.busAliasKey; else raw.busAliasKey = value;
    const bytes = JSON.stringify(raw); writeFileSync(initial.path, bytes); const failed = new ExternalDeviceStore(root);
    assert.equal(failed.available, false); assert.equal(failed.enabled, false); unavailable(() => failed.busAlias(FIRST)); unavailable(() => failed.setEnabled(true));
    assert.equal(readFileSync(initial.path, "utf8") === bytes, true);
  }
  const unreadableRoot = testRoot(); mkdirSync(join(unreadableRoot, "external-control.json"));
  const unreadable = new ExternalDeviceStore(unreadableRoot); assert.equal(unreadable.available, false); unavailable(() => unreadable.busAlias(FIRST));
  const parent = testRoot(), blocker = join(parent, "blocked"); writeFileSync(blocker, "fixture");
  const cannotSave = new ExternalDeviceStore(join(blocker, "settings")); assert.equal(cannotSave.available, false); unavailable(() => cannotSave.busAlias(FIRST));
});

test("an unavailable key store does not prevent constructing the local application or silently regenerate a key", async t => {
  const f = await fixture(t); f.engine.addBus(new VcBus(FIRST, "Private Bus", 480, 48000));
  const saved = read(f.store); delete saved.busAliasKey; const bytes = JSON.stringify(saved); writeFileSync(f.store.path, bytes);
  const failed = new ExternalDeviceStore(f.root), api = new ExternalControlServer({ ...f.api.options, store: failed });
  assert.equal(api.managementSnapshot().available, false); unavailable(() => api.manage({ action: "enable" }));
  assert.equal(readFileSync(f.store.path, "utf8") === bytes, true); await api.close();
});

test("a forced HMAC collision blocks both IDs, raw-ID compatibility and pending operations, and closes existing WS", async t => {
  const f = await fixture(t); f.engine.addBus(new VcBus(FIRST, "First private Bus", 480, 48000));
  const derive = f.store.busAlias.bind(f.store), collision = derive(FIRST); f.store.busAlias = () => collision;
  f.api.manage({ action: "permissions", deviceId: f.registration.deviceId, readDisplayNames: false, allowedTierBOperations: ["bus.limiter.set"] });
  f.api.manage({ action: "enable" }); const alias = f.api.state.publicBusId(FIRST);
  const ws = await connectWs(f.api.port, f.headers.authorization); t.after(() => ws.socket.destroy()); await ws.next();
  const armed = await f.raw(f.request("bus.limiter.set", { busId: alias, enabled: false }), "/arm"); assert.equal(armed.status, 200);
  f.engine.addBus(new VcBus(SECOND, "Second private Bus", 480, 48000)); f.advance(1000);
  for (const id of [FIRST, SECOND, alias]) {
    const response = await f.raw(f.request("bus.mute.set", { busId: id, mute: true })); assert.equal(response.body.code, "UNAVAILABLE");
    unavailable(() => f.api.state.resolveBusId(id));
  }
  const execute = await f.raw({ requestId: randomUUID(), instanceId: f.api.state.instanceId, armId: armed.body.data.armId }, "/execute");
  assert.equal(execute.body.code, "UNAVAILABLE"); assert.equal(f.commands.length, 0);
  assert.equal(f.api.managementSnapshot().available, false); f.api.tick(); assert.equal((await ws.next()).payload.code, "UNAVAILABLE"); assert.equal((await ws.next()).closeCode, 4003);
  const lines = f.logs.filter(line => line.includes("alias collision")); assert.deepEqual(lines, ["External control Bus alias collision"]);
  for (const value of [FIRST, SECOND, collision, read(f.store).busAliasKey]) assert.equal(lines.join("\n").includes(value), false);
});

test("key material is absent from management, HTTP/WS projections, arm/error replies, and action logs", async t => {
  const f = await fixture(t), key = read(f.store).busAliasKey; f.engine.addBus(new VcBus(FIRST, "Private Bus", 480, 48000));
  f.api.manage({ action: "permissions", deviceId: f.registration.deviceId, readDisplayNames: false, allowedTierBOperations: ["bus.limiter.set"] });
  f.api.manage({ action: "enable" }); const alias = f.api.state.publicBusId(FIRST);
  const privateValues = [key, Buffer.from(key, "base64url").toString("hex"), FIRST, "717171717171717171", "828282828282828282"];
  const safe = (value: unknown) => { const bytes = JSON.stringify(value); for (const secret of privateValues) assert.equal(bytes.includes(secret), false); };
  safe(f.api.managementSnapshot());
  for (const route of ["/info", "/state"]) { const response = await fetch(f.base + route, { headers: f.headers }); assert.equal(response.status, 200); safe(await response.json()); }
  const ws = await connectWs(f.api.port, f.headers.authorization); t.after(() => ws.socket.destroy()); safe(await ws.next());
  const arm = await f.raw(f.request("bus.limiter.set", { busId: alias, enabled: true }), "/arm"); assert.equal(arm.status, 200); safe(arm.body);
  const error = await f.raw(f.request("bus.mute.set", { busId: `${FIRST}:missing`, mute: true })); safe(error.body); safe(f.logs);
});

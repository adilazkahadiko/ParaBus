import assert from "node:assert/strict";
import test from "node:test";
import { COMMAND_POLICIES, classifyCommand } from "../services/router-core-sim/src/external-protocol.ts";
import { stateBroadcastScheduler } from "../services/router-core-sim/src/state-broadcast-scheduler.ts";
import { fixture, USER } from "./helpers/external-control-fixture.ts";
import { connectWs } from "./helpers/external-ws.ts";

const target = { kind: "user", discordUserId: USER };
test("legacy channel operations are unknown, absent from discovery/permissions/state, while Send controls the Bus mix", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" });
  const info = (await (await fetch(f.base + "/info", { headers: f.headers })).json() as any).data;
  assert.ok(!info.operations.some((o: any) => o.name.startsWith("channel.")));
  assert.equal(COMMAND_POLICIES.SET_CHANNEL_FADER, "C"); assert.equal(COMMAND_POLICIES.SET_CHANNEL_MUTE, "C");
  assert.equal(classifyCommand({ type: "SET_CHANNEL_FADER", channelId: f.channel.id, db: 0 }, { state: "SETUP", increaseDb: 0 }), "C");
  const before = { db: f.channel.faderDb, mute: f.channel.mute, send: { ...f.channel.vcSends.get("bus")! }, commands: f.commands.length };
  const unknown = await f.action("unknown.operation", {});
  for (const [operation, args] of [["channel.fader.adjust", { target, deltaDb: -1 }], ["channel.fader.set", { target, db: -20 }],
    ["channel.mute.set", { target, mute: true }], ["channel.mute.toggle", { target, expectedMute: false }]] as const) {
    for (const path of ["/actions", "/arm"]) {
      f.advance(); const result = await f.raw(f.request(operation, args), path);
      assert.equal(result.status, unknown.status); assert.equal(result.body.code, unknown.body.code);
    }
  }
  assert.throws(() => f.api.manage({ action: "permissions", deviceId: f.registration.deviceId, readDisplayNames: false, allowedTierBOperations: ["channel.fader.set"] }));
  assert.deepEqual({ db: f.channel.faderDb, mute: f.channel.mute, send: { ...f.channel.vcSends.get("bus")! }, commands: f.commands.length }, before);
  for (const names of [false, true]) {
    f.api.manage({ action: "permissions", deviceId: f.registration.deviceId, readDisplayNames: names });
    const state = await f.state();
    assert.deepEqual(Object.keys(state.participants[0]).sort(), ["discordUserId", "sends", ...(names ? ["displayName"] : [])].sort());
    const ws = await connectWs(f.api.port, f.headers.authorization);
    const initial = await ws.next(); assert.deepEqual(initial.payload.participants, state.participants); ws.socket.destroy();
  }
  assert.equal((await f.action("send.fader.set", { target, busId: "bus", db: -30 })).status, 200);
  assert.equal((await f.action("send.fader.adjust", { target, busId: "bus", deltaDb: -2 })).body.data.value, -32);
  assert.equal((await f.action("send.mute.set", { target, busId: "bus", mute: false })).status, 200);
  assert.equal((await f.action("send.mute.toggle", { target, busId: "bus", expectedMute: false })).body.data.value, true);
  assert.deepEqual(f.channel.vcSends.get("bus"), { gainDb: -32, mute: true });
  assert.equal(f.channel.faderDb, before.db); assert.equal(f.channel.mute, before.mute);
  assert.ok(f.commands.every((c: any) => c.type === "SET_VC_SEND"));
});

test("external change notification excludes no-ops, cached requests and rejected commands", async t => {
  const f = await fixture(t); f.api.manage({ action: "enable" }); let changes = 0;
  f.api.options.onChange = () => { changes++; };
  const body = f.request("send.fader.adjust", { target, busId: "bus", deltaDb: -1 });
  assert.equal((await f.raw(body)).status, 200); assert.equal(changes, 1);
  assert.equal((await f.raw(body)).status, 200); assert.equal(changes, 1);
  assert.equal((await f.action("send.fader.set", { target, busId: "bus", db: -21 })).status, 200); assert.equal(changes, 1);
  assert.equal((await f.action("bus.mute.set", { busId: "missing", mute: true })).status, 404); assert.equal(changes, 1);
  const execute = f.api.options.execute;
  f.api.options.execute = command => { execute(command); return { ok: false, revision: f.control.revision }; };
  assert.equal((await f.action("send.fader.adjust", { target, busId: "bus", deltaDb: -1 })).status, 409); assert.equal(changes, 1);
});

test("desktop state scheduler coalesces a tick and consecutive bursts before creating snapshots, with 50ms spacing", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let snapshots = 0;
  const scheduler = stateBroadcastScheduler(() => { snapshots++; }); t.after(() => scheduler.cancel());
  for (let i = 0; i < 100; i++) scheduler.schedule(); assert.equal(snapshots, 0);
  t.mock.timers.tick(49); assert.equal(snapshots, 0); t.mock.timers.tick(1); assert.equal(snapshots, 1);
  for (let i = 0; i < 100; i++) scheduler.schedule();
  t.mock.timers.tick(49); assert.equal(snapshots, 1); scheduler.schedule(); t.mock.timers.tick(1); assert.equal(snapshots, 2);
  scheduler.schedule(); scheduler.cancel(); t.mock.timers.tick(1000); assert.equal(snapshots, 2);
});

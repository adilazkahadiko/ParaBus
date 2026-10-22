import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import test from "node:test";
import { decodeDiscordFrame, encodeDiscordFrame, DiscordFrameType, DiscordTxFlags, type DiscordFrameTypeValue } from "../packages/discord-ipc/src/index.ts";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";

class Adapter extends EventEmitter {
  writable = true; destroyed = false; writableLength = 0;
  writes: Buffer[] = [];
  failStartBot: string | null = null;
  setNoDelay() {}
  write(buffer: Buffer) {
    const frame = decodeDiscordFrame(buffer);
    if (frame.type === DiscordFrameType.TX_CONTROL && (frame.flags ?? 0) & DiscordTxFlags.START && frame.botId === this.failStartBot) throw new Error("injected START failure");
    this.writes.push(buffer); return true;
  }
  resetAndDestroy() { this.destroy(); }
  destroy() { this.writable = false; this.destroyed = true; this.emit("close"); }
}

function fixture(teams = 20) {
  const engine = AudioEngine.createDemo(1), ingest = new DiscordIngestServer(engine, "test-only"), adapter = new Adapter();
  (ingest as unknown as { accept(socket: Socket): void }).accept(adapter as unknown as Socket);
  const bots = Array.from({ length: teams + 2 }, (_, i) => ({
    profileId: `TX${String(i + 1).padStart(2, "0")}`,
    botId: String(900000000000000001n + BigInt(i)), guildId: "100000000000000001", voiceChannelId: String(100000000000000101n + BigInt(i)),
    txDestination: i < teams ? `TEAM_${String(i + 1).padStart(2, "0")}` : i === teams ? "INTERVIEW" : "SPARE",
  }));
  const state = (i: number, overrides: Record<string, unknown> = {}, type: DiscordFrameTypeValue = DiscordFrameType.ADAPTER_STATE) => adapter.emit("data", encodeDiscordFrame({
    type, ...bots[i], voiceChannelId: typeof overrides.voiceChannelId === "string" ? overrides.voiceChannelId : bots[i].voiceChannelId,
    payload: Buffer.from(JSON.stringify({ ...bots[i], label: bots[i].profileId, role: "TX", txSubtype: "CUSTOM", txAudioMode: "MONO", gatewayState: "ready", voiceState: "ready", txEnabled: false, ...overrides })),
  }));
  bots.forEach((_, i) => state(i, {}, DiscordFrameType.BOT_META));
  const control = new ControlPlane(engine, undefined, ingest);
  const arm = (ids: string[]) => control.execute({ type: "SET_TX_TARGETS", ids, expectedRevision: ingest.txTargetsRevision });
  const targets = () => ingest.snapshot().txTargets!;
  const starts = () => adapter.writes.map(decodeDiscordFrame).filter((frame) => frame.type === DiscordFrameType.TX_CONTROL && (frame.flags ?? 0) & DiscordTxFlags.START);
  return { engine, ingest, adapter, bots, state, control, arm, targets, starts };
}

test("ALL TEAMS requires confirmation; 20 Team TX receive PCM while Interview and Spare stay stopped", () => {
  const f = fixture();
  const teams = f.bots.slice(0, 20).map((bot) => bot.profileId);
  assert.deepEqual(f.targets().armed, []); assert.deepEqual(f.targets().live, []);
  assert.equal(f.arm(teams).ok, true);
  assert.deepEqual(f.targets().live, []);
  assert.equal(f.control.execute({ type: "START_ARMED" }).confirmationRequired, true);
  assert.equal(f.starts().length, 0);
  assert.equal(f.control.execute({ type: "START_ARMED", confirmed: true }).ok, true);
  assert.deepEqual(f.targets().live, teams);
  f.engine.processBlock(); f.ingest.writeTxBlock();
  const pcm = f.adapter.writes.map(decodeDiscordFrame).filter((frame) => frame.type === DiscordFrameType.TX_PCM);
  assert.equal(pcm.length, 20);
  assert.equal(pcm.some((frame) => frame.botId === f.bots[20].botId || frame.botId === f.bots[21].botId), false);
});

test("19 of 20 Teams and all 22 unclassified Bots still require explicit start confirmation", () => {
  const f = fixture();
  f.arm(f.bots.slice(0, 19).map((bot) => bot.profileId));
  assert.equal(f.ingest.isAllTeamsArmed(), false);
  assert.equal(f.control.execute({ type: "START_ARMED" }).confirmationRequired, true);
  assert.throws(() => f.ingest.startArmed(), /requires confirmation/);
  assert.equal(f.starts().length, 0);
  f.bots.forEach((_, i) => f.state(i, { txDestination: null }));
  assert.deepEqual(f.targets().allTeams, []);
  f.arm(f.bots.map((bot) => bot.profileId));
  assert.equal(f.control.execute({ type: "START_ARMED" }).confirmationRequired, true);
  assert.throws(() => f.ingest.startArmed(), /requires confirmation/);
  assert.equal(f.starts().length, 0);
  assert.equal(f.control.execute({ type: "START_ARMED", confirmed: true }).ok, true);
  assert.equal(f.targets().live.length, 22);
});

test("target CAS and validation are atomic; armed changes leave live unchanged until START", () => {
  const f = fixture(3), a = f.bots[0].profileId, b = f.bots[1].profileId;
  assert.equal(f.arm([a]).ok, true);
  assert.equal(f.control.execute({ type: "START_ARMED" }).ok, true);
  const revision = f.ingest.txTargetsRevision;
  assert.equal(f.arm([b]).ok, true);
  assert.deepEqual(f.targets().armed, [b]); assert.deepEqual(f.targets().live, [a]);
  assert.equal(f.control.execute({ type: "SET_TX_TARGETS", ids: [a], expectedRevision: revision }).code, "STALE_STATE");
  assert.equal(f.control.execute({ type: "START_ARMED", confirmed: true, expectedRevision: revision }).code, "STALE_STATE", "a stale confirmation cannot start newly selected destinations");
  assert.equal(f.arm([b, "MISSING"]).ok, false);
  assert.equal(f.arm([b, b]).ok, false);
  assert.deepEqual(f.targets().armed, [b]); assert.deepEqual(f.targets().live, [a]);
  assert.equal(f.control.execute({ type: "START_ARMED" }).ok, true);
  assert.deepEqual(f.targets().live, [b]);
  assert.equal(f.control.execute({ type: "START_TX", profileId: a, confirmed: true }).ok, true);
  assert.ok(f.targets().armed.includes(a) && f.targets().live.includes(a));
  assert.equal(f.control.execute({ type: "STOP_TX", profileId: a, confirmed: true }).ok, true);
  assert.ok(f.targets().armed.includes(a) && !f.targets().live.includes(a));
});

test("TX revision ignores fader traffic and no-ops but versions real selection, START, disconnect and CLEAR changes", () => {
  const f = fixture(3), id = f.bots[0].profileId;
  const fader = () => assert.equal(f.control.execute({ type: "SET_CHANNEL_FADER", channelId: "user-01", db: -10 }).ok, true);
  const initial = f.ingest.txTargetsRevision;
  for (let i = 0; i < 10; i++) fader();
  assert.equal(f.ingest.txTargetsRevision, initial);
  assert.equal(f.control.execute({ type: "SET_TX_TARGETS", ids: [id], expectedRevision: initial }).ok, true);
  const armed = f.ingest.txTargetsRevision;
  assert.equal(armed, initial + 1);
  f.arm([id]); assert.equal(f.ingest.txTargetsRevision, armed);
  for (let i = 0; i < 10; i++) fader();
  assert.equal(f.control.execute({ type: "START_ARMED", expectedRevision: armed }).ok, true);
  const live = f.ingest.txTargetsRevision;
  f.control.execute({ type: "START_ARMED", confirmed: true }); assert.equal(f.ingest.txTargetsRevision, live);
  const before = f.targets();
  f.ingest.txSnapshot(Date.now() + 16000); // Reading a future-dated snapshot is not a stop command.
  assert.equal(f.ingest.txTargetsRevision, live); assert.deepEqual(f.targets(), before);
  f.state(0, { voiceState: "disconnected" }); assert.equal(f.ingest.txTargetsRevision, live + 1);
  f.state(0); assert.equal(f.ingest.txTargetsRevision, live + 1);
  f.control.execute({ type: "CLEAR_ALL" });
  const cleared = f.ingest.txTargetsRevision;
  f.control.execute({ type: "CLEAR_ALL" }); assert.equal(f.ingest.txTargetsRevision, cleared);
});

test("CLEAR ALL continues across STOP failure, scrubs live and rejects malformed direct target lists", () => {
  const f = fixture(3), ids = f.bots.slice(0, 2).map((bot) => bot.profileId);
  f.arm(ids); f.control.execute({ type: "START_ARMED", confirmed: true });
  const original = f.adapter.write.bind(f.adapter);
  f.adapter.write = (buffer) => {
    const frame = decodeDiscordFrame(buffer);
    if (frame.type === DiscordFrameType.TX_CONTROL && !(frame.flags ?? 0) && frame.botId === f.bots[0].botId) throw new Error("STOP failed");
    return original(buffer);
  };
  assert.equal(f.control.execute({ type: "CLEAR_ALL" }).ok, true);
  assert.deepEqual(f.targets().live, []); assert.deepEqual(f.targets().armed, []);
  assert.equal(f.adapter.destroyed, true);
  assert.throws(() => f.ingest.setTxTargets([""]), /profile ID/);
});

test("duplicate profile authority and stale health stop TX without changing armed selection", () => {
  const f = fixture(3), id = f.bots[0].profileId;
  f.arm([id]); f.control.execute({ type: "START_ARMED", confirmed: true });
  f.adapter.emit("data", encodeDiscordFrame({ type: DiscordFrameType.BOT_META, ...f.bots[0], botId: "900000000000009999", payload: Buffer.from(JSON.stringify({ ...f.bots[0], role: "TX", gatewayState: "ready", voiceState: "ready" })) }));
  assert.deepEqual(f.targets().live, []); assert.deepEqual(f.targets().armed, [id]);
  assert.equal(f.control.execute({ type: "START_ARMED", confirmed: true }).ok, false);
  const g = fixture(3);
  g.arm([g.bots[0].profileId]); g.control.execute({ type: "START_ARMED", confirmed: true });
  for (const bot of g.ingest.bots.values()) { bot.lastStateAt = Date.now() - 16000; bot.lastHeartbeatAt = 0; }
  g.ingest.writeTxBlock(); assert.deepEqual(g.targets().live, []);
  g.state(0); assert.deepEqual(g.targets().live, []);
});

test("group START preflights every Bot and rolls back every live target after a partial write failure", () => {
  const f = fixture(3), ids = f.bots.slice(0, 2).map((bot) => bot.profileId);
  f.arm(ids);
  f.state(1, { voiceState: "connecting" });
  assert.equal(f.control.execute({ type: "START_ARMED", confirmed: true }).ok, false);
  assert.equal(f.starts().length, 0);
  f.state(1);
  f.adapter.failStartBot = f.bots[1].botId;
  assert.equal(f.control.execute({ type: "START_ARMED", confirmed: true }).ok, false);
  assert.equal(f.starts().length, 1);
  assert.deepEqual(f.targets().live, []); assert.deepEqual(f.targets().armed, ids);
  const stop = f.adapter.writes.map(decodeDiscordFrame).find((frame) => frame.botId === f.bots[0].botId && frame.type === DiscordFrameType.TX_CONTROL && !(frame.flags ?? 0));
  assert.ok(stop);
});

test("VC disconnect, fault and VC reassignment remove only the affected live Bot and never rearm automatically", () => {
  const f = fixture(3), ids = f.bots.slice(0, 2).map((bot) => bot.profileId);
  f.arm(ids); f.control.execute({ type: "START_ARMED", confirmed: true });
  f.state(0, { voiceState: "disconnected" }); f.state(0);
  assert.deepEqual(f.targets().live, [ids[1]]); assert.deepEqual(f.targets().armed, ids);
  f.adapter.emit("data", encodeDiscordFrame({ type: DiscordFrameType.ADAPTER_STATE, ...f.bots[1], payload: Buffer.from("voice-disconnected") }));
  f.state(1);
  assert.deepEqual(f.targets().live, []);
  f.state(1, { voiceState: "fault" }); f.state(1);
  assert.deepEqual(f.targets().live, []);
  f.control.execute({ type: "START_ARMED", confirmed: true });
  f.state(0, { voiceChannelId: "100000000000000999" }, DiscordFrameType.BOT_META);
  assert.deepEqual(f.targets().live, [ids[1]]); assert.deepEqual(f.targets().armed, ids);
});

test("START with an empty armed set stops the old live set rather than retaining it", () => {
  const f = fixture(3);
  f.arm([f.bots[0].profileId]); f.control.execute({ type: "START_ARMED", confirmed: true });
  f.arm([]); assert.deepEqual(f.targets().live, [f.bots[0].profileId]);
  assert.equal(f.control.execute({ type: "START_ARMED" }).ok, true);
  assert.deepEqual(f.targets().armed, []); assert.deepEqual(f.targets().live, []);
});

test("IPC close and a socket takeover stop live TX while retaining armed targets", () => {
  const f = fixture(3), ids = f.bots.slice(0, 2).map((bot) => bot.profileId);
  f.arm(ids); f.control.execute({ type: "START_ARMED", confirmed: true });
  const next = new Adapter();
  (f.ingest as unknown as { accept(socket: Socket): void }).accept(next as unknown as Socket);
  next.emit("data", encodeDiscordFrame({ type: DiscordFrameType.BOT_META, ...f.bots[0], payload: Buffer.from(JSON.stringify({ ...f.bots[0], role: "TX", gatewayState: "ready", voiceState: "ready" })) }));
  assert.deepEqual(f.targets().live, [ids[1]]);
  f.adapter.destroy();
  assert.deepEqual(f.targets().live, []); assert.deepEqual(f.targets().armed, ids);
});

test("Emergency Mute retains armed but clears live; CLEAR ALL is confirmation-free and flushes queued PCM", () => {
  const f = fixture(3), ids = f.bots.slice(0, 2).map((bot) => bot.profileId);
  f.arm(ids); f.control.execute({ type: "START_ARMED", confirmed: true });
  assert.equal(f.control.execute({ type: "EMERGENCY_MUTE", active: true }).ok, true);
  assert.deepEqual(f.targets().live, []); assert.deepEqual(f.targets().armed, ids);
  assert.equal(f.control.execute({ type: "START_ARMED", confirmed: true }).ok, false);
  const g = fixture(3);
  g.arm(g.bots.slice(0, 2).map((bot) => bot.profileId)); g.control.execute({ type: "START_ARMED", confirmed: true });
  g.adapter.writableLength = 256 * 1024 + 1;
  g.control.state = "FAULT";
  assert.equal(g.control.execute({ type: "CLEAR_ALL" }).ok, true);
  assert.deepEqual(g.targets().armed, []); assert.deepEqual(g.targets().live, []);
  assert.equal(g.adapter.destroyed, true);
  assert.equal(g.adapter.writes.map(decodeDiscordFrame).filter((frame) => frame.type === DiscordFrameType.TX_CONTROL && !(frame.flags ?? 0)).length, g.bots.length);
  const before = g.adapter.writes.length;
  g.ingest.writeTxBlock(); assert.equal(g.adapter.writes.length, before);
  assert.equal(g.control.execute({ type: "CLEAR_ALL" }).ok, true);
});

test("ordinary CLEAR ALL preserves shared IPC and RX, and can start TX again immediately", () => {
  const f = fixture(3), id = f.bots[0].profileId;
  f.adapter.emit("data", encodeDiscordFrame({ type: DiscordFrameType.BOT_META, botId: "800000000000000001", guildId: "100000000000000001", voiceChannelId: "100000000000000801", payload: Buffer.from(JSON.stringify({ profileId: "RX", role: "RX", gatewayState: "ready", voiceState: "ready" })) }));
  f.arm([id]); f.control.execute({ type: "START_ARMED", confirmed: true });
  f.adapter.writableLength = 256 * 1024;
  assert.equal(f.control.execute({ type: "CLEAR_ALL" }).ok, true);
  assert.equal(f.adapter.destroyed, false);
  assert.deepEqual(f.targets().live, []); assert.deepEqual(f.targets().armed, []);
  assert.equal(f.ingest.snapshot().bots.find((bot) => bot.profileId === "RX")?.health, "READY");
  assert.equal(f.arm([id]).ok, true);
  assert.equal(f.control.execute({ type: "START_ARMED" }).ok, true);
  assert.deepEqual(f.targets().live, [id]);
});

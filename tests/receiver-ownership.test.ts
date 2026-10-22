import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import test from "node:test";
import { DiscordFrameType, type DiscordIpcFrame } from "../packages/discord-ipc/src/index.ts";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { discordSourceId, discordVoiceBusId, DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";
import type { OpusDecoder, OpusDecoderFactory } from "../services/router-core-sim/src/opus-decoder.ts";
import { ReceiverOwnershipStore } from "../services/router-core-sim/src/receiver-ownership-store.ts";
import { UserProfileStore } from "../services/router-core-sim/src/user-profile-store.ts";
import { UserSessionRegistry } from "../services/router-core-sim/src/user-session-registry.ts";

const guildId = "610000000000000001";
const voiceChannelId = "620000000000000001";
const userId = "630000000000000001";

class ToneDecoder implements OpusDecoder {
  decode(): Buffer {
    const pcm = Buffer.alloc(960 * 2);
    for (let index = 0; index < 960; index += 1) pcm.writeInt16LE(index % 2 ? 12_000 : -12_000, index * 2);
    return pcm;
  }
  dispose(): void {}
}

const decoderFactory: OpusDecoderFactory = {
  backend: "@discordjs/opus",
  create48kMono: () => new ToneDecoder(),
};

function identity(botId: string, user = userId): Pick<DiscordIpcFrame, "botId" | "guildId" | "voiceChannelId" | "userId"> {
  return { botId, guildId, voiceChannelId, userId: user };
}

function botMeta(botId: string, profileId: string, role: "RX" | "TX" | "DUPLEX" | "SPARE", state = "ready"): DiscordIpcFrame {
  return {
    type: DiscordFrameType.BOT_META,
    ...identity(botId, botId),
    payload: Buffer.from(JSON.stringify({ profileId, label: `${profileId} Bot`, role, gatewayState: state, voiceState: state, voiceChannelName: "Interview VC" })),
  };
}

function userMeta(botId: string, generation = 1, label = "Guest"): DiscordIpcFrame {
  return { type: DiscordFrameType.USER_META, ...identity(botId), sourceGeneration: generation, payload: Buffer.from(label) };
}

function opus(botId: string, generation = 1, sequence = 1): DiscordIpcFrame {
  return { type: DiscordFrameType.OPUS, ...identity(botId), sourceGeneration: generation, sequence, payload: Buffer.from([1]) };
}

function runtime(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "dbr-receiver-owner-"));
  const engine = new AudioEngine(48_000, 480, 4);
  const profiles = new UserProfileStore(root);
  const sessions = new UserSessionRegistry(profiles);
  const owners = new ReceiverOwnershipStore(root);
  const ingest = new DiscordIngestServer(engine, "test-only", null, decoderFactory, sessions, owners);
  const control = new ControlPlane(engine, undefined, ingest, undefined, undefined, sessions);
  ingest.setReceiverEventHandler((level, message) => control.recordExternalEvent(level, message));
  t.after(() => { profiles.flush(); rmSync(root, { recursive: true, force: true }); });
  return { root, engine, profiles, sessions, owners, ingest, control };
}

function setApproval(target: ReturnType<typeof runtime>, channel: { id: string; discordUserId?: string }, approved: boolean) {
  assert.ok(channel.discordUserId);
  const session = target.sessions.sessions.get(channel.discordUserId);
  assert.ok(session);
  return target.control.execute({
    type: "SET_PARTICIPANT_APPROVAL",
    channelId: channel.id,
    discordUserId: channel.discordUserId,
    approved,
    expectedSessionGeneration: session.sessionGeneration,
    expectedApprovalRevision: session.approvalRevision,
  });
}

function setReceiverOwner(target: ReturnType<typeof runtime>, profileId: string, confirmed?: boolean) {
  const ownership = target.ingest.snapshot().receiverOwnership[0];
  assert.ok(ownership);
  return target.control.execute({
    type: "SET_RECEIVER_OWNER",
    guildId,
    voiceChannelId,
    profileId,
    confirmed,
    expectedCurrentOwner: ownership.ownerProfileId,
    expectedReceiverGeneration: ownership.generation,
  });
}

test("one RX-capable Bot owns its VC while TX-only remains outside ownership", (t) => {
  const target = runtime(t);
  target.ingest.ingest(botMeta("600000000000000001", "RX01", "RX"));
  target.ingest.ingest(botMeta("600000000000000009", "TX01", "TX"));
  const ownership = target.ingest.snapshot().receiverOwnership[0];
  assert.equal(ownership.ownerProfileId, "RX01");
  assert.equal(ownership.status, "ACTIVE");
  assert.deepEqual(ownership.receivers.map((receiver) => [receiver.profileId, receiver.state]), [["RX01", "ACTIVE"]]);
  assert.deepEqual(ownership.transmitters.map((bot) => bot.profileId), ["TX01"]);

  target.ingest.ingest({ type: DiscordFrameType.USER_META, ...identity("600000000000000001"), sourceGeneration: 1, payload: Buffer.from("Guest") });
  assert.equal(target.engine.channels.size, 1);
  assert.equal([...target.engine.channels.keys()][0], discordSourceId(identity("600000000000000001")));
  assert.equal(target.engine.buses.has(discordVoiceBusId(identity("600000000000000001"))), true);
});

test("multiple receivers admit only the selected owner and DUPLEX can own RX", (t) => {
  const target = runtime(t);
  const primary = "600000000000000001";
  const standby = "600000000000000002";
  target.ingest.ingest(botMeta(primary, "RX01", "RX"));
  target.ingest.ingest(botMeta(standby, "RX02", "SPARE"));
  let ownership = target.ingest.snapshot().receiverOwnership[0];
  assert.equal(ownership.receivers.filter((receiver) => receiver.state === "ACTIVE").length, 1);
  assert.equal(ownership.receivers.find((receiver) => receiver.profileId === "RX02")?.state, "STANDBY");

  target.ingest.ingest({ type: DiscordFrameType.USER_META, ...identity(standby), sourceGeneration: 1, payload: Buffer.from("Standby duplicate") });
  target.ingest.ingest({ type: DiscordFrameType.OPUS, ...identity(standby), sourceGeneration: 1, sequence: 1, payload: Buffer.from([1]) });
  assert.equal(target.engine.channels.size, 0, "Standby metadata and audio are rejected before source creation");

  target.ingest.ingest({ type: DiscordFrameType.USER_META, ...identity(primary), sourceGeneration: 1, payload: Buffer.from("Owner") });
  target.ingest.ingest({ type: DiscordFrameType.OPUS, ...identity(primary), sourceGeneration: 1, sequence: 1, payload: Buffer.from([1]) });
  assert.equal(target.engine.channels.size, 1);
  assert.equal(target.ingest.runtimes.size, 1, "one User cannot become two audio sources");

  const ambiguous = runtime(t);
  ambiguous.ingest.ingest(botMeta("600000000000000004", "RX03", "RX"));
  ambiguous.ingest.ingest(botMeta("600000000000000005", "RX04", "RX"));
  assert.equal(ambiguous.ingest.snapshot().receiverOwnership[0].status, "UNSELECTED");
  ambiguous.ingest.ingest({ type: DiscordFrameType.USER_META, ...identity("600000000000000004"), sourceGeneration: 1, payload: Buffer.from("No implicit owner") });
  assert.equal(ambiguous.engine.channels.size, 0, "ambiguous primaries fail closed until operator selection");

  const duplexTarget = runtime(t);
  duplexTarget.ingest.ingest(botMeta("600000000000000003", "DUPLEX01", "DUPLEX"));
  ownership = duplexTarget.ingest.snapshot().receiverOwnership[0];
  assert.equal(ownership.ownerProfileId, "DUPLEX01");
  assert.equal(ownership.receivers[0].state, "ACTIVE");
  assert.deepEqual(ownership.transmitters.map((bot) => bot.profileId), ["DUPLEX01"]);
});

test("owner disconnect fails closed until manual switch and preserves User state", (t) => {
  const target = runtime(t);
  const primary = "600000000000000001";
  const standby = "600000000000000002";
  target.ingest.ingest(botMeta(primary, "RX01", "RX"));
  target.ingest.ingest(botMeta(standby, "RX02", "SPARE"));
  target.ingest.ingest({ type: DiscordFrameType.USER_META, ...identity(primary), sourceGeneration: 1, payload: Buffer.from("Guest") });
  let channel = [...target.engine.channels.values()][0];
  const busId = discordVoiceBusId(identity(primary));
  setApproval(target, channel, true);
  target.control.execute({ type: "SET_CHANNEL_FADER", channelId: channel.id, db: -4 });
  target.control.execute({ type: "SET_VC_SEND", channelId: channel.id, busId, db: -7, mute: false });
  target.control.execute({ type: "SET_DIRECT_OUTPUT", channelId: channel.id, output: 0, tap: "PRE", gainDb: -2, mute: false });

  target.ingest.ingest(botMeta(primary, "RX01", "RX", "disconnected"));
  assert.equal(target.engine.channels.size, 0);
  assert.equal(target.ingest.snapshot().receiverOwnership[0].ownerProfileId, "RX01", "disconnect never auto-fails over");
  assert.equal(target.ingest.snapshot().receiverOwnership[0].status, "DISCONNECTED");
  target.engine.processBlock();
  assert.equal(target.engine.outputs[0].every((sample) => sample === 0), true);
  target.ingest.ingest({ type: DiscordFrameType.USER_META, ...identity(standby), sourceGeneration: 2, payload: Buffer.from("Not owner yet") });
  assert.equal(target.engine.channels.size, 0);

  assert.equal(setReceiverOwner(target, "RX02").confirmationRequired, true);
  assert.equal(setReceiverOwner(target, "RX02", true).ok, true);
  target.ingest.ingest({ type: DiscordFrameType.USER_META, ...identity(standby), sourceGeneration: 2, payload: Buffer.from("Guest renamed") });
  channel = [...target.engine.channels.values()][0];
  assert.equal(channel.discordUserId, userId);
  assert.equal(channel.faderDb, -4);
  assert.deepEqual(channel.directOutput, { output: 0, tap: "PRE", gainDb: -2, mute: false });
  assert.deepEqual(channel.vcSends.get(busId), { gainDb: -7, mute: false });
  assert.equal(channel.approvalGateOpen, true, "same-session approval survives receiver replacement");
  assert.equal(channel.preferredStripPosition, target.profiles.snapshot()[0].preferredStripPosition);

  target.ingest.ingest({ type: DiscordFrameType.USER_META, ...identity(primary), sourceGeneration: 3, payload: Buffer.from("Old owner") });
  assert.equal(target.engine.channels.size, 1);
  assert.equal(target.ingest.snapshot().receiverOwnership[0].ownerProfileId, "RX02");
  assert.equal(new ReceiverOwnershipStore(target.root).get(guildId, voiceChannelId), "RX02");
  const restartedEngine = new AudioEngine(48_000, 480, 2);
  const restarted = new DiscordIngestServer(restartedEngine, "test-only", null, decoderFactory, null, new ReceiverOwnershipStore(target.root));
  restarted.ingest(botMeta(primary, "RX01", "RX"));
  restarted.ingest({ type: DiscordFrameType.USER_META, ...identity(primary), sourceGeneration: 4, payload: Buffer.from("Rejected after restart") });
  assert.equal(restartedEngine.channels.size, 0, "persisted RX02 preference keeps RX01 closed while owner is absent");
  restarted.ingest(botMeta(standby, "RX02", "SPARE"));
  assert.equal(restarted.snapshot().receiverOwnership[0].ownerProfileId, "RX02");
  assert.ok(target.control.alerts.some((entry) => entry.message.includes("receiver disconnected") && entry.message.includes("RX02")));
  assert.ok(target.control.alerts.some((entry) => entry.message.startsWith("Receiver switched: Interview VC · RX01 → RX02; receiver generation")));
  assert.equal(target.control.alerts.some((entry) => /token|secret/i.test(entry.message)), false);
});

test("duplicate receiver profile authority fails closed until explicit conflict resolution", (t) => {
  const target = runtime(t);
  const first = new Socket();
  const duplicate = new Socket();
  const firstBot = "600000000000000011";
  const duplicateBot = firstBot;

  target.ingest.ingest(botMeta(firstBot, "RX01", "RX"), first);
  target.ingest.ingest(userMeta(firstBot), first);
  assert.equal(target.engine.channels.size, 1);

  target.ingest.ingest(botMeta(duplicateBot, "RX01", "RX"), duplicate);
  let ownership = target.ingest.snapshot().receiverOwnership[0];
  assert.equal(ownership.status, "CONFLICT");
  assert.equal(ownership.receivers.every((receiver) => receiver.state === "CONFLICT"), true);
  assert.equal(target.engine.channels.size, 0, "an existing source is removed as soon as authority becomes ambiguous");

  target.ingest.ingest(userMeta(firstBot, 2), first);
  target.ingest.ingest(opus(firstBot, 2), first);
  target.ingest.ingest(userMeta(duplicateBot, 2), duplicate);
  target.ingest.ingest(opus(duplicateBot, 2), duplicate);
  assert.equal(target.engine.channels.size, 0, "both duplicate authorities remain fail closed");
  assert.ok(target.control.alerts.some((entry) => entry.message === "Duplicate receiver authority: RX01; RX fail closed"));

  const release = (socket: Socket) => (target.ingest as unknown as { releaseSocketAuthorities(socket: Socket): void }).releaseSocketAuthorities(socket);
  release(duplicate);
  release(first);
  const restored = new Socket();
  target.ingest.ingest(botMeta(firstBot, "RX01", "RX"), restored);
  assert.equal(setReceiverOwner(target, "RX01", true).ok, true);
  target.ingest.ingest(userMeta(firstBot, 3), restored);
  target.ingest.ingest(userMeta(duplicateBot, 3), duplicate);
  ownership = target.ingest.snapshot().receiverOwnership[0];
  assert.equal(ownership.status, "ACTIVE");
  assert.equal(target.engine.channels.size, 1, "only the explicitly restored authority is accepted");
  assert.ok(target.control.alerts.some((entry) => entry.message === "Receiver authority conflict cleared after fresh reconnect: RX01"));
});

test("TX-only duplicate labels are outside receiver authority and distinct profiles coexist", (t) => {
  const target = runtime(t);
  target.ingest.ingest(botMeta("600000000000000021", "TX01", "TX"), new Socket());
  target.ingest.ingest(botMeta("600000000000000022", "TX01", "TX"), new Socket());
  target.ingest.ingest(botMeta("600000000000000023", "RX01", "RX"), new Socket());
  target.ingest.ingest(botMeta("600000000000000024", "RX02", "SPARE"), new Socket());
  const ownership = target.ingest.snapshot().receiverOwnership[0];
  assert.equal(ownership.status, "ACTIVE");
  assert.deepEqual(ownership.receivers.map((receiver) => receiver.profileId), ["RX01", "RX02"]);
  assert.equal(target.control.alerts.some((entry) => entry.message.includes("Duplicate receiver authority")), false);
});

test("receiver ingest accepts USER_META and OPUS only while health is READY", (t) => {
  const rejectedStates = ["connecting", "unknown", "reconnecting", "fault", "disconnected"];
  for (const [index, health] of rejectedStates.entries()) {
    const target = runtime(t);
    const botId = `6000000000000001${String(index).padStart(2, "0")}`;
    target.ingest.ingest(botMeta(botId, "RX01", "RX", health));
    target.ingest.ingest(userMeta(botId));
    target.ingest.ingest(opus(botId));
    assert.equal(target.engine.channels.size, 0, `${health} receiver must not create a source`);
  }

  const stale = runtime(t);
  const staleBot = "600000000000000199";
  stale.ingest.ingest(botMeta(staleBot, "RX01", "RX"));
  const staleRuntime = [...stale.ingest.bots.values()][0];
  staleRuntime.lastStateAt = Date.now() - 20_000;
  stale.ingest.ingest(userMeta(staleBot));
  assert.equal(stale.engine.channels.size, 0, "STALE receiver must not create a source");

  staleRuntime.lastHeartbeatAt = Date.now() - 20_000;
  stale.ingest.ingest({ ...botMeta(staleBot, "RX01", "RX"), type: DiscordFrameType.ADAPTER_STATE });
  stale.ingest.ingest(userMeta(staleBot));
  assert.equal(stale.engine.channels.size, 1, "fresh READY adapter state admits the reconnect membership before the next PING");

  const ready = runtime(t);
  const readyBot = "600000000000000200";
  ready.ingest.ingest(botMeta(readyBot, "RX01", "RX", "connecting"));
  ready.ingest.ingest(userMeta(readyBot));
  ready.ingest.ingest(opus(readyBot));
  ready.ingest.ingest(botMeta(readyBot, "RX01", "RX", "ready"));
  ready.ingest.ingest(opus(readyBot, 1, 2));
  assert.equal(ready.engine.channels.size, 0, "pre-READY packets are never retained for later playback");
  ready.ingest.ingest(userMeta(readyBot));
  ready.ingest.ingest(opus(readyBot, 1, 3));
  assert.equal(ready.engine.channels.size, 1);
  assert.equal([...ready.ingest.runtimes.values()][0].packets, 1);
});

test("ON AIR receiver switching is locked while healthy and permits confirmed fail-closed recovery", (t) => {
  const target = runtime(t);
  const primary = "600000000000000031";
  const standby = "600000000000000032";
  target.ingest.ingest(botMeta(primary, "RX01", "RX"));
  target.ingest.ingest(botMeta(standby, "RX02", "SPARE"));
  target.ingest.ingest(userMeta(primary));
  let channel = [...target.engine.channels.values()][0];
  const busId = discordVoiceBusId(identity(primary));
  setApproval(target, channel, true);
  target.control.execute({ type: "SET_CHANNEL_FADER", channelId: channel.id, db: -5 });
  target.control.execute({ type: "SET_VC_SEND", channelId: channel.id, busId, db: -8, mute: false });
  target.control.execute({ type: "SET_DIRECT_OUTPUT", channelId: channel.id, output: 0, tap: "POST", gainDb: -1, mute: false });
  target.control.execute({ type: "SET_STATE", state: "READY" });
  target.control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });

  let result = setReceiverOwner(target, "RX02", true);
  assert.equal(result.ok, false, "healthy owner switch is structural and remains locked ON AIR");
  assert.equal(target.ingest.snapshot().receiverOwnership[0].ownerProfileId, "RX01");
  assert.ok(target.control.alerts.some((entry) => entry.message.includes("ON AIR receiver switch rejected")));

  target.ingest.ingest(botMeta(primary, "RX01", "RX", "fault"));
  assert.equal(target.engine.channels.size, 0, "owner failure closes the VC before recovery selection");
  result = setReceiverOwner(target, "RX02");
  assert.equal(result.ok, false);
  assert.equal(result.confirmationRequired, true);
  result = setReceiverOwner(target, "RX02", true);
  assert.equal(result.ok, true);
  assert.equal(target.ingest.snapshot().receiverOwnership[0].ownerProfileId, "RX02");

  target.ingest.ingest(opus(primary, 1, 2));
  target.ingest.ingest(opus(standby, 2, 1));
  assert.equal(target.engine.channels.size, 0, "old generation and OPUS without fresh membership are rejected");
  target.ingest.ingest(userMeta(standby, 2, "Guest renamed"));
  target.ingest.ingest(opus(standby, 2, 2));
  channel = [...target.engine.channels.values()][0];
  assert.equal(channel.discordUserId, userId);
  assert.equal(channel.approvalGateOpen, true);
  assert.equal(channel.faderDb, -5);
  assert.deepEqual(channel.vcSends.get(busId), { gainDb: -8, mute: false });
  assert.deepEqual(channel.directOutput, { output: 0, tap: "POST", gainDb: -1, mute: false });
  assert.equal([...target.ingest.runtimes.values()][0].packets, 1, "only the new owner creates and feeds the source");
  assert.ok(target.control.alerts.some((entry) => entry.message.startsWith("ON AIR recovery switch: Interview VC · RX01 → RX02; receiver generation")));
});

test("ON AIR recovery rejects a non-READY target and a duplicate authority conflict", (t) => {
  const target = runtime(t);
  const primary = "600000000000000041";
  const standby = "600000000000000042";
  target.ingest.ingest(botMeta(primary, "RX01", "RX"));
  target.ingest.ingest(botMeta(standby, "RX02", "SPARE", "connecting"));
  target.control.execute({ type: "SET_STATE", state: "READY" });
  target.control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  target.ingest.ingest(botMeta(primary, "RX01", "RX", "disconnected"));
  assert.equal(setReceiverOwner(target, "RX02", true).ok, false);

  const conflict = runtime(t);
  const first = new Socket();
  const duplicate = new Socket();
  conflict.ingest.ingest(botMeta(primary, "RX01", "RX"), new Socket());
  conflict.ingest.ingest(botMeta(standby, "RX02", "SPARE"), first);
  conflict.ingest.ingest(botMeta("600000000000000043", "RX02", "SPARE"), duplicate);
  conflict.control.execute({ type: "SET_STATE", state: "READY" });
  conflict.control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  conflict.ingest.ingest(botMeta(primary, "RX01", "RX", "fault"));
  assert.equal(setReceiverOwner(conflict, "RX02", true).ok, false);
  assert.equal(conflict.ingest.snapshot().receiverOwnership[0].status, "DISCONNECTED", "conflicted standby cannot become owner");
});

test("receiver owner switch rejects stale owner or generation without changing authority", (t) => {
  const target = runtime(t);
  target.ingest.ingest(botMeta("600000000000000051", "RX01", "RX"));
  target.ingest.ingest(botMeta("600000000000000052", "RX02", "SPARE"));
  const initial = target.ingest.snapshot().receiverOwnership[0];
  const firstSwitch = {
    type: "SET_RECEIVER_OWNER" as const,
    guildId,
    voiceChannelId,
    profileId: "RX02",
    confirmed: true,
    expectedCurrentOwner: initial.ownerProfileId,
    expectedReceiverGeneration: initial.generation,
  };
  assert.equal(target.control.execute(firstSwitch).ok, true);
  const current = target.ingest.snapshot().receiverOwnership[0];
  assert.equal(current.ownerProfileId, "RX02");

  const delayed = target.control.execute(firstSwitch);
  assert.equal(delayed.code, "STALE_STATE");
  assert.equal(target.ingest.snapshot().receiverOwnership[0].ownerProfileId, "RX02");
  const staleOwner = target.control.execute({ ...firstSwitch, expectedReceiverGeneration: current.generation });
  assert.equal(staleOwner.code, "STALE_STATE");
  const staleGeneration = target.control.execute({ ...firstSwitch, expectedCurrentOwner: current.ownerProfileId });
  assert.equal(staleGeneration.code, "STALE_STATE");
  assert.equal(setReceiverOwner(target, "RX01", true).ok, true, "a fresh snapshot permits explicit operator action");
  assert.ok(target.control.alerts.some((entry) => entry.message.includes("receiver-owner") && entry.message.includes("target=RX02")));
});

test("Emergency Mute and FAULT stay authoritative after receiver selection", (t) => {
  let now = 0; t.mock.method(performance, "now", () => now);
  const target = runtime(t);
  const botId = "600000000000000001";
  target.ingest.ingest(botMeta(botId, "RX01", "RX"));
  target.ingest.ingest({ type: DiscordFrameType.USER_META, ...identity(botId), sourceGeneration: 1, payload: Buffer.from("Guest") });
  const channel = [...target.engine.channels.values()][0];
  setApproval(target, channel, true);
  target.control.execute({ type: "SET_DIRECT_OUTPUT", channelId: channel.id, output: 0, tap: "PRE", gainDb: 0, mute: false });
  target.ingest.ingest({ type: DiscordFrameType.OPUS, ...identity(botId), sourceGeneration: 1, sequence: 1, payload: Buffer.from([1]) });
  now = 40;
  target.engine.processBlock();
  assert.equal(target.engine.outputs[0].some((sample) => sample !== 0), true);
  target.control.execute({ type: "EMERGENCY_MUTE", active: true });
  target.engine.processBlock();
  assert.equal(target.engine.outputs[0].every((sample) => sample === 0), true);
  target.control.execute({ type: "DEVICE_LOST", deviceId: "receiver-test" });
  target.engine.processBlock();
  assert.equal(target.control.state, "FAULT");
  assert.equal(target.engine.outputs[0].every((sample) => sample === 0), true);
});

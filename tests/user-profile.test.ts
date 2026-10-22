import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DiscordFrameType } from "../packages/discord-ipc/src/index.ts";
import { AudioChannel, AudioEngine, SineSource } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";
import type { OpusDecoder, OpusDecoderFactory } from "../services/router-core-sim/src/opus-decoder.ts";
import { UserProfileStore } from "../services/router-core-sim/src/user-profile-store.ts";
import { UserSessionRegistry } from "../services/router-core-sim/src/user-session-registry.ts";

class SilentDecoder implements OpusDecoder {
  decode(): Buffer { return Buffer.alloc(960 * 2); }
  dispose(): void {}
}

class SilentDecoderFactory implements OpusDecoderFactory {
  readonly backend = "@discordjs/opus" as const;
  create48kMono(): OpusDecoder { return new SilentDecoder(); }
}

function temporaryRoot(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "dbr-user-profiles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const identity = {
  botId: "710000000000000001",
  guildId: "720000000000000001",
  userId: "730000000000000001",
};
const otherUserId = "730000000000000002";
const vcA = "740000000000000001";
const vcB = "740000000000000002";

function channelId(userId: string, voiceChannelId: string): string {
  return `discord-user:${identity.guildId}:${voiceChannelId}:${userId}`;
}

function createRuntime(root: string) {
  const engine = new AudioEngine(48_000, 480, 8);
  const profiles = new UserProfileStore(root);
  const sessions = new UserSessionRegistry(profiles);
  const ingest = new DiscordIngestServer(engine, "test-only", null, new SilentDecoderFactory(), sessions);
  const control = new ControlPlane(engine, undefined, undefined, undefined, undefined, sessions);
  return { engine, profiles, sessions, ingest, control };
}

function receiverReady(runtime: ReturnType<typeof createRuntime>, voiceChannelId: string): void {
  runtime.ingest.ingest({
    type: DiscordFrameType.BOT_META,
    ...identity,
    userId: identity.botId,
    voiceChannelId,
    payload: Buffer.from(JSON.stringify({ profileId: `RX-${voiceChannelId}`, role: "RX", gatewayState: "ready", voiceState: "ready" })),
  });
}

test("participant strip ordering admits all 112 users and rejects a 113th ID atomically", (t) => {
  const runtime = createRuntime(temporaryRoot(t));
  receiverReady(runtime, vcA);
  const ids = Array.from({ length: 112 }, (_, index) => String(730000000000010000n + BigInt(index)));
  for (const userId of ids) {
    runtime.ingest.ingest({ type: DiscordFrameType.USER_META, ...identity, userId, voiceChannelId: vcA, payload: Buffer.from("Guest") });
  }
  assert.equal(runtime.control.execute({ type: "SET_USER_STRIP_ORDER", discordUserIds: [...ids].reverse() }).ok, true);
  const before = runtime.profiles.snapshot();
  assert.equal(runtime.control.execute({ type: "SET_USER_STRIP_ORDER", discordUserIds: [...ids, "730000000000020000"] }).ok, false);
  assert.deepEqual(runtime.profiles.snapshot(), before);
  runtime.profiles.flush();
});

test("Discord User profile keeps routes scoped to each VC across moves, rejoin, and process restart", (t) => {
  const root = temporaryRoot(t);
  const runtime = createRuntime(root);
  receiverReady(runtime, vcA);
  runtime.ingest.ingest({ type: DiscordFrameType.USER_META, ...identity, voiceChannelId: vcA, sourceGeneration: 1, payload: Buffer.from("Alex") });
  const initialSession = runtime.sessions.sessions.get(identity.userId)!;
  const firstId = channelId(identity.userId, vcA);
  const firstBusId = `discord-vc:${identity.guildId}:${vcA}`;
  assert.equal(runtime.control.execute({ type: "SET_CHANNEL_FADER", channelId: firstId, db: -6 }).ok, true);
  assert.equal(runtime.control.execute({ type: "SET_USER_CHANNEL_COLOR", channelId: firstId, color: "#e24452" }).ok, true);
  assert.equal(runtime.control.execute({ type: "SET_DIRECT_OUTPUT", channelId: firstId, output: 3, tap: "PRE", gainDb: -2, mute: false }).ok, true);
  assert.equal(runtime.control.execute({ type: "SET_VC_SEND", channelId: firstId, busId: firstBusId, db: -4, mute: false }).ok, true);
  assert.equal(runtime.control.execute({ type: "SET_RECALL_SAFE", parameter: `channel.${firstId}.faderDb`, safe: true }).ok, true);

  receiverReady(runtime, vcB);
  runtime.ingest.ingest({ type: DiscordFrameType.USER_META, ...identity, voiceChannelId: vcB, sourceGeneration: 2, payload: Buffer.from("Alex renamed") });
  const movedId = channelId(identity.userId, vcB);
  const moved = runtime.engine.channels.get(movedId)!;
  assert.equal(runtime.engine.channels.has(firstId), false);
  assert.equal(moved.discordUserId, identity.userId);
  assert.equal(moved.faderDb, -6);
  assert.equal(moved.channelColor, "#e24452");
  assert.equal(moved.directOutput, undefined, "a different VC must not inherit Direct Out");
  assert.equal(moved.vcSends.has(firstBusId), false, "a different VC must not remain in the previous VC MIX");
  assert.deepEqual(moved.vcSends.get("discord-vc:" + identity.guildId + ":" + vcB), { gainDb: -12, mute: false });
  assert.equal(runtime.control.recallSafe.has(`channel.${firstId}.faderDb`), false);
  assert.equal(runtime.control.recallSafe.has(`channel.${movedId}.faderDb`), true);

  const secondBusId = `discord-vc:${identity.guildId}:${vcB}`;
  assert.equal(runtime.control.execute({ type: "SET_VC_SEND", channelId: movedId, busId: secondBusId, db: -9, mute: true }).ok, true);
  runtime.ingest.ingest({ type: DiscordFrameType.USER_LEFT, ...identity, voiceChannelId: vcB, sourceGeneration: 2 });
  assert.equal(runtime.sessions.sessions.get(identity.userId)?.online, false);

  runtime.ingest.ingest({ type: DiscordFrameType.USER_META, ...identity, voiceChannelId: vcA, sourceGeneration: 3, payload: Buffer.from("Alex") });
  const rejoined = runtime.engine.channels.get(firstId)!;
  assert.equal(rejoined.faderDb, -6);
  assert.deepEqual(rejoined.directOutput, { output: 3, tap: "PRE", gainDb: -2, mute: false });
  assert.deepEqual(rejoined.vcSends.get(firstBusId), { gainDb: -4, mute: false });
  assert.equal(rejoined.vcSends.has(secondBusId), false, "returning to VC A must only join VC A MIX");
  assert.deepEqual(runtime.sessions.snapshot()[0], {
    discordUserId: identity.userId,
    sessionGeneration: initialSession.sessionGeneration,
    approvalRevision: initialSession.approvalRevision,
    currentChannelId: firstId,
    currentVC: vcA,
    currentStripSlot: 0,
    online: true,
    temporaryAlert: null,
    sessionApproval: "PENDING",
    audioActive: false,
  });

  runtime.ingest.ingest({ type: DiscordFrameType.USER_META, ...identity, userId: otherUserId, voiceChannelId: vcA, sourceGeneration: 1, payload: Buffer.from("Alex") });
  const other = runtime.engine.channels.get(channelId(otherUserId, vcA))!;
  assert.equal(other.faderDb, 0, "displayName equality must not reuse another Discord User profile");
  assert.equal(runtime.profiles.snapshot().length, 2);

  assert.equal(runtime.control.execute({ type: "SET_USER_STRIP_ORDER", discordUserIds: [otherUserId, identity.userId] }).ok, true);
  runtime.profiles.flush();
  const persisted = new UserProfileStore(root).snapshot();
  assert.deepEqual(persisted.map((profile) => profile.discordUserId), [otherUserId, identity.userId]);
  assert.equal(persisted[1].mainFaderDb, -6);
  assert.equal(persisted[1].channelColor, "#e24452");
  assert.equal(persisted[1].directOutput, undefined);
  assert.deepEqual(persisted[1].directOutputsByVoiceChannel[vcA], { output: 3, tap: "PRE", gainDb: -2, mute: false });
  assert.equal(persisted[1].directOutputsByVoiceChannel[vcB], undefined);
  assert.deepEqual(persisted[1].busSends[secondBusId], { gainDb: -9, mute: true });
  assert.deepEqual(persisted[1].recallSafe, ["faderDb"]);
  const disk = JSON.parse(readFileSync(join(root, "user-profiles.json"), "utf8"));
  assert.equal(disk.version, 1);
  assert.equal("sessions" in disk, false, "session state must not be mixed into the persistent store");

  const restarted = createRuntime(root);
  receiverReady(restarted, vcA);
  restarted.ingest.ingest({ type: DiscordFrameType.USER_META, ...identity, voiceChannelId: vcA, sourceGeneration: 1, payload: Buffer.from("Alex") });
  const afterRestart = restarted.engine.channels.get(firstId)!;
  assert.deepEqual(afterRestart.directOutput, { output: 3, tap: "PRE", gainDb: -2, mute: false });
  assert.deepEqual(afterRestart.vcSends.get(firstBusId), { gainDb: -4, mute: false });
  assert.equal(afterRestart.vcSends.has(secondBusId), false);
  restarted.profiles.flush();
});

test("old POST mute persists until explicit recovery, which restores audio without changing PRE or VC send", (t) => {
  const root = temporaryRoot(t);
  writeFileSync(join(root, "user-profiles.json"), JSON.stringify({ profiles: [{
    discordUserId: identity.userId, channelName: "Legacy", mainFaderDb: -18, mainMute: true,
    directOutputsByVoiceChannel: { [vcA]: { output: 0, tap: "POST", gainDb: 0, mute: false } },
  }] }));
  const store = new UserProfileStore(root);
  const engine = new AudioEngine(48_000, 480, 2);
  const channel = new AudioChannel("legacy", "Legacy", "DiscordUser", new SineSource(1_000, -12), 480, 48_000);
  channel.currentVoiceChannelId = vcA; channel.approvalGateOpen = true;
  channel.vcSends.set("vc", { gainDb: -9, mute: true });
  store.restoreOrCreate(channel, identity.userId, "Legacy"); engine.addChannel(channel);
  engine.processBlock();
  assert.ok(channel.processed.some(value => value !== 0));
  assert.equal(engine.outputs[0].some(value => value !== 0), false);
  const sends = [...channel.vcSends]; const route = { ...channel.directOutput };
  const control = new ControlPlane(engine);
  assert.equal(control.execute({ type: "SET_CHANNEL_FADER", channelId: channel.id, db: 0 }).ok, true);
  assert.equal(control.execute({ type: "SET_CHANNEL_MUTE", channelId: channel.id, mute: false }).ok, true);
  engine.processBlock(); assert.ok(engine.outputs[0].some(value => value !== 0));
  assert.deepEqual([...channel.vcSends], sends); assert.deepEqual(channel.directOutput, route);
  store.captureChannel(channel); store.flush();
  const saved = new UserProfileStore(root).snapshot()[0];
  assert.equal(saved.mainFaderDb, 0); assert.equal(saved.mainMute, false);
});

test("legacy channel-shaped profile fields migrate only by Discord User ID", (t) => {
  const root = temporaryRoot(t);
  writeFileSync(join(root, "user-profiles.json"), JSON.stringify({
    profiles: [
      { id: identity.userId, label: "Legacy Alex", faderDb: -8, stripPosition: 4, vcSends: { legacy: { gainDb: -3, mute: false } } },
      { label: "Legacy Alex", faderDb: 6 },
    ],
  }));
  const store = new UserProfileStore(root);
  const profiles = store.snapshot();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].discordUserId, identity.userId);
  assert.equal(profiles[0].channelName, "Legacy Alex");
  assert.equal(profiles[0].mainFaderDb, -8);
  assert.equal(profiles[0].preferredStripPosition, 4);
  assert.deepEqual(profiles[0].directOutputsByVoiceChannel, {});
  assert.deepEqual(profiles[0].busSends.legacy, { gainDb: -3, mute: false });
});

test("persistent strip order remains locked while ON AIR and resets in READY", (t) => {
  const root = temporaryRoot(t);
  const runtime = createRuntime(root);
  receiverReady(runtime, vcA);
  runtime.ingest.ingest({ type: DiscordFrameType.USER_META, ...identity, voiceChannelId: vcA, sourceGeneration: 1, payload: Buffer.from("One") });
  runtime.ingest.ingest({ type: DiscordFrameType.USER_META, ...identity, userId: otherUserId, voiceChannelId: vcA, sourceGeneration: 1, payload: Buffer.from("Two") });
  runtime.control.execute({ type: "SET_STATE", state: "READY" });
  assert.equal(runtime.control.execute({ type: "SET_USER_STRIP_ORDER", discordUserIds: [otherUserId, identity.userId] }).ok, true);
  assert.equal(runtime.engine.channels.get(channelId(otherUserId, vcA))?.preferredStripPosition, 0);
  assert.equal(runtime.engine.channels.get(channelId(identity.userId, vcA))?.preferredStripPosition, 1);
  runtime.control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  assert.equal(runtime.control.execute({ type: "SET_USER_STRIP_ORDER", discordUserIds: [identity.userId, otherUserId] }).ok, false);
  assert.deepEqual(runtime.profiles.snapshot().map((profile) => profile.discordUserId), [otherUserId, identity.userId]);
  runtime.control.execute({ type: "SET_STATE", state: "SETUP", confirmed: true });
  runtime.control.execute({ type: "SET_STATE", state: "READY" });
  assert.equal(runtime.control.execute({ type: "RESET_USER_STRIP_ORDER" }).ok, true);
  assert.deepEqual(runtime.profiles.snapshot().map((profile) => profile.discordUserId), [identity.userId, otherUserId]);
});

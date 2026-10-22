import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AudioChannel, AudioEngine, SineSource, VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { RecorderManager } from "../services/router-core-sim/src/recorder.ts";
import { UserProfileStore } from "../services/router-core-sim/src/user-profile-store.ts";
import { UserSessionRegistry } from "../services/router-core-sim/src/user-session-registry.ts";

const userA = "910000000000000001";
const userB = "910000000000000002";
const vcA = "920000000000000001";
const vcB = "920000000000000002";

function temporaryRoot(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "dbr-approval-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function runtime(root: string, outputs = 4) {
  const engine = new AudioEngine(48_000, 480, outputs);
  const profiles = new UserProfileStore(root);
  const sessions = new UserSessionRegistry(profiles);
  const control = new ControlPlane(engine, undefined, undefined, undefined, undefined, sessions);
  return { engine, profiles, sessions, control };
}

function participant(id: string, label = "Guest", voiceChannelId = vcA): AudioChannel {
  return new AudioChannel(`discord:test:${voiceChannelId}:${id}`, label, "DiscordUser", new SineSource(1_000, -6), 480, 48_000);
}

function joinParticipant(target: ReturnType<typeof runtime>, id: string, label = "Guest", voiceChannelId = vcA): AudioChannel {
  const channel = participant(id, label, voiceChannelId);
  target.sessions.join(channel, id, voiceChannelId, label);
  target.engine.addChannel(channel);
  return channel;
}

function setApproval(target: ReturnType<typeof runtime>, channel: AudioChannel, approved: boolean) {
  const session = target.sessions.sessions.get(channel.discordUserId!);
  assert.ok(session);
  return target.control.execute({
    type: "SET_PARTICIPANT_APPROVAL",
    channelId: channel.id,
    discordUserId: channel.discordUserId!,
    approved,
    expectedSessionGeneration: session.sessionGeneration,
    expectedApprovalRevision: session.approvalRevision,
  });
}

function clearEmergency(target: ReturnType<typeof runtime>) {
  return target.control.execute({
    type: "EMERGENCY_MUTE",
    active: false,
    confirmed: true,
    expectedEmergencyEpoch: target.control.snapshot().emergencyEpoch,
  });
}

function peak(samples: Float32Array): number {
  let result = 0;
  for (const sample of samples) result = Math.max(result, Math.abs(sample));
  return result;
}

test("PENDING gate meters Discord RX but blocks MAIN, VC BUS, Direct Out, and TX Return paths", (t) => {
  const target = runtime(temporaryRoot(t));
  const main = new VcBus("main", "MAIN", target.engine.blockSize, target.engine.sampleRate);
  const interview = new VcBus("interview", "INTERVIEW", target.engine.blockSize, target.engine.sampleRate);
  target.engine.addBus(main);
  target.engine.addBus(interview);
  const channel = joinParticipant(target, userA);
  channel.vcSends.set(main.id, { gainDb: 0, mute: false });
  channel.vcSends.set(interview.id, { gainDb: 0, mute: false });
  channel.directOutput = { output: 0, tap: "PRE", gainDb: 0, mute: false };
  target.engine.addMatrixRoute({ id: "main-out", sourceId: main.id, output: 1, gainDb: 0, mute: false, tap: "POST" });
  target.engine.addMatrixRoute({ id: "vc-out", sourceId: interview.id, output: 2, gainDb: 0, mute: false, tap: "POST" });
  target.engine.addMatrixRoute({ id: "tx-return", sourceId: channel.id, output: 3, gainDb: 0, mute: false, tap: "PRE" });

  target.engine.processBlock();
  assert.equal(target.sessions.sessions.get(userA)?.sessionApproval, "PENDING");
  assert.equal(channel.approvalGateOpen, false);
  assert.ok(channel.inputMeter.peak > 0.1, "pre-gate Meter remains live");
  assert.equal(channel.outputMeter.peak, 0);
  assert.equal(peak(channel.post), 0, "MAIN fader signal is closed");
  assert.equal(peak(main.buffer), 0, "MAIN bus is closed");
  assert.equal(peak(interview.buffer), 0, "VC BUS is closed");
  assert.equal(peak(target.engine.outputs[0]), 0, "Direct Out is closed");
  assert.equal(peak(target.engine.outputs[3]), 0, "TX Return Matrix output is closed");

  assert.equal(setApproval(target, channel, true).ok, true);
  target.engine.processBlock();
  assert.equal(channel.approvalGateOpen, true);
  assert.ok(peak(channel.post) > 0.1, "MAIN opens only after approval");
  assert.ok(peak(interview.buffer) > 0.1, "VC BUS opens only after approval");
  assert.ok(peak(target.engine.outputs[0]) > 0.1, "Direct Out opens only after approval");
  assert.ok(peak(target.engine.outputs[3]) > 0.1, "TX Return opens only after approval");

  assert.equal(setApproval(target, channel, false).ok, true);
  target.engine.processBlock();
  assert.equal(peak(channel.post), 0);
  assert.equal(peak(main.buffer), 0);
  assert.equal(peak(interview.buffer), 0);
  assert.equal(peak(target.engine.outputs[0]), 0);
  assert.equal(peak(target.engine.outputs[3]), 0, "revoke closes every path on the next audio block");
  assert.ok(target.control.alerts.some((entry) => entry.message === "user joined: Guest"));
  assert.ok(target.control.alerts.some((entry) => entry.message === "pending created: Guest"));
  assert.ok(target.control.alerts.some((entry) => entry.message === "approved: Guest"));
  assert.ok(target.control.alerts.some((entry) => entry.message === "approval revoked: Guest"));
  target.profiles.flush();
});

test("PENDING participant records silence on program, BUS, and user tracks", async (t) => {
  const root = temporaryRoot(t);
  const target = runtime(root, 2);
  const main = new VcBus("main", "MAIN", target.engine.blockSize, target.engine.sampleRate);
  target.engine.addBus(main);
  const channel = joinParticipant(target, userA);
  channel.vcSends.set(main.id, { gainDb: 0, mute: false });
  target.engine.addMatrixRoute({ id: "program", sourceId: main.id, output: 0, gainDb: 0, mute: false, tap: "POST" });
  const folder = join(root, "recordings");
  const recorder = new RecorderManager(target.engine, folder);
  try {
    recorder.start({ matrixOutput: 0, includeUsers: true, includeBuses: true });
    target.engine.processBlock();
    recorder.captureBlock();
    recorder.stop();
    await recorder.waitForIdle();
    const files = readdirSync(folder).filter((name) => name.endsWith(".wav"));
    assert.equal(files.length, 3);
    for (const file of files) {
      const wav = readFileSync(join(folder, file));
      for (let offset = 44; offset < wav.length; offset += 4) assert.equal(wav.readFloatLE(offset), 0, `${file} must remain silent`);
    }
  } finally {
    await recorder.close();
    target.profiles.flush();
  }
});

test("session approval survives rejoin and VC move while identity and Trusted remain ID-only", (t) => {
  const root = temporaryRoot(t);
  const first = runtime(root);
  const original = joinParticipant(first, userA, "Same Name", vcA);
  assert.equal(first.sessions.sessions.get(userA)?.sessionApproval, "PENDING");
  assert.equal(first.profiles.snapshot()[0].trusted, false, "an unseen user is never Trusted");
  setApproval(first, original, true);
  first.sessions.leave(original);
  first.engine.removeChannel(original.id);

  const moved = joinParticipant(first, userA, "Same Name", vcB);
  assert.equal(first.sessions.sessions.get(userA)?.sessionApproval, "APPROVED");
  assert.equal(moved.approvalGateOpen, true, "same-session VC move restores approval");
  const distinct = joinParticipant(first, userB, "Same Name", vcA);
  assert.equal(first.sessions.sessions.get(userB)?.sessionApproval, "PENDING", "displayName does not transfer approval");
  assert.equal(first.control.execute({ type: "SET_USER_TRUSTED", channelId: distinct.id, trusted: true }).confirmationRequired, true);
  assert.equal(first.control.execute({ type: "SET_USER_TRUSTED", channelId: distinct.id, trusted: true, confirmed: true }).ok, true);
  assert.equal(first.sessions.sessions.get(userB)?.sessionApproval, "PENDING", "Trusted is separate from current-session approval");
  assert.equal(distinct.approvalGateOpen, false);

  assert.equal(first.control.endParticipantSession(), 1);
  assert.equal(first.sessions.sessions.get(userA)?.sessionApproval, "PENDING", "normal approval resets at session end");
  assert.equal(first.sessions.sessions.get(userB)?.sessionApproval, "APPROVED", "Trusted user is eligible in the next session");
  assert.ok(first.control.alerts.some((entry) => entry.message === "rejoin restored: Same Name (APPROVED)"));
  assert.ok(first.control.alerts.some((entry) => entry.message === "trusted enabled: Same Name"));
  assert.ok(first.control.alerts.some((entry) => entry.message === "session approval reset: Same Name"));
  first.profiles.flush();

  const second = runtime(root);
  const ordinaryNextSession = joinParticipant(second, userA, "Same Name", vcA);
  const trustedNextSession = joinParticipant(second, userB, "Same Name", vcA);
  assert.equal(ordinaryNextSession.approvalGateOpen, false);
  assert.equal(second.sessions.sessions.get(userA)?.sessionApproval, "PENDING");
  assert.equal(trustedNextSession.approvalGateOpen, true);
  assert.equal(second.sessions.sessions.get(userB)?.sessionApproval, "APPROVED");
  assert.ok(second.control.alerts.some((entry) => entry.message === "approved: Same Name (trusted auto-approve)"));
  assert.equal(second.control.execute({ type: "SET_USER_TRUSTED", channelId: trustedNextSession.id, trusted: false }).ok, true);
  assert.equal(trustedNextSession.approvalGateOpen, true, "removing Trusted does not silently revoke current approval");
  assert.ok(second.control.alerts.some((entry) => entry.message === "trusted disabled: Same Name"));
  second.profiles.flush();
});

test("Emergency Mute and FAULT remain authoritative after participant approval", (t) => {
  const target = runtime(temporaryRoot(t), 1);
  const channel = joinParticipant(target, userA);
  channel.directOutput = { output: 0, tap: "PRE", gainDb: 0, mute: false };
  setApproval(target, channel, true);
  target.engine.processBlock();
  assert.ok(peak(target.engine.outputs[0]) > 0.1);

  target.control.execute({ type: "EMERGENCY_MUTE", active: true });
  target.engine.processBlock();
  assert.equal(peak(target.engine.outputs[0]), 0);
  clearEmergency(target);
  target.control.execute({ type: "DEVICE_LOST", deviceId: "approval-test-output" });
  assert.equal(target.control.state, "FAULT");
  assert.equal(channel.approvalGateOpen, true);
  target.engine.processBlock();
  assert.equal(peak(target.engine.outputs[0]), 0, "FAULT emergency silence has priority over approval");
  target.profiles.flush();
});

test("approval and revoke remain available ON AIR without bypassing structural locks", (t) => {
  const target = runtime(temporaryRoot(t));
  const first = joinParticipant(target, userA, "One");
  joinParticipant(target, userB, "Two");
  target.control.execute({ type: "SET_STATE", state: "READY" });
  target.control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  assert.equal(setApproval(target, first, true).ok, true);
  assert.equal(first.approvalGateOpen, true);
  assert.equal(target.control.execute({ type: "SET_USER_STRIP_ORDER", discordUserIds: [userB, userA] }).ok, false);
  assert.equal(target.control.execute({ type: "CREATE_VC_BUS", name: "Bypass" }).ok, false);
  assert.equal(setApproval(target, first, false).ok, true);
  assert.equal(first.approvalGateOpen, false);
  target.profiles.flush();
});

test("approval commands use per-session generation and revision CAS", (t) => {
  const root = temporaryRoot(t);
  const target = runtime(root);
  const channel = joinParticipant(target, userA, "CAS Guest");
  const initial = target.sessions.sessions.get(userA)!;
  const approve = {
    type: "SET_PARTICIPANT_APPROVAL" as const,
    channelId: channel.id,
    discordUserId: userA,
    approved: true,
    expectedSessionGeneration: initial.sessionGeneration,
    expectedApprovalRevision: initial.approvalRevision,
  };

  assert.equal(target.control.execute(approve).ok, true);
  const duplicate = target.control.execute(approve);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, "STALE_STATE");
  assert.equal(channel.approvalGateOpen, true);

  const approved = target.sessions.sessions.get(userA)!;
  const revoke = {
    ...approve,
    approved: false,
    expectedApprovalRevision: approved.approvalRevision,
  };
  assert.equal(target.control.execute(revoke).ok, true);
  assert.equal(target.control.execute(approve).code, "STALE_STATE", "delayed APPROVE cannot override a newer revoke");
  assert.equal(channel.approvalGateOpen, false);

  const beforeReset = target.sessions.sessions.get(userA)!;
  target.control.endParticipantSession();
  const afterReset = target.sessions.sessions.get(userA)!;
  assert.notEqual(afterReset.sessionGeneration, beforeReset.sessionGeneration);
  const oldSession = target.control.execute({
    ...approve,
    expectedApprovalRevision: beforeReset.approvalRevision,
  });
  assert.equal(oldSession.code, "STALE_STATE");
  assert.equal(channel.approvalGateOpen, false);

  const other = joinParticipant(target, userB, "CAS Guest");
  assert.equal(other.approvalGateOpen, false, "same display name has an independent safety resource");
  assert.equal(target.sessions.sessions.get(userB)?.approvalRevision, 1);
  assert.equal(target.control.alerts.some((entry) => entry.message.includes(userA)), false, "stale rejection log does not expose Discord User ID");
  target.profiles.flush();

  const restarted = runtime(root);
  joinParticipant(restarted, userA, "CAS Guest");
  assert.notEqual(restarted.sessions.sessions.get(userA)?.sessionGeneration, afterReset.sessionGeneration, "application restart creates a new approval lifetime");
  restarted.profiles.flush();
});

test("short rejoin and VC move preserve approval generation and revision", (t) => {
  const target = runtime(temporaryRoot(t));
  const first = joinParticipant(target, userA, "Moving Guest", vcA);
  assert.equal(setApproval(target, first, true).ok, true);
  const before = target.sessions.sessions.get(userA)!;
  target.sessions.leave(first);
  target.engine.removeChannel(first.id);
  const moved = joinParticipant(target, userA, "Moving Guest", vcB);
  const after = target.sessions.sessions.get(userA)!;
  assert.equal(after.sessionGeneration, before.sessionGeneration);
  assert.equal(after.approvalRevision, before.approvalRevision);
  assert.equal(after.sessionApproval, "APPROVED");
  assert.equal(moved.approvalGateOpen, true);
  target.profiles.flush();
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AudioChannel, AudioEngine, SineSource } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane, type DiscordTxController } from "../services/router-core-sim/src/control-plane.ts";
import { RecorderManager } from "../services/router-core-sim/src/recorder.ts";
import { UserProfileStore } from "../services/router-core-sim/src/user-profile-store.ts";
import { UserSessionRegistry } from "../services/router-core-sim/src/user-session-registry.ts";

test("ON AIR Scene recall keeps approval, Trusted, receiver ownership, and structural locks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dbr-scene-header-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const engine = AudioEngine.createDemo(1);
  const profiles = new UserProfileStore(root);
  const sessions = new UserSessionRegistry(profiles);
  let receiverChanges = 0;
  const receiver: DiscordTxController = {
    connectBot() {}, disconnectBot() {}, setTxSource() {}, assignTxVoiceChannel() {}, startTx() {}, stopTx() {}, stopAllTx() {},
    setReceiverOwner(_guildId, _voiceChannelId, profileId) {
      receiverChanges += 1;
      return { previousProfileId: null, profileId, voiceChannelName: "Interview VC" };
    },
  };
  const control = new ControlPlane(engine, undefined, receiver, undefined, undefined, sessions);
  const participant = new AudioChannel("discord-user:test", "Guest", "DiscordUser", new SineSource(1_000, -12), 480, 48_000);
  sessions.join(participant, "910000000000000001", "920000000000000001", "Guest");
  engine.addChannel(participant);
  const session = sessions.sessions.get("910000000000000001")!;
  control.execute({
    type: "SET_PARTICIPANT_APPROVAL", channelId: participant.id, discordUserId: session.discordUserId, approved: true,
    expectedSessionGeneration: session.sessionGeneration, expectedApprovalRevision: session.approvalRevision,
  });
  control.execute({ type: "SET_USER_TRUSTED", channelId: participant.id, trusted: true, confirmed: true });
  control.execute({
    type: "SET_RECEIVER_OWNER", guildId: "930000000000000001", voiceChannelId: "920000000000000001", profileId: "RX01", confirmed: true,
    expectedCurrentOwner: null, expectedReceiverGeneration: 1,
  });

  control.execute({ type: "SET_LIMITER", busId: "interview", enabled: false });
  const unsafeScene = control.execute({ type: "SAVE_SCENE", name: "Interview" }).data as { id: string; values: Record<string, unknown> };
  control.execute({ type: "SET_LIMITER", busId: "interview", enabled: true });
  const holdingScene = control.execute({ type: "SAVE_SCENE", name: "Holding" }).data as { id: string };
  assert.equal(control.snapshot().currentSceneId, holdingScene.id);
  assert.equal(Object.keys(unsafeScene.values).some((key) => /approval|trusted|receiver/i.test(key)), false);

  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  assert.equal(control.execute({ type: "RECALL_SCENE", sceneId: unsafeScene.id, confirmed: true }).ok, true);
  assert.equal(control.snapshot().currentSceneId, unsafeScene.id);
  assert.equal(engine.buses.get("interview")?.limiter.enabled, true, "Scene cannot disable the limiter outside SETUP");
  assert.equal(sessions.sessions.get("910000000000000001")?.sessionApproval, "APPROVED");
  assert.equal(profiles.snapshot().find((profile) => profile.discordUserId === "910000000000000001")?.trusted, true);
  assert.equal(receiverChanges, 1, "Scene recall never changes Receiver Owner");
  assert.ok(control.alerts.some((event) => event.message === "Scene Interview recalled"));
  profiles.flush();
});

test("Recorder Start and Stop remain available ON AIR and are logged", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dbr-recorder-header-"));
  const engine = AudioEngine.createDemo(1);
  const recorder = new RecorderManager(engine, join(root, "recordings"));
  const control = new ControlPlane(engine, undefined, undefined, undefined, recorder);
  t.after(async () => { await recorder.close(); rmSync(root, { recursive: true, force: true }); });
  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  assert.equal(control.execute({ type: "START_RECORDING", matrixOutput: 0, includeUsers: false, includeBuses: true, confirmed: true }).ok, true);
  assert.equal(recorder.snapshot().state, "RECORDING");
  engine.processBlock();
  recorder.captureBlock();
  assert.equal(control.execute({ type: "STOP_RECORDING", confirmed: true }).ok, true);
  await recorder.waitForIdle();
  assert.equal(recorder.snapshot().state, "IDLE");
  assert.ok(control.alerts.some((event) => event.message === "Recorder started: Matrix OUT 1"));
  assert.ok(control.alerts.some((event) => event.message === "Recorder stopping"));
});

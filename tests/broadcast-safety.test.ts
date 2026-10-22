import assert from "node:assert/strict";
import test from "node:test";
import type { SceneChange } from "../packages/shared-types/src/index.ts";
import { AudioChannel, AudioEngine, SilenceSource } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";

function savedSceneId(control: ControlPlane, name = "Scene"): string {
  const result = control.execute({ type: "SAVE_SCENE", name });
  return (result.data as { id: string }).id;
}

test("FAULT cannot be bypassed through SET_STATE and acknowledgement keeps emergency mute active", () => {
  const control = new ControlPlane(AudioEngine.createDemo(1));
  control.execute({ type: "DEVICE_LOST", deviceId: "SoundGrid" });
  const bypass = control.execute({ type: "SET_STATE", state: "SETUP", confirmed: true });
  assert.equal(bypass.ok, false);
  assert.equal(control.state, "FAULT");
  assert.equal(control.execute({ type: "ACKNOWLEDGE_FAULT", confirmed: false }).ok, false);
  assert.equal(control.execute({ type: "ACKNOWLEDGE_FAULT", confirmed: true }).ok, true);
  assert.equal(control.state, "SETUP");
  assert.equal(control.engine.emergencyMuted, true);
});

test("leaving ON AIR requires confirmation", () => {
  const control = new ControlPlane(AudioEngine.createDemo(1));
  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  const unconfirmed = control.execute({ type: "SET_STATE", state: "SETUP" });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.confirmationRequired, true);
  assert.equal(control.state, "ON_AIR");
  assert.equal(control.execute({ type: "SET_STATE", state: "SETUP", confirmed: true }).ok, true);
});

test("Scene Preview distinguishes Recall Safe and ON AIR safety locks", () => {
  const control = new ControlPlane(AudioEngine.createDemo(1));
  control.execute({ type: "SET_CHANNEL_FADER", channelId: "user-01", db: -3 });
  control.execute({ type: "SET_LIMITER", busId: "interview", enabled: false });
  const sceneId = savedSceneId(control, "Unsafe Opening");
  control.execute({ type: "SET_CHANNEL_FADER", channelId: "user-01", db: -10 });
  control.execute({ type: "SET_LIMITER", busId: "interview", enabled: true });
  control.execute({ type: "SET_RECALL_SAFE", parameter: "channel.user-01.faderDb", safe: true });
  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });

  const preview = control.execute({ type: "PREVIEW_SCENE", sceneId });
  const changes = (preview.data as { changes: SceneChange[] }).changes;
  assert.equal(changes.find((change) => change.parameter === "channel.user-01.faderDb")?.recallSafe, true);
  assert.equal(changes.find((change) => change.parameter === "bus.interview.limiterEnabled")?.locked, true);
  assert.equal(control.execute({ type: "RECALL_SCENE", sceneId, confirmed: true }).ok, true);
  assert.equal(control.engine.channels.get("user-01")?.faderDb, -10);
  assert.equal(control.engine.buses.get("interview")?.limiter.enabled, true);
});

test("Scene Preview reports Discord participants that joined after save", () => {
  const engine = AudioEngine.createDemo(0);
  const control = new ControlPlane(engine);
  const sceneId = savedSceneId(control, "Empty room");
  const participant = new AudioChannel("discord-user:test", "Late Guest", "DiscordUser", new SilenceSource(), engine.blockSize, engine.sampleRate);
  engine.addChannel(participant);

  const preview = control.execute({ type: "PREVIEW_SCENE", sceneId });
  assert.deepEqual((preview.data as { excludedParticipants: string[] }).excludedParticipants, ["Late Guest"]);
  assert.equal(control.execute({ type: "RECALL_SCENE", sceneId, confirmed: true }).ok, true);
  assert.equal(engine.channels.get(participant.id)?.faderDb, 0, "a participant absent from the Scene is preserved");
});

test("Scene overwrite requires confirmation, keeps identity, and rejects duplicate names", () => {
  const control = new ControlPlane(AudioEngine.createDemo(1));
  control.execute({ type: "SET_CHANNEL_FADER", channelId: "user-01", db: -3 });
  const sceneId = savedSceneId(control, "Baseline");
  control.execute({ type: "SET_CHANNEL_FADER", channelId: "user-01", db: -10 });

  const unconfirmed = control.execute({ type: "SAVE_SCENE", sceneId, name: "Baseline" });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.confirmationRequired, true);
  assert.equal(control.execute({ type: "SAVE_SCENE", sceneId, name: "Baseline", confirmed: true }).ok, true);
  assert.equal(control.snapshot().scenes.length, 1);
  assert.equal(control.scenes.get(sceneId)?.values["channel.user-01.faderDb"], -10);
  assert.equal(control.execute({ type: "SAVE_SCENE", name: "baseline" }).ok, false);

  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  assert.equal(control.execute({ type: "SAVE_SCENE", sceneId, name: "Baseline", confirmed: true }).ok, false);
});

test("ON AIR Scene recall preserves strip order and Recall Safe is locked in ON AIR and FAULT", () => {
  const engine = AudioEngine.createDemo(2);
  const control = new ControlPlane(engine);
  const sceneId = savedSceneId(control, "Original Order");
  engine.setChannelOrder([...engine.channels.values()].reverse());
  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });

  const preview = control.execute({ type: "PREVIEW_SCENE", sceneId });
  const changes = (preview.data as { changes: SceneChange[] }).changes;
  assert.equal(changes.find((change) => change.parameter === "channel.user-01.order")?.locked, true);
  assert.equal(control.execute({ type: "SET_RECALL_SAFE", parameter: "channel.user-01.order", safe: true }).ok, false);
  assert.equal(control.execute({ type: "RECALL_SCENE", sceneId, confirmed: true }).ok, true);
  assert.deepEqual([...engine.channels.keys()], ["user-02", "user-01"], "ON AIR recall cannot reorder the channel bank");

  control.execute({ type: "DEVICE_LOST", deviceId: "SoundGrid" });
  assert.equal(control.execute({ type: "SET_RECALL_SAFE", parameter: "channel.user-01.order", safe: true }).ok, false);
  const faultPreview = control.execute({ type: "PREVIEW_SCENE", sceneId });
  const faultChanges = (faultPreview.data as { changes: SceneChange[] }).changes;
  assert.equal(faultChanges.find((change) => change.parameter === "channel.user-01.order")?.locked, true);
  control.execute({ type: "RECALL_SCENE", sceneId, confirmed: true });
  assert.deepEqual([...engine.channels.keys()], ["user-02", "user-01"], "FAULT recall cannot reorder the channel bank");
});

test("READY Scene recall may restore strip order", () => {
  const engine = AudioEngine.createDemo(2);
  const control = new ControlPlane(engine);
  const sceneId = savedSceneId(control, "Ready Order");
  engine.setChannelOrder([...engine.channels.values()].reverse());
  control.execute({ type: "SET_STATE", state: "READY" });
  assert.equal(control.execute({ type: "RECALL_SCENE", sceneId, confirmed: true }).ok, true);
  assert.deepEqual([...engine.channels.keys()], ["user-01", "user-02"]);
});

test("Scene recall restores labels, compressor, matrix gain and channel order", () => {
  const engine = AudioEngine.createDemo(2);
  const control = new ControlPlane(engine);
  const sceneId = savedSceneId(control, "Full State");
  engine.channels.get("user-01")!.label = "Changed";
  engine.buses.get("interview")!.compressor.thresholdDb = -40;
  engine.matrixRoutes.get("interview-program")!.gainDb = -12;
  const reversed = [...engine.channels.entries()].reverse();
  engine.channels.clear();
  reversed.forEach(([id, channel]) => engine.channels.set(id, channel));
  control.execute({ type: "RECALL_SCENE", sceneId, confirmed: true });
  assert.equal(engine.channels.get("user-01")?.label, "Guest 1");
  assert.equal(engine.buses.get("interview")?.compressor.thresholdDb, -12);
  assert.equal(engine.matrixRoutes.get("interview-program")?.gainDb, 0);
  assert.deepEqual([...engine.channels.keys()], ["user-01", "user-02"]);
});

test("Scene delete requires confirmation and is locked ON AIR", () => {
  const control = new ControlPlane(AudioEngine.createDemo(1));
  const sceneId = savedSceneId(control, "Delete Me");
  assert.equal(control.execute({ type: "DELETE_SCENE", sceneId }).confirmationRequired, true);
  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  assert.equal(control.execute({ type: "DELETE_SCENE", sceneId, confirmed: true }).ok, false);
  control.execute({ type: "SET_STATE", state: "SETUP", confirmed: true });
  assert.equal(control.execute({ type: "DELETE_SCENE", sceneId, confirmed: true }).ok, true);
  assert.equal(control.snapshot().scenes.length, 0);
});

test("Event Log clear requires confirmation and leaves an audit event", () => {
  const control = new ControlPlane(AudioEngine.createDemo(1));
  control.execute({ type: "SET_CHANNEL_FADER", channelId: "user-01", db: -6 });
  assert.ok(control.snapshot().alerts.length >= 2);
  assert.equal(control.execute({ type: "CLEAR_EVENT_LOG" }).confirmationRequired, true);
  assert.equal(control.execute({ type: "CLEAR_EVENT_LOG", confirmed: true }).ok, true);
  const alerts = control.snapshot().alerts;
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /cleared by operator/);
});

test("Recall Safe accepts only current scene parameters", () => {
  const control = new ControlPlane(AudioEngine.createDemo(1));
  assert.equal(control.execute({ type: "SET_RECALL_SAFE", parameter: "channel.user-01.faderDb", safe: true }).ok, true);
  assert.equal(control.execute({ type: "SET_RECALL_SAFE", parameter: "token.secret", safe: true }).ok, false);
  assert.deepEqual(control.snapshot().recallSafe, ["channel.user-01.faderDb"]);
});

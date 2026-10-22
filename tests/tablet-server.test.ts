import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RouterSnapshot } from "../packages/shared-types/src/index.ts";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { TabletControlServer, TabletProjection } from "../services/router-core-sim/src/tablet-server.ts";

test("Tablet snapshot removes admin, secret, path and Discord identity fields", () => {
  const control = new ControlPlane(AudioEngine.createDemo(2));
  const guildId = "111111111111111111";
  const voiceChannelId = "222222222222222222";
  const discordUserId = "333333333333333333";
  const canonicalChannelId = `discord-user:${guildId}:${voiceChannelId}:${discordUserId}`;
  const canonicalBusId = `discord-vc:${guildId}:${voiceChannelId}`;
  const base = control.snapshot();
  const source = {
    ...base,
    monitorSourceId: canonicalChannelId,
    channels: base.channels.map((channel, index) => index === 0 ? {
      ...channel,
      id: canonicalChannelId,
      discordUserId,
      currentVoiceChannelId: voiceChannelId,
      vcSends: { [canonicalBusId]: { gainDb: -6, mute: false } },
    } : channel),
    buses: base.buses.map((bus, index) => index === 0 ? { ...bus, id: canonicalBusId } : bus),
    recorder: {
      state: "RECORDING", folder: "D:/secret/recordings", format: "WAV_FLOAT32", sampleRate: 48_000,
      startedAt: new Date().toISOString(), durationSeconds: 1, matrixOutput: 0, includeUsers: true, includeBuses: true,
      selection: { outputs: [0], busIds: [canonicalBusId], channelIds: [canonicalChannelId] }, selectionSupported: true,
      queuedBlocks: 0, maxQueuedBlocks: 20, droppedBlocks: 0, freeBytes: 100, totalBytes: 200, message: "write failed at /home/operator/private/session.wav token=super-secret-value",
      tracks: [{ kind: "DISCORD_USER", sourceId: canonicalChannelId, label: "Guest", fileName: "secret.wav", dataBytes: 10 }],
    },
    discord: {
      endpoint: "secret-pipe", connectedAdapters: 1, adapterState: "READY", configuredBots: 1, readyBots: 1, staleBots: 0, reconnectingBots: 0,
      packets: 1, bytes: 1, decodeErrors: 0, tx: null, txStems: [], availableVoiceChannels: [{ guildId, id: voiceChannelId, name: "Studio" }], sources: [], receiverOwnership: [],
      bots: [{ profileId: "BOT01", label: "Main", role: "DUPLEX", voiceChannelName: "Studio", health: "FAULT", wsPingMs: 10, udpPingMs: 20, reconnectCount: 0, lastAudioAgoMs: 10, message: "Authorization: Bearer bot-secret at /tmp/discord.sock",
        key: "secret-key", botId: "444444444444444444", guildId, voiceChannelId, gatewayState: "Ready", voiceState: "Ready", txSubtype: "GAME", txAudioMode: "STEREO", txEnabled: true, txFrames: 1, txDroppedFrames: 0, lastTxFrameAgoMs: 1, lastHeartbeatAgoMs: 1 }],
    },
  } as unknown as RouterSnapshot;
  const projection = new TabletProjection();
  const first = projection.snapshot(source);
  const second = projection.snapshot(source);
  const json = JSON.stringify(first);
  for (const sensitive of [guildId, voiceChannelId, discordUserId, canonicalChannelId, canonicalBusId]) assert.doesNotMatch(json, new RegExp(sensitive));
  assert.doesNotMatch(json, /secret-pipe|secret-key|D:\/secret|secret\.wav|super-secret|discord\.sock|Authorization|"guildId"|"botId"|"profileId"/i);
  assert.match(json, /tablet-channel-1/);
  assert.match(json, /tablet-bus-1/);
  assert.equal((first.channels as Array<{ id: string }>)[0].id, (second.channels as Array<{ id: string }>)[0].id, "opaque IDs remain stable across Tablet reconnect snapshots");
  assert.equal(first.monitorSourceId, (first.channels as Array<{ id: string }>)[0].id);
  assert.match(json, /Recorder unavailable/);
  assert.match(json, /Discord receiver connection failed/);
  assert.match(json, /Guest/);
  assert.match(json, /Main/);
  assert.match(json, /"topologyMutationFaults":0/);
});

test("Tablet server requires pairing and only accepts operator commands", async () => {
  const publicDirectory = mkdtempSync(join(tmpdir(), "dbr-tablet-public-"));
  writeFileSync(join(publicDirectory, "index.html"), "tablet");
  const control = new ControlPlane(AudioEngine.createDemo(2));
  const server = new TabletControlServer({
    enabled: true, host: "127.0.0.1", port: 0, publicDirectory, pairingCode: "12345678",
    snapshot: () => control.snapshot(),
    execute: (command) => command.type === "SET_BUS_MUTE"
      ? { ok: false, revision: control.revision, error: "failed /home/operator/router.json Authorization: Bearer tablet-secret" }
      : control.execute(command),
  });
  try {
    await server.start();
    const origin = `http://127.0.0.1:${server.actualPort}`;
    assert.equal((await fetch(`${origin}/api/state`)).status, 401);
    const failedPair = await fetch(`${origin}/api/pair`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code: "00000000" }) });
    assert.equal(failedPair.status, 401);
    const paired = await fetch(`${origin}/api/pair`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code: "12345678" }) });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const projected = await (await fetch(`${origin}/api/state`, { headers: { cookie } })).json() as { channels: Array<{ id: string }>; buses: Array<{ id: string }> };
    assert.match(projected.channels[0].id, /^tablet-channel-\d+$/);
    assert.match(projected.buses[0].id, /^tablet-bus-\d+$/);
    const allowed = await fetch(`${origin}/api/command`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ type: "SET_CHANNEL_FADER", channelId: projected.channels[0].id, db: -7 }) });
    assert.equal(allowed.status, 200);
    assert.equal(control.snapshot().channels[0].faderDb, -7);
    assert.equal(control.snapshot().channels[1].faderDb, 0, "opaque Channel resolution never mutates a different target");
    const busAllowed = await fetch(`${origin}/api/command`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ type: "SET_BUS_MASTER", busId: projected.buses[0].id, db: -4 }) });
    assert.equal(busAllowed.status, 200);
    assert.equal(control.snapshot().buses[0].masterDb, -4);
    const sanitizedFailure = await fetch(`${origin}/api/command`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ type: "SET_BUS_MUTE", busId: projected.buses[0].id, mute: true }) });
    const sanitizedBody = JSON.stringify(await sanitizedFailure.json());
    assert.equal(sanitizedFailure.status, 409);
    assert.doesNotMatch(sanitizedBody, /home\/operator|tablet-secret|Authorization/i);
    assert.match(sanitizedBody, /failed/);
    const wrongTarget = await fetch(`${origin}/api/command`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ type: "SET_CHANNEL_FADER", channelId: projected.buses[0].id, db: -20 }) });
    assert.equal(wrongTarget.status, 409);
    assert.equal(control.snapshot().channels[0].faderDb, -7, "a BUS opaque ID never resolves as a Channel");
    const reconnected = await (await fetch(`${origin}/api/state`, { headers: { cookie } })).json() as { channels: Array<{ id: string }>; buses: Array<{ id: string }> };
    assert.equal(reconnected.channels[0].id, projected.channels[0].id);
    assert.equal(reconnected.buses[0].id, projected.buses[0].id);
    const malformed = await fetch(`${origin}/api/command`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ type: "SET_CHANNEL_FADER", channelId: projected.channels[0].id, db: "NaN" }) });
    assert.equal(malformed.status, 409);
    assert.equal(control.snapshot().channels[0].faderDb, -7);
    const denied = await fetch(`${origin}/api/command`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ type: "SET_STATE", state: "ON_AIR", confirmed: true }) });
    assert.equal(denied.status, 403);
    assert.equal(control.state, "SETUP");
    await server.close();
    assert.equal(control.snapshot().channels[0].faderDb, -7, "Tablet切断で音声状態を変更しない");
  } finally {
    await server.close();
    rmSync(publicDirectory, { recursive: true, force: true });
  }
});

test("Tablet Scene recall cannot bypass the ON AIR channel-order lock", () => {
  const engine = AudioEngine.createDemo(2);
  const control = new ControlPlane(engine);
  const scene = control.execute({ type: "SAVE_SCENE", name: "Tablet Order" }).data as { id: string };
  engine.setChannelOrder([...engine.channels.values()].reverse());
  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });

  const projection = new TabletProjection();
  const tabletState = projection.snapshot(control.snapshot()) as { scenes: Array<{ id: string }> };
  const opaqueSceneId = tabletState.scenes.find((item) => item.id === projection.sceneId(scene.id))?.id;
  assert.ok(opaqueSceneId);
  const resolved = projection.resolve({ type: "RECALL_SCENE", sceneId: opaqueSceneId, confirmed: true });
  assert.ok(resolved);
  assert.equal(control.execute(resolved).ok, true);
  assert.deepEqual([...engine.channels.keys()], ["user-02", "user-01"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { DiscordFrameType } from "../packages/discord-ipc/src/index.ts";
import { AudioEngine, VcBus } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";

const ids = { botId: "700000000000000001", guildId: "710000000000000001", voiceChannelId: "720000000000000001", userId: "730000000000000001" };

test("SETUP BUS binding connects an observed Discord VC to the selected BUS", () => {
  const engine = new AudioEngine(48_000, 480, 4);
  const bus = new VcBus("interview", "Interview", 480, 48_000);
  engine.addBus(bus);
  const control = new ControlPlane(engine);
  assert.equal(control.execute({ type: "SET_BUS_BINDING", busId: bus.id, guildId: ids.guildId, voiceChannelId: ids.voiceChannelId }).ok, true);
  assert.equal(control.snapshot().buses[0].linkedDiscordVoiceChannelId, ids.voiceChannelId);
  assert.equal(control.snapshot().buses[0].format, "MONO");

  const ingest = new DiscordIngestServer(engine, "test-only");
  ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, userId: ids.botId, payload: Buffer.from(JSON.stringify({ profileId: "RX01", label: "RX01", role: "RX", gatewayState: "ready", voiceState: "ready", voiceChannelName: "Interview VC" })) });
  ingest.ingest({ type: DiscordFrameType.USER_META, ...ids, payload: Buffer.from("Guest") });
  const channel = [...engine.channels.values()][0];
  assert.deepEqual(channel.vcSends.get(bus.id), { gainDb: -12, mute: false });
  assert.equal(engine.buses.size, 1, "binding must not create a duplicate canonical BUS");
});

test("BUS binding rejects duplicates and stays structurally locked ON AIR", () => {
  const engine = new AudioEngine(48_000, 480, 4);
  const first = new VcBus("first", "First", 480, 48_000);
  const second = new VcBus("second", "Second", 480, 48_000);
  engine.addBus(first); engine.addBus(second);
  const control = new ControlPlane(engine);
  assert.equal(control.execute({ type: "SET_BUS_BINDING", busId: first.id, guildId: ids.guildId, voiceChannelId: ids.voiceChannelId }).ok, true);
  assert.equal(control.execute({ type: "SET_BUS_BINDING", busId: second.id, guildId: ids.guildId, voiceChannelId: ids.voiceChannelId }).ok, false);
  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  assert.equal(control.execute({ type: "SET_BUS_BINDING", busId: second.id, guildId: ids.guildId, voiceChannelId: "720000000000000002" }).ok, false);
});

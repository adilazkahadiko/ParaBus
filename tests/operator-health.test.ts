import assert from "node:assert/strict";
import test from "node:test";
import type { DiscordIngestSnapshot, ReceiverOwnershipSnapshot, RouterSnapshot } from "../packages/shared-types/src/index.ts";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { AudioOutputManager } from "../services/router-core-sim/src/audio-output.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { deriveOperatorHealth } from "../services/router-core-sim/src/operator-health.ts";

function discord(overrides: Partial<DiscordIngestSnapshot> = {}): DiscordIngestSnapshot {
  return {
    endpoint: "/tmp/test.sock", connectedAdapters: 1, adapterState: "READY", configuredBots: 1, readyBots: 1,
    staleBots: 0, reconnectingBots: 0, packets: 0, bytes: 0, decodeErrors: 0, decoderState: "READY",
    tx: { state: "NO_BOT", active: false, sourceOutput: 63, profileId: null, label: null, botId: null, guildId: null, voiceChannelId: null, voiceChannelName: null, subtype: null, audioMode: null, framesSent: 0, droppedFrames: 0, peak: 0, lastFrameAgoMs: null },
    txStems: [], bots: [], receiverOwnership: [], availableVoiceChannels: [], sources: [], ...overrides,
  };
}

function baseSnapshot(channelCount = 1): RouterSnapshot {
  const engine = AudioEngine.createDemo(channelCount);
  engine.processBlock();
  const output = new AudioOutputManager(engine.sampleRate, engine.blockSize, engine.outputChannelCount, null);
  return { ...new ControlPlane(engine, output).snapshot(), xruns: 0, discord: discord() };
}

function receiver(status: ReceiverOwnershipSnapshot["status"]): ReceiverOwnershipSnapshot {
  return {
    guildId: "10000000000000001", voiceChannelId: "20000000000000001", voiceChannelName: "Interview VC",
    ownerProfileId: status === "UNSELECTED" ? null : "rx-main", status, generation: 1,
    receivers: [
      { profileId: "rx-main", label: "Interview Bot", role: "RX", health: status === "DISCONNECTED" ? "DISCONNECTED" : status === "CONFLICT" ? "FAULT" : "READY", state: status === "ACTIVE" ? "ACTIVE" : status === "CONFLICT" ? "CONFLICT" : "DISCONNECTED" },
      { profileId: "rx-backup", label: "RX02", role: "SPARE", health: "READY", state: "STANDBY" },
    ],
    transmitters: [{ profileId: "tx-ifb", label: "IFB Return", role: "TX", health: "READY" }],
  };
}

test("normal operator health stays quiet and exposes only four system summaries", () => {
  const health = deriveOperatorHealth(baseSnapshot());
  assert.equal(health.overallSeverity, "OK");
  assert.equal(health.rootCauses.length, 0);
  assert.equal(health.headerAlert, null);
  assert.deepEqual(health.system.map((item) => item.label), ["Discord", "Audio Engine", "Output", "Recorder"]);
  assert.equal("processCpuPercent" in health, false);
});

test("Discord setup incomplete stays WARNING across overall, root cause, system and header", () => {
  const snapshot = baseSnapshot();
  snapshot.discord = discord({ connectedAdapters: 0, configuredBots: 0, readyBots: 0 });
  const health = deriveOperatorHealth(snapshot);
  const root = health.rootCauses[0];
  const service = health.system.find((item) => item.id === "discord");
  assert.equal(health.overallSeverity, "WARNING");
  assert.deepEqual(root && { id: root.id, severity: root.severity, title: root.title, summary: root.summary }, {
    id: "discord", severity: "WARNING", title: "Discord setup incomplete", summary: "Not configured",
  });
  assert.deepEqual(service && { severity: service.severity, summary: service.summary }, { severity: "WARNING", summary: "Not configured" });
  assert.equal(health.headerAlert?.message, `${root?.severity} — ${root?.title} — ${root?.summary}`);
});

test("Discord failure and device loss are each aggregated as one root cause", () => {
  const disconnected = baseSnapshot();
  disconnected.discord = discord({ connectedAdapters: 0, configuredBots: 2, readyBots: 0 });
  const discordHealth = deriveOperatorHealth(disconnected);
  assert.equal(discordHealth.rootCauses.filter((cause) => cause.id === "discord").length, 1);
  assert.equal(discordHealth.rootCauses.find((cause) => cause.id === "discord")?.severity, "CRITICAL");

  const deviceLost = baseSnapshot();
  deviceLost.output = { ...deviceLost.output!, state: "FAULT", selectedDeviceName: "SoundGrid", error: "device disconnected" };
  const outputHealth = deriveOperatorHealth(deviceLost);
  assert.equal(outputHealth.rootCauses.filter((cause) => cause.id === "output").length, 1);
  assert.equal(outputHealth.rootCauses.find((cause) => cause.id === "output")?.title, "Audio output disconnected");
});

test("latched input loss is a CRITICAL Audio Engine root cause", () => {
  const snapshot = baseSnapshot();
  snapshot.state = "FAULT";
  snapshot.emergencyMuted = true;
  snapshot.input = {
    state: "FAULT", selectedDeviceId: "pa:9", selectedDeviceName: "Studio Input", activeChannelCount: 0,
    sampleRate: 48_000, framesCaptured: 480, peak: 0, error: "device lost", devices: [],
  };
  const health = deriveOperatorHealth(snapshot);
  assert.equal(health.system.find((item) => item.id === "audio")?.severity, "CRITICAL");
  assert.equal(health.rootCauses.find((cause) => cause.id === "input")?.title, "Audio input disconnected");
  assert.equal(health.rootCauses.some((cause) => cause.id === "output"), false, "an input fault is not mislabeled as an output fault");
});

test("pending participant is visible while the Approval Gate remains fail closed", () => {
  const snapshot = baseSnapshot();
  snapshot.channels[0] = { ...snapshot.channels[0], kind: "DiscordUser", discordUserId: "30000000000000001", currentVoiceChannelId: "20000000000000001", approvalGateOpen: false };
  snapshot.userSessions = [{ discordUserId: "30000000000000001", currentChannelId: snapshot.channels[0].id, currentVC: "20000000000000001", currentStripSlot: 0, online: true, temporaryAlert: null, sessionApproval: "PENDING", sessionGeneration: 1, approvalRevision: 1, audioActive: false }];
  snapshot.discord = discord({ receiverOwnership: [receiver("ACTIVE")], availableVoiceChannels: [{ guildId: "10000000000000001", id: "20000000000000001", name: "Interview VC" }] });
  const health = deriveOperatorHealth(snapshot);
  assert.equal(health.users[0].severity, "WARNING");
  assert.equal(health.users[0].approvalState, "PENDING");
  assert.match(health.users[0].reason, /audio blocked/);
  assert.equal(health.rootCauses.find((cause) => cause.id === "approval")?.severity, "WARNING");
  assert.equal(snapshot.channels[0].approvalGateOpen, false, "health derivation must not alter gate state");
});

test("receiver disconnect reports standby without switching ownership", () => {
  const snapshot = baseSnapshot();
  snapshot.discord = discord({ receiverOwnership: [receiver("DISCONNECTED")] });
  const health = deriveOperatorHealth(snapshot);
  assert.equal(health.receivers[0].ownerState, "DISCONNECTED");
  assert.deepEqual(health.receivers[0].standby, ["RX02"]);
  assert.match(health.rootCauses.find((cause) => cause.id.startsWith("receiver:"))?.summary ?? "", /standby available/);
  assert.equal(snapshot.discord.receiverOwnership[0].ownerProfileId, "rx-main");
});

test("duplicate receiver authority is one CRITICAL fail-closed root cause", () => {
  const snapshot = baseSnapshot();
  snapshot.discord = discord({ receiverOwnership: [receiver("CONFLICT")] });
  const health = deriveOperatorHealth(snapshot);
  assert.equal(health.receivers[0].ownerState, "CONFLICT");
  assert.equal(health.receivers[0].severity, "CRITICAL");
  const roots = health.rootCauses.filter((cause) => cause.id.startsWith("receiver:"));
  assert.equal(roots.length, 1);
  assert.equal(roots[0].title, "Interview VC receiver authority conflict");
  assert.equal(roots[0].summary, "Duplicate authority · RX fail closed");
  assert.equal(health.headerAlert?.message, `${roots[0].severity} — ${roots[0].title} — ${roots[0].summary}`);
});

test("header alert uses the highest-priority STATUS root and emergency wins", () => {
  const snapshot = baseSnapshot();
  snapshot.emergencyMuted = true;
  snapshot.output = { ...snapshot.output!, state: "FAULT", error: "lost" };
  const health = deriveOperatorHealth(snapshot);
  assert.equal(health.rootCauses[0].id, "emergency");
  assert.equal(health.rootCauses.filter((cause) => cause.id === "output").length, 1, "derived output failure remains aggregated");
  assert.equal(health.headerAlert?.message, `${health.rootCauses[0].severity} — ${health.rootCauses[0].title} — ${health.rootCauses[0].summary}`);
});

test("recent events keep important activity and redact secret values", () => {
  const snapshot = baseSnapshot();
  snapshot.alerts = [
    { at: new Date().toISOString(), level: "INFO", message: "meter tick" },
    { at: new Date().toISOString(), level: "WARNING", message: "Recorder started token=super-secret" },
  ];
  const events = deriveOperatorHealth(snapshot).recentEvents;
  assert.equal(events.length, 1);
  assert.match(events[0].message, /token=\[REDACTED\]/);
  assert.doesNotMatch(events[0].message, /super-secret/);
});

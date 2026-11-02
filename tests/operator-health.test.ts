import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { DiscordIngestSnapshot, ReceiverOwnershipSnapshot, RouterSnapshot } from "../packages/shared-types/src/index.ts";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { AudioOutputManager } from "../services/router-core-sim/src/audio-output.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { deriveOperatorHealth, OperatorHealthTracker } from "../services/router-core-sim/src/operator-health.ts";
import { desktopState, type DesktopStateSources } from "../services/router-core-sim/src/desktop-state.ts";

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

function rxHealthFixture() {
  const snapshot = baseSnapshot();
  const channel = snapshot.channels[0];
  Object.assign(channel, { kind: "DiscordUser", discordUserId: "30000000000000001", currentVoiceChannelId: "20000000000000001", approvalGateOpen: true });
  snapshot.userSessions = [{ discordUserId: channel.discordUserId!, currentChannelId: channel.id, currentVC: channel.currentVoiceChannelId!,
    currentStripSlot: 0, online: true, temporaryAlert: null, sessionApproval: "APPROVED", sessionGeneration: 1, approvalRevision: 1, audioActive: true }];
  snapshot.discord!.receiverOwnership = [receiver("ACTIVE")];
  const source: DiscordIngestSnapshot["sources"][number] = { channelId: channel.id, botId: "1", guildId: "10000000000000001",
    voiceChannelId: "20000000000000001", userId: channel.discordUserId!, packets: 1000, decodedSamples: 960000,
    decodeErrors: 0, sequenceGaps: 0, sequenceGapsKnown: true, queuedMilliseconds: 80, droppedSamples: 0, lastPacketAgoMs: 0,
    rxTiming: { maxPacketGapMs: 20, maxQueuedMilliseconds: 100, overflowEvents: 0, lastOverflow: null, inSpeechUnderruns: 0 } };
  snapshot.discord!.sources = [source];
  const tracker = new OperatorHealthTracker();
  return { snapshot, source, channel, tracker, at: (now: number) => tracker.derive(snapshot, now) };
}

test("old lifetime RX totals establish a baseline and a single 52-packet jump never raises live health", () => {
  const { snapshot, source, at } = rxHealthFixture();
  source.sequenceGaps = 53; source.droppedSamples = 960; source.rxTiming!.inSpeechUnderruns = 7;
  const before = structuredClone(snapshot);
  assert.equal(at(0).overallSeverity, "OK");
  assert.deepEqual(snapshot, before, "deriving health cannot change counters or routing");
  source.sequenceGaps += 52; source.packets++;
  for (let second = 1; second <= 32; second++) {
    source.packets += 50;
    const health = at(second * 1000);
    assert.equal(health.overallSeverity, "OK");
    assert.equal(health.rootCauses.some(root => root.id === "user-health"), false);
    assert.equal(health.users[0].packetGaps, 105);
    assert.equal(health.users[0].droppedPackets, 960);
  }
});

test("continued >5% gaps across multiple seconds warn and recover while cumulative GAP stays", () => {
  const { source, at } = rxHealthFixture();
  at(0);
  source.packets += 19; source.sequenceGaps++;
  assert.equal(at(1000).overallSeverity, "OK");
  source.packets += 19; source.sequenceGaps++;
  assert.equal(at(2000).overallSeverity, "OK", "2/(38+2) is exactly 5%, not above it");
  source.packets++; source.sequenceGaps++;
  const warning = at(3000);
  assert.equal(warning.users[0].reason, "RX quality warning");
  assert.equal(warning.overallSeverity, "WARNING");
  assert.equal(warning.rootCauses.find(root => root.id === "user-health")?.severity, "WARNING");
  assert.match(warning.headerAlert!.message, /participant health warning/);
  for (let second = 4; second <= 33; second++) at(second * 1000);
  const recovered = at(33_001);
  assert.equal(recovered.overallSeverity, "OK");
  assert.equal(recovered.headerAlert, null);
  assert.equal(recovered.users[0].packetGaps, 3);
  assert.equal(source.sequenceGaps, 3);
});

test("one cap drop warns immediately and expires at 30s without clearing cumulative DROP", () => {
  const { source, at } = rxHealthFixture();
  at(0); source.droppedSamples = 1;
  assert.equal(at(1000).overallSeverity, "WARNING");
  assert.equal(at(30_999).overallSeverity, "WARNING");
  const health = at(31_000);
  assert.equal(health.overallSeverity, "OK");
  assert.equal(health.users[0].droppedPackets, 1);
  assert.equal(health.rootCauses.some(root => root.id === "user-health"), false);
});

test("in-speech shortages need at least two recent occurrences; repeated reads cannot double count", () => {
  const { source, at } = rxHealthFixture();
  at(0); source.rxTiming!.inSpeechUnderruns = 1;
  for (let read = 0; read < 20; read++) assert.equal(at(1000 + read).overallSeverity, "OK");
  source.rxTiming!.inSpeechUnderruns = 2;
  assert.equal(at(2000).overallSeverity, "WARNING");
  assert.equal(at(30_999).overallSeverity, "WARNING");
  assert.equal(at(31_000).overallSeverity, "OK", "the first shortage expires and only one remains");
  assert.equal(source.rxTiming!.inSpeechUnderruns, 2);
});

test("GAP changes within one second and unknown sequence coverage alone do not warn", () => {
  const { source, at } = rxHealthFixture();
  at(0);
  for (let read = 0; read < 10; read++) {
    source.packets++; source.sequenceGaps += 5;
    assert.equal(at(1000 + read).overallSeverity, "OK");
  }
  source.sequenceGapsKnown = false;
  source.packets++; source.sequenceGaps += 5;
  assert.equal(at(2000).overallSeverity, "OK", "unknown coverage alone is not evidence for a GAP warning");
  source.droppedSamples++;
  assert.equal(at(3000).overallSeverity, "WARNING", "unknown GAP coverage must not hide a cap drop");
});

test("source resets, receiver changes, departed sources and unobserved intervals do not reuse old RX warnings", () => {
  const { source, snapshot, at } = rxHealthFixture();
  at(0); source.droppedSamples = 960;
  assert.equal(at(1000).overallSeverity, "WARNING");
  source.packets = 0; source.droppedSamples = 0;
  assert.equal(at(2000).overallSeverity, "OK");
  source.droppedSamples = 1;
  assert.equal(at(3000).overallSeverity, "WARNING");
  source.botId = "2";
  assert.equal(at(4000).overallSeverity, "OK");
  source.droppedSamples = 2;
  assert.equal(at(5000).overallSeverity, "WARNING");
  snapshot.userSessions![0].sessionGeneration++;
  assert.equal(at(6000).overallSeverity, "OK");
  snapshot.discord!.sources = []; at(7000);
  snapshot.discord!.sources = [source];
  assert.equal(at(8000).overallSeverity, "OK");
  source.sequenceGaps = 100; source.droppedSamples = 100;
  assert.equal(at(38_000).overallSeverity, "OK", "unobserved lifetime deltas cannot be assigned to the recent window");
});

test("recent RX warnings are isolated per source", () => {
  const { snapshot, source, channel, at } = rxHealthFixture();
  const second = { ...structuredClone(source), channelId: "second", userId: "30000000000000002" };
  snapshot.discord!.sources.push(second);
  snapshot.channels.push({ ...structuredClone(channel), id: second.channelId, discordUserId: second.userId });
  at(0); source.droppedSamples++;
  const first = at(1000);
  assert.equal(first.users[0].severity, "WARNING");
  assert.equal(first.users[1].severity, "OK");
  second.rxTiming!.inSpeechUnderruns = 2;
  const both = at(2000);
  assert.deepEqual(both.users.map(user => user.severity), ["WARNING", "WARNING"]);
  const one = at(31_000);
  assert.deepEqual(one.users.map(user => user.severity), ["OK", "WARNING"]);
});

test("approval, stale and receiver authority retain their priorities when recent RX quality recovers", () => {
  const { snapshot, source, channel, at } = rxHealthFixture();
  at(0); source.droppedSamples = 960;
  assert.equal(at(1000).users[0].reason, "RX quality warning");
  snapshot.userSessions![0].sessionApproval = "PENDING"; channel.approvalGateOpen = false;
  const pending = at(2000);
  assert.equal(pending.users[0].reason, "Approval pending · audio blocked");
  assert.equal(pending.users[0].severity, "WARNING");
  snapshot.userSessions![0].sessionApproval = "APPROVED"; channel.approvalGateOpen = true;
  channel.meter.stale = true;
  assert.equal(at(31_000).users[0].reason, "RX audio stale");
  assert.equal(at(32_000).overallSeverity, "WARNING", "stale must not expire with quality history");
  channel.meter.stale = false;
  assert.equal(at(33_000).overallSeverity, "OK");
  for (const status of ["UNSELECTED", "DISCONNECTED", "CONFLICT"] as const) {
    snapshot.discord!.receiverOwnership = [receiver(status)];
    const health = at(34_000);
    assert.equal(health.users[0].severity, "CRITICAL");
    assert.match(health.users[0].reason, /Receiver/);
    assert.equal(snapshot.discord!.receiverOwnership[0].status, status);
  }
  assert.equal(channel.approvalGateOpen, true);
});

test("desktop WS/GET snapshots share recent RX state across fresh wrappers without adding wire history", t => {
  let now = 0; t.mock.method(performance, "now", () => now);
  const { snapshot, source } = rxHealthFixture();
  const sources: DesktopStateSources = { control: { snapshot: () => snapshot }, ingest: { snapshot: () => snapshot.discord! }, extras: () => ({}) };
  const read = (history: boolean, details: boolean) => desktopState({ ...sources }, history, details);
  const initial = read(true, false);
  now = 1000; source.droppedSamples = 960;
  const periodic = read(true, false);
  assert.equal(periodic.operatorHealth.overallSeverity, "WARNING");
  assert.equal(read(false, true).operatorHealth.overallSeverity, "WARNING");
  const independent = desktopState({ ...sources, ingest: { snapshot: sources.ingest.snapshot } });
  assert.equal(independent.operatorHealth.overallSeverity, "OK", "independent producers do not share warning history");
  now = 31_000;
  const recovered = read(true, false);
  assert.equal(recovered.operatorHealth.overallSeverity, "OK");
  assert.deepEqual(Object.keys(recovered.operatorHealth), Object.keys(initial.operatorHealth));
  assert.deepEqual(Object.keys(recovered.discord!.sources[0]), Object.keys(initial.discord!.sources[0]));
  assert.equal(recovered.discord!.sources[0].droppedSamples, 960);
  assert.doesNotMatch(JSON.stringify(recovered), /buckets|speechUnderruns|observedAt/);
});

test("desktop user-health guidance appears for current trouble and disappears on automatic recovery", () => {
  const { snapshot, source, at } = rxHealthFixture();
  const script = readFileSync(new URL("../services/router-core-sim/public/app.js", import.meta.url), "utf8");
  const start = script.indexOf("function statusGuidance(");
  const context: any = { mainOutputGuidance: () => "Routing ready" };
  runInNewContext(script.slice(start, script.indexOf("\n}", start) + 2), context);
  snapshot.output = { ...snapshot.output!, selectedDeviceId: "fixture", devices: [{ id: "fixture", backend: "portaudio" }] as never };
  snapshot.operatorHealth = at(0);
  source.sequenceGaps = 52;
  snapshot.operatorHealth = at(1000);
  assert.equal(context.statusGuidance(snapshot).title, "機器・接続に障害なし");
  source.droppedSamples = 1;
  snapshot.operatorHealth = at(2000);
  assert.equal(context.statusGuidance(snapshot).title, "受信音声の品質を確認");
  assert.equal(context.statusGuidance(snapshot).view, "status");
  snapshot.operatorHealth = at(32_000);
  assert.equal(context.statusGuidance(snapshot).title, "機器・接続に障害なし");
  assert.equal(snapshot.operatorHealth.overallSeverity, "OK");
  assert.equal(snapshot.discord!.sources[0].sequenceGaps, 52);
  assert.equal(snapshot.discord!.sources[0].droppedSamples, 1);
});

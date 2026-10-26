import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { crc32 } from "node:zlib";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { AudioOutputManager } from "../services/router-core-sim/src/audio-output.ts";
import { AudioInputManager, inputTimingSummary } from "../services/router-core-sim/src/audio-input.ts";
import { ControlPlane } from "../services/router-core-sim/src/control-plane.ts";
import { DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";
import { createSupportBundle, supportDiagnostics } from "../services/router-core-sim/src/support-bundle.ts";
import type { DiscordBotSnapshot } from "../packages/shared-types/src/index.ts";
import { AudioSchedulerTiming, OutputWriteTiming, RxQueueTiming, audioTimingSummary } from "../services/router-core-sim/src/audio-timing.ts";
import { AUDIO_FAULT_CLASSIFICATIONS } from "../services/router-core-sim/src/audio-fault-diagnostics.ts";
import { OperationalLog } from "../services/router-core-sim/src/operational-log.ts";

const userId = "100000000000000123", guildId = "200000000000000123", vcId = "300000000000000123";
const participant = "秘密参加者🦊", guild = "会社の秘密Guild", vc = "非公開のVC";
const token = "FAKE_DISCORD_TOKEN_DO_NOT_EXPORT_abcdef123456789";
const envSecret = "FAKE_ENV_VALUE_DO_NOT_EXPORT";
const commit = "abcdef1234567890abcdef1234567890abcdef12";
const now = new Date(2026, 9, 6, 12).toISOString();
const runtimeInfo = { buildCommit: commit, pcRole: "RX" as const, startedAt: now };

test("Support diagnostics retain only driver family and numeric RX playout counters", () => {
  const state = snapshot();
  const driver = new AudioOutputManager(48000, 480, 64).snapshot();
  state.output = { ...driver, selectedHostApi: "Windows WASAPI" };
  state.cueOutput = { ...driver, selectedHostApi: "ASIO" };
  const source = { playout: { targetMs: 60, backlogEwmaMs: 60.1, expandedFrames: 4, compressedFrames: 5, prebufferBlocks: 2, staleDiscardedSamples: 480, token: "secret" } };
  state.discord!.sources = [source as any];
  let diagnostics = supportDiagnostics(state);
  assert.equal(diagnostics.output.selectedHostApi, "Windows WASAPI");
  assert.equal(diagnostics.cueOutput.selectedHostApi, "ASIO");
  assert.equal(diagnostics.discord.sources[0].playout.expandedFrames, 4);
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret/);
  state.output.selectedHostApi = "private-device-secret";
  diagnostics = supportDiagnostics(state);
  assert.equal(diagnostics.output.selectedHostApi, null);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-device-secret/);
});

function snapshot() {
  const engine = AudioEngine.createDemo(2);
  const state = new ControlPlane(engine).snapshot();
  state.channels[0].kind = "DiscordUser";
  state.channels[0].id = `discord:${userId}`;
  state.channels[0].discordUserId = userId;
  state.channels[0].label = participant;
  state.discord = new DiscordIngestServer(engine).snapshot();
  const bot: DiscordBotSnapshot = { key: "raw-secret-key", profileId: "RX01", label: "Operator Bot", role: "RX", txSubtype: null, txAudioMode: null, botId: "400000000000000123", guildId, guildName: guild, voiceChannelId: vcId, voiceChannelName: vc, gatewayState: "ready", voiceState: "ready", health: "READY", wsPingMs: 25, udpPingMs: 30, reconnectCount: 1, lastAudioAgoMs: 10, txEnabled: false, txFrames: 0, txDroppedFrames: 4, lastTxFrameAgoMs: null, lastHeartbeatAgoMs: 20, message: token };
  state.discord.bots = [bot];
  state.discord.sources = [{ channelId: `discord:${userId}`, userId, guildId, voiceChannelId: vcId, botId: bot.botId, packets: 100, decodedSamples: 96000, decodeErrors: 3, sequenceGaps: 2, queuedMilliseconds: 20, droppedSamples: 960, lastPacketAgoMs: 10 }];
  state.discord.rxDiagnostics = { rejectedOpus: { receiverOwner: 5, [token]: 88 }, ipcBatches: { count: 10, maxOpusFrames: 5, maxBytes: 1000, maxProcessingMs: 0.4 }, adapterIpc: [{ opusDroppedFrames: 2, backpressureWrites: 3, writableBytes: 1024, maxWritableBytes: 2048 }] };
  state.xruns = 59;
  state.alerts = [{ at: now, level: "WARNING", message: token }];
  return state;
}

/** Read stored entries through the ZIP central directory and verify data descriptors/CRC. */
function unzip(bytes: Buffer): Map<string, string> {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  let cursor = bytes.readUInt32LE(end + 16);
  const entries = new Map<string, string>();
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    assert.equal(bytes.readUInt16LE(cursor + 10), 0, "stored ZIP, no hidden compressed payload");
    const size = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    const local = bytes.readUInt32LE(cursor + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const payload = bytes.subarray(start, start + size);
    assert.equal(crc32(payload), bytes.readUInt32LE(cursor + 16));
    assert.equal(bytes.readUInt32LE(start + size), 0x08074b50);
    assert.equal(bytes.readUInt32LE(start + size + 4), crc32(payload));
    entries.set(name, payload.toString());
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  return entries;
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "dbr-support-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "logs"));
  await mkdir(join(root, "recordings"));
  await writeFile(join(root, ".env"), `DISCORD_BOT_TOKEN=${token}\nEXTRA_SECRET=${envSecret}\n`);
  await writeFile(join(root, "discord-bots.json"), JSON.stringify({ privateMarker: "RAW_BOT_CONFIG_MARKER", bots: [{ id: "RX01", label: "Operator Bot", role: "RX", enabled: true, guildId, voiceChannelId: vcId, token, tokenEnv: "DISCORD_BOT_TOKEN" }, { id: "TX01", role: "TX", txDestination: "TEAM_01", enabled: false }] }));
  await writeFile(join(root, "recordings", "secret.wav"), "RAW_RECORDING_MARKER");
  await writeFile(join(root, "scenes.json"), "RAW_SCENE_MARKER");
  await writeFile(join(root, "user-profiles.json"), "RAW_USER_PROFILE_MARKER");
  await writeFile(join(root, "release-build-info.json"), JSON.stringify({ schemaVersion: 1, buildCommit: commit, token }));
  const event = (message: string) => JSON.stringify({ at: now, level: "WARNING", message, token, extra: { token: envSecret } }) + "\n";
  const logs = [event(`${participant}: audio samples dropped +960`), event(`Operator Bot: TX dropped frames +4`), event(`${guild} / ${vc} ${userId} ${token} ${envSecret}`), event("Unknown historic participant 私の名前"), event("Audio engine xruns +59")].join("");
  await writeFile(join(root, "logs", "operational-2026-10-06.jsonl"), logs + '{"unfinished":');
  for (const date of ["2026-09-29", "2026-09-30", "2026-10-07"]) await writeFile(join(root, "logs", `operational-${date}.jsonl`), event("Audio engine xruns +1"));
  await writeFile(join(root, "logs", "router.log"), `[RX01] Discord RX ready: ${guild} / ${vc}\n[RX01] Opus receive stream failed for ${userId}: DAVE error ${token}; retrying in 3000ms (attempt 20)\n${envSecret}\n`);
  await utimes(join(root, "logs", "router.log"), new Date(now), new Date(now));
  return { root, request: { settingsRoot: root, projectRoot: root, runtimeInfo, diagnostics: supportDiagnostics(snapshot()), now } };
}

test("fault diagnostics retain classification and host API in Bundle while raw errors stay only in the local log", async t => {
  const { root, request } = await fixture(t);
  await writeFile(join(root, "logs/operational-2026-10-06.jsonl"), "");
  const log = new OperationalLog(root, 7, () => new Date(now));
  const control = new ControlPlane(AudioEngine.createDemo(0), undefined, undefined, undefined, undefined, undefined, event => log.append(event));
  const reason = "PRIVATE_DEVICE C:\\private\\driver.dll raw driver error\r\n\0" + "x".repeat(2000);
  for (const classification of AUDIO_FAULT_CLASSIFICATIONS) for (const type of ["DEVICE_LOST", "INPUT_DEVICE_LOST"] as const) {
    assert.equal(control.execute({ type, deviceId: "PRIVATE_DEVICE", fault: { classification, hostApi: "ASIO", reason } }).ok, true);
  }
  assert.equal(control.execute({ type: "DEVICE_LOST", deviceId: "PRIVATE_DEVICE", fault: { classification: "UNKNOWN", hostApi: "PRIVATE_HOST", reason } }).ok, true);
  await log.close();
  const local = (await readFile(log.pathFor(), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const details = local.filter(event => event.message.startsWith("Audio fault:"));
  assert.equal(details.length, 13);
  for (const event of details) { assert.match(event.localDetail, /PRIVATE_DEVICE.*raw driver error/); assert.equal(event.localDetail.length, 1024); assert.doesNotMatch(event.localDetail, /[\r\n\0]/); }
  assert.doesNotMatch(JSON.stringify(control.snapshot().alerts), /PRIVATE_DEVICE|private|localDetail|raw driver/);
  const injection = { at: now, level: "CRITICAL", message: "Audio fault: target=INPUT classification=STREAM_ERROR hostApi=PRIVATE_HOST", localDetail: reason };
  await writeFile(log.pathFor(), (await readFile(log.pathFor(), "utf8")) + JSON.stringify(injection) + "\n");
  const bundle = await createSupportBundle(request), bytes = await readFile(bundle.path), entries = unzip(bytes);
  const exported = entries.get("logs/operational-2026-10-06.jsonl")!;
  for (const classification of AUDIO_FAULT_CLASSIFICATIONS) for (const target of ["MAIN_OUTPUT", "INPUT"]) assert.ok(exported.includes(`Audio fault: target=${target} classification=${classification} hostApi=ASIO`));
  assert.ok(exported.includes("Audio fault: target=MAIN_OUTPUT classification=UNKNOWN hostApi=UNKNOWN"));
  assert.ok(exported.includes("OUTPUT DEVICE LOST; output forced to silence"));
  assert.ok(exported.includes("INPUT DEVICE LOST; input buffers cleared and all outputs fail closed"));
  for (const secret of ["PRIVATE_DEVICE", "PRIVATE_HOST", "raw driver error", "localDetail", "C:\\private\\driver.dll"]) assert.equal(bytes.includes(Buffer.from(secret)), false, secret);
});

test("support ZIP retains numeric audio timing and summary grammar without exporting names, IDs or extra fields", async t => {
  const { root, request } = await fixture(t);
  const state = snapshot();
  const main = new OutputWriteTiming(0), cue = new OutputWriteTiming(0);
  main.observeInFlight(0, 0); main.observeInFlight(3, 0); main.callback(24, 25); main.drop(30);
  cue.observeInFlight(0, 0);
  const scheduler = new AudioSchedulerTiming(0); scheduler.record(4.2, 2, 0);
  let clock = 0; const rx = new RxQueueTiming(48_000, 120, () => clock);
  rx.packet(); rx.fill(0, 480); clock = 100; rx.overflow();
  rx.silenceBlocksDropped = 7; rx.compressedSamples = 123;
  state.output = new AudioOutputManager(48_000, 480, 2, null).snapshot();
  state.output.writeTiming = main.snapshot(960, 0, 100);
  state.cueOutput = { ...state.output!, writeTiming: cue.snapshot(480, 0, 100) };
  state.audioTiming = scheduler.snapshot(100);
  const runtimeWindow = { startedAt: now, durationMs: 60_000, eventLoopP99Ms: 24.2, eventLoopMaxMs: 39.1, processBlockMaxMs: 3.1, processBlocks: 6000 };
  state.audioRuntimeTiming = { resolutionMs: 20, current: { ...runtimeWindow }, windows: [{ ...runtimeWindow }] };
  Object.assign(state.audioRuntimeTiming.current, { privateMarker: token });
  Object.assign(state.audioRuntimeTiming.windows[0], { participant, userId, token });
  state.discord!.sources[0].rxTiming = { maxPacketGapMs: 20, maxQueuedMilliseconds: 120, overflowEvents: 2, lastOverflow: null, ...rx.snapshot() };
  Object.assign(state.output!.writeTiming, { privateMarker: token });
  Object.assign(state.output!.writeTiming.windows[0], { participant, userId, token });
  state.discord!.sources[0].rxTiming.queueWindows![0] = Object.assign({}, state.discord!.sources[0].rxTiming.queueWindows![0], { participant, userId, token });
  request.diagnostics = supportDiagnostics(state);
  const summary = audioTimingSummary(state.output!.writeTiming, state.cueOutput.writeTiming, state.audioTiming, 3, 2, 1, runtimeWindow);
  const oldSummary = audioTimingSummary(state.output!.writeTiming, state.cueOutput.writeTiming, state.audioTiming, 3, 2, 1);
  const unsafe = `${summary} ${participant} ${userId}`;
  await writeFile(join(root, "logs", "operational-2026-10-06.jsonl"), [summary, unsafe, oldSummary].map(message => JSON.stringify({ at: now, level: "INFO", message }) + "\n").join(""));
  const bundle = await createSupportBundle(request), raw = await readFile(bundle.path), entries = unzip(raw);
  const lines = entries.get("logs/operational-2026-10-06.jsonl")!.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines[0].message, summary, "the useful timeline is not replaced by event aliases");
  assert.match(lines[1].message, /^event-/, "free-form suffixes do not bypass the numeric-only grammar");
  assert.equal(lines[2].message, oldSummary, "earlier builds' timing summaries remain readable");
  for (const sensitive of [participant, userId, token, "privateMarker"]) assert.equal(raw.includes(Buffer.from(sensitive)), false);
  const diagnostics = JSON.parse(entries.get("diagnostics.json")!);
  assert.equal(diagnostics.output.writeTiming.windows[0].callbackMaxMs, 24);
  assert.equal(diagnostics.output.writeTiming.windows[0].inFlightMax, 3);
  assert.equal(diagnostics.output.writeTiming.framesWritten, 960);
  assert.equal(diagnostics.output.writeTiming.elapsedMs, 100);
  assert.equal(diagnostics.output.writeTiming.backpressureDropTimes.length, 1);
  assert.equal(diagnostics.cueOutput.writeTiming.windows[0].inFlightMax, 0);
  assert.equal(diagnostics.audioTiming.windows[0].p99LateMs, 4.2);
  assert.equal(diagnostics.audioTiming.catchupCalls, 1);
  assert.equal(diagnostics.audioRuntimeTiming.current.processBlockMaxMs, 3.1);
  assert.equal(diagnostics.audioRuntimeTiming.windows[0].eventLoopP99Ms, 24.2);
  assert.equal(diagnostics.audioRuntimeTiming.windows[0].eventLoopMaxMs, 39.1);
  assert.equal(diagnostics.discord.sources[0].rxTiming.underruns, 1);
  assert.equal(diagnostics.discord.sources[0].rxTiming.overflowsAfterUnderrun, 1);
  assert.equal(diagnostics.discord.sources[0].rxTiming.silenceBlocksDropped, 7);
  assert.equal(diagnostics.discord.sources[0].rxTiming.compressedSamples, 123);
  assert.equal(diagnostics.discord.sources[0].rxTiming.queueWindows[0].p50Ms, 0);
});

test("support ZIP retains physical capture timing and numeric summary, never extra fields or free text", async t => {
  const { root, request } = await fixture(t);
  const state = snapshot();
  state.input = new AudioInputManager(AudioEngine.createDemo(0), null).snapshot();
  assert.equal(inputTimingSummary(state.input), null);
  state.input.captureTiming = { elapsedMs: 60000, physicalChannelCount: 10, packets: 6000,
    minPacketBytes: 19200, maxPacketBytes: 19200, lastPacketGapMs: 10, maxPacketGapMs: 42.5,
    lastPacketAgeMs: 2, pendingFrameBytes: 0,
    channels: [{ channel: 1, queuedFrames: 480, maxQueuedFrames: 960, underruns: 3, missingFrames: 1440, droppedFrames: 480 }] };
  Object.assign(state.input.captureTiming, { token, participant });
  Object.assign(state.input.captureTiming.channels[0], { userId, token });
  request.diagnostics = supportDiagnostics(state);
  const summary = inputTimingSummary(state.input)!;
  assert.equal(summary, "Physical input timing totals: channels=1/10 packets=6000 gapMax=42.5ms underruns=3 missing=1440 dropped=480");
  await writeFile(join(root, "logs", "operational-2026-10-06.jsonl"), [summary, `${summary} ${participant} ${userId}`]
    .map(message => JSON.stringify({ at: now, level: "INFO", message }) + "\n").join(""));
  const bundle = await createSupportBundle(request), raw = await readFile(bundle.path), entries = unzip(raw);
  for (const sensitive of [participant, userId, token]) assert.equal(raw.includes(Buffer.from(sensitive)), false);
  const messages = entries.get("logs/operational-2026-10-06.jsonl")!.trim().split("\n").map(line => JSON.parse(line).message);
  assert.equal(messages[0], summary);
  assert.match(messages[1], /^event-/);
  const capture = JSON.parse(entries.get("diagnostics.json")!).input.captureTiming;
  assert.equal(capture.physicalChannelCount, 10);
  assert.equal(capture.maxPacketGapMs, 42.5);
  assert.deepEqual(capture.channels, [{ channel: 1, queuedFrames: 480, maxQueuedFrames: 960, underruns: 3, missingFrames: 1440, droppedFrames: 480 }]);
  assert.equal(capture.token, undefined);
});

test("support ZIP uses an explicit allowlist, redacts secrets and anonymizes IDs/names per bundle", async (t) => {
  const { root, request } = await fixture(t);
  const first = await createSupportBundle(request), second = await createSupportBundle(request);
  assert.match(first.fileName, /^ParaBus-support-RX-abcdef123456-\d{8}T\d{6}Z-[a-f0-9]{8}\.zip$/);
  assert.equal(first.directory, join(root, "support"));
  const raw = await readFile(first.path), entries = unzip(raw);
  assert.deepEqual([...entries.keys()].sort(), ["bot-summary.json", "bundle-info.json", "diagnostics.json", "logs/operational-2026-09-30.jsonl", "logs/operational-2026-10-06.jsonl", "logs/router.log", "release-build-info.json", "runtime-info.json", "system.json"].sort());
  for (const secret of [token, envSecret, userId, guildId, vcId, participant, guild, vc, "RAW_BOT_CONFIG_MARKER", "RAW_RECORDING_MARKER", "RAW_SCENE_MARKER", "RAW_USER_PROFILE_MARKER", "私の名前", "raw-secret-key"]) assert.equal(raw.includes(Buffer.from(secret)), false, `bundle leaked ${secret}`);
  assert.equal(/\b\d{17,20}\b/.test(raw.toString()), false);
  const diagnostics = JSON.parse(entries.get("diagnostics.json")!);
  assert.match(diagnostics.discord.sources[0].userId, /^user-[a-f0-9]{12}$/);
  assert.ok(diagnostics.discord.sources[0].channelId.endsWith(diagnostics.discord.sources[0].userId));
  assert.equal(diagnostics.participants[0].discordUserId, diagnostics.discord.sources[0].userId);
  assert.ok(entries.get("logs/router.log")!.includes(diagnostics.discord.sources[0].userId), "same ID links console and snapshot");
  assert.ok(entries.get("logs/operational-2026-10-06.jsonl")!.includes(diagnostics.participants[0].label), "name aliases link logs and snapshot");
  assert.ok(entries.get("logs/router.log")!.includes(diagnostics.discord.bots[0].guildName));
  assert.equal(diagnostics.discord.bots[0].profileId, "RX01");
  assert.equal(diagnostics.discord.bots[0].label, "Operator Bot");
  assert.equal(diagnostics.xruns, 59);
  assert.equal(diagnostics.discord.rxDiagnostics.rejectedOpus.receiverOwner, 5);
  assert.equal(Object.keys(diagnostics.discord.rxDiagnostics.rejectedOpus).length, 1);
  assert.equal(diagnostics.discord.rxDiagnostics.adapterIpc[0].opusDroppedFrames, 2);
  const other = JSON.parse(unzip(await readFile(second.path)).get("diagnostics.json")!);
  assert.notEqual(other.discord.sources[0].userId, diagnostics.discord.sources[0].userId);
  assert.notEqual(other.participants[0].label, diagnostics.participants[0].label);
  assert.deepEqual(JSON.parse(entries.get("release-build-info.json")!), { schemaVersion: 1, buildCommit: commit });
  assert.deepEqual(JSON.parse(entries.get("runtime-info.json")!), runtimeInfo);
  const botSummary = JSON.parse(entries.get("bot-summary.json")!);
  assert.deepEqual(botSummary, { total: 2, enabled: 1, bots: [{ role: "RX", txDestination: null, enabled: true }, { role: "TX", txDestination: "TEAM_01", enabled: false }] });
});

test("support operational timeline preserves event wording while anonymizing names and IDs", async (t) => {
  const { root, request } = await fixture(t);
  const participantPrefixes = ["user joined", "user left", "pending created", "approved", "approval revoked", "trusted enabled", "trusted disabled", "session approval reset"];
  const messages = [
    ...participantPrefixes.map((prefix) => `${prefix}: ${participant}`),
    `approved: ${participant} (trusted auto-approve)`,
    `rejoin restored: ${participant} (APPROVED)`, `rejoin restored: ${participant} (PENDING)`,
    `user joined: ${userId}`,
    "TX targets armed: RX01, TX01, LEGACY_BOT", "TX targets armed: none",
    "Armed TX targets started by operator",
    "TX01 started by operator", "TX01 stopped by operator", "TX01 disconnected by operator", "TX01 connection requested by operator",
    "Operator Bot stopped by operator", "Discord TX started by operator",
    "TX01 source: Matrix OUT 64", `TX01 assigned to Discord VC ${vcId}`,
    "ON AIR receiver switch rejected: RX01; confirmation required",
    `ParaBus startup: commit=${commit.slice(0, 12)} PC=RX started=${now}`,
    `${participant} fader -12.0 dB`, `${participant} muted`, `${participant} opened`, `${participant} → Output 1 (PRE)`,
    `${vc} → Output 1/2 (DUAL MONO)`, `${vc} Discord VC binding changed`, `${vc} new participant policy: HOLD`, `${vc} limiter disabled`,
    `VC Bus ${vc} created (SAFE)`, `VC Bus ${vc} removed`,
    `Scene ${guild} saved`, `Scene ${guild} recalled`, `Scene ${guild} deleted`,
    `出力デバイス: ${vc}`, `Cueデバイス: ${vc}`, `入力デバイス: ${vc} / 2ch`,
    "Fault acknowledged; select and validate the output device manually", "Router core simulator started",
    `Error: failed for ${participant} ${userId} ${token}`,
  ];
  const timestamps = messages.map((_, i) => new Date(Date.parse(now) + i).toISOString());
  await writeFile(join(root, "logs", "operational-2026-10-06.jsonl"), messages.map((message, i) => JSON.stringify({ at: timestamps[i], level: "INFO", message }) + "\n").join(""));
  const raw = await readFile((await createSupportBundle(request)).path), entries = unzip(raw);
  const diagnostics = JSON.parse(entries.get("diagnostics.json")!);
  const user = diagnostics.participants[0].label, vcName = diagnostics.discord.bots[0].voiceChannelName;
  const guildName = diagnostics.discord.bots[0].guildName;
  const replacements = new Map([[participant, user], [userId, diagnostics.participants[0].discordUserId]]);
  const events = entries.get("logs/operational-2026-10-06.jsonl")!.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.length, messages.length);
  for (let i = 0; i < messages.length - 1; i++) {
    let expected = messages[i];
    for (const [name, pseudonym] of replacements) expected = expected.replace(name, pseudonym);
    expected = expected.replace(vcId, diagnostics.discord.bots[0].voiceChannelId.replace(/^vc-/, "user-"));
    expected = expected.replace(vc, messages[i].startsWith("入力デバイス:") || messages[i].startsWith("出力デバイス:") || messages[i].startsWith("Cueデバイス:") ? vcName.replace(/^vc-/, "device-") : vcName);
    expected = expected.replace(guild, guildName.replace(/^guild-/, "scene-"));
    assert.equal(events[i].message, expected, messages[i]);
    assert.equal(events[i].at, timestamps[i], "chronological ordering and original timestamps are preserved");
  }
  assert.match(events.at(-1).message, /^event-[a-f0-9]{12}$/);
  for (const privateValue of [participant, userId, guild, vc, vcId, token, envSecret]) assert.equal(raw.includes(Buffer.from(privateValue)), false, `timeline leaked ${privateValue}`);
});

test("support ID aliases use field-specific prefixes with a shared HMAC digest", async (t) => {
  const { request } = await fixture(t);
  for (const row of [request.diagnostics.discord.bots[0], request.diagnostics.discord.sources[0]]) {
    Object.assign(row, { guildId: userId, voiceChannelId: userId, botId: userId });
  }
  const raw = await readFile((await createSupportBundle(request)).path);
  const diagnostics = JSON.parse(unzip(raw).get("diagnostics.json")!);
  const bot = diagnostics.discord.bots[0], source = diagnostics.discord.sources[0];
  const user = source.userId;
  assert.match(user, /^user-[a-f0-9]{12}$/);
  for (const [field, prefix] of [["guildId", "guild"], ["voiceChannelId", "vc"], ["botId", "bot"]]) {
    assert.match(bot[field], new RegExp(`^${prefix}-[a-f0-9]{12}$`));
    assert.equal(bot[field].split("-")[1], user.split("-")[1], "same ID retains its digest across kinds");
    assert.equal(source[field], bot[field], "repeated fields retain the same alias");
  }
  assert.equal(diagnostics.participants[0].discordUserId, user);
  assert.ok(source.channelId.endsWith(user), "IDs embedded in ordinary strings default to user-");
  assert.equal(raw.includes(Buffer.from(userId)), false);
});

test("support console export keeps only complete tail lines within 5 MiB and records truncation", async (t) => {
  const { root, request } = await fixture(t);
  const mb = 1024 * 1024, limit = 5 * mb;
  const early = "TX_EARLY_ONLY started by operator\n";
  const cutPrefix = "discard-this-prefix ";
  const partial = "TX_PARTIAL_ONLY started by operator\n";
  const recent = "TX_RECENT_ONLY stopped by operator\n";
  const fill = (bytes: number) => {
    const line = "Router core simulator started\n";
    const count = Math.floor(bytes / line.length) - (bytes % line.length > 0 && bytes % line.length < 19 ? 1 : 0);
    const remainder = bytes - count * line.length;
    return line.repeat(count) + (remainder ? "x".repeat(remainder - 1) + "\n" : "");
  };
  const input = early + fill(mb - early.length - cutPrefix.length) + cutPrefix + partial + fill(limit - partial.length - recent.length) + recent;
  assert.equal(Buffer.byteLength(input), 6 * mb);
  await writeFile(join(root, "logs", "router.log"), input);
  await utimes(join(root, "logs", "router.log"), new Date(now), new Date(now));
  const raw = await readFile((await createSupportBundle(request)).path), entries = unzip(raw);
  const consoleText = entries.get("logs/router.log")!;
  assert.ok(Buffer.byteLength(consoleText) <= limit);
  assert.equal(raw.includes(Buffer.from("TX_EARLY_ONLY")), false, "old recognized event was not read");
  assert.equal(raw.includes(Buffer.from("TX_PARTIAL_ONLY")), false, "a valid-looking suffix of the first partial line was discarded");
  assert.ok(consoleText.endsWith(recent));
  assert.deepEqual(JSON.parse(entries.get("bundle-info.json")!).routerLog, { truncated: true, originalSizeBytes: 6 * mb, exportedBytes: Buffer.byteLength(consoleText) });
  const boundary = "TX_BOUNDARY_ONLY started by operator\n";
  await writeFile(join(root, "logs", "router.log"), early + boundary + fill(limit - boundary.length - recent.length) + recent);
  await utimes(join(root, "logs", "router.log"), new Date(now), new Date(now));
  const aligned = unzip(await readFile((await createSupportBundle(request)).path));
  assert.ok(aligned.get("logs/router.log")!.startsWith(boundary), "a tail window aligned to a complete line does not discard it");
  await writeFile(join(root, "logs", "router.log"), recent);
  await utimes(join(root, "logs", "router.log"), new Date(now), new Date(now));
  const small = unzip(await readFile((await createSupportBundle(request)).path));
  assert.equal(small.get("logs/router.log"), recent, "a short console file keeps its first complete line");
  assert.deepEqual(JSON.parse(small.get("bundle-info.json")!).routerLog, { truncated: false, originalSizeBytes: recent.length, exportedBytes: recent.length });
  const expanding = "x\n".repeat(300000) + recent;
  await writeFile(join(root, "logs", "router.log"), expanding);
  await utimes(join(root, "logs", "router.log"), new Date(now), new Date(now));
  const expanded = unzip(await readFile((await createSupportBundle(request)).path));
  const tail = expanded.get("logs/router.log")!;
  assert.ok(Buffer.byteLength(tail) <= limit, "HMAC aliases cannot expand the exported console beyond the cap");
  assert.ok(tail.endsWith(recent), "output cap drops oldest lines, not newest lines");
  assert.deepEqual(JSON.parse(expanded.get("bundle-info.json")!).routerLog, { truncated: true, originalSizeBytes: Buffer.byteLength(expanding), exportedBytes: Buffer.byteLength(tail) });
});

test("support reads tray console from projectRoot even when settingsRoot is a different folder", async (t) => {
  const { root, request } = await fixture(t);
  const project = await mkdtemp(join(tmpdir(), "dbr-support-project-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(join(project, "logs"));
  const consolePath = join(project, "logs", "router.log"), actual = "TX_PROJECT_ONLY started by operator\n";
  await writeFile(consolePath, actual);
  await utimes(consolePath, new Date(now), new Date(now));
  await writeFile(join(root, "logs", "router.log"), "TX_SETTINGS_DECOY stopped by operator\n");
  await utimes(join(root, "logs", "router.log"), new Date(now), new Date(now));
  const raw = await readFile((await createSupportBundle({ ...request, projectRoot: project })).path), entries = unzip(raw);
  assert.equal(entries.get("logs/router.log"), actual);
  assert.equal(raw.includes(Buffer.from("TX_SETTINGS_DECOY")), false, "settingsRoot console is not a fallback or a second archive entry");
  assert.ok(entries.has("logs/operational-2026-10-06.jsonl"), "operational logs still come from settingsRoot");
  await utimes(consolePath, new Date(2026, 8, 29), new Date(2026, 8, 29));
  const old = unzip(await readFile((await createSupportBundle({ ...request, projectRoot: project })).path));
  assert.equal(old.has("logs/router.log"), false, "project console still follows retention selection");
  if (process.platform !== "win32") {
    await rm(consolePath);
    await symlink(join(root, ".env"), consolePath);
    const linked = unzip(await readFile((await createSupportBundle({ ...request, projectRoot: project })).path));
    assert.equal(linked.has("logs/router.log"), false, "project console symlinks cannot export secrets");
  }
  const missingProject = await mkdtemp(join(tmpdir(), "dbr-support-project-empty-"));
  t.after(() => rm(missingProject, { recursive: true, force: true }));
  const missing = unzip(await readFile((await createSupportBundle({ ...request, projectRoot: missingProject })).path));
  assert.equal(missing.has("logs/router.log"), false);
  assert.equal(JSON.parse(missing.get("bundle-info.json")!).routerLog, null);
});

test("support export honors N days, omits symlinks and never follows a support output symlink", async (t) => {
  const { root, request } = await fixture(t);
  await writeFile(join(root, "logs", "operational-2026-10-05.jsonl"), "");
  if (process.platform !== "win32") {
    await symlink(join(root, ".env"), join(root, "logs", "operational-2026-10-04.jsonl"));
    const recent = unzip(await readFile((await createSupportBundle(request)).path));
    assert.equal(recent.has("logs/operational-2026-10-04.jsonl"), false, "a recent allowlisted name cannot follow a secret-file symlink");
  }
  const bundle = unzip(await readFile((await createSupportBundle({ ...request, days: 1 })).path));
  assert.equal(bundle.has("logs/operational-2026-10-05.jsonl"), false);
  assert.equal(bundle.has("logs/operational-2026-10-04.jsonl"), false);
  await assert.rejects(createSupportBundle({ ...request, days: 31 }), /1\.\.30/);
  if (process.platform !== "win32") {
    const linkedRoot = await mkdtemp(join(tmpdir(), "dbr-support-link-"));
    t.after(() => rm(linkedRoot, { recursive: true, force: true }));
    await symlink(join(root, "recordings"), join(linkedRoot, "support"));
    await assert.rejects(createSupportBundle({ ...request, settingsRoot: linkedRoot }));
    assert.deepEqual(await readdir(join(root, "recordings")), ["secret.wav"]);
  }
});

test("support ZIP streams large logs on a worker while ON_AIR audio blocks continue", async (t) => {
  const { root, request } = await fixture(t);
  const line = JSON.stringify({ at: now, level: "WARNING", message: `${participant}: audio samples dropped +1` }) + "\n";
  await writeFile(join(root, "logs", "operational-2026-10-06.jsonl"), line.repeat(20000));
  const engine = AudioEngine.createDemo(4);
  const plane = new ControlPlane(engine);
  assert.equal(plane.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true }).ok, true);
  let maxGap = 0, last = performance.now();
  const timer = setInterval(() => { const current = performance.now(); maxGap = Math.max(maxGap, current - last); last = current; engine.processBlock(); }, 10);
  try {
    const result = await createSupportBundle({ ...request, diagnostics: supportDiagnostics(plane.snapshot()) });
    assert.ok(engine.blocksProcessed >= 10, `audio only processed ${engine.blocksProcessed} blocks`);
    assert.ok(maxGap < 250, `event loop stalled ${maxGap.toFixed(1)}ms`);
    assert.equal(plane.state, "ON_AIR");
    assert.ok((await readFile(result.path)).length > 1024 * 1024);
  } finally { clearInterval(timer); }
});

test("support creation handles missing logs/metadata/native probes without raw errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dbr-support-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await createSupportBundle({ settingsRoot: root, projectRoot: root, runtimeInfo: { ...runtimeInfo, buildCommit: null, pcRole: "UNCONFIGURED" }, diagnostics: supportDiagnostics(snapshot()), now });
  const entries = unzip(await readFile(result.path));
  assert.equal([...entries.keys()].some((name) => name.startsWith("logs/")), false);
  assert.equal(JSON.parse(entries.get("release-build-info.json")!).buildCommit, null);
  assert.deepEqual(JSON.parse(entries.get("system.json")!).nativeDependencies, { "@discordjs/opus": "UNAVAILABLE", naudiodon2: "UNAVAILABLE" });
  await writeFile(join(root, "release-build-info.json"), JSON.stringify({ schemaVersion: 999, buildCommit: commit }));
  const invalid = await createSupportBundle({ settingsRoot: root, projectRoot: root, runtimeInfo, diagnostics: supportDiagnostics(snapshot()), now });
  assert.equal(JSON.parse(unzip(await readFile(invalid.path)).get("release-build-info.json")!).buildCommit, null, "an unsupported release schema cannot masquerade as valid build metadata");
});

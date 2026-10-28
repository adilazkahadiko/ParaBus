import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { DiscordFrameType } from "../packages/discord-ipc/src/index.ts";
import { offlineState } from "./rx-load/state.ts";
import { schedule, matrixPatterns } from "./rx-load/schedule.ts";
import { supportDiagnostics } from "../services/router-core-sim/src/support-bundle.ts";

test("seeded independent speakers preserve order, alternate speech/silence, and reproduce burst delivery", () => {
  const seed = 20261029;
  for (const pattern of matrixPatterns) {
    const first = schedule(0, 900_000, pattern, seed);
    assert.deepEqual(first, schedule(0, 900_000, pattern, seed));
    assert.notDeepEqual(first, schedule(1, 900_000, pattern, seed));
    assert.notDeepEqual(first, schedule(0, 900_000, pattern, seed + 1));
    assert.ok(first.talkspurts > 50); assert.ok(first.speechMs > 0 && first.speechMs < 900_000);
    let silences = 0, batches = 0;
    for (let i = 1; i < first.arrivals.length; i++) {
      const before = first.arrivals[i - 1], current = first.arrivals[i];
      assert.ok(current.at >= before.at); assert.equal(current.sequence, before.sequence + 1);
      if (current.sentAt - before.sentAt > 200) { silences++; assert.ok(current.sentAt - before.sentAt >= 300); }
      if (current.at === before.at) batches++;
    }
    assert.ok(silences > 50); assert.ok(batches > 0);
    if (pattern !== "regular") assert.ok(first.stalls > 10);
  }
  const first = schedule(0, 900_000, "realistic", seed), second = schedule(0, 900_000, "severe", seed);
  assert.equal(first.speechMs, second.speechMs, "speech RNG is independent from transport RNG");
  assert.ok(second.stalls > first.stalls);
});

test("periodic full Desktop state omits only RX details while diagnostics/Bundle preserve them", async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now); t.mock.method(Date, "now", () => 1_800_000_000_000);
  const state = offlineState({ backend: "@discordjs/opus", create48kMono: () => ({ decode: () => Buffer.alloc(1920), dispose() {} }) });
  t.after(() => state.close());
  const ids = { botId: "100000000000000001", guildId: "100000000000000002", voiceChannelId: "100000000000000003", userId: "100000000000000004", sourceGeneration: 1 };
  state.ingest.ingest({ type: DiscordFrameType.BOT_META, ...ids, payload: Buffer.from(JSON.stringify({ profileId: "RX", role: "RX", gatewayState: "ready", voiceState: "ready" })) });
  state.ingest.ingest({ type: DiscordFrameType.USER_META, ...ids, payload: Buffer.from("Synthetic") });
  const timing = [...state.ingest.runtimes.values()][0].source.timing!;
  for (let i = 0; i < 30; i++) {
    now = i * 60_000; timing.observePacket(now, 0); timing.packet(now); timing.observeFill(now, 10);
    now += 10; timing.fill(0, 480); timing.observeFill(now, 10);
    now += 10; timing.observePacket(now, 0); timing.observeQueued(960);
  }
  const detailed = state.state(true), periodic = state.state(false);
  const reduced = structuredClone(detailed);
  for (const source of reduced.payload.discord!.sources) for (const key of ["packetJitterWindows", "fillJitterWindows", "recentInSpeechUnderruns"] as const) delete source.rxTiming![key];
  assert.deepEqual(periodic, reduced);
  const light = periodic.payload.discord!.sources[0].rxTiming!;
  assert.equal(light.inSpeechUnderruns, 30); assert.equal(light.queueWindows!.length, 30);
  assert.doesNotMatch(JSON.stringify(periodic), /packetJitterWindows|fillJitterWindows|recentInSpeechUnderruns/);
  assert.ok(Buffer.byteLength(JSON.stringify(detailed)) > Buffer.byteLength(JSON.stringify(periodic)));
  const diagnostic = state.ingest.snapshot(Date.now(), true);
  assert.equal(diagnostic.sources[0].rxTiming!.packetJitterWindows!.length, 30);
  const bundle = supportDiagnostics({ ...periodic.payload, discord: diagnostic });
  assert.equal((bundle.discord.sources[0].rxTiming.packetJitterWindows as unknown[]).length, 30);
  assert.equal((bundle.discord.sources[0].rxTiming.recentInSpeechUnderruns as unknown[]).length, 30);
  for (const key of ["channels", "buses", "userProfiles", "userSessions", "system", "output", "input", "recorder", "runtimeInfo", "audioTiming", "audioRuntimeTiming", "coreOwnership", "programAudioShadow", "rustManagement", "operatorHealth"]) assert.ok(Object.hasOwn(periodic.payload, key), key);
});

test("WebSocket delivery disables new RX details; on-demand GET and Support retain full diagnostics; UI does not read details", () => {
  const server = readFileSync(new URL("../services/router-core-sim/src/server.ts", import.meta.url), "utf8");
  assert.match(server, /desktopSnapshot = \(includeHistory = true, includeRxDetails = true\)/);
  assert.match(server, /desktopSnapshot\(includeHistory, false\)/);
  assert.match(server, /desktopSnapshot\(true, false\)/);
  assert.match(server, /setInterval\(\(\) => broadcastState\(true\), 1_000\)/);
  assert.match(server, /writeJson\(response, 200, desktopSnapshot\(\)\)/);
  assert.match(server, /diagnostics: supportDiagnostics\(\{.*discord: discordIngest.snapshot\(\)/);
  const root = new URL("../services/router-core-sim/public/", import.meta.url);
  for (const file of readdirSync(root, { recursive: true, encoding: "utf8" }).filter(x => /\.(js|html)$/.test(x))) {
    assert.doesNotMatch(readFileSync(new URL(file.replaceAll("\\", "/"), root), "utf8"), /packetJitterWindows|fillJitterWindows|recentInSpeechUnderruns/, file);
  }
});

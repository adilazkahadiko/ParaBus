import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Events } from "discord.js";
import { DiscordFrameDecoder, DiscordFrameType, encodeDiscordFrame, decodeDiscordFrame, type DiscordIpcFrame } from "../packages/discord-ipc/src/index.ts";
import { DiscordBotConnection } from "../services/discord-adapter/src/bot-connection.ts";
import { DiscordBotRack, type ManagedDiscordBot } from "../services/discord-adapter/src/bot-rack.ts";
import { loadBotRackEnvironment, loadBotRackProfiles, type DiscordBotProfile } from "../services/discord-adapter/src/bot-config.ts";
import type { DiscordIpcClient } from "../services/discord-adapter/src/ipc-client.ts";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane, type DiscordTxController } from "../services/router-core-sim/src/control-plane.ts";
import { DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";

const profile: DiscordBotProfile = {
  profileId: "RX01",
  label: "RX 01",
  role: "RX",
  txSubtype: null,
  txAudioMode: null,
  tokenEnv: "DISCORD_TOKEN_RX01",
  token: "test-only-token",
  guildId: "100000000000000001",
  voiceChannelId: "100000000000000101",
};

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("Adapter RX IPC diagnostics distinguish unavailable drops from queued backpressure", () => {
  const program = `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { mock } from 'node:test';
    const writes = [];
    const socket = Object.assign(new EventEmitter(), {
      writable: true, connecting: true, writableLength: 0,
      setNoDelay() {},
      write(frame) { writes.push(frame); this.writableLength += frame.length; return false; },
      destroy() { this.emit('close'); },
    });
    mock.module('node:net', { namedExports: { createConnection: () => socket } });
    const { DiscordIpcClient } = await import(${JSON.stringify(new URL("../services/discord-adapter/src/ipc-client.ts", import.meta.url).href)});
    const client = new DiscordIpcClient('test-only-no-network');
    client.send({ type: ${DiscordFrameType.OPUS}, payload: Buffer.from([1]) });
    client.send({ type: ${DiscordFrameType.USER_META} });
    client.start();
    client.send({ type: ${DiscordFrameType.OPUS}, payload: Buffer.from([1]) });
    assert.equal(client.rxDiagnostics().opusDroppedFrames, 2);
    assert.equal(client.droppedFrames, 3, 'Metadata drops are not audio drops');
    socket.connecting = false;
    socket.emit('connect');
    client.send({ type: ${DiscordFrameType.OPUS}, payload: Buffer.from([1]) });
    assert.equal(writes.length, 1, 'A connecting/disconnected stream does not replay speech');
    const stats = client.rxDiagnostics();
    assert.equal(stats.opusDroppedFrames, 2, 'write(false) queues, it does not discard');
    assert.equal(stats.backpressureWrites, 1);
    assert.equal(stats.writableBytes, writes[0].length);
    assert.equal(stats.maxWritableBytes, writes[0].length);
    socket.writableLength = 0;
    assert.equal(client.rxDiagnostics().writableBytes, 0);
    assert.equal(client.rxDiagnostics().maxWritableBytes, writes[0].length);
    client.close();
    assert.equal(client.rxDiagnostics().writableBytes, 0);
  `;
  const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", program], { encoding: "utf8", timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
});

test("Discord Bot control frame round-trips without exposing a token", () => {
  const payload = Buffer.from(JSON.stringify({ action: "DISCONNECT", profileId: "RX01" }));
  const decoded = decodeDiscordFrame(encodeDiscordFrame({ type: DiscordFrameType.BOT_CONTROL, payload }));
  assert.equal(decoded.type, DiscordFrameType.BOT_CONTROL);
  assert.deepEqual(JSON.parse(Buffer.from(decoded.payload ?? []).toString("utf8")), { action: "DISCONNECT", profileId: "RX01" });
  assert.equal(Buffer.from(decoded.payload ?? []).includes(Buffer.from(profile.token)), false);
});

test("Adapter reloads current token values from .env without sending them over IPC", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dbr-bot-control-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const environmentFile = join(root, ".env");
  writeFileSync(environmentFile, "DISCORD_TOKEN_RX01=fresh-value\n", "utf8");
  const loaded = loadBotRackEnvironment({ DISCORD_TOKEN_RX01: "stale-value" }, environmentFile);
  assert.equal(loaded.DISCORD_TOKEN_RX01, "fresh-value");
});

test("unconfigured Adapter starts as an empty rack for first-run live setup", () => {
  const missingConfig = join(tmpdir(), `dbr-no-config-${process.pid}-${Date.now()}.json`);
  assert.deepEqual(loadBotRackProfiles({}, missingConfig), []);
});

test("Adapter entry point waits for manual connect with an enabled saved profile, including restart", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dbr-bot-startup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const program = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    let creates = 0, starts = 0, ipcStarts = 0, onFrame;
    mock.module(${JSON.stringify(new URL("../services/discord-adapter/src/bot-connection.ts", import.meta.url).href)}, {
      namedExports: { DiscordBotConnection: class {
        constructor(profile) { this.profile = profile; creates++; }
        async start() { starts++; }
        async close() {}
      } },
    });
    mock.module(${JSON.stringify(new URL("../services/discord-adapter/src/ipc-client.ts", import.meta.url).href)}, {
      namedExports: { DiscordIpcClient: class {
        start() { ipcStarts++; }
        onFrame(handler) { onFrame = handler; }
        close() {}
      } },
    });
    for (let boot = 0; boot < 2; boot++) {
      await import(${JSON.stringify(new URL("../services/discord-adapter/src/index.ts", import.meta.url).href)} + '?boot=' + boot);
      assert.equal(ipcStarts, boot + 1, 'Local IPC stays available');
      assert.equal(creates, boot, 'No Bot is created automatically on startup or restart');
      assert.equal(starts, boot, 'No Discord login until an explicit CONNECT');
      onFrame({ type: ${DiscordFrameType.BOT_CONTROL}, payload: Buffer.from(JSON.stringify({ action: 'CONNECT', profileId: 'RX01' })) });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(creates, boot + 1);
      assert.equal(starts, boot + 1, 'Manual connection still works');
    }
  `;
  const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", program], {
    cwd: root,
    env: {
      ...process.env,
      DISCORD_BOT_RACK_FILE: "",
      DISCORD_BOT_RACK_JSON: JSON.stringify({ bots: [{ id: "RX01", tokenEnv: "DISCORD_TEST_ONLY_TOKEN", guildId: profile.guildId, voiceChannelId: profile.voiceChannelId, enabled: true }] }),
      DISCORD_TEST_ONLY_TOKEN: "test-only-token",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
});

test("empty Adapter rack can connect and disconnect one profile at runtime", async () => {
  const events: string[] = [];
  const createConnection = (candidate: DiscordBotProfile): ManagedDiscordBot => ({
    profile: candidate,
    async start() { events.push(`start:${candidate.profileId}`); },
    async close() { events.push(`close:${candidate.profileId}`); },
    async disconnect() { events.push(`disconnect:${candidate.profileId}`); },
    ingest() {},
    resync() { events.push(`resync:${candidate.profileId}`); },
  });
  let profiles: DiscordBotProfile[] = [];
  const rack = new DiscordBotRack({} as DiscordIpcClient, new Set(), {
    loadProfiles: () => profiles,
    createConnection,
  });
  assert.equal(rack.bots.size, 0);

  profiles = [profile];
  rack.ingest({
    type: DiscordFrameType.BOT_CONTROL,
    payload: Buffer.from(JSON.stringify({ action: "CONNECT", profileId: profile.profileId })),
  });
  await nextTurn();
  assert.equal(rack.bots.size, 1);
  assert.deepEqual(events, ["start:RX01"]);

  rack.ingest({
    type: DiscordFrameType.BOT_CONTROL,
    payload: Buffer.from(JSON.stringify({ action: "CONNECT", profileId: profile.profileId })),
  });
  await nextTurn();
  assert.deepEqual(events, ["start:RX01", "resync:RX01"]);

  rack.ingest({
    type: DiscordFrameType.BOT_CONTROL,
    payload: Buffer.from(JSON.stringify({ action: "DISCONNECT", profileId: profile.profileId })),
  });
  await nextTurn();
  assert.equal(rack.bots.size, 0);
  assert.deepEqual(events, ["start:RX01", "resync:RX01", "disconnect:RX01"]);
});

test("intentional Bot disconnect ignores late Discord reconnect events", async () => {
  const frames: DiscordIpcFrame[] = [];
  const ipc = { send(frame: DiscordIpcFrame) { frames.push(frame); } } as DiscordIpcClient;
  const connection = new DiscordBotConnection(profile, ipc, new Set());
  await connection.disconnect();
  frames.splice(0);

  connection.client.emit(Events.ShardReconnecting, 0);

  assert.equal(connection.gatewayState, "disconnected");
  assert.equal(connection.voiceState, "disconnected");
  assert.equal(frames.length, 0);
});

test("Bot Rack resync hook is bounded and is removed during close", async () => {
  let connected: (() => void) | undefined;
  let removed = 0;
  let resyncs = 0;
  const ipc = {
    onConnected(handler: () => void) { connected = handler; return () => { removed += 1; }; },
  } as unknown as DiscordIpcClient;
  const rack = new DiscordBotRack(ipc, new Set(), {
    loadProfiles: () => [profile],
    createConnection: (candidate) => ({
      profile: candidate, async start() {}, async close() {}, async disconnect() {}, ingest() {}, resync() { resyncs += 1; },
    }),
  });
  connected?.();
  assert.equal(resyncs, 0, "IPC connection does not start a configured Bot");
  await rack.connect(profile.profileId);
  connected?.();
  assert.equal(resyncs, 1);
  await rack.close();
  assert.equal(removed, 1);
});

test("Adapter IPC disconnect fail-closes every TX PassThrough", async () => {
  let disconnected: (() => void) | undefined;
  let stops = 0;
  const ipc = {
    onDisconnected(handler: () => void) { disconnected = handler; return () => {}; },
  } as unknown as DiscordIpcClient;
  const txProfile = { ...profile, profileId: "TX01", role: "TX" as const, txSubtype: "CUSTOM" as const, txAudioMode: "MONO" as const };
  const rack = new DiscordBotRack(ipc, new Set(), {
    loadProfiles: () => [txProfile],
    createConnection: (candidate) => ({
      profile: candidate, async start() {}, async close() {}, async disconnect() {}, ingest() {}, resync() {}, stopTxImmediately() { stops += 1; },
    }),
  });
  await rack.connect(txProfile.profileId);
  disconnected?.();
  assert.equal(stops, 1, "Core transport reset destroys Adapter-side queued PCM");
  await rack.close();
});

test("Core sends profile-only Bot control over the existing local IPC socket", async (t) => {
  const endpoint = process.platform === "win32"
    ? String.raw`\\.\pipe\dbr-bot-control-${process.pid}-${Date.now()}`
    : join(tmpdir(), `dbr-bot-control-${process.pid}-${Date.now()}.sock`);
  const ingest = new DiscordIngestServer(new AudioEngine(48_000, 480, 2), endpoint);
  await ingest.start();
  const socket = createConnection(endpoint);
  t.after(async () => {
    socket.destroy();
    await ingest.close();
  });
  await once(socket, "connect");
  await nextTurn();
  const decoder = new DiscordFrameDecoder();
  const received = new Promise<DiscordIpcFrame>((resolve, reject) => {
    socket.on("data", (chunk) => {
      try {
        const frame = decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)[0];
        if (frame) resolve(frame);
      } catch (error) {
        reject(error);
      }
    });
  });
  ingest.connectBot("RX01");
  const frame = await received;
  assert.equal(frame.type, DiscordFrameType.BOT_CONTROL);
  assert.deepEqual(JSON.parse(Buffer.from(frame.payload ?? []).toString("utf8")), { action: "CONNECT", profileId: "RX01" });
});

test("Discord IPC shutdown completes while an Adapter socket is connected", async () => {
  const endpoint = process.platform === "win32"
    ? String.raw`\\.\pipe\dbr-close-${process.pid}-${Date.now()}`
    : join(tmpdir(), `dbr-close-${process.pid}-${Date.now()}.sock`);
  const ingest = new DiscordIngestServer(new AudioEngine(48_000, 480, 2), endpoint);
  await ingest.start();
  const socket = createConnection(endpoint);
  await once(socket, "connect");
  await Promise.race([
    ingest.close(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Discord IPC shutdown timed out")), 1_000)),
  ]);
  socket.destroy();
});

test("Control Plane locks connection ON AIR and confirms individual disconnect", () => {
  const events: string[] = [];
  const controller: DiscordTxController = {
    connectBot: (id) => events.push(`connect:${id}`),
    disconnectBot: (id) => events.push(`disconnect:${id}`),
    setTxSource() {},
    assignTxVoiceChannel() {},
    startTx() {},
    stopTx() {},
    stopAllTx() {},
  };
  const control = new ControlPlane(AudioEngine.createDemo(1), undefined, controller);
  assert.equal(control.execute({ type: "CONNECT_DISCORD_BOT", profileId: "RX01" }).ok, true);
  assert.equal(control.execute({ type: "DISCONNECT_DISCORD_BOT", profileId: "RX01" }).confirmationRequired, true);
  assert.equal(control.execute({ type: "DISCONNECT_DISCORD_BOT", profileId: "RX01", confirmed: true }).ok, true);
  control.execute({ type: "SET_STATE", state: "READY" });
  control.execute({ type: "SET_STATE", state: "ON_AIR", confirmed: true });
  assert.equal(control.execute({ type: "CONNECT_DISCORD_BOT", profileId: "RX02" }).ok, false);
  assert.equal(control.execute({ type: "DISCONNECT_DISCORD_BOT", profileId: "RX02", confirmed: true }).ok, true);
  assert.deepEqual(events, ["connect:RX01", "disconnect:RX01", "disconnect:RX02"]);
});

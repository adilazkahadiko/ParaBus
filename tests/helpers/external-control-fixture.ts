import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { decodeDiscordFrame, encodeDiscordFrame, DiscordFrameType, DiscordTxFlags } from "../../packages/discord-ipc/src/index.ts";
import { AudioChannel, AudioEngine, SilenceSource, VcBus } from "../../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../../services/router-core-sim/src/control-plane.ts";
import { DiscordIngestServer } from "../../services/router-core-sim/src/discord-ingest.ts";
import { ExternalDeviceStore } from "../../services/router-core-sim/src/external-device-store.ts";
import { ExternalControlServer } from "../../services/router-core-sim/src/external-control.ts";
import { UserProfileStore } from "../../services/router-core-sim/src/user-profile-store.ts";
import { UserSessionRegistry } from "../../services/router-core-sim/src/user-session-registry.ts";

export const USER = "100000000000000001", GUILD = "200000000000000001", VC = "300000000000000001";
export function testRoot() {
  const parent = resolve(process.env.PARABUS_EXTERNAL_TEST_ROOT ?? "target/external-api-tests");
  mkdirSync(parent, { recursive: true }); return mkdtempSync(join(parent, "case-"));
}
export async function availablePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
export class FakeAdapter extends EventEmitter {
  writable = true; destroyed = false; writableLength = 0; writes: Buffer[] = []; failStartBot: string | null = null;
  setNoDelay() {}
  write(frame: Buffer) {
    const data = decodeDiscordFrame(frame);
    if (data.type === DiscordFrameType.TX_CONTROL && (data.flags ?? 0) & DiscordTxFlags.START && data.botId === this.failStartBot) throw new Error("Injected group failure");
    this.writes.push(frame); return true;
  }
  resetAndDestroy() { this.destroy(); }
  destroy() { this.destroyed = true; this.writable = false; this.emit("close"); }
}
export async function fixture(t: TestContext, teams = 2) {
  const root = testRoot(), engine = new AudioEngine(48000, 480, 4), profiles = new UserProfileStore(root), sessions = new UserSessionRegistry(profiles);
  const bus = new VcBus("bus", "Private bus label", 480, 48000); bus.linkedDiscordGuildId = GUILD; bus.linkedDiscordVoiceChannelId = VC; engine.addBus(bus);
  const channel = new AudioChannel(`discord-user:${GUILD}:${VC}:${USER}`, "Private guest", "DiscordUser", new SilenceSource(), 480, 48000);
  channel.vcSends.set(bus.id, { gainDb: -20, mute: true }); engine.addChannel(channel); sessions.join(channel, USER, VC, channel.label);
  const ingest = new DiscordIngestServer(engine, "test-only", null, null, sessions), adapter = new FakeAdapter();
  (ingest as unknown as { accept(socket: Socket): void }).accept(adapter as unknown as Socket);
  const bots = Array.from({ length: teams + 2 }, (_, i) => ({ profileId: `TX${i + 1}`, botId: String(900000000000000001n + BigInt(i)), guildId: GUILD,
    voiceChannelId: String(800000000000000001n + BigInt(i)), txDestination: i < teams ? `TEAM_${String(i + 1).padStart(2, "0")}` : i === teams ? "INTERVIEW" : "SPARE" }));
  const botState = (i: number, changes: Record<string, unknown> = {}) => adapter.emit("data", encodeDiscordFrame({ type: DiscordFrameType.BOT_META, ...bots[i],
    payload: Buffer.from(JSON.stringify({ ...bots[i], label: "Private bot", role: "TX", txSubtype: "CUSTOM", gatewayState: "ready", voiceState: "ready", txEnabled: false, ...changes })) }));
  bots.forEach((_, i) => botState(i));
  const control = new ControlPlane(engine, undefined, ingest, undefined, undefined, sessions);
  const store = new ExternalDeviceStore(root); store.setPort(await availablePort());
  const registration = store.register("Private device"), logs: string[] = [], commands: unknown[] = []; let now = 1000;
  const api = new ExternalControlServer({ control, ingest: () => ingest.snapshot(), store, version: "0.1.0", now: () => now,
    txIdentities: () => [...ingest.bots.values()].filter(bot => bot.role === "TX" || bot.role === "DUPLEX"),
    execute: command => { commands.push(command); return control.execute(command); }, log: message => logs.push(message) });
  const unsubscribe = ingest.onControlStateChange(() => api.observe());
  await api.start(); t.after(async () => { unsubscribe(); await api.close(); profiles.flush(); await ingest.close(); });
  const base = `http://127.0.0.1:${api.port}/external/v1`, headers = { authorization: `Bearer ${registration.token}`, "content-type": "application/json" };
  const advance = (ms = 1000) => { now += ms; };
  const request = (operation: string, args: unknown, extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), instanceId: api.state.instanceId, operation, args, ...extra });
  const raw = async (body: unknown, path = "/actions", customHeaders = headers) => {
    const response = await fetch(base + path, { method: "POST", headers: customHeaders, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any, headers: response.headers };
  };
  const action = async (operation: string, args: unknown, extra: Record<string, unknown> = {}) => { advance(); return raw(request(operation, args, extra)); };
  const state = async () => { advance(); const response = await fetch(base + "/state", { headers }); return (await response.json() as any).data; };
  return { root, engine, bus, channel, ingest, adapter, control, store, api, bots, botState, logs, commands, registration, profiles, sessions, base, headers, advance, request, raw, action, state };
}

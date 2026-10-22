import { createConnection } from "node:net";
import { DiscordFrameType, encodeDiscordFrame } from "../../packages/discord-ipc/src/index.ts";

const endpoint = process.env.BOT_RACK_SIM_ENDPOINT;
if (!endpoint) throw new Error("BOT_RACK_SIM_ENDPOINT is required");
const count = Math.min(20, Math.max(1, Number(process.env.BOT_RACK_SIM_COUNT ?? 20)));
const socket = createConnection(endpoint);

function ids(index: number) {
  return {
    botId: String(200000000000000001n + BigInt(index)),
    guildId: "100000000000000001",
    voiceChannelId: String(100000000000000101n + BigInt(index)),
  };
}

function payload(index: number) {
  return Buffer.from(JSON.stringify({
    profileId: `RX${String(index + 1).padStart(2, "0")}`,
    label: `RX TEAM ${String(index + 1).padStart(2, "0")}`,
    role: "RX",
    gatewayState: "ready",
    voiceState: index === 7 ? "reconnecting" : "ready",
    voiceChannelName: `TEAM ${String(index + 1).padStart(2, "0")}`,
    wsPingMs: 38 + index,
    udpPingMs: 16 + index,
    reconnectCount: index === 7 ? 2 : 0,
    lastAudioAt: Date.now() - index * 930,
    message: index === 7 ? "same VC reconnect" : null,
  }));
}

function sendHeartbeat(): void {
  const frames = [];
  for (let index = 0; index < count; index += 1) {
    frames.push(encodeDiscordFrame({ type: DiscordFrameType.PING, ...ids(index), payload: payload(index) }));
  }
  socket.write(Buffer.concat(frames));
}

socket.once("connect", () => {
  const metadata = [];
  for (let index = 0; index < count; index += 1) {
    const identity = ids(index);
    metadata.push(encodeDiscordFrame({ type: DiscordFrameType.BOT_META, ...identity, payload: payload(index) }));
    metadata.push(encodeDiscordFrame({
      type: DiscordFrameType.USER_META,
      ...identity,
      userId: String(300000000000000001n + BigInt(index)),
      payload: Buffer.from(`Guest ${index + 1}`),
    }));
  }
  socket.write(Buffer.concat(metadata));
  sendHeartbeat();
  setInterval(sendHeartbeat, 5_000).unref();
});

process.once("SIGTERM", () => socket.end());
process.once("SIGINT", () => socket.end());

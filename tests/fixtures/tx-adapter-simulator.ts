import { createConnection } from "node:net";
import {
  DiscordFrameDecoder,
  DiscordFrameType,
  DiscordTxFlags,
  defaultDiscordIpcEndpoint,
  encodeDiscordFrame,
  type DiscordIpcFrame,
} from "../../packages/discord-ipc/src/index.ts";

const endpoint = process.env.DISCORD_IPC_ENDPOINT ?? defaultDiscordIpcEndpoint();
const guildId = "100000000000000001";
const voiceChannels = [
  { id: "100000000000000101", name: "INTERVIEW TEST" },
  { id: "100000000000000102", name: "TEAM 07" },
  { id: "100000000000000103", name: "COMMENTARY BOOTH" },
];
const stems = [
  { profileId: "TX_GAME01", label: "TX GAME", subtype: "GAME", mode: "STEREO", botId: "900000000000000001", voiceChannelId: voiceChannels[0].id },
  { profileId: "TX_CASTER01", label: "TX CASTER", subtype: "CASTER", mode: "MONO", botId: "900000000000000002", voiceChannelId: voiceChannels[0].id },
  { profileId: "TX_COMMENTARY01", label: "TX COMMENTARY", subtype: "COMMENTARY", mode: "MONO", botId: "900000000000000003", voiceChannelId: voiceChannels[0].id },
  { profileId: "TX_IFB01", label: "TX IFB", subtype: "IFB", mode: "MONO", botId: "900000000000000004", voiceChannelId: voiceChannels[0].id },
].map((stem) => ({ ...stem, txEnabled: false, txFrames: 0, txDroppedFrames: 0, lastTxFrameAt: null as number | null }));

function identity(stem: (typeof stems)[number]) {
  return { botId: stem.botId, guildId, voiceChannelId: stem.voiceChannelId };
}

function status(stem: (typeof stems)[number]): Buffer {
  return Buffer.from(JSON.stringify({
    profileId: stem.profileId,
    label: stem.label,
    role: "TX",
    txSubtype: stem.subtype,
    txAudioMode: stem.mode,
    gatewayState: "ready",
    voiceState: "ready",
    voiceChannelName: voiceChannels.find((channel) => channel.id === stem.voiceChannelId)?.name ?? "UNKNOWN VC",
    wsPingMs: 24,
    udpPingMs: 12,
    reconnectCount: 0,
    txEnabled: stem.txEnabled,
    txFrames: stem.txFrames,
    txDroppedFrames: stem.txDroppedFrames,
    lastTxFrameAt: stem.lastTxFrameAt,
  }));
}

function write(socket: ReturnType<typeof createConnection>, stem: (typeof stems)[number], type: DiscordIpcFrame["type"]): void {
  socket.write(encodeDiscordFrame({ type, ...identity(stem), payload: status(stem) }));
}

const socket = createConnection(endpoint);
const decoder = new DiscordFrameDecoder();
socket.setNoDelay(true);
socket.once("connect", () => {
  for (const stem of stems) {
    write(socket, stem, DiscordFrameType.BOT_META);
    write(socket, stem, DiscordFrameType.ADAPTER_STATE);
  }
  socket.write(encodeDiscordFrame({
    type: DiscordFrameType.VOICE_CHANNELS,
    ...identity(stems[0]),
    payload: Buffer.from(JSON.stringify(voiceChannels)),
  }));
});
socket.on("data", (chunk) => {
  for (const frame of decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)) {
    const stem = stems.find((candidate) => candidate.botId === frame.botId);
    if (!stem) continue;
    if (frame.type === DiscordFrameType.TX_CONTROL) {
      if ((frame.flags ?? 0) & DiscordTxFlags.ASSIGN_VOICE_CHANNEL) {
        stem.txEnabled = false;
        stem.voiceChannelId = frame.voiceChannelId ?? stem.voiceChannelId;
      } else {
        stem.txEnabled = Boolean((frame.flags ?? 0) & DiscordTxFlags.START);
      }
      write(socket, stem, DiscordFrameType.ADAPTER_STATE);
    } else if (frame.type === DiscordFrameType.TX_PCM && stem.txEnabled) {
      stem.txFrames += 1;
      stem.lastTxFrameAt = Date.now();
    }
  }
});
socket.on("error", (error) => console.error(error.message));
const heartbeat = setInterval(() => { for (const stem of stems) write(socket, stem, DiscordFrameType.PING); }, 500);
process.once("SIGTERM", () => { clearInterval(heartbeat); socket.end(); });
process.once("SIGINT", () => { clearInterval(heartbeat); socket.end(); });

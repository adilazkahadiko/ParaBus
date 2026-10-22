import {
  AudioPlayerStatus,
  DAVESession,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioReceiveStream,
  type AudioResource,
  type VoiceConnection,
} from "@discordjs/voice";
import { PassThrough } from "node:stream";
import { ChannelType, Client, Events, GatewayIntentBits, type VoiceBasedChannel } from "discord.js";
import { DiscordFrameType, DiscordTxFlags, type DiscordFrameTypeValue, type DiscordIpcFrame } from "../../../packages/discord-ipc/src/index.ts";
import { isRxCapableRole, isTxCapableRole, type DiscordBotProfile } from "./bot-config.ts";
import type { DiscordIpcClient } from "./ipc-client.ts";

const HEARTBEAT_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const DISCORD_TX_PCM_BLOCK_BYTES = 480 * 2 * 2;
const DISCORD_SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);
export const DISCORD_TX_STREAM_HIGH_WATER_MARK_BYTES = DISCORD_TX_PCM_BLOCK_BYTES * 10;

const nativeProcessDaveProposals = DAVESession.prototype.processProposals;

export function installDaveWrongEpochRecovery(): void {
  if (DAVESession.prototype.processProposals !== nativeProcessDaveProposals) return;
  DAVESession.prototype.processProposals = function (payload, connectedClients) {
    try {
      return nativeProcessDaveProposals.call(this, payload, connectedClients);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ValidationError(WrongEpoch)")) throw error;
      // @discordjs/voice 0.19.2 already uses this recovery for invalid commits/welcomes,
      // but lets the equivalent proposal error escape and terminate the Adapter.
      this.recoverFromInvalidTransition(this.lastTransitionId ?? 0);
      return undefined;
    }
  };
}

installDaveWrongEpochRecovery();

export class DiscordBotConnection {
  readonly profile: DiscordBotProfile;
  readonly ipc: DiscordIpcClient;
  readonly ignoredUserIds: Set<string>;
  readonly client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  readonly streams = new Map<string, AudioReceiveStream>();
  readonly receiveRetryCounts = new Map<string, number>();
  readonly receiveRetryTimers = new Map<string, NodeJS.Timeout>();
  readonly sequences = new Map<string, number>();
  readonly timestamps = new Map<string, number>();
  /** Active VC membership generation; retained across silence-end, cleared only on a real leave. */
  readonly sourceGenerations = new Map<string, number>();
  // Live PCM may pause: emit silence rather than ending the authorized TX session.
  readonly player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: Infinity } });
  connection: VoiceConnection | null = null;
  botId = "0";
  gatewayState = "starting";
  voiceState = "idle";
  guildName: string | null = null;
  voiceChannelName: string | null = null;
  reconnectCount = 0;
  lastAudioAt: number | null = null;
  txEnabled = false;
  txFrames = 0;
  txDroppedFrames = 0;
  lastTxFrameAt: number | null = null;
  message: string | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #closed = false;
  #txStream: PassThrough | null = null;
  #txResource: AudioResource | null = null;
  #txFailed = false;
  #txBackpressured = false;
  #nextSourceGeneration = 1;

  constructor(profile: DiscordBotProfile, ipc: DiscordIpcClient, ignoredUserIds: Set<string>) {
    this.profile = profile;
    this.ipc = ipc;
    this.ignoredUserIds = ignoredUserIds;
    this.wireClientEvents();
  }

  async start(): Promise<void> {
    this.#closed = false;
    this.gatewayState = "connecting";
    this.sendStatus();
    try {
      await this.client.login(this.profile.token);
    } catch (error) {
      this.fail("gateway-login-failed", error);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closeInternal(false);
  }

  async disconnect(): Promise<void> {
    this.closeInternal(true);
  }

  /** Fail-closed hook for Core IPC loss; queued Discord TX PCM is destroyed. */
  stopTxImmediately(): void {
    this.stopTx();
  }

  /** Metadata-only replay after the local Core IPC reconnects; never replays Opus. */
  resync(): void {
    if (this.#closed || this.botId === "0") return;
    this.sendBotMeta();
    this.sendStatus();
    for (const [userId, sourceGeneration] of this.sourceGenerations) {
      this.ipc.send({
        type: DiscordFrameType.USER_META,
        ...this.identity(userId),
        sourceGeneration,
        payload: Buffer.from(this.displayName(userId), "utf8"),
      });
    }
  }

  private closeInternal(notifyCore: boolean): void {
    this.#closed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#heartbeat = null;
    this.#reconnectTimer = null;
    this.releaseAllUsers(true);
    this.stopTx();
    this.connection?.destroy();
    this.connection = null;
    this.gatewayState = "disconnected";
    this.voiceState = "disconnected";
    this.guildName = null;
    this.voiceChannelName = null;
    this.message = notifyCore ? "Disconnected by operator" : null;
    if (notifyCore) this.sendStatus();
    this.client.destroy();
  }

  private identity(userId = "0") {
    return {
      botId: this.botId,
      guildId: this.profile.guildId,
      voiceChannelId: this.profile.voiceChannelId,
      userId,
    };
  }

  private statusPayload(): Buffer {
    const ping = this.connection?.ping;
    return Buffer.from(JSON.stringify({
      profileId: this.profile.profileId,
      label: this.profile.label,
      role: this.profile.role,
      txSubtype: this.profile.txSubtype,
      txAudioMode: this.profile.txAudioMode,
      txDestination: this.profile.txDestination ?? null,
      gatewayState: this.gatewayState,
      voiceState: this.voiceState,
      guildName: this.guildName,
      voiceChannelName: this.voiceChannelName,
      wsPingMs: ping?.ws ?? null,
      udpPingMs: ping?.udp ?? null,
      reconnectCount: this.reconnectCount,
      lastAudioAt: this.lastAudioAt,
      txEnabled: this.txEnabled,
      txFailed: this.#txFailed,
      txFrames: this.txFrames,
      txDroppedFrames: this.txDroppedFrames,
      lastTxFrameAt: this.lastTxFrameAt,
      rxIpc: this.ipc.rxDiagnostics?.(),
      message: this.message,
    }), "utf8");
  }

  private sendStatus(type: DiscordFrameTypeValue = DiscordFrameType.ADAPTER_STATE): void {
    this.ipc.send({ type, ...this.identity(), payload: this.statusPayload() });
  }

  private sendBotMeta(): void {
    this.ipc.send({
      type: DiscordFrameType.BOT_META,
      ...this.identity(),
      payload: Buffer.from(JSON.stringify({
        profileId: this.profile.profileId,
        label: this.profile.label,
        role: this.profile.role,
        txSubtype: this.profile.txSubtype,
        txAudioMode: this.profile.txAudioMode,
        txDestination: this.profile.txDestination ?? null,
        guildName: this.guildName,
        voiceChannelName: this.voiceChannelName,
      }), "utf8"),
    });
  }

  ingest(frame: DiscordIpcFrame): void {
    if (!isTxCapableRole(this.profile.role) || this.botId === "0" || frame.botId !== this.botId) return;
    if (frame.type === DiscordFrameType.TX_CONTROL) {
      if ((frame.flags ?? 0) & DiscordTxFlags.ASSIGN_VOICE_CHANNEL) {
        void this.assignVoiceChannel(frame.guildId ?? "0", frame.voiceChannelId ?? "0").catch((error) => this.fail("tx-assignment-failed", error));
        return;
      }
      if ((frame.flags ?? 0) & DiscordTxFlags.START) this.startTx();
      else this.stopTx();
      this.sendStatus();
      return;
    }
    if (frame.type !== DiscordFrameType.TX_PCM || !this.txEnabled || !this.#txStream) return;
    if (this.#txBackpressured) {
      this.txDroppedFrames += 1;
      return;
    }
    const pcm = Buffer.from(frame.payload ?? []);
    if (pcm.length === 0 || pcm.length % 4 !== 0) {
      this.txDroppedFrames += 1;
      return;
    }
    this.txFrames += 1;
    this.lastTxFrameAt = Date.now();
    if (!this.#txStream.write(pcm)) this.#txBackpressured = true;
  }

  private startTx(): void {
    if (this.#closed || !isTxCapableRole(this.profile.role) || this.txEnabled) return;
    // Ten 10 ms stereo PCM blocks cap Adapter-side latency at 100 ms while
    // tolerating ordinary Windows/Node scheduling jitter without choppy audio.
    // Backpressure already drops subsequent blocks until drain, preferring
    // current audio over an ever-growing delayed queue.
    const stream = new PassThrough({ highWaterMark: DISCORD_TX_STREAM_HIGH_WATER_MARK_BYTES });
    stream.on("drain", () => { if (this.#txStream === stream) this.#txBackpressured = false; });
    stream.on("error", (error) => {
      if (this.#txStream === stream) this.failTx("tx-stream-failed", error);
    });
    this.#txStream = stream;
    this.#txBackpressured = false;
    this.txEnabled = true;
    this.#txFailed = false;
    this.message = null;
    try {
      this.#txResource = createAudioResource(stream, { inputType: StreamType.Raw });
      this.player.play(this.#txResource);
    } catch (error) {
      this.failTx("tx-start-failed", error);
    }
  }

  private stopTx(): void {
    this.txEnabled = false;
    this.#txFailed = false;
    this.#txBackpressured = false;
    // Clear ownership before teardown so late errors cannot stop a replacement.
    const stream = this.#txStream;
    this.#txStream = null;
    this.#txResource = null;
    this.player.stop(true);
    stream?.destroy();
  }

  private failTx(state: string, error: unknown): void {
    if (!this.txEnabled) return;
    this.stopTx();
    this.message = `TX stopped (${state}); restart TX explicitly`;
    this.#txFailed = true;
    this.sendStatus();
    console.error(`[${this.profile.profileId}] ${state}: ${error instanceof Error ? error.message : String(error)}`);
  }

  private async assignVoiceChannel(guildId: string, voiceChannelId: string): Promise<void> {
    if (!isTxCapableRole(this.profile.role)) throw new Error("このBotは送信Roleではありません");
    if (guildId !== this.profile.guildId) throw new Error("TX Botは設定済みGuildのVCにのみ割り当てできます");
    const channel = await this.client.channels.fetch(voiceChannelId);
    if (!channel || !channel.isVoiceBased() || channel.type === ChannelType.GuildStageVoice) {
      throw new Error(`voiceChannelId must identify a guild voice channel: ${voiceChannelId}`);
    }
    if (channel.guildId !== guildId) throw new Error("割り当て先VCが設定済みGuildに属していません");
    if (this.txEnabled) this.stopTx();
    // Emit leaves with the old identity before changing the configured VC.
    this.releaseAllUsers(true);
    this.profile.voiceChannelId = voiceChannelId;
    this.voiceChannelName = channel.name;
    this.voiceState = "connecting";
    this.message = null;
    this.sendBotMeta();
    this.sendStatus();
    if (!this.connection) {
      await this.joinConfiguredChannel();
      return;
    }
    const accepted = this.connection.rejoin({ channelId: voiceChannelId, ...this.voiceFlags() });
    if (!accepted) throw new Error("Discord Voice connectionがVC移動を受け付けませんでした");
    await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    this.voiceState = "ready";
    this.sendBotMeta();
    this.sendStatus();
  }

  private wireClientEvents(): void {
    this.client.once(Events.ClientReady, (readyClient) => {
      this.botId = readyClient.user.id;
      this.ignoredUserIds.add(this.botId);
      this.gatewayState = "ready";
      this.sendBotMeta();
      this.sendStatus();
      this.#heartbeat = setInterval(() => this.sendStatus(DiscordFrameType.PING), HEARTBEAT_MS);
      this.#heartbeat.unref();
      void this.joinConfiguredChannel().catch((error) => {
        this.fail("join-failed", error);
        this.scheduleReconnect();
      });
    });
    this.client.on(Events.ShardReconnecting, () => {
      if (this.#closed) return;
      this.gatewayState = "reconnecting";
      this.stopTx();
      this.sendStatus();
    });
    this.client.on(Events.ShardResume, () => {
      if (this.#closed) return;
      this.gatewayState = "ready";
      this.sendStatus();
    });
    this.client.on(Events.ShardDisconnect, () => {
      if (this.#closed) return;
      this.gatewayState = "disconnected";
      this.stopTx();
      this.sendStatus();
    });
    this.client.on(Events.VoiceStateUpdate, (before, after) => {
      if (before.channelId === this.profile.voiceChannelId && after.channelId !== this.profile.voiceChannelId && before.id !== this.botId) {
        this.releaseUser(before.id, true);
      }
      if (before.channelId !== this.profile.voiceChannelId && after.channelId === this.profile.voiceChannelId) {
        this.announceUser(after.id);
      }
    });
    this.client.on(Events.Error, (error) => this.fail("gateway-error", error));
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.txEnabled) this.failTx("tx-ended", new Error("TX audio resource ended"));
    });
    this.player.on("error", (error) => {
      if (error.resource === this.#txResource) this.failTx("tx-player-failed", error);
    });
  }

  private displayName(userId: string): string {
    const guild = this.client.guilds.cache.get(this.profile.guildId);
    const member = guild?.members.cache.get(userId);
    return member?.displayName ?? this.client.users.cache.get(userId)?.displayName ?? `Discord ${userId}`;
  }

  /** Establishes a VC membership before the user speaks. Audio subscription remains speaking-driven. */
  private announceUser(userId: string, displayName = this.displayName(userId)): void {
    if (this.voiceState !== "ready" || !isRxCapableRole(this.profile.role) || this.ignoredUserIds.has(userId) || userId === this.botId) return;
    if (this.sourceGenerations.has(userId)) return;
    const sourceGeneration = this.allocateSourceGeneration();
    this.sourceGenerations.set(userId, sourceGeneration);
    this.ipc.send({
      type: DiscordFrameType.USER_META,
      ...this.identity(userId),
      sourceGeneration,
      payload: Buffer.from(displayName, "utf8"),
    });
  }

  private announceVoiceChannelMembers(channel: VoiceBasedChannel): void {
    const announced = new Set<string>();
    for (const [userId, member] of channel.members) {
      announced.add(userId);
      this.announceUser(userId, member.displayName);
    }
    // channel.members omits initial voice states whose GuildMember is not cached.
    // Those users are already in the VC but may be silent, so use voice state as
    // the membership authority and fetch only the missing display name.
    for (const [userId, state] of channel.guild.voiceStates.cache) {
      if (state.channelId !== channel.id || announced.has(userId)) continue;
      const announceIfStillPresent = (displayName?: string) => {
        if (channel.guild.voiceStates.cache.get(userId)?.channelId !== channel.id) return;
        this.announceUser(userId, displayName);
      };
      void channel.guild.members.fetch(userId)
        .then((member) => announceIfStillPresent(member.displayName))
        .catch(() => announceIfStillPresent());
    }
  }

  private subscribeUser = (userId: string): void => {
    if (!this.connection || this.ignoredUserIds.has(userId) || userId === this.botId || this.streams.has(userId)) return;
    const pendingRetry = this.receiveRetryTimers.get(userId);
    if (pendingRetry) clearTimeout(pendingRetry);
    this.receiveRetryTimers.delete(userId);
    this.announceUser(userId);
    const sourceGeneration = this.sourceGenerations.get(userId);
    if (sourceGeneration === undefined) return;
    const stream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 250 },
    });
    this.streams.set(userId, stream);
    stream.on("data", (packet: Buffer) => {
      if (this.streams.get(userId) !== stream || this.sourceGenerations.get(userId) !== sourceGeneration) return;
      if (!packet.equals(DISCORD_SILENCE_FRAME)) this.receiveRetryCounts.delete(userId);
      const sequence = ((this.sequences.get(userId) ?? 0) + 1) >>> 0;
      const rtpTimestamp = ((this.timestamps.get(userId) ?? 0) + 960) >>> 0;
      this.sequences.set(userId, sequence);
      this.timestamps.set(userId, rtpTimestamp);
      this.lastAudioAt = Date.now();
      this.ipc.send({
        type: DiscordFrameType.OPUS,
        ...this.identity(userId),
        sourceGeneration,
        sequence,
        rtpTimestamp,
        payload: packet,
      });
    });
    stream.once("end", () => {
      if (this.streams.get(userId) === stream && this.sourceGenerations.get(userId) === sourceGeneration) {
        this.streams.delete(userId);
      }
    });
    stream.once("error", (error) => {
      if (this.streams.get(userId) !== stream || this.sourceGenerations.get(userId) !== sourceGeneration) return;
      this.streams.delete(userId);
      const retries = (this.receiveRetryCounts.get(userId) ?? 0) + 1;
      this.receiveRetryCounts.set(userId, retries);
      const delay = Math.min(200 * retries, 3_000);
      if (retries === 1 || retries % 20 === 0) {
        console.error(`[${this.profile.profileId}] Opus receive stream failed for ${userId}: ${error.message}; retrying in ${delay}ms (attempt ${retries})`);
      }
      const connection = this.connection;
      const timer = setTimeout(() => {
        if (this.receiveRetryTimers.get(userId) !== timer) return;
        this.receiveRetryTimers.delete(userId);
        if (this.connection !== connection || this.sourceGenerations.get(userId) !== sourceGeneration || this.streams.has(userId)) return;
        this.subscribeUser(userId);
      }, delay);
      timer.unref();
      this.receiveRetryTimers.set(userId, timer);
    });
  };

  private allocateSourceGeneration(): number {
    const generation = this.#nextSourceGeneration;
    this.#nextSourceGeneration = (this.#nextSourceGeneration + 1) >>> 0;
    if (this.#nextSourceGeneration === 0) this.#nextSourceGeneration = 1;
    return generation;
  }

  private releaseUser(userId: string, notifyCore: boolean): void {
    const generation = this.sourceGenerations.get(userId);
    if (generation === undefined) return;
    const stream = this.streams.get(userId);
    this.streams.delete(userId);
    this.sequences.delete(userId);
    this.timestamps.delete(userId);
    this.receiveRetryCounts.delete(userId);
    const retryTimer = this.receiveRetryTimers.get(userId);
    if (retryTimer) clearTimeout(retryTimer);
    this.receiveRetryTimers.delete(userId);
    this.sourceGenerations.delete(userId);
    stream?.destroy();
    if (notifyCore) this.ipc.send({ type: DiscordFrameType.USER_LEFT, ...this.identity(userId), sourceGeneration: generation });
  }

  private releaseAllUsers(notifyCore: boolean): void {
    for (const userId of [...this.sourceGenerations.keys()]) this.releaseUser(userId, notifyCore);
  }

  private async joinConfiguredChannel(): Promise<void> {
    const guild = this.client.guilds.cache.get(this.profile.guildId) ?? await this.client.guilds.fetch(this.profile.guildId);
    this.guildName = guild.name;
    let channel = guild.channels.cache.get(this.profile.voiceChannelId) ?? null;
    if (!channel) channel = (await guild.channels.fetch()).get(this.profile.voiceChannelId) ?? null;
    const availableVoiceChannels = [...guild.channels.cache.values()]
      .filter((candidate) => candidate.type === ChannelType.GuildVoice)
      .map((candidate) => ({ id: candidate.id, name: candidate.name }));
    this.ipc.send({
      type: DiscordFrameType.VOICE_CHANNELS,
      ...this.identity(),
      payload: Buffer.from(JSON.stringify(availableVoiceChannels), "utf8"),
    });
    if (!channel || !channel.isVoiceBased() || channel.type === ChannelType.GuildStageVoice) {
      throw new Error(`voiceChannelId must identify a guild voice channel: ${this.profile.voiceChannelId}`);
    }
    if (channel.guildId !== this.profile.guildId) throw new Error("configured voice channel does not belong to guildId");
    const voiceChannel = channel as VoiceBasedChannel;
    this.voiceChannelName = voiceChannel.name;
    this.voiceState = "connecting";
    this.sendBotMeta();
    this.sendStatus();
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: this.profile.guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      ...this.voiceFlags(),
      daveEncryption: true,
      group: this.profile.profileId,
    });
    if (isTxCapableRole(this.profile.role)) this.connection.subscribe(this.player);
    if (isRxCapableRole(this.profile.role)) this.connection.receiver.speaking.on("start", this.subscribeUser);
    this.connection.on("error", (error) => this.fail("voice-error", error));
    this.connection.on(VoiceConnectionStatus.Disconnected, () => this.handleVoiceDisconnected());
    this.connection.on(VoiceConnectionStatus.Connecting, () => {
      this.stopTx();
      this.voiceState = "connecting";
      this.sendStatus();
    });
    this.connection.on(VoiceConnectionStatus.Signalling, () => {
      this.stopTx();
      this.voiceState = "signalling";
      this.sendStatus();
    });
    this.connection.on(VoiceConnectionStatus.Ready, () => {
      this.voiceState = "ready";
      this.message = null;
      if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
      this.sendStatus();
      this.announceVoiceChannelMembers(voiceChannel);
    });
    await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    console.log(`[${this.profile.profileId}] Discord ${this.profile.role} ready: ${voiceChannel.guild.name} / ${voiceChannel.name}`);
  }

  private handleVoiceDisconnected(): void {
    this.releaseAllUsers(true);
    // A reconnect must never resume a previous TX request or replay queued PCM.
    this.stopTx();
    this.voiceState = "disconnected";
    this.sendStatus();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer || !this.connection) return;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** Math.min(this.reconnectCount, 5));
    this.voiceState = "reconnecting";
    this.reconnectCount += 1;
    this.message = `same VC reconnect in ${delay} ms`;
    this.sendStatus();
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#closed || !this.connection) return;
      const accepted = this.connection.rejoin({
        channelId: this.profile.voiceChannelId,
        ...this.voiceFlags(),
      });
      if (!accepted) this.scheduleReconnect();
    }, delay);
    this.#reconnectTimer.unref();
  }

  private voiceFlags(): { selfDeaf: boolean; selfMute: boolean } {
    return {
      selfDeaf: this.profile.role === "TX",
      selfMute: !isTxCapableRole(this.profile.role),
    };
  }

  private fail(state: string, error: unknown): void {
    this.stopTx();
    this.message = error instanceof Error ? error.message : String(error);
    if (state.startsWith("gateway")) this.gatewayState = "fault";
    else this.voiceState = "fault";
    this.sendStatus();
    console.error(`[${this.profile.profileId}] ${state}: ${this.message}`);
  }
}

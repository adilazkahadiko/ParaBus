import type {
  CommandResult,
  ControlCommand,
  LogLevel,
  OnAirState,
  RouterSnapshot,
  SceneChange,
  SceneParameterSnapshot,
  SceneSnapshot,
  SceneValue,
} from "../../../packages/shared-types/src/index.ts";
import { MAX_DISCORD_RX_CHANNELS } from "../../../packages/shared-types/src/index.ts";
import { clamp } from "./dsp.ts";
import { AudioEngine, VcBus } from "./audio-engine.ts";
import type { AudioOutputManager } from "./audio-output.ts";
import type { AudioInputManager } from "./audio-input.ts";
import type { RecorderManager } from "./recorder.ts";
import { isRecorderSelection } from "./recorder.ts";
import type { UserSessionRegistry } from "./user-session-registry.ts";
import { StaleSafetyStateError } from "./stale-state.ts";
import { sanitizeOperatorMessage } from "./operator-sanitize.ts";
import type { TabletSnapshotSource } from "./tablet-server.ts";
import type { OperationalEvent } from "./operational-log.ts";
import { AUDIO_FAULT_CLASSIFICATIONS, audioFaultMessage, localAudioFaultDetail } from "./audio-fault-diagnostics.ts";

const STRUCTURAL_COMMANDS = new Set(["SET_LIMITER", "SELECT_OUTPUT_DEVICE", "SELECT_CUE_OUTPUT_DEVICE", "SELECT_INPUT_DEVICE", "SET_DIRECT_OUTPUT", "CLEAR_DIRECT_OUTPUT", "SET_BUS_OUTPUT", "CLEAR_BUS_OUTPUT", "SET_MONITOR_OUTPUT", "SET_BUS_BINDING", "SET_OUTPUT_TEST_TONE", "CREATE_VC_BUS", "REMOVE_VC_BUS", "SET_NEW_PARTICIPANT_POLICY", "SET_USER_STRIP_ORDER", "RESET_USER_STRIP_ORDER", "DELETE_SCENE", "CLEAR_EVENT_LOG", "SET_TX_SOURCE", "ASSIGN_TX_VOICE_CHANNEL", "CONNECT_DISCORD_BOT", "SET_RECALL_SAFE"]);
const POLICIES = new Set(["SAFE", "HOLD", "PRESET"]);
const STATES = new Set(["SETUP", "READY", "ON_AIR", "FAULT"]);
const TAPS = new Set(["PRE", "POST"]);
const BUS_OUTPUT_MODES = new Set(["MONO", "DUAL_MONO"]);
const MAX_DEVICE_ID_BYTES = 8_192;
const MAX_SCENE_PARAMETER_BYTES = 4_096;
STRUCTURAL_COMMANDS.add("SET_GROUP_BUS_SOURCES");
const busIds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 32 && value.every(id => typeof id === "string" && id.length > 0 && id.length <= 256) && new Set(value).size === value.length;

type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const isUtf8String = (value: unknown, maxBytes: number): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const finite = (value: unknown, min: number, max: number): boolean => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const integer = (value: unknown, min: number, max = 64): boolean => Number.isInteger(value) && finite(value, min, max);
const safetyVersion = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const optional = (record: UnknownRecord, key: string, check: (value: unknown) => boolean): boolean => record[key] === undefined || check(record[key]);

/** The control plane is the trust boundary for HTTP, WS, Tablet, and in-process callers. */
function validateCommand(command: unknown): command is ControlCommand {
  if (!isRecord(command) || !isString(command.type, 64)) return false;
  const type = command.type;
  const id = (key: string) => isString(command[key]);
  const confirmed = () => optional(command, "confirmed", isBoolean);
  switch (type) {
    case "SET_STATE": return STATES.has(command.state as string) && confirmed();
    case "SET_CHANNEL_FADER": return id("channelId") && finite(command.db, -90, 12);
    case "SET_CHANNEL_MUTE": return id("channelId") && isBoolean(command.mute);
    case "SET_USER_CHANNEL_COLOR": return id("channelId") && typeof command.color === "string" && /^#[0-9a-f]{6}$/i.test(command.color);
    case "SET_USER_STRIP_ORDER": return Array.isArray(command.discordUserIds) && command.discordUserIds.length <= MAX_DISCORD_RX_CHANNELS && new Set(command.discordUserIds).size === command.discordUserIds.length && command.discordUserIds.every((value) => typeof value === "string" && /^\d{17,20}$/.test(value));
    case "RESET_USER_STRIP_ORDER": return true;
    case "SET_PARTICIPANT_APPROVAL": return id("channelId") && /^\d{17,20}$/.test(String(command.discordUserId)) && isBoolean(command.approved) && safetyVersion(command.expectedSessionGeneration, 1) && safetyVersion(command.expectedApprovalRevision, 1);
    case "SET_USER_TRUSTED": return id("channelId") && isBoolean(command.trusted) && confirmed();
    case "SET_RECEIVER_OWNER": return /^\d{17,20}$/.test(String(command.guildId)) && /^\d{17,20}$/.test(String(command.voiceChannelId)) && /^[A-Za-z0-9_-]{1,32}$/.test(String(command.profileId)) && (command.expectedCurrentOwner === null || /^[A-Za-z0-9_-]{1,32}$/.test(String(command.expectedCurrentOwner))) && safetyVersion(command.expectedReceiverGeneration) && confirmed();
    case "SET_VC_SEND": return id("channelId") && id("busId") && optional(command, "db", (v) => finite(v, -90, 12)) && optional(command, "mute", isBoolean) && (command.db !== undefined || command.mute !== undefined);
    case "SET_BUS_MASTER": return id("busId") && finite(command.db, -90, 12);
    case "SET_BUS_MUTE": return id("busId") && isBoolean(command.mute);
    case "SET_BUS_OUTPUT": return id("busId") && integer(command.output, 0) && optional(command, "mode", (value) => BUS_OUTPUT_MODES.has(value as string)) && confirmed() && optional(command, "allowCollision", isBoolean);
    case "CLEAR_BUS_OUTPUT": return id("busId");
    case "SET_BUS_BINDING": return id("busId") && /^\d{17,20}$/.test(String(command.guildId)) && /^\d{17,20}$/.test(String(command.voiceChannelId));
    case "CREATE_VC_BUS": return isString(command.name, 80) && optional(command, "policy", (v) => POLICIES.has(v as string)) && optional(command, "defaultSendDb", (v) => finite(v, -60, 0)) && optional(command, "groupSourceIds", busIds);
    case "SET_GROUP_BUS_SOURCES": return id("busId") && busIds(command.sourceBusIds);
    case "REMOVE_VC_BUS": case "RESET_LOUDNESS": return id("busId") && confirmed();
    case "SET_NEW_PARTICIPANT_POLICY": return id("busId") && POLICIES.has(command.policy as string) && optional(command, "defaultSendDb", (v) => finite(v, -60, 0));
    case "SET_BUS_COMPRESSOR": return id("busId") && optional(command, "enabled", isBoolean) && optional(command, "thresholdDb", (v) => finite(v, -60, 0)) && optional(command, "ratio", (v) => finite(v, 1, 20)) && optional(command, "attackMs", (v) => finite(v, 0.1, 200)) && optional(command, "releaseMs", (v) => finite(v, 10, 2_000)) && optional(command, "makeupDb", (v) => finite(v, -12, 24)) && ["enabled", "thresholdDb", "ratio", "attackMs", "releaseMs", "makeupDb"].some((key) => command[key] !== undefined);
    case "SELECT_OUTPUT_DEVICE": case "SELECT_CUE_OUTPUT_DEVICE": return isUtf8String(command.deviceId, MAX_DEVICE_ID_BYTES) && optional(command, "windowsEndpointId", (value) => isUtf8String(value, MAX_DEVICE_ID_BYTES));
    case "REFRESH_OUTPUT_DEVICES": case "REFRESH_CUE_OUTPUT_DEVICES": case "REFRESH_INPUT_DEVICES": case "CLEAR_EVENT_LOG": case "STOP_RECORDING": return confirmed();
    case "SELECT_INPUT_DEVICE": return isUtf8String(command.deviceId, MAX_DEVICE_ID_BYTES) && integer(command.channelCount, 1) && optional(command, "windowsEndpointId", (value) => isUtf8String(value, MAX_DEVICE_ID_BYTES));
    case "SET_DIRECT_OUTPUT": return id("channelId") && integer(command.output, 0) && TAPS.has(command.tap as string) && optional(command, "gainDb", (v) => finite(v, -90, 12)) && optional(command, "mute", isBoolean) && confirmed() && optional(command, "allowCollision", isBoolean);
    case "CLEAR_DIRECT_OUTPUT": return id("channelId");
    case "SET_OUTPUT_TEST_TONE": return integer(command.output, 0) && isBoolean(command.active);
    case "SET_LIMITER": return id("busId") && isBoolean(command.enabled);
    case "SET_PFL": return command.sourceId === null || isString(command.sourceId);
    case "SET_MONITOR_OUTPUT": return command.output === null || (integer(command.output, 0) && optional(command, "mode", (value) => BUS_OUTPUT_MODES.has(value as string)));
    case "EMERGENCY_MUTE": return isBoolean(command.active) && confirmed() && (command.active === true || safetyVersion(command.expectedEmergencyEpoch, 1));
    case "SAVE_SCENE": return isString(command.name, 80) && optional(command, "sceneId", isString) && confirmed();
    case "PREVIEW_SCENE": return id("sceneId");
    case "RECALL_SCENE": case "DELETE_SCENE": return id("sceneId") && confirmed();
    case "SET_RECALL_SAFE": return isUtf8String(command.parameter, MAX_SCENE_PARAMETER_BYTES) && isBoolean(command.safe);
    case "SET_TX_SOURCE": return integer(command.output, 0) && optional(command, "profileId", isString);
    case "SET_TX_INPUT": return isString(command.profileId) && (command.channelId === null || isString(command.channelId));
    case "SET_TX_MASTER": return isString(command.profileId) && finite(command.db, -90, 12);
    case "ASSIGN_TX_VOICE_CHANNEL": return id("profileId") && id("voiceChannelId") && confirmed();
    case "CONNECT_DISCORD_BOT": return id("profileId");
    case "DISCONNECT_DISCORD_BOT": return id("profileId") && confirmed();
    case "START_TX": case "STOP_TX": return optional(command, "profileId", isString) && confirmed();
    case "SET_TX_TARGETS": return Array.isArray(command.ids) && command.ids.length <= 22 && new Set(command.ids).size === command.ids.length && command.ids.every((value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value)) && safetyVersion(command.expectedRevision, 1);
    case "START_ARMED": return confirmed() && optional(command, "expectedRevision", (value) => safetyVersion(value, 1));
    case "CLEAR_ALL": return true;
    case "START_RECORDING": return integer(command.matrixOutput, 0) && isBoolean(command.includeUsers) && isBoolean(command.includeBuses) && optional(command, "selection", isRecorderSelection) && confirmed();
    case "DEVICE_LOST": case "INPUT_DEVICE_LOST": return isUtf8String(command.deviceId, MAX_DEVICE_ID_BYTES) && optional(command, "fault", value => isRecord(value) && AUDIO_FAULT_CLASSIFICATIONS.includes(value.classification as typeof AUDIO_FAULT_CLASSIFICATIONS[number]) && (value.hostApi === null || isString(value.hostApi, 128)) && typeof value.reason === "string");
    case "ACKNOWLEDGE_FAULT": return isBoolean(command.confirmed);
    default: return false;
  }
}

export interface DiscordTxController {
  readonly txTargetsRevision?: number;
  connectBot(profileId: string): void;
  disconnectBot(profileId: string): void;
  setTxSource(output: number, profileId?: string): void;
  setTxInput?(channelId: string | null, profileId: string): void;
  setTxMaster?(db: number, profileId: string): void;
  txMeters?(): Array<{ profileId: string | null; active: boolean; state: string; peak: number; masterDb?: number }>;
  assignTxVoiceChannel(profileId: string, voiceChannelId: string): void;
  startTx(profileId?: string): void;
  stopTx(profileId?: string): void;
  stopAllTx(): void;
  setTxTargets?(ids: string[]): void;
  startArmed?(confirmed?: boolean): void;
  isAllTeamsArmed?(): boolean;
  requiresTxStartConfirmation?(): boolean;
  clearAllTx?(): void;
  emergencyStopAndFlushTx?(): void;
  setReceiverOwner?(guildId: string, voiceChannelId: string, profileId: string, options: { recoveryOnly?: boolean; expectedCurrentOwner: string | null; expectedReceiverGeneration: number }): { previousProfileId: string | null; profileId: string; voiceChannelName: string; previousGeneration?: number; generation?: number };
}

export class ControlPlane {
  readonly engine: AudioEngine;
  readonly outputManager?: AudioOutputManager;
  readonly cueOutputManager?: AudioOutputManager;
  readonly txController?: DiscordTxController;
  readonly inputManager?: AudioInputManager;
  readonly recorder?: RecorderManager;
  readonly userSessions?: UserSessionRegistry;
  readonly eventSink?: (event: OperationalEvent) => void;
  state: OnAirState = "SETUP";
  revision = 1;
  emergencyEpoch = 0;
  readonly alerts: Array<{ level: LogLevel; message: string; at: string }> = [];
  readonly scenes = new Map<string, SceneSnapshot>();
  currentSceneId: string | null = null;
  readonly recallSafe = new Set<string>();

  constructor(engine: AudioEngine, outputManager?: AudioOutputManager, txController?: DiscordTxController, inputManager?: AudioInputManager, recorder?: RecorderManager, userSessions?: UserSessionRegistry, eventSink?: (event: OperationalEvent) => void, cueOutputManager?: AudioOutputManager) {
    this.engine = engine;
    this.outputManager = outputManager;
    this.cueOutputManager = cueOutputManager;
    this.txController = txController;
    this.inputManager = inputManager;
    this.recorder = recorder;
    this.userSessions = userSessions;
    this.eventSink = eventSink;
    this.userSessions?.onJoin((channel, profile, event) => {
      for (const parameter of profile.recallSafe) this.recallSafe.add(`channel.${channel.id}.${parameter}`);
      if (event.kind === "REJOIN_RESTORED") {
        this.log("INFO", `rejoin restored: ${channel.label} (${channel.approvalGateOpen ? "APPROVED" : "PENDING"})`);
        return;
      }
      this.log("INFO", `user joined: ${channel.label}`);
      if (event.automaticApproval) this.log("INFO", `approved: ${channel.label} (trusted auto-approve)`);
      else this.log("WARNING", `pending created: ${channel.label}`);
    });
    this.userSessions?.onLeave((channel) => {
      const prefix = `channel.${channel.id}.`;
      for (const parameter of this.recallSafe) if (parameter.startsWith(prefix)) this.recallSafe.delete(parameter);
      this.log("INFO", `user left: ${channel.label}`);
    });
    this.log("INFO", "Router core simulator started");
  }

  execute(command: ControlCommand): CommandResult {
    if (!validateCommand(command)) return this.denied("Invalid command");
    try {
      if (this.state === "ON_AIR" && STRUCTURAL_COMMANDS.has(command.type)) {
        return this.denied(`${command.type} is locked while ON AIR`);
      }
      switch (command.type) {
        case "SET_STATE":
          return this.setState(command.state, command.confirmed === true);
        case "SET_CHANNEL_FADER": {
          const channel = this.requireChannel(command.channelId);
          channel.faderDb = clamp(command.db, -90, 12);
          this.userSessions?.captureChannel(channel);
          this.log("INFO", `${channel.label} fader ${channel.faderDb.toFixed(1)} dB`);
          break;
        }
        case "SET_CHANNEL_MUTE": {
          const channel = this.requireChannel(command.channelId);
          channel.mute = command.mute;
          this.userSessions?.captureChannel(channel);
          this.log("INFO", `${channel.label} ${command.mute ? "muted" : "opened"}`);
          break;
        }
        case "SET_VC_SEND": {
          const channel = this.requireChannel(command.channelId);
          if (!this.engine.buses.has(command.busId)) throw new Error(`unknown bus: ${command.busId}`);
          if (this.requireBus(command.busId).groupSourceIds !== null) return this.denied("Group BusはVC MIXの後段です。参加者を直接Sendできません");
          const current = channel.vcSends.get(command.busId) ?? { gainDb: -12, mute: true };
          channel.vcSends.set(command.busId, {
            gainDb: command.db === undefined ? current.gainDb : clamp(command.db, -90, 12),
            mute: command.mute === undefined ? current.mute : command.mute,
          });
          this.userSessions?.captureChannel(channel);
          break;
        }
        case "SET_USER_CHANNEL_COLOR": {
          const channel = this.requireChannel(command.channelId);
          if (!channel.discordUserId) return this.denied("Channel has no persistent Discord User identity");
          this.userSessions?.setChannelColor(channel, command.color);
          break;
        }
        case "SET_USER_STRIP_ORDER":
          if (!this.userSessions) return this.denied("Persistent User Profile store is unavailable");
          this.userSessions.setStripOrder(command.discordUserIds);
          break;
        case "RESET_USER_STRIP_ORDER":
          if (!this.userSessions) return this.denied("Persistent User Profile store is unavailable");
          this.userSessions.resetStripOrder();
          break;
        case "SET_PARTICIPANT_APPROVAL": {
          const channel = this.requireChannel(command.channelId);
          if (!channel.discordUserId || !this.userSessions) return this.denied("Channel has no current Discord User session");
          const changed = this.userSessions.setApproval(channel, command.discordUserId, command.expectedSessionGeneration, command.expectedApprovalRevision, command.approved);
          if (changed) this.log(command.approved ? "INFO" : "WARNING", `${command.approved ? "approved" : "approval revoked"}: ${channel.label}`);
          break;
        }
        case "SET_USER_TRUSTED": {
          const channel = this.requireChannel(command.channelId);
          if (!channel.discordUserId || !this.userSessions) return this.denied("Channel has no current Discord User session");
          if (command.trusted && !command.confirmed) return this.denied("Trusted enable requires confirmation", true);
          const changed = this.userSessions.setTrusted(channel, command.trusted);
          if (changed) this.log(command.trusted ? "WARNING" : "INFO", `trusted ${command.trusted ? "enabled" : "disabled"}: ${channel.label}`);
          break;
        }
        case "SET_RECEIVER_OWNER": {
          if (!command.confirmed) {
            if (this.state === "ON_AIR") this.log("WARNING", `ON AIR receiver switch rejected: ${command.profileId}; confirmation required`);
            return this.denied("Receiver切替には確認が必要です", true);
          }
          if (!this.txController?.setReceiverOwner) return this.denied("Discord Receiver backendがありません");
          if (this.state === "FAULT") return this.denied("FAULT中はReceiver Ownerを変更できません");
          try {
            this.txController.setReceiverOwner(command.guildId, command.voiceChannelId, command.profileId, {
              recoveryOnly: this.state === "ON_AIR",
              expectedCurrentOwner: command.expectedCurrentOwner,
              expectedReceiverGeneration: command.expectedReceiverGeneration,
            });
          } catch (error) {
            if (error instanceof StaleSafetyStateError) throw error;
            if (this.state === "ON_AIR") this.log("WARNING", `ON AIR receiver switch rejected: ${command.profileId}`);
            return this.denied(error instanceof Error ? error.message : String(error));
          }
          break;
        }
        case "SET_BUS_MASTER":
          this.requireBus(command.busId).masterDb = clamp(command.db, -90, 12);
          break;
        case "SET_BUS_MUTE":
          this.requireBus(command.busId).mute = command.mute;
          break;
        case "SET_BUS_OUTPUT": {
          const bus = this.requireBus(command.busId);
          const activeChannels = this.outputManager?.snapshot().activeChannelCount ?? this.engine.outputChannelCount;
          const mode = command.mode ?? "MONO";
          const outputs = mode === "DUAL_MONO" ? [command.output, command.output + 1] : [command.output];
          if (outputs.some((output) => output >= activeChannels)) throw new RangeError(`出力chは1〜${activeChannels}で指定してください`);
          const routes = [...this.engine.matrixRoutes.values()].filter((route) => route.sourceId === bus.id);
          const rightRouteId = `bus-output:${bus.id}:right`;
          const rightRoute = routes.find((route) => route.id === rightRouteId);
          const primaryRoutes = routes.filter((route) => route.id !== rightRouteId);
          if (primaryRoutes.length > 1 || routes.length > 2) return this.denied("複数出力のBUSはAdvanced Matrixで変更してください");
          const primaryRoute = primaryRoutes[0];
          const excludedRouteIds = [primaryRoute?.id, rightRoute?.id].filter((id): id is string => Boolean(id));
          const collisionsByOutput = outputs.map((output) => ({
            output,
            collisions: this.physicalOutputOccupants(output, undefined, excludedRouteIds),
          }));
          for (const entry of collisionsByOutput) {
            const collisionGuard = this.guardPhysicalOutputCollision(entry.output, entry.collisions, command.allowCollision === true, command.confirmed === true);
            if (collisionGuard) return collisionGuard;
          }
          if (primaryRoute) {
            this.engine.matrixRoutes.set(primaryRoute.id, { ...primaryRoute, output: command.output });
          } else {
            this.engine.addMatrixRoute({ id: `bus-output:${bus.id}`, sourceId: bus.id, output: command.output, gainDb: 0, mute: false, tap: "POST" });
          }
          if (mode === "DUAL_MONO") {
            this.engine.matrixRoutes.set(rightRouteId, { id: rightRouteId, sourceId: bus.id, output: command.output + 1, gainDb: 0, mute: false, tap: "POST" });
          } else if (rightRoute) {
            this.engine.matrixRoutes.delete(rightRouteId);
          }
          for (const entry of collisionsByOutput) if (entry.collisions.length) this.log("WARNING", `Intentional output collision confirmed: Output ${entry.output + 1}`);
          this.log("INFO", `${bus.label} → Output ${command.output + 1}${mode === "DUAL_MONO" ? `/${command.output + 2} (DUAL MONO)` : ""}`);
          break;
        }
        case "CLEAR_BUS_OUTPUT": {
          const bus = this.requireBus(command.busId);
          const routes = [...this.engine.matrixRoutes.values()].filter((route) => route.sourceId === bus.id);
          const rightRouteId = `bus-output:${bus.id}:right`;
          const primaryRoutes = routes.filter((route) => route.id !== rightRouteId);
          if (primaryRoutes.length > 1 || routes.length > 2) return this.denied("複数出力のBUSはAdvanced Matrixで変更してください");
          for (const route of routes) this.engine.matrixRoutes.delete(route.id);
          this.log("INFO", `${bus.label} physical output unassigned`);
          break;
        }
        case "SET_BUS_BINDING": {
          const bus = this.requireBus(command.busId);
          if (bus.groupSourceIds !== null) return this.denied("Group BusにDiscord VCを紐付けることはできません");
          const duplicate = [...this.engine.buses.values()].find((candidate) => candidate.id !== bus.id && candidate.linkedDiscordGuildId === command.guildId && candidate.linkedDiscordVoiceChannelId === command.voiceChannelId);
          if (duplicate) return this.denied(`Discord VC is already linked to ${duplicate.label}`);
          bus.linkedDiscordGuildId = command.guildId;
          bus.linkedDiscordVoiceChannelId = command.voiceChannelId;
          this.log("INFO", `${bus.label} Discord VC binding changed`);
          break;
        }
        case "CREATE_VC_BUS": {
          const name = command.name.trim().slice(0, 80);
          if (!name) throw new Error("VC Bus名を入力してください");
          const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "vc-bus";
          let id = base;
          let suffix = 2;
          while (this.engine.buses.has(id)) id = `${base.slice(0, 28)}-${suffix++}`;
          const bus = new VcBus(id, name, this.engine.blockSize, this.engine.sampleRate);
          bus.newParticipantPolicy = command.policy ?? "SAFE";
          bus.defaultSendDb = clamp(command.defaultSendDb ?? -12, -60, 0);
          if (command.groupSourceIds) {
            for (const sourceId of command.groupSourceIds) if (this.requireBus(sourceId).groupSourceIds !== null) return this.denied("Group BusをさらにGroup Busへ接続することはできません");
            bus.groupSourceIds = Object.freeze([...command.groupSourceIds]);
            bus.compressorEnabled = false;
          }
          this.engine.addBus(bus);
          this.log("INFO", `VC Bus ${name} created (${bus.newParticipantPolicy})`);
          this.revision += 1;
          return { ok: true, revision: this.revision, data: { busId: id } };
        }
        case "SET_GROUP_BUS_SOURCES": {
          if (this.requireBus(command.busId).groupSourceIds === null) return this.denied("Group Busを選択してください");
          this.engine.setGroupSources(command.busId, command.sourceBusIds);
          break;
        }
        case "REMOVE_VC_BUS":
          if (!command.confirmed) return this.denied("VC Bus削除には確認が必要です", true);
          if (this.engine.buses.size <= 1) return this.denied("最後のVC Busは削除できません");
          this.log("WARNING", `VC Bus ${this.requireBus(command.busId).label} removed`);
          this.engine.removeBus(command.busId);
          this.userSessions?.removeBus(command.busId);
          break;
        case "SET_NEW_PARTICIPANT_POLICY": {
          const bus = this.requireBus(command.busId);
          bus.newParticipantPolicy = command.policy;
          if (command.defaultSendDb !== undefined) bus.defaultSendDb = clamp(command.defaultSendDb, -60, 0);
          this.log("INFO", `${bus.label} new participant policy: ${bus.newParticipantPolicy}`);
          break;
        }
        case "SET_BUS_COMPRESSOR": {
          const bus = this.requireBus(command.busId);
          if (command.enabled !== undefined) bus.compressorEnabled = command.enabled;
          if (command.thresholdDb !== undefined) bus.compressor.thresholdDb = clamp(command.thresholdDb, -60, 0);
          if (command.ratio !== undefined) bus.compressor.ratio = clamp(command.ratio, 1, 20);
          if (command.attackMs !== undefined) bus.compressor.attackMs = clamp(command.attackMs, 0.1, 200);
          if (command.releaseMs !== undefined) bus.compressor.releaseMs = clamp(command.releaseMs, 10, 2_000);
          if (command.makeupDb !== undefined) bus.compressor.makeupDb = clamp(command.makeupDb, -12, 24);
          break;
        }
        case "SELECT_OUTPUT_DEVICE":
          if (this.state !== "SETUP") return this.denied("出力デバイスはSETUP中だけ変更できます");
          if (!this.outputManager) return this.denied("Audio Output backendがありません");
          if (this.cueOutputManager?.physicalReady() && this.cueOutputManager.snapshot().selectedDeviceId === command.deviceId) return this.denied("MainとCueに同じ物理デバイスは選べません");
          this.outputManager.selectDevice(command.deviceId, command.windowsEndpointId);
          if (this.engine.monitorOutput !== null && this.engine.monitorOutput + (this.engine.monitorOutputMode === "DUAL_MONO" ? 1 : 0) >= this.outputManager.snapshot().activeChannelCount) {
            this.engine.setMonitorSource(null);
            this.engine.setMonitorOutput(null);
            this.log("WARNING", "Monitor Out was unassigned because the selected device has fewer output channels");
          }
          this.log("INFO", `出力デバイス: ${this.outputManager.snapshot().selectedDeviceName}`);
          break;
        case "REFRESH_OUTPUT_DEVICES":
          this.outputManager?.refreshDevices();
          break;
        case "SELECT_CUE_OUTPUT_DEVICE": {
          if (this.state !== "SETUP") return this.denied("CueデバイスはSETUP中だけ変更できます");
          if (!this.cueOutputManager) return this.denied("Cue Output backendがありません");
          const device = this.cueOutputManager.snapshot().devices.find((candidate) => candidate.id === command.deviceId);
          if (device?.backend === "portaudio" && device.hostApi !== "Windows WASAPI") return this.denied("CueはWindows WASAPI出力だけ選択できます");
          if (this.outputManager?.physicalReady() && this.outputManager.snapshot().selectedDeviceId === command.deviceId) return this.denied("MainとCueに同じ物理デバイスは選べません");
          this.cueOutputManager.selectDevice(command.deviceId, command.windowsEndpointId);
          if (this.cueOutputManager.physicalReady() && this.engine.monitorOutput !== null) {
            this.engine.setMonitorOutput(null);
            this.log("INFO", "Monitor Out moved from Main device to independent Cue device");
          }
          this.log("INFO", `Cueデバイス: ${this.cueOutputManager.snapshot().selectedDeviceName}`);
          break;
        }
        case "REFRESH_CUE_OUTPUT_DEVICES":
          this.cueOutputManager?.refreshDevices();
          break;
        case "SELECT_INPUT_DEVICE":
          if (this.state !== "SETUP") return this.denied("入力デバイスはSETUP中だけ変更できます");
          if (this.txController?.txMeters?.().some((stem) => stem.active)) return this.denied("TX送信中は入力デバイスを変更できません。先に送信を停止してください");
          if (!this.inputManager) return this.denied("Audio Input backendがありません");
          this.inputManager.selectDevice(command.deviceId, command.channelCount, command.windowsEndpointId);
          this.log("INFO", `入力デバイス: ${this.inputManager.snapshot().selectedDeviceName} / ${this.inputManager.snapshot().activeChannelCount}ch`);
          break;
        case "REFRESH_INPUT_DEVICES":
          this.inputManager?.refreshDevices();
          break;
        case "SET_DIRECT_OUTPUT": {
          const channel = this.requireChannel(command.channelId);
          const activeChannels = this.outputManager?.snapshot().activeChannelCount ?? this.engine.outputChannelCount;
          if (!Number.isInteger(command.output) || command.output < 0 || command.output >= activeChannels) {
            throw new RangeError(`出力chは1〜${activeChannels}で指定してください`);
          }
          const collisions = this.physicalOutputOccupants(command.output, channel.id);
          const collisionGuard = this.guardPhysicalOutputCollision(command.output, collisions, command.allowCollision === true, command.confirmed === true);
          if (collisionGuard) return collisionGuard;
          channel.directOutput = {
            output: command.output,
            tap: command.tap,
            gainDb: clamp(command.gainDb ?? channel.directOutput?.gainDb ?? 0, -90, 12),
            mute: command.mute ?? channel.directOutput?.mute ?? false,
          };
          this.userSessions?.captureChannel(channel);
          if (collisions.length) this.log("WARNING", `Intentional output collision confirmed: Output ${command.output + 1}`);
          this.log("INFO", `${channel.label} → Output ${command.output + 1} (${command.tap})`);
          break;
        }
        case "CLEAR_DIRECT_OUTPUT": {
          const channel = this.requireChannel(command.channelId);
          channel.directOutput = undefined;
          this.userSessions?.captureChannel(channel);
          break;
        }
        case "SET_OUTPUT_TEST_TONE": {
          const activeChannels = this.outputManager?.snapshot().activeChannelCount ?? this.engine.outputChannelCount;
          if (!Number.isInteger(command.output) || command.output < 0 || command.output >= activeChannels) {
            throw new RangeError(`出力chは1〜${activeChannels}で指定してください`);
          }
          if (command.active) {
            this.engine.outputTestTones.clear();
            this.engine.outputTestTones.add(command.output);
          } else {
            this.engine.outputTestTones.delete(command.output);
          }
          break;
        }
        case "SET_LIMITER": {
          const bus = this.requireBus(command.busId);
          if (!command.enabled && this.state !== "SETUP") return this.denied("Limiter can only be disabled in SETUP");
          bus.limiter.enabled = command.enabled;
          this.log(command.enabled ? "INFO" : "WARNING", `${bus.label} limiter ${command.enabled ? "enabled" : "disabled"}`);
          break;
        }
        case "RESET_LOUDNESS": {
          const bus = this.requireBus(command.busId);
          bus.loudness.resetIntegrated();
          bus.loudnessValue = bus.loudness.snapshot();
          this.log("INFO", `${bus.label} integrated loudness reset`);
          break;
        }
        case "SET_PFL":
          this.engine.setMonitorSource(command.sourceId);
          break;
        case "SET_MONITOR_OUTPUT": {
          if (command.output === null) {
            this.engine.setMonitorSource(null);
            this.engine.setMonitorOutput(null);
            this.log("INFO", "Monitor Out unassigned");
            break;
          }
          if (this.cueOutputManager?.physicalReady()) return this.denied("独立Cueデバイス使用中はMain側Monitor Outを割り当てられません");
          const activeChannels = this.outputManager?.snapshot().activeChannelCount ?? this.engine.outputChannelCount;
          const mode = command.mode ?? "DUAL_MONO";
          const outputs = mode === "DUAL_MONO" ? [command.output, command.output + 1] : [command.output];
          if (outputs.some((output) => output >= activeChannels)) throw new RangeError(`Monitor Outは1〜${activeChannels}chで指定してください`);
          if (this.engine.monitorOutput === command.output && this.engine.monitorOutputMode === mode) break;
          for (const output of outputs) {
            const occupants = this.physicalOutputOccupants(output, undefined, [], true);
            if (occupants.length) return this.denied(`OUT ${output + 1} is already used by ${occupants.join(", ")}`);
          }
          this.engine.setMonitorOutput(command.output, mode);
          this.log("INFO", `Monitor Out → Output ${command.output + 1}${mode === "DUAL_MONO" ? `/${command.output + 2} (DUAL MONO)` : " (MONO)"}`);
          break;
        }
        case "EMERGENCY_MUTE":
          if (!command.active && !command.confirmed) {
            return { ok: false, revision: this.revision, confirmationRequired: true, error: "Confirmation is required to release emergency mute" };
          }
          if (!command.active) {
            if (this.state === "FAULT") return this.denied("Emergency mute cannot be released while FAULT is latched");
            if (this.state !== "READY") return this.denied("Emergency mute can only be released from READY after explicit recovery");
            if (this.outputManager && this.outputManager.snapshot().state !== "READY") return this.denied("Output device must be explicitly recovered before emergency mute release");
            if (this.inputManager?.snapshot().state === "FAULT") return this.denied("Input device must be explicitly recovered before emergency mute release");
            if (command.expectedEmergencyEpoch !== this.emergencyEpoch) {
              throw new StaleSafetyStateError("emergency-mute", { emergencyEpoch: command.expectedEmergencyEpoch }, { emergencyEpoch: this.emergencyEpoch });
            }
            this.engine.emergencyMuted = false;
          } else {
            const changed = this.engageEmergencyMute();
            if (!changed) return { ok: true, revision: this.revision, data: { emergencyEpoch: this.emergencyEpoch } };
          }
          this.log(command.active ? "CRITICAL" : "WARNING", `Emergency mute ${command.active ? "activated" : "released"}`);
          break;
        case "SAVE_SCENE": {
          const previous = command.sceneId ? this.scenes.get(command.sceneId) : undefined;
          if (command.sceneId && !previous) throw new Error("unknown scene: " + command.sceneId);
          if (previous && (this.state === "ON_AIR" || this.state === "FAULT")) return this.denied("Scene上書きはSETUPまたはREADYで行ってください");
          if (previous && !command.confirmed) return this.denied("Scene上書きには確認が必要です", true);
          const name = command.name.trim();
          if (!previous && [...this.scenes.values()].some((scene) => scene.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
            return this.denied("同名のSceneがあります。選択して上書きしてください");
          }
          const scene = this.captureScene(name, previous);
          this.scenes.set(scene.id, scene);
          this.currentSceneId = scene.id;
          this.log("INFO", `Scene ${scene.name} saved`);
          this.revision += 1;
          return { ok: true, revision: this.revision, data: scene };
        }
        case "PREVIEW_SCENE":
          return {
            ok: true,
            revision: this.revision,
            data: {
              kind: "scene-preview",
              sceneId: command.sceneId,
              changes: this.previewScene(command.sceneId),
              excludedParticipants: this.excludedSceneParticipants(command.sceneId),
            },
          };
        case "RECALL_SCENE":
          if (!command.confirmed) {
            return {
              ok: false,
              revision: this.revision,
              confirmationRequired: true,
              error: "Preview and confirmation are required before scene recall",
              data: {
                kind: "scene-preview",
                sceneId: command.sceneId,
                changes: this.previewScene(command.sceneId),
                excludedParticipants: this.excludedSceneParticipants(command.sceneId),
              },
            };
          }
          this.applyScene(command.sceneId);
          break;
        case "DELETE_SCENE": {
          const scene = this.scenes.get(command.sceneId);
          if (!scene) throw new Error(`unknown scene: ${command.sceneId}`);
          if (!command.confirmed) return this.denied("Scene削除には確認が必要です", true);
          this.scenes.delete(command.sceneId);
          if (this.currentSceneId === command.sceneId) this.currentSceneId = null;
          this.log("WARNING", `Scene ${scene.name} deleted`);
          break;
        }
        case "SET_RECALL_SAFE": {
          if (this.state === "ON_AIR" || this.state === "FAULT") return this.denied(`SET_RECALL_SAFE is locked while ${this.state.replace("_", " ")}`);
          const parameters = new Set(this.sceneParameters().map((item) => item.parameter));
          if (!parameters.has(command.parameter)) throw new Error("unknown scene parameter");
          command.safe ? this.recallSafe.add(command.parameter) : this.recallSafe.delete(command.parameter);
          const parts = command.parameter.split(".");
          const channel = parts[0] === "channel" ? this.engine.channels.get(parts[1]) : undefined;
          if (channel?.discordUserId) this.userSessions?.setRecallSafe(channel, parts.slice(2).join("."), command.safe);
          this.log("INFO", `${this.parameterLabel(command.parameter)} Recall Safe ${command.safe ? "ON" : "OFF"}`);
          break;
        }
        case "CLEAR_EVENT_LOG":
          if (!command.confirmed) return this.denied("Event Log消去には確認が必要です", true);
          this.alerts.splice(0);
          this.log("WARNING", "Event Log cleared by operator");
          break;
        case "SET_TX_SOURCE":
          if (!this.txController) return this.denied("Discord TX backendがありません");
          this.txController.setTxSource(command.output, command.profileId);
          this.log("INFO", `${command.profileId ?? "Discord TX"} source: Matrix OUT ${command.output + 1}`);
          break;
        case "SET_TX_MASTER":
          if (this.state === "FAULT") return this.denied("TX level is locked during FAULT");
          if (!this.txController?.setTxMaster) return this.denied("Discord TX level backendがありません");
          this.txController.setTxMaster(command.db, command.profileId);
          break;
        case "SET_TX_INPUT":
          if (["ON_AIR", "FAULT"].includes(this.state)) return this.denied("TX input routing is locked while ON AIR / FAULT");
          if (!this.txController?.setTxInput) return this.denied("Discord TX input backendがありません");
          this.txController.setTxInput(command.channelId, command.profileId);
          this.log("INFO", `${command.profileId} TX input ${command.channelId ?? "unassigned"}`);
          break;
        case "ASSIGN_TX_VOICE_CHANNEL":
          if (this.state === "ON_AIR" && !command.confirmed) return this.denied("ON AIR中のTX Bot VC移動には確認が必要です", true);
          if (!this.txController) return this.denied("Discord TX backendがありません");
          this.txController.assignTxVoiceChannel(command.profileId, command.voiceChannelId);
          this.log("WARNING", `${command.profileId} assigned to Discord VC ${command.voiceChannelId}`);
          break;
        case "CONNECT_DISCORD_BOT":
          if (!this.txController) return this.denied("Discord Adapter backendがありません");
          this.txController.connectBot(command.profileId);
          this.log("WARNING", `${command.profileId} connection requested by operator`);
          break;
        case "DISCONNECT_DISCORD_BOT":
          if (!command.confirmed) return this.denied("Discord Bot切断には確認が必要です", true);
          if (!this.txController) return this.denied("Discord Adapter backendがありません");
          this.txController.disconnectBot(command.profileId);
          this.log("WARNING", `${command.profileId} disconnected by operator`);
          break;
        case "SET_TX_TARGETS":
          if (!this.txController?.setTxTargets) return this.denied("Discord TX target backendがありません");
          if (command.expectedRevision !== this.txController.txTargetsRevision) throw new StaleSafetyStateError("TX targets", { revision: command.expectedRevision }, { revision: this.txController.txTargetsRevision ?? 0 });
          this.txController.setTxTargets(command.ids);
          this.log("INFO", `TX targets armed: ${command.ids.join(", ") || "none"}`);
          break;
        case "START_ARMED":
          if (this.engine.emergencyMuted || this.state === "FAULT") return this.denied("Discord TX cannot start while Emergency Mute or FAULT is active");
          if (!this.txController?.startArmed) return this.denied("Discord TX target backendがありません");
          if (command.expectedRevision !== undefined && command.expectedRevision !== this.txController.txTargetsRevision) throw new StaleSafetyStateError("TX targets", { revision: command.expectedRevision }, { revision: this.txController.txTargetsRevision ?? 0 });
          if ((this.txController.requiresTxStartConfirmation?.() ?? this.txController.isAllTeamsArmed?.()) && !command.confirmed) return this.denied("複数宛先 / ALL TEAMSの送信開始には確認が必要です", true);
          this.txController.startArmed(command.confirmed);
          this.log("WARNING", "Armed TX targets started by operator");
          break;
        case "CLEAR_ALL":
          if (!this.txController?.clearAllTx) return this.denied("Discord TX target backendがありません");
          this.txController.clearAllTx();
          this.log("WARNING", "All TX targets cleared and stopped");
          break;
        case "START_TX":
          if (!command.confirmed) return this.denied("Discord TX開始には確認が必要です", true);
          if (this.engine.emergencyMuted || this.state === "FAULT") return this.denied("Discord TX cannot start while Emergency Mute or FAULT is active");
          if (!this.txController) return this.denied("Discord TX backendがありません");
          this.txController.startTx(command.profileId);
          this.log("WARNING", `${command.profileId ?? "Discord TX"} started by operator`);
          break;
        case "STOP_TX":
          if (!command.confirmed) return this.denied("Discord TX停止には確認が必要です", true);
          if (!this.txController) return this.denied("Discord TX backendがありません");
          this.txController.stopTx(command.profileId);
          this.log("WARNING", `${command.profileId ?? "Discord TX"} stopped by operator`);
          break;
        case "START_RECORDING":
          if (!command.confirmed) return this.denied("録音開始には確認が必要です", true);
          if (!this.recorder) return this.denied("Recorder backendがありません");
          this.recorder.start({
            matrixOutput: command.matrixOutput,
            includeUsers: command.includeUsers,
            includeBuses: command.includeBuses,
            selection: command.selection,
          });
          this.log("WARNING", command.selection ? `Recorder started: ${this.recorder.tracks.length} selected tracks` : `Recorder started: Matrix OUT ${command.matrixOutput + 1}`);
          break;
        case "STOP_RECORDING":
          if (!command.confirmed) return this.denied("録音停止には確認が必要です", true);
          if (!this.recorder) return this.denied("Recorder backendがありません");
          this.recorder.stop();
          this.log("WARNING", "Recorder stopping");
          break;
        case "DEVICE_LOST":
          this.state = "FAULT";
          this.engageEmergencyMute(`Output device lost: ${command.deviceId}`);
          this.log("CRITICAL", audioFaultMessage("MAIN_OUTPUT", command.fault), command.fault?.reason);
          this.log("CRITICAL", "OUTPUT DEVICE LOST; output forced to silence");
          break;
        case "INPUT_DEVICE_LOST":
          this.state = "FAULT";
          this.inputManager?.failClosed(`Input device lost: ${command.deviceId}`);
          this.engageEmergencyMute();
          this.log("CRITICAL", audioFaultMessage("INPUT", command.fault), command.fault?.reason);
          this.log("CRITICAL", "INPUT DEVICE LOST; input buffers cleared and all outputs fail closed");
          break;
        case "ACKNOWLEDGE_FAULT":
          if (!command.confirmed) return this.denied("Fault acknowledgement requires confirmation", true);
          if (this.state !== "FAULT") return this.denied("Router is not in FAULT state");
          this.endParticipantSession();
          this.state = "SETUP";
          this.log("WARNING", "Fault acknowledged; select and validate the output device manually");
          break;
        default:
          return this.denied("Unknown command");
      }
      this.revision += 1;
      return { ok: true, revision: this.revision };
    } catch (error) {
      if (error instanceof StaleSafetyStateError) {
        const current = Object.entries(error.current).map(([key, value]) => `${key}=${value ?? "none"}`).join(" ");
        const target = command.type === "SET_RECEIVER_OWNER" ? `; target=${command.profileId}` : "";
        this.log("WARNING", `Stale safety command rejected: ${error.resource}; ${command.type}; current ${current}${target}`);
        return {
          ok: false,
          revision: this.revision,
          error: error.message,
          code: error.code,
          conflict: { resource: error.resource, expected: error.expected, current: error.current },
        };
      }
      return this.denied(error instanceof Error ? error.message : String(error));
    }
  }

  /** High-rate values only. Configuration is sent on changes and once/second. */
  meterSnapshot() {
    return {
      revision: this.revision, state: this.state, emergencyMuted: this.engine.emergencyMuted, emergencyEpoch: this.emergencyEpoch,
      monitorSourceId: this.engine.monitorSourceId, uptimeSeconds: (Date.now() - this.engine.startedAt) / 1000,
      callbackLoad: this.engine.callbackLoad, xruns: this.engine.xruns, topologyMutationFaults: this.engine.topologyMutationFaults,
      channels: [...this.engine.channels.values()].map(channel => ({ id: channel.id, faderDb: channel.faderDb, mute: channel.mute,
        meter: channel.outputMeter.snapshot(channel.id, channel.stale, channel.loudnessValue), inputMeter: channel.inputMeter.snapshot(`${channel.id}:input`, channel.stale) })),
      buses: [...this.engine.buses.values()].map(bus => ({ id: bus.id, masterDb: bus.masterDb, mute: bus.mute,
        meter: bus.meter.snapshot(bus.id, false, bus.loudnessValue), inputMeter: bus.inputMeter.snapshot(`${bus.id}:input`),
        limiterGainReductionDb: bus.limiter.gainReductionDb, compressorGainReductionDb: bus.compressor.gainReductionDb })),
      output: this.outputManager?.meters(), cueOutput: this.cueOutputManager?.meters(),
      txMeters: this.txController?.txMeters?.() ?? [],
    };
  }

  /** Direct Tablet input: no scenes' values, parameters, device inventories,
   * participant profiles, RX diagnostics or full Desktop snapshot allocation. */
  tabletSnapshot(): TabletSnapshotSource {
    return {
      revision: this.revision, state: this.state, emergencyMuted: this.engine.emergencyMuted,
      monitorSourceId: this.engine.monitorSourceId, sampleRate: this.engine.sampleRate,
      uptimeSeconds: (Date.now() - this.engine.startedAt) / 1000, callbackLoad: this.engine.callbackLoad,
      xruns: this.engine.xruns, topologyMutationFaults: this.engine.topologyMutationFaults,
      channels: [...this.engine.channels.values()].map(channel => ({
        id: channel.id, label: channel.label, kind: channel.kind, faderDb: channel.faderDb, mute: channel.mute,
        meter: channel.outputMeter.snapshot(channel.id, channel.stale, channel.loudnessValue), vcSends: Object.fromEntries(channel.vcSends),
      })),
      buses: [...this.engine.buses.values()].map(bus => ({
        id: bus.id, label: bus.label, masterDb: bus.masterDb, mute: bus.mute, limiterEnabled: bus.limiter.enabled,
        limiterGainReductionDb: bus.limiter.gainReductionDb, meter: bus.meter.snapshot(bus.id, false, bus.loudnessValue),
        inputMeter: bus.inputMeter.snapshot(`${bus.id}:input`), participantCount: [...this.engine.channels.values()].filter(channel => channel.vcSends.has(bus.id)).length,
      })),
      recorder: this.recorder?.snapshot(), alerts: this.alerts.slice(-100).reverse(),
      scenes: [...this.scenes.values()].map(scene => ({ id: scene.id, name: scene.name, createdAt: scene.createdAt })).reverse(),
    };
  }

  snapshot(includeHistory = true): RouterSnapshot {
    return {
      revision: this.revision,
      state: this.state,
      emergencyMuted: this.engine.emergencyMuted,
      emergencyEpoch: this.emergencyEpoch,
      monitorSourceId: this.engine.monitorSourceId,
      monitorOutput: this.engine.monitorOutput === null ? null : {
        leftOutput: this.engine.monitorOutput,
        rightOutput: this.engine.monitorOutputMode === "DUAL_MONO" ? this.engine.monitorOutput + 1 : null,
        mode: this.engine.monitorOutputMode,
      },
      sampleRate: this.engine.sampleRate,
      blockSize: this.engine.blockSize,
      uptimeSeconds: (Date.now() - this.engine.startedAt) / 1000,
      callbackLoad: this.engine.callbackLoad,
      xruns: this.engine.xruns,
      topologyMutationFaults: this.engine.topologyMutationFaults,
      channels: [...this.engine.channels.values()].map((channel) => ({
        id: channel.id,
        ...(channel.discordUserId ? { discordUserId: channel.discordUserId } : {}),
        ...(channel.currentVoiceChannelId ? { currentVoiceChannelId: channel.currentVoiceChannelId } : {}),
        ...(channel.channelColor ? { channelColor: channel.channelColor } : {}),
        ...(channel.preferredStripPosition !== undefined ? { preferredStripPosition: channel.preferredStripPosition } : {}),
        ...(channel.kind === "DiscordUser" ? { approvalGateOpen: channel.approvalGateOpen } : {}),
        label: channel.label,
        kind: channel.kind,
        trimDb: channel.trimDb,
        faderDb: channel.faderDb,
        mute: channel.mute,
        meter: channel.outputMeter.snapshot(channel.id, channel.stale, channel.loudnessValue),
        inputMeter: channel.inputMeter.snapshot(`${channel.id}:input`, channel.stale),
        vcSends: Object.fromEntries(channel.vcSends),
        directOutput: channel.directOutput ? { ...channel.directOutput } : undefined,
      })),
      buses: [...this.engine.buses.values()].map((bus) => ({
        id: bus.id,
        label: bus.label,
        groupSourceIds: bus.groupSourceIds ? [...bus.groupSourceIds] : null,
        ...(bus.linkedDiscordGuildId ? { linkedDiscordGuildId: bus.linkedDiscordGuildId } : {}),
        ...(bus.linkedDiscordVoiceChannelId ? { linkedDiscordVoiceChannelId: bus.linkedDiscordVoiceChannelId } : {}),
        format: bus.format,
        masterDb: bus.masterDb,
        mute: bus.mute,
        limiterEnabled: bus.limiter.enabled,
        limiterGainReductionDb: bus.limiter.gainReductionDb,
        meter: bus.meter.snapshot(bus.id, false, bus.loudnessValue),
        inputMeter: bus.inputMeter.snapshot(`${bus.id}:input`),
        compressorEnabled: bus.compressorEnabled,
        compressorThresholdDb: bus.compressor.thresholdDb,
        compressorRatio: bus.compressor.ratio,
        compressorAttackMs: bus.compressor.attackMs,
        compressorReleaseMs: bus.compressor.releaseMs,
        compressorMakeupDb: bus.compressor.makeupDb,
        compressorGainReductionDb: bus.compressor.gainReductionDb,
        newParticipantPolicy: bus.newParticipantPolicy,
        defaultSendDb: bus.defaultSendDb,
        participantCount: [...this.engine.channels.values()].filter((channel) => channel.vcSends.has(bus.id)).length,
        autoCreated: bus.autoCreated,
        physicalOutputs: [...this.engine.matrixRoutes.values()]
          .filter((route) => route.sourceId === bus.id)
          .map((route) => ({ output: route.output, gainDb: route.gainDb, mute: route.mute }))
          .sort((left, right) => left.output - right.output),
      })),
      output: this.outputManager ? { ...this.outputManager.snapshot(includeHistory), testToneOutputs: [...this.engine.outputTestTones] } : undefined,
      cueOutput: this.cueOutputManager?.snapshot(includeHistory),
      input: this.inputManager?.snapshot(),
      recorder: this.recorder?.snapshot(),
      alerts: this.alerts.slice(-100).reverse(),
      scenes: [...this.scenes.values()].map((scene) => ({ ...scene, values: { ...scene.values } })).reverse(),
      currentSceneId: this.currentSceneId,
      recallSafe: [...this.recallSafe].sort(),
      sceneParameters: this.sceneParameters(),
    };
  }

  private setState(next: OnAirState, confirmed: boolean): CommandResult {
    if (next === "FAULT") return this.denied("FAULT is entered by a detected failure, not an operator command");
    if (this.state === "FAULT") return this.denied("Faultを確認してからACKNOWLEDGE FAULTを実行してください", true);
    if (next === "ON_AIR") {
      if (this.outputManager && this.outputManager.snapshot().state !== "READY") return this.denied("Output device must be explicitly selected and ready");
      if (this.inputManager?.snapshot().state === "FAULT") return this.denied("Input device fault must be explicitly recovered");
      if (this.outputManager && !this.outputManager.presenceMonitoringReady()) return this.denied("Windows output endpoint presence binding is required before ON AIR");
      if (this.inputManager && !this.inputManager.presenceMonitoringReady()) return this.denied("Windows input endpoint presence binding is required before ON AIR");
      const limiterOff = [...this.engine.buses.values()].some((bus) => !bus.limiter.enabled);
      if (limiterOff) return this.denied("All VC bus safety limiters must be enabled before ON AIR");
      if (!confirmed) return this.denied("Going ON AIR requires confirmation", true);
    }
    if (next === "READY") {
      if (this.outputManager && this.outputManager.snapshot().state !== "READY") return this.denied("Output device must be explicitly selected and ready");
      if (this.inputManager?.snapshot().state === "FAULT") return this.denied("Input device fault must be explicitly recovered");
      if (this.outputManager && !this.outputManager.presenceMonitoringReady()) return this.denied("Windows output endpoint presence binding is required before READY");
      if (this.inputManager && !this.inputManager.presenceMonitoringReady()) return this.denied("Windows input endpoint presence binding is required before READY");
    }
    if (this.state === "ON_AIR" && next !== "ON_AIR" && !confirmed) {
      return this.denied("ON AIR解除には確認が必要です", true);
    }
    this.state = next;
    this.log("INFO", `State changed to ${next}`);
    this.revision += 1;
    return { ok: true, revision: this.revision };
  }

  endParticipantSession(): number {
    const reset = this.userSessions?.resetSessionApprovals() ?? [];
    for (const participant of reset) this.log("WARNING", `session approval reset: ${participant.label}`);
    return reset.length;
  }

  recordExternalEvent(level: LogLevel, message: string): void {
    this.log(level, message);
  }

  private captureScene(name: string, previous?: SceneSnapshot): SceneSnapshot {
    return {
      id: previous?.id ?? crypto.randomUUID(),
      name: name.trim().slice(0, 80) || "Untitled",
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      values: this.captureSceneValues(),
    };
  }

  private captureSceneValues(): Record<string, SceneValue> {
    const values: Record<string, SceneValue> = {};
    let order = 0;
    for (const channel of this.engine.channels.values()) {
      values[`channel.${channel.id}.order`] = order++;
      values[`channel.${channel.id}.label`] = channel.label;
      values[`channel.${channel.id}.faderDb`] = channel.faderDb;
      values[`channel.${channel.id}.mute`] = channel.mute;
      values[`channel.${channel.id}.trimDb`] = channel.trimDb;
      for (const [busId, send] of channel.vcSends) {
        values[`channel.${channel.id}.send.${busId}.gainDb`] = send.gainDb;
        values[`channel.${channel.id}.send.${busId}.mute`] = send.mute;
      }
    }
    for (const bus of this.engine.buses.values()) {
      values[`bus.${bus.id}.label`] = bus.label;
      values[`bus.${bus.id}.masterDb`] = bus.masterDb;
      values[`bus.${bus.id}.mute`] = bus.mute;
      values[`bus.${bus.id}.compressorEnabled`] = bus.compressorEnabled;
      values[`bus.${bus.id}.compressorThresholdDb`] = bus.compressor.thresholdDb;
      values[`bus.${bus.id}.compressorRatio`] = bus.compressor.ratio;
      values[`bus.${bus.id}.compressorAttackMs`] = bus.compressor.attackMs;
      values[`bus.${bus.id}.compressorReleaseMs`] = bus.compressor.releaseMs;
      values[`bus.${bus.id}.compressorMakeupDb`] = bus.compressor.makeupDb;
      values[`bus.${bus.id}.limiterEnabled`] = bus.limiter.enabled;
      values[`bus.${bus.id}.limiterCeilingDb`] = bus.limiter.ceilingDb;
      values[`bus.${bus.id}.limiterReleaseMs`] = bus.limiter.releaseMs;
    }
    for (const route of this.engine.matrixRoutes.values()) {
      values[`matrix.${route.id}.gainDb`] = route.gainDb;
      values[`matrix.${route.id}.mute`] = route.mute;
    }
    return values;
  }

  private sceneParameters(): SceneParameterSnapshot[] {
    return Object.entries(this.captureSceneValues()).map(([parameter, value]) => ({
      parameter,
      label: this.parameterLabel(parameter),
      value,
    }));
  }

  private previewScene(sceneId: string): SceneChange[] {
    const scene = this.scenes.get(sceneId);
    if (!scene) throw new Error(`unknown scene: ${sceneId}`);
    const current = this.captureSceneValues();
    return Object.entries(scene.values)
      .filter(([parameter, value]) => current[parameter] !== value)
      .map(([parameter, value]) => ({
        parameter,
        label: this.parameterLabel(parameter),
        from: current[parameter],
        to: value,
        recallSafe: this.recallSafe.has(parameter),
        locked: this.sceneParameterLocked(parameter, value),
      }));
  }

  private excludedSceneParticipants(sceneId: string): string[] {
    const scene = this.scenes.get(sceneId);
    if (!scene) throw new Error("unknown scene: " + sceneId);
    return [...this.engine.channels.values()]
      .filter((channel) => channel.kind === "DiscordUser" && !Object.hasOwn(scene.values, "channel." + channel.id + ".faderDb"))
      .map((channel) => channel.label);
  }

  private applyScene(sceneId: string): void {
    if (this.state === "FAULT") throw new Error("FAULT中はSceneをRecallできません");
    const scene = this.scenes.get(sceneId);
    if (!scene) throw new Error(`unknown scene: ${sceneId}`);
    // Validate every still-live target before any mutation. Missing topology is
    // intentionally skipped as before; malformed values never partly apply.
    for (const [parameter, value] of Object.entries(scene.values)) {
      if (this.sceneTargetExists(parameter) && !this.validSceneValue(parameter, value)) {
        throw new Error("Scene contains an invalid parameter value");
      }
    }
    for (const [parameter, value] of Object.entries(scene.values)) {
      if (this.recallSafe.has(parameter) || this.sceneParameterLocked(parameter, value)) continue;
      const parts = parameter.split(".");
      if (parts[0] === "channel") {
        const channel = this.engine.channels.get(parts[1]);
        if (!channel) continue;
        if (parts[2] === "label") channel.label = String(value).slice(0, 80);
        if (parts[2] === "faderDb") channel.faderDb = Number(value);
        if (parts[2] === "mute") channel.mute = Boolean(value);
        if (parts[2] === "trimDb") channel.trimDb = Number(value);
        if (parts[2] === "send") {
          const send = channel.vcSends.get(parts[3]);
          if (send && parts[4] === "gainDb") send.gainDb = Number(value);
          if (send && parts[4] === "mute") send.mute = Boolean(value);
        }
      }
      if (parts[0] === "bus") {
        const bus = this.engine.buses.get(parts[1]);
        if (!bus) continue;
        if (parts[2] === "label") bus.label = String(value).slice(0, 80);
        if (parts[2] === "masterDb") bus.masterDb = Number(value);
        if (parts[2] === "mute") bus.mute = Boolean(value);
        if (parts[2] === "compressorEnabled") bus.compressorEnabled = Boolean(value);
        if (parts[2] === "compressorThresholdDb") bus.compressor.thresholdDb = Number(value);
        if (parts[2] === "compressorRatio") bus.compressor.ratio = Number(value);
        if (parts[2] === "compressorAttackMs") bus.compressor.attackMs = Number(value);
        if (parts[2] === "compressorReleaseMs") bus.compressor.releaseMs = Number(value);
        if (parts[2] === "compressorMakeupDb") bus.compressor.makeupDb = Number(value);
        if (parts[2] === "limiterEnabled") bus.limiter.enabled = Boolean(value);
        if (parts[2] === "limiterCeilingDb") bus.limiter.ceilingDb = Number(value);
        if (parts[2] === "limiterReleaseMs") bus.limiter.releaseMs = Number(value);
      }
      if (parts[0] === "matrix") {
        const route = this.engine.matrixRoutes.get(parts[1]);
        if (!route) continue;
        if (parts[2] === "gainDb") route.gainDb = Number(value);
        if (parts[2] === "mute") route.mute = Boolean(value);
      }
    }
    const currentOrder = new Map([...this.engine.channels.keys()].map((id, index) => [id, index]));
    const channelOrder = [...this.engine.channels.entries()].sort(([, a], [, b]) => {
      const aParameter = `channel.${a.id}.order`;
      const bParameter = `channel.${b.id}.order`;
      const preserveOrder = this.state === "ON_AIR" || this.state === "FAULT";
      const aOrder = preserveOrder || this.recallSafe.has(aParameter) ? currentOrder.get(a.id) : scene.values[aParameter];
      const bOrder = preserveOrder || this.recallSafe.has(bParameter) ? currentOrder.get(b.id) : scene.values[bParameter];
      return Number(aOrder ?? Number.MAX_SAFE_INTEGER) - Number(bOrder ?? Number.MAX_SAFE_INTEGER);
    });
    this.engine.setChannelOrder(channelOrder.map(([, channel]) => channel));
    for (const [, channel] of channelOrder) this.userSessions?.captureChannel(channel);
    this.currentSceneId = scene.id;
    this.log("INFO", `Scene ${scene.name} recalled`);
  }

  private sceneParameterLocked(parameter: string, value: SceneValue): boolean {
    if ((this.state === "ON_AIR" || this.state === "FAULT") && parameter.endsWith(".order")) return true;
    return this.state !== "SETUP" && parameter.endsWith(".limiterEnabled") && value === false;
  }

  private physicalOutputOccupants(output: number, excludedDirectChannelId?: string, excludedMatrixRouteIds: readonly string[] = [], excludeMonitor = false): string[] {
    const occupants: string[] = [];
    for (const channel of this.engine.channels.values()) {
      if (channel.id === excludedDirectChannelId || channel.directOutput?.output !== output) continue;
      occupants.push(`${channel.label} Direct Out`);
    }
    for (const route of this.engine.matrixRoutes.values()) {
      if (excludedMatrixRouteIds.includes(route.id) || route.output !== output) continue;
      const bus = this.engine.buses.get(route.sourceId);
      const channel = this.engine.channels.get(route.sourceId);
      occupants.push(bus ? `${bus.label} BUS` : channel ? `${channel.label} Matrix route` : `Matrix route ${route.id}`);
    }
    if (!excludeMonitor && this.engine.monitorOutput !== null && (output === this.engine.monitorOutput || (this.engine.monitorOutputMode === "DUAL_MONO" && output === this.engine.monitorOutput + 1))) occupants.push("Monitor Out");
    return occupants;
  }

  private guardPhysicalOutputCollision(output: number, occupants: readonly string[], allowCollision: boolean, confirmed: boolean): CommandResult | null {
    if (!occupants.length || (allowCollision && confirmed)) return null;
    return {
      ...this.denied(`OUT ${output + 1} is already used by ${occupants.join(", ")}`, true),
      data: { kind: "physical-output-collision", output, routes: [...occupants] },
    };
  }

  private sceneTargetExists(parameter: string): boolean {
    const parts = parameter.split(".");
    if (parts[0] === "channel") return this.engine.channels.has(parts[1]);
    if (parts[0] === "bus") return this.engine.buses.has(parts[1]);
    if (parts[0] === "matrix") return this.engine.matrixRoutes.has(parts[1]);
    return false;
  }

  private validSceneValue(parameter: string, value: SceneValue): boolean {
    const parts = parameter.split(".");
    const field = parts[0] === "channel" && parts[2] === "send" ? parts[4] : parts[2];
    if (field === "label") return typeof value === "string" && value.length <= 80;
    if (["mute", "compressorEnabled", "limiterEnabled"].includes(field)) return typeof value === "boolean";
    if (field === "order") return integer(value, 0, Number.MAX_SAFE_INTEGER);
    if (["faderDb", "trimDb", "gainDb", "masterDb"].includes(field)) return finite(value, -90, 12);
    if (field === "compressorThresholdDb") return finite(value, -60, 0);
    if (field === "compressorRatio") return finite(value, 1, 20);
    if (field === "compressorAttackMs") return finite(value, 0.1, 200);
    if (field === "compressorReleaseMs") return finite(value, 10, 2_000);
    if (field === "compressorMakeupDb") return finite(value, -12, 24);
    if (field === "limiterCeilingDb") return finite(value, -24, 0);
    if (field === "limiterReleaseMs") return finite(value, 10, 2_000);
    return false;
  }

  private parameterLabel(parameter: string): string {
    const parts = parameter.split(".");
    if (parts[0] === "channel") {
      const channel = this.engine.channels.get(parts[1]);
      const owner = channel?.label ?? parts[1];
      if (parts[2] === "send") {
        const bus = this.engine.buses.get(parts[3]);
        return `${owner} → ${bus?.label ?? parts[3]} ${parts[4] === "gainDb" ? "Send" : "Send Mute"}`;
      }
      const names: Record<string, string> = { order: "表示順", label: "表示名", faderDb: "Fader", mute: "Mute", trimDb: "Trim" };
      return `${owner} ${names[parts[2]] ?? parts[2]}`;
    }
    if (parts[0] === "bus") {
      const bus = this.engine.buses.get(parts[1]);
      const names: Record<string, string> = {
        label: "表示名", masterDb: "Master", mute: "Mute", compressorEnabled: "Compressor",
        compressorThresholdDb: "Comp Threshold", compressorRatio: "Comp Ratio", compressorAttackMs: "Comp Attack",
        compressorReleaseMs: "Comp Release", compressorMakeupDb: "Comp Makeup", limiterEnabled: "Limiter",
        limiterCeilingDb: "Limiter Ceiling", limiterReleaseMs: "Limiter Release",
      };
      return `${bus?.label ?? parts[1]} ${names[parts[2]] ?? parts[2]}`;
    }
    if (parts[0] === "matrix") return `Matrix ${parts[1]} ${parts[2] === "gainDb" ? "Gain" : "Mute"}`;
    return parameter;
  }

  private requireChannel(id: string) {
    const channel = this.engine.channels.get(id);
    if (!channel) throw new Error(`unknown channel: ${id}`);
    return channel;
  }

  private requireBus(id: string) {
    const bus = this.engine.buses.get(id);
    if (!bus) throw new Error(`unknown bus: ${id}`);
    return bus;
  }

  private denied(error: string, confirmationRequired = false): CommandResult {
    return { ok: false, revision: this.revision, error: sanitizeOperatorMessage(error), confirmationRequired };
  }

  private engageEmergencyMute(outputFault?: string): boolean {
    // Gate new blocks first, then synchronously discard every downstream queue.
    const changed = !this.engine.emergencyMuted;
    this.engine.emergencyMuted = true;
    if (changed) this.emergencyEpoch += 1;
    try {
      if (this.txController?.emergencyStopAndFlushTx) this.txController.emergencyStopAndFlushTx();
      else this.txController?.stopAllTx();
    } catch {
      try { this.txController?.stopAllTx(); } catch {}
    }
    try { this.recorder?.discardPendingAudio(); } catch {}
    try {
      if (outputFault) this.outputManager?.failClosed(outputFault);
      else this.outputManager?.emergencyStop();
    } catch {}
    try { this.cueOutputManager?.emergencyStop(); } catch {}
    return changed;
  }

  private log(level: LogLevel, message: string, localDetail?: string): void {
    const event = { level, message: sanitizeOperatorMessage(message, "Operator event"), at: new Date().toISOString() };
    this.alerts.push(event);
    if (this.alerts.length > 500) this.alerts.splice(0, this.alerts.length - 500);
    this.eventSink?.({ ...event, ...(localDetail ? { localDetail: localAudioFaultDetail(localDetail) } : {}) });
  }
}

export const SAMPLE_RATE = 48_000;
export const DEFAULT_BLOCK_SIZE = 480;
export const MAX_DISCORD_RX_CHANNELS = 112;
export const MAX_LOCAL_INPUT_CHANNELS = 8;
export const MAX_RX_CHANNELS = MAX_DISCORD_RX_CHANNELS + MAX_LOCAL_INPUT_CHANNELS;
export const MAX_OUTPUT_CHANNELS = 64;
export const TX_DESTINATIONS = Object.freeze([...Array.from({ length: 20 }, (_, i) => `TEAM_${String(i + 1).padStart(2, "0")}`), "INTERVIEW", "SPARE"]);
export function isTxDestination(value: unknown): value is string {
  return typeof value === "string" && TX_DESTINATIONS.includes(value);
}
export const MAX_VC_BUSES = 32;

export type OnAirState = "SETUP" | "READY" | "ON_AIR" | "FAULT";
export type TapPoint = "PRE" | "POST";
export type SourceKind = "DiscordUser" | "LocalMonoInput" | "LocalStereoInput" | "TestTone";
export type NewParticipantPolicy = "SAFE" | "HOLD" | "PRESET";
export type BotRole = "RX" | "TX" | "DUPLEX" | "SPARE";
export type TxSubtype = "GAME" | "CASTER" | "COMMENTARY" | "IFB" | "CUSTOM";
export type TxAudioMode = "MONO" | "STEREO";
export type LogLevel = "INFO" | "WARNING" | "CRITICAL";
export type SceneValue = number | boolean | string;
export type ParticipantApprovalState = "PENDING" | "APPROVED";

export interface SceneSnapshot {
  id: string;
  name: string;
  createdAt: string;
  values: Record<string, SceneValue>;
}

export interface SceneChange {
  parameter: string;
  label: string;
  from: SceneValue | undefined;
  to: SceneValue;
  recallSafe: boolean;
  locked: boolean;
}

export interface SceneParameterSnapshot {
  parameter: string;
  label: string;
  value: SceneValue;
}

export interface MeterValue {
  channelId: string;
  peak: number;
  rms: number;
  hold: number;
  clip: boolean;
  voiceActive: boolean;
  stale?: boolean;
  loudnessMomentary: number;
  loudnessShortTerm: number;
  loudnessIntegrated: number;
}

export interface ChannelSnapshot {
  id: string;
  discordUserId?: string;
  currentVoiceChannelId?: string;
  channelColor?: string;
  preferredStripPosition?: number;
  approvalGateOpen?: boolean;
  label: string;
  kind: SourceKind;
  trimDb: number;
  faderDb: number;
  mute: boolean;
  meter: MeterValue;
  inputMeter?: MeterValue;
  vcSends: Record<string, { gainDb: number; mute: boolean }>;
  directOutput?: { output: number; tap: TapPoint; gainDb: number; mute: boolean };
}

export interface PersistentUserProfileSnapshot {
  discordUserId: string;
  displayName: string;
  channelName: string;
  channelColor: string;
  mainFaderDb: number;
  mainMute: boolean;
  trimDb: number;
  hpf: { enabled: boolean; cutoffHz: number };
  compressor: { enabled: boolean; thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; makeupDb: number };
  /** Legacy unscoped route. Never auto-applied; retained only while old profile data is loaded. */
  directOutput?: { output: number; tap: TapPoint; gainDb: number; mute: boolean };
  directOutputsByVoiceChannel: Record<string, { output: number; tap: TapPoint; gainDb: number; mute: boolean }>;
  preferredStripPosition: number;
  busSends: Record<string, { gainDb: number; mute: boolean }>;
  recallSafe: string[];
  trusted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserSessionSnapshot {
  discordUserId: string;
  sessionGeneration: number;
  approvalRevision: number;
  currentChannelId: string | null;
  currentVC: string | null;
  currentStripSlot: number;
  online: boolean;
  temporaryAlert: string | null;
  sessionApproval: ParticipantApprovalState;
  audioActive: boolean;
}

export interface BusSnapshot {
  id: string;
  label: string;
  groupSourceIds?: readonly string[] | null;
  linkedDiscordGuildId?: string;
  linkedDiscordVoiceChannelId?: string;
  format: "MONO" | "STEREO";
  masterDb: number;
  mute: boolean;
  limiterEnabled: boolean;
  limiterGainReductionDb: number;
  meter: MeterValue;
  inputMeter: MeterValue;
  compressorEnabled: boolean;
  compressorThresholdDb: number;
  compressorRatio: number;
  compressorAttackMs: number;
  compressorReleaseMs: number;
  compressorMakeupDb: number;
  compressorGainReductionDb: number;
  newParticipantPolicy: NewParticipantPolicy;
  defaultSendDb: number;
  participantCount: number;
  autoCreated: boolean;
  physicalOutputs: Array<{ output: number; gainDb: number; mute: boolean }>;
}

export type AudioFaultClassification = "STREAM_ENDED" | "STREAM_ERROR" | "DEVICE_UNAVAILABLE" | "PRESENCE_PROVIDER_UNAVAILABLE" | "ASIO_FAULT" | "UNKNOWN";
export interface AudioFaultDiagnostic {
  classification: AudioFaultClassification;
  hostApi: string | null;
}
export interface AudioFaultReport extends AudioFaultDiagnostic { reason: string }

export interface AudioOutputDevice {
  id: string;
  name: string;
  backend: "mock" | "portaudio";
  hostApi: string;
  maxOutputChannels: number;
  defaultSampleRate: number;
}

export interface AudioOutputTimingSnapshot {
  measurement: "js-write-completion-not-playback";
  startedAt: string;
  elapsedMs: number;
  framesWritten: number;
  inFlight: number;
  windows: Array<{ startedAt: string; durationMs: number; samples: number; inFlightMin: number | null; inFlightMax: number; inFlightMean: number | null; callbackCount: number; callbackMaxMs: number }>;
  backpressureDropTimes: string[];
  correctionAddedFrames: number;
  correctionRemovedFrames: number;
  primingFrames: number;
  backlogEwma: number;
  /** Net inserted/removed frames per nominal PCM frame; not a measured DAC clock. */
  estimatedPpm: number;
}

export interface AudioSchedulerTimingSnapshot {
  latenessResolutionMs: number;
  latenessOverflowThresholdMs: number;
  catchupCalls: number;
  maxBlocksPerCall: number;
  windows: Array<{ startedAt: string; durationMs: number; samples: number; maxLateMs: number; p99LateMs: number; catchupCalls: number; maxBlocksPerCall: number }>;
}

export interface AudioRuntimeWindow {
  startedAt: string;
  durationMs: number;
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  processBlockMaxMs: number;
  processBlocks: number;
}

export interface AudioRuntimeTimingSnapshot {
  resolutionMs: number;
  current: AudioRuntimeWindow;
  windows: AudioRuntimeWindow[];
}

export interface AudioOutputSnapshot {
  state: "READY" | "STOPPED" | "FAULT";
  selectedDeviceId: string | null;
  selectedDeviceName: string | null;
  selectedHostApi?: string | null;
  activeChannelCount: number;
  sampleRate: number;
  framesWritten: number;
  backpressureDrops: number;
  writeTiming?: AudioOutputTimingSnapshot | null;
  peak: number;
  error: string | null;
  devices: AudioOutputDevice[];
  windowsEndpointBinding?: WindowsEndpointBindingSnapshot | null;
  testToneOutputs?: number[];
}

export interface AudioInputDevice {
  id: string;
  name: string;
  hostApi: string;
  maxInputChannels: number;
  defaultSampleRate: number;
}

export interface InputCaptureTimingSnapshot {
  elapsedMs: number;
  physicalChannelCount: number;
  packets: number;
  minPacketBytes: number;
  maxPacketBytes: number;
  lastPacketGapMs: number;
  maxPacketGapMs: number;
  lastPacketAgeMs: number | null;
  pendingFrameBytes: number;
  channels: Array<{ channel: number; queuedFrames: number; maxQueuedFrames: number; underruns: number; missingFrames: number; droppedFrames: number }>;
}

export interface AudioInputSnapshot {
  state: "UNSELECTED" | "READY" | "STOPPED" | "FAULT";
  selectedDeviceId: string | null;
  selectedDeviceName: string | null;
  selectedHostApi?: string | null;
  activeChannelCount: number;
  sampleRate: number;
  framesCaptured: number;
  captureTiming?: InputCaptureTimingSnapshot | null;
  peak: number;
  error: string | null;
  devices: AudioInputDevice[];
  windowsEndpointBinding?: WindowsEndpointBindingSnapshot | null;
}

export type WindowsEndpointDirection = "render" | "capture";
export type WindowsEndpointState = "ACTIVE" | "DISABLED" | "NOT_PRESENT" | "UNPLUGGED" | "UNKNOWN";

export interface WindowsEndpointSnapshot {
  id: string;
  name: string;
  direction: WindowsEndpointDirection;
  state: WindowsEndpointState;
}

export interface WindowsEndpointBindingSnapshot {
  endpointId: string;
  endpointName: string;
  direction: WindowsEndpointDirection;
  state: WindowsEndpointState;
  monitoring: "ACTIVE" | "UNBOUND" | "UNAVAILABLE";
}

export type RecorderState = "IDLE" | "RECORDING" | "STOPPING" | "FAULT";
export type RecorderTrackKind = "MATRIX" | "VC_BUS" | "DISCORD_USER" | "LOCAL_INPUT";

export interface RecorderTrackSnapshot {
  kind: RecorderTrackKind;
  sourceId: string;
  label: string;
  fileName: string;
  dataBytes: number;
}

export interface RecorderSelection {
  /** 0-based Main Output channels; each is a separate mono WAV. */
  outputs: number[];
  busIds: string[];
  channelIds: string[];
}

export interface RecorderSnapshot {
  state: RecorderState;
  folder: string;
  format: "WAV_FLOAT32";
  sampleRate: number;
  startedAt: string | null;
  durationSeconds: number;
  matrixOutput: number;
  includeUsers: boolean;
  includeBuses: boolean;
  selection?: RecorderSelection;
  selectionSupported?: boolean;
  queuedBlocks: number;
  maxQueuedBlocks: number;
  droppedBlocks: number;
  freeBytes: number | null;
  totalBytes: number | null;
  message: string | null;
  tracks: RecorderTrackSnapshot[];
}

export type DiscordBotHealth = "READY" | "CONNECTING" | "RECONNECTING" | "DISCONNECTED" | "STALE" | "FAULT";

export interface DiscordBotSnapshot {
  key: string;
  profileId: string;
  label: string;
  role: BotRole;
  txSubtype: TxSubtype | null;
  txAudioMode: TxAudioMode | null;
  botId: string;
  guildId: string;
  guildName: string | null;
  voiceChannelId: string;
  voiceChannelName: string | null;
  gatewayState: string;
  voiceState: string;
  health: DiscordBotHealth;
  wsPingMs: number | null;
  udpPingMs: number | null;
  reconnectCount: number;
  lastAudioAgoMs: number | null;
  txEnabled: boolean;
  txFrames: number;
  txDroppedFrames: number;
  lastTxFrameAgoMs: number | null;
  lastHeartbeatAgoMs: number | null;
  message: string | null;
}

export interface ReceiverOwnershipSnapshot {
  guildId: string;
  voiceChannelId: string;
  voiceChannelName: string | null;
  ownerProfileId: string | null;
  generation: number;
  status: "ACTIVE" | "DISCONNECTED" | "UNSELECTED" | "CONFLICT";
  receivers: Array<{
    profileId: string;
    label: string;
    role: "RX" | "DUPLEX" | "SPARE";
    health: DiscordBotHealth;
    state: "ACTIVE" | "STANDBY" | "DISCONNECTED" | "CONFLICT";
  }>;
  transmitters: Array<{
    profileId: string;
    label: string;
    role: "TX" | "DUPLEX";
    health: DiscordBotHealth;
  }>;
}

export interface DiscordTxSnapshot {
  masterDb?: number;
  destination?: string | null;
  state: "NO_BOT" | "NOT_READY" | "READY" | "SENDING" | "FAULT";
  active: boolean;
  sourceOutput: number;
  /** undefined: legacy Matrix output; null: unassigned; string: local input POST. */
  sourceInputChannelId?: string | null;
  sourceInputRightChannelId?: string | null;
  profileId: string | null;
  label: string | null;
  botId: string | null;
  guildId: string | null;
  voiceChannelId: string | null;
  voiceChannelName: string | null;
  subtype: TxSubtype | null;
  audioMode: TxAudioMode | null;
  framesSent: number;
  droppedFrames: number;
  peak: number;
  lastFrameAgoMs: number | null;
}

export interface DiscordShadowSnapshot {
  enabled: boolean;
  status: "DISABLED" | "STARTING" | "READY" | "FAULT" | "STOPPED";
  mirroredFrames: number;
  comparedFrames: number;
  matchedFrames: number;
  mismatchFrames: number;
  droppedFrames: number;
  pendingFrames: number;
  unexpectedFrames: number;
  processErrors: number;
  lastMismatch: string | null;
  lastError: string | null;
}

export interface ProgramAudioShadowSnapshot extends DiscordShadowSnapshot {
  capturedFrames: number;
  bufferedFrames: number;
  peak: number;
}

/** Adapter-process counters, shared by all Bots on one IPC connection. */
export interface DiscordRxIpcSnapshot {
  opusDroppedFrames: number;
  backpressureWrites: number;
  writableBytes: number;
  maxWritableBytes: number;
}

export interface DiscordIngestSnapshot {
  endpoint: string;
  connectedAdapters: number;
  adapterState: string;
  configuredBots: number;
  readyBots: number;
  staleBots: number;
  reconnectingBots: number;
  packets: number;
  bytes: number;
  decodeErrors: number;
  decoderState: "READY" | "UNAVAILABLE";
  rxDiagnostics?: {
    /** Lifetime total includes retired sources so short sessions are not lost before logging. */
    inSpeechUnderruns?: number;
    /** Local rejection reasons; these are not Discord network packet-loss counters. */
    rejectedOpus: Record<string, number>;
    ipcBatches: { count: number; maxOpusFrames: number; maxBytes: number; maxProcessingMs: number };
    /** One entry per current socket, not per Bot. */
    adapterIpc: DiscordRxIpcSnapshot[];
  };
  shadow?: DiscordShadowSnapshot;
  tx: DiscordTxSnapshot;
  txStems: DiscordTxSnapshot[];
  txTargets?: { armed: string[]; live: string[]; allTeams: string[] };
  txTargetsRevision?: number;
  bots: DiscordBotSnapshot[];
  receiverOwnership: ReceiverOwnershipSnapshot[];
  availableVoiceChannels: Array<{ guildId: string; id: string; name: string }>;
  sources: Array<{
    channelId: string;
    botId: string;
    guildId: string;
    voiceChannelId: string;
    userId: string;
    packets: number;
    decodedSamples: number;
    decodeErrors: number;
    sequenceGaps: number;
    sequenceGapsKnown?: boolean;
    queuedMilliseconds: number;
    droppedSamples: number;
    lastPacketAgoMs: number | null;
    playout?: { hardCapMs?: number; microShortages?: number; silenceMs?: number; fadeMs?: number; targetBlocks?: number[]; targetMs: number; backlogEwmaMs: number; prebufferBlocks: number; expandedFrames: number; compressedFrames: number; staleDiscardedSamples: number };
    rxTiming?: {
      /** Arrival spacing includes silence and reconnects; not a network latency measurement. */
      maxPacketGapMs: number;
      maxQueuedMilliseconds: number;
      overflowEvents: number;
      underruns?: number;
      /** Classified after a future packet: both sides of the shortage are <=200ms. */
      inSpeechUnderruns?: number;
      inSpeechByKind?: Record<string, number>;
      microInSpeechUnderruns?: number;
      endOfSpeechUnderruns?: number;
      pendingUnderruns?: number;
      unclassifiedUnderruns?: number;
      recentInSpeechUnderruns?: Array<{ at: string; previousPacketAgeMs: number; nextPacketDelayMs: number; queuedBeforeMs: number; queuedAfterPacketMs: number; classification?: "loss" | "senderPause" | "delayed" | "fillBurst" | "unknown" }>;
      rtp?: { realPackets: number; syntheticPackets: number; missingPackets: number; counts: Record<string, number>; gapWindows?: Record<string, Array<{ startedAt: string; durationMs: number; samples: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number }>> };
      jitterResolutionMs?: number;
      packetJitterExcludedGaps?: number;
      packetJitterWindows?: Array<{ startedAt: string; durationMs: number; samples: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number }>;
      fillJitterWindows?: Array<{ startedAt: string; durationMs: number; samples: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number }>;
      overflowsAfterUnderrun?: number;
      silenceBlocksDropped?: number;
      compressedSamples?: number;
      queueResolutionMs?: number;
      queueWindows?: Array<{ startedAt: string; durationMs: number; samples: number; p50Ms: number; p95Ms: number; maxMs: number }>;
      lastOverflow: {
        at: string;
        queuedBeforeMilliseconds: number;
        incomingSamples: number;
        droppedSamples: number;
        packetGapMs: number;
        batchOpusFrames: number;
        batchBytes: number;
        batchElapsedMs: number;
      } | null;
    };
  }>;
}

export interface SystemMonitorSnapshot {
  processCpuPercent: number;
  processRssBytes: number;
  processHeapUsedBytes: number;
  systemTotalMemoryBytes: number;
  systemFreeMemoryBytes: number;
  networkInterfaces: Array<{
    name: string;
    address: string;
    family: "IPv4" | "IPv6";
    internal: boolean;
  }>;
}

export interface CoreOwnershipSnapshot {
  requestedMode: "typescript" | "rust-shadow" | "rust-canary" | "rust-production";
  effectiveOwner: "typescript" | "rust";
  managementProvider: "none" | "rust-read-only";
  configurationSource: "default" | "ownership-flag" | "legacy-shadow-flag";
  shadowScope: "none" | "discord-metadata-program-audio-control-and-wasapi-management";
  transitionPolicy: "restart-required";
  canaryReady: boolean;
  productionReady: boolean;
  blockers: readonly string[];
}

export interface RustControlShadowSnapshot {
  enabled: boolean;
  comparedCommands: number;
  matchedCommands: number;
  mismatchedCommands: number;
  pendingCommands: number;
  lastMismatch: string | null;
}

export interface RustWasapiPublicSnapshot {
  supported: boolean;
  selectedEndpointName: string | null;
  selectedAvailable: boolean;
  preflightReady: boolean;
  format: WasapiStreamDescriptor["format"] | null;
  enginePeriod: WasapiStreamDescriptor["enginePeriod"] | null;
  streamStarted: boolean;
  streamState: "STOPPED" | "RUNNING" | "FAULT";
  streamError: string | null;
  mmcssRegistered: boolean;
  renderCallbacks: number;
  outputUnderruns: number;
}

export interface RustManagementSnapshot {
  enabled: boolean;
  streamControlEnabled: boolean;
  status: "DISABLED" | "STARTING" | "READY" | "FAULT" | "STOPPED";
  protocolVersion: number | null;
  endpointCount: number;
  lastError: string | null;
  controlShadow: RustControlShadowSnapshot;
  wasapi: RustWasapiPublicSnapshot;
}

export interface WasapiStreamDescriptor {
  endpointId: string;
  format: {
    sampleRate: number;
    framesPerBuffer: number;
    channels: number;
    sampleFormat: "FLOAT32";
  };
  enginePeriod: {
    defaultFrames: number;
    fundamentalFrames: number;
    minimumFrames: number;
    maximumFrames: number;
  };
}

export interface WasapiManagementSnapshot {
  supported: boolean;
  selectedEndpointId: string | null;
  selectedEndpointName: string | null;
  selectedAvailable: boolean;
  preflightReady: boolean;
  descriptor: WasapiStreamDescriptor | null;
  streamStarted: boolean;
  streamState: "STOPPED" | "RUNNING" | "FAULT";
  streamError: string | null;
  mmcssRegistered: boolean;
  renderCallbacks: number;
  outputUnderruns: number;
}

export type OperatorSeverity = "OK" | "WARNING" | "CRITICAL";

export interface OperatorRootCauseSnapshot {
  id: string;
  severity: OperatorSeverity;
  title: string;
  summary: string;
  details: string[];
  actionView?: "mixer" | "bot-rack" | "io" | "recorder" | "scenes";
}

export interface OperatorSystemHealthSnapshot {
  id: "discord" | "audio" | "output" | "recorder";
  label: string;
  severity: OperatorSeverity;
  summary: string;
}

export interface OperatorUserHealthSnapshot {
  channelId: string;
  label: string;
  severity: OperatorSeverity;
  reason: string;
  currentVC: string;
  rxState: string;
  packetGaps: number;
  droppedPackets: number;
  queuedMilliseconds: number;
  lastAudioAgoMs: number | null;
  approvalState: ParticipantApprovalState | "NOT REQUIRED";
  receiverOwner: string;
}

export interface OperatorReceiverHealthSnapshot {
  voiceChannel: string;
  severity: OperatorSeverity;
  owner: string;
  ownerState: "ACTIVE" | "DISCONNECTED" | "UNSELECTED" | "CONFLICT";
  standby: string[];
  transmitters: Array<{ label: string; state: OperatorSeverity }>;
}

export interface OperatorHealthSnapshot {
  overallSeverity: OperatorSeverity;
  system: OperatorSystemHealthSnapshot[];
  users: OperatorUserHealthSnapshot[];
  receivers: OperatorReceiverHealthSnapshot[];
  rootCauses: OperatorRootCauseSnapshot[];
  recentEvents: Array<{ at: string; severity: OperatorSeverity; message: string }>;
  headerAlert: { severity: "WARNING" | "CRITICAL"; message: string } | null;
}

export interface RuntimeInfoSnapshot {
  buildCommit: string | null;
  pcRole: "RX" | "TX" | "MIXED" | "UNCONFIGURED";
  startedAt: string;
}

export interface RouterSnapshot {
  revision: number;
  state: OnAirState;
  emergencyMuted: boolean;
  emergencyEpoch: number;
  monitorSourceId: string | null;
  monitorOutput?: { leftOutput: number; rightOutput: number | null; mode: "MONO" | "DUAL_MONO" } | null;
  sampleRate: number;
  blockSize: number;
  uptimeSeconds: number;
  callbackLoad: number;
  xruns: number;
  topologyMutationFaults: number;
  audioTiming?: AudioSchedulerTimingSnapshot;
  audioRuntimeTiming?: AudioRuntimeTimingSnapshot;
  channels: ChannelSnapshot[];
  userProfiles?: PersistentUserProfileSnapshot[];
  userSessions?: UserSessionSnapshot[];
  buses: BusSnapshot[];
  output?: AudioOutputSnapshot;
  cueOutput?: AudioOutputSnapshot;
  input?: AudioInputSnapshot;
  recorder?: RecorderSnapshot;
  discord?: DiscordIngestSnapshot;
  system?: SystemMonitorSnapshot;
  runtimeInfo?: RuntimeInfoSnapshot;
  coreOwnership?: CoreOwnershipSnapshot;
  programAudioShadow?: ProgramAudioShadowSnapshot;
  rustManagement?: RustManagementSnapshot;
  wasapi?: WasapiManagementSnapshot;
  operatorHealth?: OperatorHealthSnapshot;
  alerts: Array<{ level: LogLevel; message: string; at: string }>;
  scenes: SceneSnapshot[];
  currentSceneId?: string | null;
  recallSafe: string[];
  sceneParameters: SceneParameterSnapshot[];
}

export type ControlCommand =
  | { type: "SET_STATE"; state: OnAirState; confirmed?: boolean }
  | { type: "SET_CHANNEL_FADER"; channelId: string; db: number }
  | { type: "SET_CHANNEL_MUTE"; channelId: string; mute: boolean }
  | { type: "SET_USER_CHANNEL_COLOR"; channelId: string; color: string }
  | { type: "SET_USER_STRIP_ORDER"; discordUserIds: string[] }
  | { type: "RESET_USER_STRIP_ORDER" }
  | { type: "SET_PARTICIPANT_APPROVAL"; channelId: string; discordUserId: string; approved: boolean; expectedSessionGeneration: number; expectedApprovalRevision: number }
  | { type: "SET_USER_TRUSTED"; channelId: string; trusted: boolean; confirmed?: boolean }
  | { type: "SET_RECEIVER_OWNER"; guildId: string; voiceChannelId: string; profileId: string; expectedCurrentOwner: string | null; expectedReceiverGeneration: number; confirmed?: boolean }
  | { type: "SET_VC_SEND"; channelId: string; busId: string; db?: number; mute?: boolean }
  | { type: "SET_BUS_MASTER"; busId: string; db: number }
  | { type: "SET_BUS_MUTE"; busId: string; mute: boolean }
  | { type: "SET_BUS_OUTPUT"; busId: string; output: number; mode?: "MONO" | "DUAL_MONO"; allowCollision?: boolean; confirmed?: boolean }
  | { type: "CLEAR_BUS_OUTPUT"; busId: string }
  | { type: "SET_BUS_BINDING"; busId: string; guildId: string; voiceChannelId: string }
  | { type: "CREATE_VC_BUS"; name: string; policy?: NewParticipantPolicy; defaultSendDb?: number; groupSourceIds?: string[] }
  | { type: "SET_GROUP_BUS_SOURCES"; busId: string; sourceBusIds: string[] }
  | { type: "REMOVE_VC_BUS"; busId: string; confirmed?: boolean }
  | { type: "SET_NEW_PARTICIPANT_POLICY"; busId: string; policy: NewParticipantPolicy; defaultSendDb?: number }
  | { type: "SET_BUS_COMPRESSOR"; busId: string; enabled?: boolean; thresholdDb?: number; ratio?: number; attackMs?: number; releaseMs?: number; makeupDb?: number }
  | { type: "SELECT_OUTPUT_DEVICE"; deviceId: string; windowsEndpointId?: string }
  | { type: "REFRESH_OUTPUT_DEVICES" }
  | { type: "SELECT_CUE_OUTPUT_DEVICE"; deviceId: string; windowsEndpointId?: string }
  | { type: "REFRESH_CUE_OUTPUT_DEVICES" }
  | { type: "SELECT_INPUT_DEVICE"; deviceId: string; channelCount: number; windowsEndpointId?: string }
  | { type: "REFRESH_INPUT_DEVICES" }
  | { type: "SET_DIRECT_OUTPUT"; channelId: string; output: number; tap: TapPoint; gainDb?: number; mute?: boolean; allowCollision?: boolean; confirmed?: boolean }
  | { type: "CLEAR_DIRECT_OUTPUT"; channelId: string }
  | { type: "SET_OUTPUT_TEST_TONE"; output: number; active: boolean }
  | { type: "SET_LIMITER"; busId: string; enabled: boolean }
  | { type: "RESET_LOUDNESS"; busId: string }
  | { type: "SET_PFL"; sourceId: string | null }
  | { type: "SET_MONITOR_OUTPUT"; output: number | null; mode?: "MONO" | "DUAL_MONO" }
  | { type: "EMERGENCY_MUTE"; active: true; confirmed?: boolean }
  | { type: "EMERGENCY_MUTE"; active: false; confirmed?: boolean; expectedEmergencyEpoch: number }
  | { type: "SAVE_SCENE"; name: string; sceneId?: string; confirmed?: boolean }
  | { type: "PREVIEW_SCENE"; sceneId: string }
  | { type: "RECALL_SCENE"; sceneId: string; confirmed?: boolean }
  | { type: "DELETE_SCENE"; sceneId: string; confirmed?: boolean }
  | { type: "SET_RECALL_SAFE"; parameter: string; safe: boolean }
  | { type: "CLEAR_EVENT_LOG"; confirmed?: boolean }
  | { type: "SET_TX_SOURCE"; profileId?: string; output: number }
  | { type: "SET_TX_INPUT"; profileId: string; channelId: string | null }
  | { type: "SET_TX_MASTER"; profileId: string; db: number }
  | { type: "ASSIGN_TX_VOICE_CHANNEL"; profileId: string; voiceChannelId: string; confirmed?: boolean }
  | { type: "CONNECT_DISCORD_BOT"; profileId: string }
  | { type: "DISCONNECT_DISCORD_BOT"; profileId: string; confirmed?: boolean }
  | { type: "START_TX"; profileId?: string; confirmed?: boolean }
  | { type: "SET_TX_TARGETS"; ids: string[]; expectedRevision: number }
  | { type: "START_ARMED"; confirmed?: boolean; expectedRevision?: number }
  | { type: "CLEAR_ALL" }
  | { type: "STOP_TX"; profileId?: string; confirmed?: boolean }
  | { type: "START_RECORDING"; matrixOutput: number; includeUsers: boolean; includeBuses: boolean; selection?: RecorderSelection; confirmed?: boolean }
  | { type: "STOP_RECORDING"; confirmed?: boolean }
  | { type: "DEVICE_LOST"; deviceId: string; fault?: AudioFaultReport }
  | { type: "INPUT_DEVICE_LOST"; deviceId: string; fault?: AudioFaultReport }
  | { type: "ACKNOWLEDGE_FAULT"; confirmed: boolean };

export interface CommandResult {
  ok: boolean;
  revision: number;
  error?: string;
  code?: "STALE_STATE";
  conflict?: { resource: string; expected: Record<string, string | number | null>; current: Record<string, string | number | null> };
  confirmationRequired?: boolean;
  data?: unknown;
}

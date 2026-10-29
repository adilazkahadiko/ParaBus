import {
  DEFAULT_BLOCK_SIZE,
  MAX_OUTPUT_CHANNELS,
  MAX_RX_CHANNELS,
  MAX_VC_BUSES,
  SAMPLE_RATE,
  type NewParticipantPolicy,
  type SourceKind,
  type TapPoint,
} from "../../../packages/shared-types/src/index.ts";
import {
  Compressor,
  HighPassFilter,
  LoudnessMeter,
  PeakRmsMeter,
  SafetyLimiter,
  clamp,
  dbToGain,
  type LoudnessSnapshot,
} from "./dsp.ts";
import type { RxQueueTiming } from "./audio-timing.ts";

export interface SourceProvider {
  fill(target: Float32Array, sampleRate: number): boolean;
}

export class SineSource implements SourceProvider {
  #phase = 0;
  frequencyHz: number;
  levelDb: number;

  constructor(frequencyHz: number, levelDb = -18) {
    this.frequencyHz = frequencyHz;
    this.levelDb = levelDb;
  }

  fill(target: Float32Array, sampleRate: number): boolean {
    const gain = dbToGain(this.levelDb);
    const step = (2 * Math.PI * this.frequencyHz) / sampleRate;
    for (let index = 0; index < target.length; index += 1) {
      target[index] = Math.sin(this.#phase) * gain;
      this.#phase += step;
      if (this.#phase >= 2 * Math.PI) this.#phase -= 2 * Math.PI;
    }
    return true;
  }
}

export class SilenceSource implements SourceProvider {
  fill(target: Float32Array): boolean {
    target.fill(0);
    return false;
  }
}

export class PcmRingSource implements SourceProvider {
  readonly capacity: number;
  readonly samples: Float32Array;
  #readIndex = 0;
  #writeIndex = 0;
  #queuedSamples = 0;
  droppedSamples = 0;
  /** Optional offline sample-provenance probe; absent in production. Never changes PCM. */
  sampleTrace?: { push(samples: number, at?: number): void; read(samples: number): void; drop(samples: number): void; clear(): void };
  readonly timing?: RxQueueTiming;

  constructor(capacity = SAMPLE_RATE * 2, timing?: RxQueueTiming) {
    this.capacity = Math.max(DEFAULT_BLOCK_SIZE, Math.trunc(capacity));
    this.samples = new Float32Array(this.capacity);
    this.timing = timing;
  }

  protected get queueLimit(): number { return this.capacity; }

  pushInt16Le(pcm: Uint8Array, packetReceivedAt?: number): number {
    const buffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const sampleCount = Math.floor(buffer.length / 2);
    const queueLimit = this.queueLimit;
    const droppedBefore = this.droppedSamples;
    if (sampleCount > 0) this.timing?.packet(packetReceivedAt);
    for (let index = 0; index < sampleCount; index += 1) {
      while (this.#queuedSamples >= queueLimit) {
        this.#readIndex = (this.#readIndex + 1) % this.capacity;
        this.#queuedSamples -= 1;
        this.droppedSamples += 1;
      }
      this.samples[this.#writeIndex] = buffer.readInt16LE(index * 2) / 32768;
      this.#writeIndex = (this.#writeIndex + 1) % this.capacity;
      this.#queuedSamples += 1;
    }
    if (sampleCount) this.sampleTrace?.push(sampleCount, packetReceivedAt);
    if (this.droppedSamples > droppedBefore) { this.sampleTrace?.drop(this.droppedSamples - droppedBefore); this.timing?.overflow(); }
    return sampleCount;
  }

  pushFloat32Le(pcm: Uint8Array, channelIndex = 0, channelCount = 1): number {
    const buffer = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const frameCount = Math.floor(buffer.length / (4 * channelCount));
    const queueLimit = this.queueLimit;
    const droppedBefore = this.droppedSamples;
    if (frameCount > 0) this.timing?.packet();
    for (let frame = 0; frame < frameCount; frame += 1) {
      while (this.#queuedSamples >= queueLimit) {
        this.#readIndex = (this.#readIndex + 1) % this.capacity;
        this.#queuedSamples -= 1;
        this.droppedSamples += 1;
      }
      this.samples[this.#writeIndex] = buffer.readFloatLE((frame * channelCount + channelIndex) * 4);
      this.#writeIndex = (this.#writeIndex + 1) % this.capacity;
      this.#queuedSamples += 1;
    }
    if (this.droppedSamples > droppedBefore) this.timing?.overflow();
    return frameCount;
  }

  fill(target: Float32Array): boolean {
    this.timing?.fill(this.#queuedSamples, target.length);
    return this.readInto(target);
  }

  /** RX quiet cuts record the original waterline once, before consuming PCM. */
  protected readInto(target: Float32Array): boolean {
    const available = Math.min(target.length, this.#queuedSamples);
    if (available) this.sampleTrace?.read(available);
    for (let index = 0; index < available; index += 1) {
      target[index] = this.samples[this.#readIndex];
      this.#readIndex = (this.#readIndex + 1) % this.capacity;
    }
    target.fill(0, available);
    this.#queuedSamples -= available;
    return available > 0;
  }

  /** RX latency control only; deliberate quiet cuts are not safety overflows. */
  protected discardQuietBlock(frames: number, maximumMeanSquare: number): boolean {
    if (this.#queuedSamples < frames * 2) return false;
    let energy = 0;
    for (let i = 0; i < frames; i++) {
      const sample = this.samples[(this.#readIndex + i) % this.capacity];
      energy += sample * sample;
      if (energy >= frames * maximumMeanSquare) return false;
    }
    // Do not splice quiet PCM directly into a voiced attack with a new step.
    const seam = this.samples[(this.#readIndex + frames) % this.capacity] - this.samples[this.#readIndex];
    if (seam * seam >= maximumMeanSquare) return false;
    this.sampleTrace?.drop(frames);
    this.#readIndex = (this.#readIndex + frames) % this.capacity;
    this.#queuedSamples -= frames;
    return true;
  }

  clear(): void {
    this.sampleTrace?.clear();
    this.#readIndex = 0;
    this.#writeIndex = 0;
    this.#queuedSamples = 0;
  }

  get queuedSamples(): number {
    return this.#queuedSamples;
  }
}

export interface DirectRoute {
  output: number;
  tap: TapPoint;
  gainDb: number;
  mute: boolean;
}

export interface VcSend {
  gainDb: number;
  mute: boolean;
}

/**
 * Audio topology is public for the reference implementation, so ordinary
 * Map/Set operations must remain available to controls and tests.  The small
 * wrapper makes each structural change observable without putting a Map
 * lookup or iterator in the audio callback.
 */
type TopologyMutation<K, V> =
  | { readonly kind: "set"; readonly key: K; readonly value: V; readonly previous: V | undefined }
  | { readonly kind: "delete"; readonly key: K; readonly previous: V | undefined }
  | { readonly kind: "clear" };

type TopologyBefore = () => void;
type TopologyAfter<K, V> = (mutation: TopologyMutation<K, V>) => void;
const NOOP_TOPOLOGY_BEFORE: TopologyBefore = () => {};
const NOOP_TOPOLOGY_AFTER: TopologyAfter<unknown, unknown> = () => {};

/**
 * Deliberately not an Error: throwing this singleton cannot create a stack or
 * a fresh object in the real-time callback.  It is private to this module so
 * only a topology mutation can trigger the fail-closed recovery path.
 */
const TOPOLOGY_MUTATION_DURING_PROCESSING = Object.freeze({ kind: "topology-mutation-during-processing" });

class TopologyMap<K, V> extends Map<K, V> {
  #before: TopologyBefore;
  #after: TopologyAfter<K, V>;

  constructor(before: TopologyBefore = NOOP_TOPOLOGY_BEFORE, after: TopologyAfter<K, V> = NOOP_TOPOLOGY_AFTER as TopologyAfter<K, V>) {
    super();
    this.#before = before;
    this.#after = after;
  }

  setTopologyObserver(before: TopologyBefore, after: TopologyAfter<K, V>): void {
    this.#before = before;
    this.#after = after;
  }

  override set(key: K, value: V): this {
    this.#before();
    const previous = super.get(key);
    super.set(key, value);
    this.#after({ kind: "set", key, value, previous });
    return this;
  }

  override delete(key: K): boolean {
    if (!super.has(key)) return false;
    this.#before();
    const previous = super.get(key);
    const deleted = super.delete(key);
    if (deleted) this.#after({ kind: "delete", key, previous });
    return deleted;
  }

  override clear(): void {
    if (this.size === 0) return;
    this.#before();
    super.clear();
    this.#after({ kind: "clear" });
  }
}

class TopologySet<T> extends Set<T> {
  #before: TopologyBefore;
  #after: () => void;

  constructor(before: TopologyBefore = NOOP_TOPOLOGY_BEFORE, after: () => void = NOOP_TOPOLOGY_BEFORE) {
    super();
    this.#before = before;
    this.#after = after;
  }

  override add(value: T): this {
    if (this.has(value)) return this;
    this.#before();
    super.add(value);
    this.#after();
    return this;
  }

  override delete(value: T): boolean {
    if (!this.has(value)) return false;
    this.#before();
    const deleted = super.delete(value);
    if (deleted) this.#after();
    return deleted;
  }

  override clear(): void {
    if (this.size === 0) return;
    this.#before();
    super.clear();
    this.#after();
  }
}

export class AudioChannel {
  readonly id: string;
  discordUserId?: string;
  currentVoiceChannelId?: string;
  channelColor?: string;
  preferredStripPosition?: number;
  approvalGateOpen: boolean;
  label: string;
  readonly kind: SourceKind;
  readonly source: SourceProvider;
  readonly sampleRate: number;
  readonly input: Float32Array;
  readonly processed: Float32Array;
  readonly post: Float32Array;
  readonly inputMeter = new PeakRmsMeter();
  readonly outputMeter = new PeakRmsMeter();
  readonly hpf: HighPassFilter;
  readonly compressor = new Compressor();
  readonly loudness: LoudnessMeter;
  loudnessValue: LoudnessSnapshot = {
    momentary: Number.NEGATIVE_INFINITY,
    shortTerm: Number.NEGATIVE_INFINITY,
    integrated: Number.NEGATIVE_INFINITY,
  };
  trimDb = 0;
  faderDb = 0;
  mute = false;
  hpfEnabled = true;
  hpfCutoffHz = 80;
  compressorEnabled = true;
  stale = false;
  lastAudioAt = Date.now();
  directOutput?: DirectRoute;
  readonly vcSends = new TopologyMap<string, VcSend>();

  constructor(
    id: string,
    label: string,
    kind: SourceKind,
    source: SourceProvider,
    blockSize: number,
    sampleRate: number,
  ) {
    this.id = id;
    this.label = label;
    this.kind = kind;
    this.source = source;
    this.sampleRate = sampleRate;
    this.approvalGateOpen = kind !== "DiscordUser";
    this.input = new Float32Array(blockSize);
    this.processed = new Float32Array(blockSize);
    this.post = new Float32Array(blockSize);
    this.hpf = new HighPassFilter(sampleRate);
    this.loudness = new LoudnessMeter(sampleRate, blockSize);
  }

  process(sampleRate: number, emergencyMuted: boolean): void {
    const received = this.source.fill(this.input, sampleRate);
    if (received) this.lastAudioAt = Date.now();
    this.stale = Date.now() - this.lastAudioAt > 500;
    if (this.stale || !finiteBuffer(this.input)) {
      this.input.fill(0); this.processed.fill(0); this.post.fill(0);
      this.hpf.reset(); this.compressor.reset(); this.loudness.reset();
      this.inputMeter.reset(); this.outputMeter.reset();
      this.loudnessValue = this.loudness.snapshot();
      return;
    }

    this.inputMeter.process(this.input, sampleRate);
    if (!this.approvalGateOpen) {
      this.processed.fill(0);
      this.post.fill(0);
      this.hpf.reset();
      this.compressor.reset();
      this.loudness.reset();
      this.outputMeter.reset();
      this.loudnessValue = this.loudness.snapshot();
      return;
    }
    const trim = dbToGain(this.trimDb);
    for (let index = 0; index < this.input.length; index += 1) {
      this.processed[index] = this.input[index] * trim;
    }
    if (this.hpfEnabled) this.hpf.processInPlace(this.processed);
    if (this.compressorEnabled) this.compressor.processInPlace(this.processed, sampleRate);

    const postGain = this.mute || emergencyMuted ? 0 : dbToGain(this.faderDb);
    for (let index = 0; index < this.processed.length; index += 1) {
      this.post[index] = this.processed[index] * postGain;
    }
    if (!finiteBuffer(this.processed) || !finiteBuffer(this.post)) {
      this.processed.fill(0); this.post.fill(0);
      this.hpf.reset(); this.compressor.reset(); this.loudness.reset();
    }
    this.outputMeter.process(this.post, sampleRate);
    // Per-participant LUFS is not presented to operators; VC buses retain the
    // broadcast loudness meters. Avoid two K-weighting filters per live user.
    if (this.kind !== "DiscordUser") this.loudnessValue = this.loudness.process(this.post);
  }

  setTopologyObserver(before: TopologyBefore, after: TopologyAfter<string, VcSend>): void {
    this.vcSends.setTopologyObserver(before, after);
  }
}

export class VcBus {
  readonly id: string;
  label: string;
  linkedDiscordGuildId?: string;
  linkedDiscordVoiceChannelId?: string;
  format: "MONO" | "STEREO" = "MONO";
  readonly buffer: Float32Array;
  readonly preMaster: Float32Array;
  readonly cueLimiter = new SafetyLimiter();
  readonly meter = new PeakRmsMeter();
  readonly inputMeter = new PeakRmsMeter();
  readonly compressor = new Compressor();
  readonly limiter = new SafetyLimiter();
  readonly loudness: LoudnessMeter;
  loudnessValue: LoudnessSnapshot = {
    momentary: Number.NEGATIVE_INFINITY,
    shortTerm: Number.NEGATIVE_INFINITY,
    integrated: Number.NEGATIVE_INFINITY,
  };
  masterDb = 0;
  mute = false;
  compressorEnabled = true;
  newParticipantPolicy: NewParticipantPolicy = "SAFE";
  defaultSendDb = -12;
  autoCreated = false;
  /** null = ordinary VC; an array = post-VC group (no nested groups). */
  groupSourceIds: readonly string[] | null = null;

  constructor(id: string, label: string, blockSize: number, sampleRate = SAMPLE_RATE) {
    this.id = id;
    this.label = label;
    this.buffer = new Float32Array(blockSize);
    this.preMaster = new Float32Array(blockSize);
    this.loudness = new LoudnessMeter(sampleRate, blockSize, true);
    this.compressor.thresholdDb = -12;
    this.compressor.ratio = 2;
  }

  beginBlock(): void {
    this.buffer.fill(0);
    this.preMaster.fill(0);
  }

  add(source: Float32Array, gainDb: number): void {
    const gain = dbToGain(gainDb);
    for (let index = 0; index < this.buffer.length; index += 1) {
      this.buffer[index] += source[index] * gain;
    }
  }

  newParticipantSend(): VcSend {
    if (this.newParticipantPolicy === "HOLD") return { gainDb: this.defaultSendDb, mute: true };
    if (this.newParticipantPolicy === "PRESET") return { gainDb: this.defaultSendDb, mute: false };
    return { gainDb: -12, mute: false };
  }

  finish(sampleRate: number, emergencyMuted: boolean): void {
    if (!finiteBuffer(this.buffer)) {
      this.buffer.fill(0); this.compressor.reset(); this.limiter.reset(); this.loudness.reset(); this.inputMeter.reset(); this.meter.reset();
      this.loudnessValue = this.loudness.snapshot();
      return;
    }
    this.inputMeter.process(this.buffer, sampleRate);
    if (this.compressorEnabled) this.compressor.processInPlace(this.buffer, sampleRate);
    else this.compressor.gainReductionDb = 0;
    // CUE is pre-master, but retains approval/send gates and its own safety ceiling.
    this.preMaster.set(this.buffer);
    this.cueLimiter.processInPlace(this.preMaster, sampleRate);
    if (emergencyMuted || !finiteBuffer(this.preMaster)) this.preMaster.fill(0);
    const gain = this.mute || emergencyMuted ? 0 : dbToGain(this.masterDb);
    for (let index = 0; index < this.buffer.length; index += 1) this.buffer[index] *= gain;
    this.limiter.processInPlace(this.buffer, sampleRate);
    if (!finiteBuffer(this.buffer)) {
      this.buffer.fill(0); this.compressor.reset(); this.limiter.reset(); this.loudness.reset();
    }
    this.meter.process(this.buffer, sampleRate);
    this.loudnessValue = this.loudness.process(this.buffer);
  }
}

export interface MatrixRoute {
  id: string;
  sourceId: string;
  output: number;
  gainDb: number;
  mute: boolean;
  tap: TapPoint;
}

interface ChannelSendPlan {
  readonly bus: VcBus;
  readonly send: VcSend;
}

interface ChannelPlan {
  readonly channel: AudioChannel;
  readonly sends: readonly ChannelSendPlan[];
}

interface MatrixRoutePlan {
  readonly route: MatrixRoute;
  readonly source: Float32Array;
}

interface AudioExecutionPlan {
  readonly channels: readonly ChannelPlan[];
  readonly buses: readonly VcBus[];
  readonly groups: readonly { bus: VcBus; sources: readonly VcBus[] }[];
  readonly matrixRoutes: readonly MatrixRoutePlan[];
  readonly monitorSource: Float32Array | null;
  readonly monitorOutput: number | null;
  readonly monitorOutputMode: "MONO" | "DUAL_MONO";
  readonly outputTestToneIndices: readonly number[];
}

export class AudioEngine {
  readonly sampleRate: number;
  readonly blockSize: number;
  readonly outputChannelCount: number;
  readonly channels: TopologyMap<string, AudioChannel>;
  readonly buses: TopologyMap<string, VcBus>;
  readonly matrixRoutes: TopologyMap<string, MatrixRoute>;
  readonly outputs: Float32Array[];
  readonly outputTestTones: TopologySet<number>;
  readonly outputTestTonePhases: Float64Array;
  readonly startedAt = Date.now();
  callbackLoad = 0;
  lastBlockDurationMs = 0;
  xruns = 0;
  blocksProcessed = 0;
  /** Number of rejected structural mutations attempted from a source callback. */
  topologyMutationFaults = 0;
  emergencyMuted = false;
  monitorSourceId: string | null = null;
  monitorOutput: number | null = null;
  monitorOutputMode: "MONO" | "DUAL_MONO" = "DUAL_MONO";
  #processing = false;
  #topologyBatchDepth = 0;
  #topologyDirty = false;
  #observedChannels: AudioChannel[] = [];
  #executionPlan: AudioExecutionPlan = {
    channels: [],
    buses: [],
    groups: [],
    matrixRoutes: [],
    monitorSource: null,
    monitorOutput: null,
    monitorOutputMode: "DUAL_MONO",
    outputTestToneIndices: [],
  };

  constructor(
    sampleRate = SAMPLE_RATE,
    blockSize = DEFAULT_BLOCK_SIZE,
    outputChannelCount = MAX_OUTPUT_CHANNELS,
  ) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
    this.outputChannelCount = outputChannelCount;
    if (outputChannelCount < 1 || outputChannelCount > MAX_OUTPUT_CHANNELS) {
      throw new RangeError(`outputChannelCount must be 1..${MAX_OUTPUT_CHANNELS}`);
    }
    this.outputs = Array.from({ length: outputChannelCount }, () => new Float32Array(blockSize));
    this.outputTestTonePhases = new Float64Array(outputChannelCount);
    this.channels = new TopologyMap(
      () => this.#beforeTopologyMutation(),
      (mutation) => this.#afterChannelMutation(mutation),
    );
    this.buses = new TopologyMap(
      () => this.#beforeTopologyMutation(),
      () => this.#afterTopologyMutation(),
    );
    this.matrixRoutes = new TopologyMap(
      () => this.#beforeTopologyMutation(),
      () => this.#afterTopologyMutation(),
    );
    this.outputTestTones = new TopologySet(
      () => this.#beforeTopologyMutation(),
      () => this.#afterTopologyMutation(),
    );
  }

  addChannel(channel: AudioChannel): void {
    if (this.channels.size >= MAX_RX_CHANNELS) throw new Error(`maximum ${MAX_RX_CHANNELS} channels exceeded`);
    if (this.channels.has(channel.id)) throw new Error(`channel already exists: ${channel.id}`);
    this.channels.set(channel.id, channel);
  }

  removeChannel(channelId: string): void {
    this.#withTopologyBatch(() => {
      if (!this.channels.delete(channelId)) return;
      for (const [routeId, route] of this.matrixRoutes) if (route.sourceId === channelId) this.matrixRoutes.delete(routeId);
      if (this.monitorSourceId === channelId) this.monitorSourceId = null;
    });
  }

  addBus(bus: VcBus): void {
    if (this.buses.size >= MAX_VC_BUSES) throw new Error(`maximum ${MAX_VC_BUSES} VC buses exceeded`);
    if (this.buses.has(bus.id)) throw new Error(`bus already exists: ${bus.id}`);
    this.buses.set(bus.id, bus);
  }

  removeBus(busId: string): void {
    this.#withTopologyBatch(() => {
      if (!this.buses.delete(busId)) throw new Error(`unknown bus: ${busId}`);
      for (const bus of this.buses.values()) if (bus.groupSourceIds?.includes(busId)) bus.groupSourceIds = bus.groupSourceIds.filter(id => id !== busId);
      for (const channel of this.channels.values()) channel.vcSends.delete(busId);
      for (const [routeId, route] of this.matrixRoutes) {
        if (route.sourceId === busId) this.matrixRoutes.delete(routeId);
      }
      if (this.monitorSourceId === busId) this.monitorSourceId = null;
    });
  }

  setGroupSources(busId: string, sourceIds: readonly string[]): void {
    const bus = this.buses.get(busId);
    if (!bus || bus.linkedDiscordVoiceChannelId || [...this.channels.values()].some(channel => channel.vcSends.has(busId))) throw new Error("Group must be a dedicated unbound bus");
    if (new Set(sourceIds).size !== sourceIds.length || sourceIds.some(id => id === busId || !this.buses.has(id) || this.buses.get(id)!.groupSourceIds !== null)) throw new Error("Group sources must be distinct ordinary VC buses");
    if ([...this.buses.values()].some(candidate => candidate.groupSourceIds?.includes(busId))) throw new Error("Nested groups are not supported");
    this.#beforeTopologyMutation();
    bus.groupSourceIds = Object.freeze([...sourceIds]);
    this.#afterTopologyMutation();
  }

  setMonitorSource(sourceId: string | null): void {
    if (sourceId !== null && !this.channels.has(sourceId) && !this.buses.has(sourceId)) throw new Error(`unknown monitor source: ${sourceId}`);
    this.#beforeTopologyMutation();
    this.monitorSourceId = sourceId;
    this.#afterTopologyMutation();
  }

  setMonitorOutput(output: number | null, mode: "MONO" | "DUAL_MONO" = this.monitorOutputMode): void {
    if (output !== null) {
      this.assertOutput(output);
      if (mode === "DUAL_MONO") this.assertOutput(output + 1);
    }
    this.#beforeTopologyMutation();
    this.monitorOutput = output;
    this.monitorOutputMode = mode;
    this.#afterTopologyMutation();
  }

  monitorSourceBlock(): Float32Array | null {
    return this.emergencyMuted ? null : this.#executionPlan.monitorSource;
  }

  addMatrixRoute(route: MatrixRoute): void {
    this.assertOutput(route.output);
    this.matrixRoutes.set(route.id, { ...route });
  }

  /** Reorders an existing channel membership with one off-callback plan rebuild. */
  setChannelOrder(orderedChannels: readonly AudioChannel[]): void {
    if (orderedChannels.length !== this.channels.size) throw new Error("channel order must include every live channel");
    for (let index = 0; index < orderedChannels.length; index += 1) {
      const channel = orderedChannels[index];
      if (this.channels.get(channel.id) !== channel) throw new Error("channel order must preserve live channel membership");
    }
    this.#withTopologyBatch(() => {
      this.channels.clear();
      for (let index = 0; index < orderedChannels.length; index += 1) {
        const channel = orderedChannels[index];
        this.channels.set(channel.id, channel);
      }
    });
  }

  processBlock(): void {
    const started = performance.now();
    this.#processing = true;
    try {
      this.#processBlockFromPlan();
    } catch (error) {
      if (error !== TOPOLOGY_MUTATION_DURING_PROCESSING) throw error;
      this.#zeroOutputs();
      this.topologyMutationFaults = saturatingIncrement(this.topologyMutationFaults);
    } finally {
      this.#processing = false;
      this.#finishBlockTiming(started);
    }
  }

  private mixToOutput(output: number, source: Float32Array, gainDb: number): void {
    const target = this.outputs[output];
    if (!target) return;
    const gain = this.emergencyMuted ? 0 : dbToGain(gainDb);
    for (let index = 0; index < target.length; index += 1) target[index] += source[index] * gain;
  }

  /** The normal callback path uses only private, callback-stable plan arrays and indexed loops. */
  #processBlockFromPlan(): void {
    const plan = this.#executionPlan;
    for (let outputIndex = 0; outputIndex < this.outputs.length; outputIndex += 1) this.outputs[outputIndex].fill(0);
    for (let busIndex = 0; busIndex < plan.buses.length; busIndex += 1) plan.buses[busIndex].beginBlock();

    for (let channelIndex = 0; channelIndex < plan.channels.length; channelIndex += 1) {
      const channelPlan = plan.channels[channelIndex];
      const channel = channelPlan.channel;
      channel.process(this.sampleRate, this.emergencyMuted);
      for (let sendIndex = 0; sendIndex < channelPlan.sends.length; sendIndex += 1) {
        const sendPlan = channelPlan.sends[sendIndex];
        if (!sendPlan.send.mute) sendPlan.bus.add(channel.processed, sendPlan.send.gainDb);
      }
      const direct = channel.directOutput;
      if (direct && !direct.mute) this.mixToOutput(direct.output, direct.tap === "PRE" ? channel.processed : channel.post, direct.gainDb);
    }

    for (let busIndex = 0; busIndex < plan.buses.length; busIndex += 1) {
      const bus = plan.buses[busIndex];
      if (bus.groupSourceIds === null) bus.finish(this.sampleRate, this.emergencyMuted);
    }
    for (let index = 0; index < plan.groups.length; index++) {
      const group = plan.groups[index];
      for (let source = 0; source < group.sources.length; source++) group.bus.add(group.sources[source].buffer, 0);
      group.bus.finish(this.sampleRate, this.emergencyMuted);
    }
    if (plan.monitorSource && plan.monitorOutput !== null) {
      this.mixToOutput(plan.monitorOutput, plan.monitorSource, 0);
      if (plan.monitorOutputMode === "DUAL_MONO") this.mixToOutput(plan.monitorOutput + 1, plan.monitorSource, 0);
    }
    for (let routeIndex = 0; routeIndex < plan.matrixRoutes.length; routeIndex += 1) {
      const routePlan = plan.matrixRoutes[routeIndex];
      if (!routePlan.route.mute) this.mixToOutput(routePlan.route.output, routePlan.source, routePlan.route.gainDb);
    }
    if (!this.emergencyMuted) {
      const testGain = dbToGain(-24);
      const phaseStep = (2 * Math.PI * 1000) / this.sampleRate;
      for (let toneIndex = 0; toneIndex < plan.outputTestToneIndices.length; toneIndex += 1) {
        const outputIndex = plan.outputTestToneIndices[toneIndex];
        const output = this.outputs[outputIndex];
        if (!output) continue;
        let phase = this.outputTestTonePhases[outputIndex];
        for (let frame = 0; frame < output.length; frame += 1) {
          output[frame] += Math.sin(phase) * testGain;
          phase += phaseStep;
          if (phase >= 2 * Math.PI) phase -= 2 * Math.PI;
        }
        this.outputTestTonePhases[outputIndex] = phase;
      }
    }
    for (let outputIndex = 0; outputIndex < this.outputs.length; outputIndex += 1) {
      const output = this.outputs[outputIndex];
      if (!finiteBuffer(output)) output.fill(0);
    }
  }

  #beforeTopologyMutation(): void {
    if (this.#processing) throw TOPOLOGY_MUTATION_DURING_PROCESSING;
  }

  #afterChannelMutation(mutation: TopologyMutation<string, AudioChannel>): void {
    if (mutation.kind === "set") {
      if (mutation.previous && mutation.previous !== mutation.value) mutation.previous.setTopologyObserver(NOOP_TOPOLOGY_BEFORE, NOOP_TOPOLOGY_AFTER as TopologyAfter<string, VcSend>);
      mutation.value.setTopologyObserver(() => this.#beforeTopologyMutation(), () => this.#afterTopologyMutation());
    } else if (mutation.kind === "delete" && mutation.previous) {
      mutation.previous.setTopologyObserver(NOOP_TOPOLOGY_BEFORE, NOOP_TOPOLOGY_AFTER as TopologyAfter<string, VcSend>);
    } else if (mutation.kind === "clear") {
      // A direct clear cannot expose removed values. Rebuild detaches all live observers below.
    }
    this.#afterTopologyMutation();
  }

  #afterTopologyMutation(): void {
    this.#topologyDirty = true;
    if (this.#topologyBatchDepth === 0) this.#rebuildExecutionPlan();
  }

  #withTopologyBatch(action: () => void): void {
    this.#topologyBatchDepth += 1;
    try {
      action();
    } finally {
      this.#topologyBatchDepth -= 1;
      if (this.#topologyBatchDepth === 0 && this.#topologyDirty) this.#rebuildExecutionPlan();
    }
  }

  #rebuildExecutionPlan(): void {
    if (this.#processing) throw TOPOLOGY_MUTATION_DURING_PROCESSING;
    const channels: ChannelPlan[] = [];
    const buses: VcBus[] = [];
    const matrixRoutes: MatrixRoutePlan[] = [];
    const outputTestToneIndices: number[] = [];
    const busById = new Map<string, VcBus>();

    // Public direct Map.clear() does not report its removed values.  Detach all
    // prior channel observers during the off-callback rebuild, then attach the
    // current membership below.  A removed channel can no longer schedule work.
    for (let index = 0; index < this.#observedChannels.length; index += 1) {
      this.#observedChannels[index].setTopologyObserver(
        NOOP_TOPOLOGY_BEFORE,
        NOOP_TOPOLOGY_AFTER as TopologyAfter<string, VcSend>,
      );
    }
    this.#observedChannels = [];

    this.buses.forEach((bus, id) => {
      buses.push(bus);
      busById.set(id, bus);
    });
    this.channels.forEach((channel) => {
      channel.setTopologyObserver(() => this.#beforeTopologyMutation(), () => this.#afterTopologyMutation());
      this.#observedChannels.push(channel);
      const sends: ChannelSendPlan[] = [];
      channel.vcSends.forEach((send, busId) => {
        const bus = busById.get(busId);
        if (bus && bus.groupSourceIds === null) sends.push({ bus, send });
      });
      channels.push({ channel, sends });
    });
    this.matrixRoutes.forEach((route) => {
      const channel = this.channels.get(route.sourceId);
      const bus = busById.get(route.sourceId);
      const source = channel
        ? route.tap === "PRE" ? channel.processed : channel.post
        : bus?.buffer;
      if (source) matrixRoutes.push({ route, source });
    });
    const monitorChannel = this.monitorSourceId ? this.channels.get(this.monitorSourceId) : undefined;
    const monitorSource = monitorChannel?.processed ?? (this.monitorSourceId ? busById.get(this.monitorSourceId)?.preMaster : undefined) ?? null;
    this.outputTestTones.forEach((outputIndex) => outputTestToneIndices.push(outputIndex));
    const groups = buses.filter(bus => bus.groupSourceIds !== null).map(bus => ({ bus, sources: bus.groupSourceIds!.map(id => busById.get(id)).filter((source): source is VcBus => !!source && source.groupSourceIds === null) }));
    this.#executionPlan = { channels, buses, groups, matrixRoutes, monitorSource, monitorOutput: this.monitorOutput, monitorOutputMode: this.monitorOutputMode, outputTestToneIndices };
    this.#topologyDirty = false;
  }

  #zeroOutputs(): void {
    for (let outputIndex = 0; outputIndex < this.outputs.length; outputIndex += 1) this.outputs[outputIndex].fill(0);
  }

  #finishBlockTiming(started: number): void {
    const elapsedMs = performance.now() - started;
    this.lastBlockDurationMs = elapsedMs;
    const deadlineMs = (this.blockSize / this.sampleRate) * 1000;
    const load = elapsedMs / deadlineMs;
    this.callbackLoad = this.callbackLoad === 0 ? load : this.callbackLoad * 0.95 + load * 0.05;
    if (load > 1) this.xruns = saturatingIncrement(this.xruns);
    this.blocksProcessed = saturatingIncrement(this.blocksProcessed);
  }

  private assertOutput(output: number): void {
    if (!Number.isInteger(output) || output < 0 || output >= this.outputs.length) {
      throw new RangeError(`output must be 0..${this.outputs.length - 1}`);
    }
  }

  static createDemo(channelCount = 64): AudioEngine {
    const engine = new AudioEngine();
    const bus = new VcBus("interview", "INTERVIEW VC", engine.blockSize, engine.sampleRate);
    engine.addBus(bus);
    const safeCount = clamp(Math.round(channelCount), 0, MAX_RX_CHANNELS);
    for (let index = 0; index < safeCount; index += 1) {
      const id = `user-${String(index + 1).padStart(2, "0")}`;
      const source = new SineSource(140 + (index * 37) % 760, -24 + (index % 5) * 2);
      const channel = new AudioChannel(id, `Guest ${index + 1}`, "TestTone", source, engine.blockSize, engine.sampleRate);
      channel.vcSends.set(bus.id, { gainDb: -12, mute: false });
      channel.directOutput = { output: index % engine.outputChannelCount, tap: "PRE", gainDb: 0, mute: false };
      engine.addChannel(channel);
    }
    engine.addMatrixRoute({
      id: "interview-program",
      sourceId: bus.id,
      output: 63,
      gainDb: 0,
      mute: false,
      tap: "POST",
    });
    return engine;
  }
}

function finiteBuffer(buffer: Float32Array): boolean {
  for (let index = 0; index < buffer.length; index += 1) if (!Number.isFinite(buffer[index])) return false;
  return true;
}

function saturatingIncrement(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

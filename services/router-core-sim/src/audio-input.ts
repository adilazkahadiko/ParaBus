import { createRequire } from "node:module";
import type { DeviceInfo, IoStreamRead } from "naudiodon2";
import {
  MAX_LOCAL_INPUT_CHANNELS,
  MAX_RX_CHANNELS,
  type AudioInputDevice,
  type AudioInputSnapshot,
  type WindowsEndpointBindingSnapshot,
} from "../../../packages/shared-types/src/index.ts";
import { AudioChannel, AudioEngine, PcmRingSource, SineSource } from "./audio-engine.ts";
import type { WindowsDevicePresenceProvider } from "./windows-device-presence.ts";
import type { AsioDuplexStream } from "./asio-duplex.ts";

interface PortAudioModule {
  AudioIO: new (options: { inOptions: {
    channelCount: number;
    sampleFormat: 1;
    sampleRate: number;
    deviceId: number;
    framesPerBuffer: number;
    maxQueue: number;
    closeOnError: boolean;
  } }) => IoStreamRead;
  SampleFormatFloat32: 1;
  getDevices(): DeviceInfo[];
}

const DEVICE_PRESENCE_POLL_INTERVAL_MS = 1_000;
const PHYSICAL_INPUT_BUFFER_BLOCKS = 10;

function loadPortAudio(): PortAudioModule | null {
  try { return createRequire(import.meta.url)("naudiodon2") as PortAudioModule; }
  catch { return null; }
}

/** Numeric-only, capture-session totals; no device names, IDs or free text. */
export function inputTimingSummary(input: AudioInputSnapshot): string | null {
  const timing = input.captureTiming;
  if (!timing) return null;
  const total = timing.channels.reduce((sum, channel) => ({ underruns: sum.underruns + channel.underruns,
    missing: sum.missing + channel.missingFrames, dropped: sum.dropped + channel.droppedFrames }), { underruns: 0, missing: 0, dropped: 0 });
  return `Physical input timing totals: channels=${timing.channels.length}/${timing.physicalChannelCount} packets=${timing.packets} gapMax=${timing.maxPacketGapMs.toFixed(1)}ms underruns=${total.underruns} missing=${total.missing} dropped=${total.dropped}`;
}

/** Observe physical capture only; do not change the ring's audio or drop policy. */
class PhysicalInputSource extends PcmRingSource {
  received = false;
  underruns = 0;
  missingFrames = 0;
  maxQueuedFrames = 0;

  override pushFloat32Le(pcm: Uint8Array, channelIndex = 0, channelCount = 1): number {
    const frames = super.pushFloat32Le(pcm, channelIndex, channelCount);
    if (frames > 0) this.received = true;
    this.maxQueuedFrames = Math.max(this.maxQueuedFrames, this.queuedSamples);
    return frames;
  }

  override fill(target: Float32Array): boolean {
    // Exclude initial startup before capture has supplied any PCM. Physical
    // input is continuous (including silence), so no speech timeout applies.
    if (this.received && this.queuedSamples < target.length) {
      this.underruns++;
      this.missingFrames += target.length - this.queuedSamples;
    }
    return super.fill(target);
  }
}

export class AudioInputManager {
  readonly engine: AudioEngine;
  onFault?: (deviceId: string, message: string) => void;
  #portAudio: PortAudioModule | null;
  #devices: AudioInputDevice[] = [];
  #stream: IoStreamRead | null = null;
  #sourceIds: string[] = [];
  #sources: PhysicalInputSource[] = [];
  #diagnosticSources: PhysicalInputSource[] = [];
  #captureStartedAt: number | null = null;
  #captureStoppedAt: number | null = null;
  #physicalChannelCount = 0;
  #packets = 0;
  #minPacketBytes = Infinity;
  #maxPacketBytes = 0;
  #lastPacketAt: number | null = null;
  #lastPacketGapMs = 0;
  #maxPacketGapMs = 0;
  #partialFrame = Buffer.alloc(0);
  #partialFrameBytes = 0;
  #closing = false;
  #state: AudioInputSnapshot["state"] = "UNSELECTED";
  #selectedDeviceId: string | null = null;
  #selectedDeviceName: string | null = null;
  #activeChannelCount = 0;
  #framesCaptured = 0;
  #peak = 0;
  #error: string | null = null;
  #streamGeneration = 0;
  #selectedDeviceIdentity: AudioInputDevice | null = null;
  #windowsEndpointBinding: WindowsEndpointBindingSnapshot | null = null;
  #presenceTimer: NodeJS.Timeout | null = null;
  #presencePollIntervalMs: number;
  #presenceProvider: WindowsDevicePresenceProvider | null;
  #platform: NodeJS.Platform;
  #presencePollPending = false;
  #presenceUnavailableUnsubscribe: (() => void) | null = null;
  #asioDuplex: AsioDuplexStream | null;

  constructor(engine: AudioEngine, portAudio = loadPortAudio(), presencePollIntervalMs = DEVICE_PRESENCE_POLL_INTERVAL_MS, presenceProvider: WindowsDevicePresenceProvider | null = null, platform: NodeJS.Platform = process.platform, asioDuplex: AsioDuplexStream | null = null) {
    this.engine = engine;
    this.#portAudio = portAudio;
    this.#presencePollIntervalMs = Math.max(1, Math.trunc(presencePollIntervalMs));
    this.#presenceProvider = presenceProvider;
    this.#platform = platform;
    this.#asioDuplex = asioDuplex;
    this.refreshDevices();
  }

  refreshDevices(): AudioInputDevice[] {
    const devices: AudioInputDevice[] = [{ id: "mock-studio-8", name: "Mock Studio 8ch Input", hostApi: "Simulator", maxInputChannels: 8, defaultSampleRate: this.engine.sampleRate }];
    if (this.#portAudio) {
      try {
        for (const device of this.#portAudio.getDevices()) {
          if (device.maxInputChannels < 1) continue;
          devices.push({ id: `pa:${device.id}`, name: device.name, hostApi: device.hostAPIName, maxInputChannels: device.maxInputChannels, defaultSampleRate: device.defaultSampleRate });
        }
      } catch (error) {
        this.#error = `入力デバイス一覧を取得できません: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    this.#devices = devices;
    if (this.#platform !== "win32" && this.#selectedDeviceId?.startsWith("pa:") && this.#state === "READY" && !devices.some((device) => this.matchesSelectedDevice(device))) {
      this.fail(this.#selectedDeviceId, "選択中の入力デバイスが見つかりません");
    }
    return devices.map((device) => ({ ...device }));
  }

  selectDevice(deviceId: string, requestedChannels: number, windowsEndpointId?: string): void {
    const device = this.#devices.find((candidate) => candidate.id === deviceId);
    if (!device) throw new Error(`不明な入力デバイスです: ${deviceId}`);
    const numericId = device.id.startsWith("pa:") ? Number(device.id.slice(3)) : null;
    if (device.hostApi === "ASIO") this.#asioDuplex?.assertSelectable(numericId!);
    const binding = this.bindingForSelection(device, windowsEndpointId);
    this.stop();
    const availableSlots = MAX_RX_CHANNELS - this.engine.channels.size;
    const channelCount = Math.min(Math.max(1, Math.trunc(requestedChannels)), device.maxInputChannels, MAX_LOCAL_INPUT_CHANNELS, availableSlots);
    if (channelCount < 1) throw new Error("Audio Input channelを追加できる空きがありません");
    this.#selectedDeviceId = device.id;
    this.#selectedDeviceName = device.name;
    this.#selectedDeviceIdentity = { ...device };
    this.#windowsEndpointBinding = binding;
    this.#activeChannelCount = channelCount;
    this.#framesCaptured = 0;
    this.#peak = 0;
    this.#error = null;
    this.#diagnosticSources = [];
    this.#captureStartedAt = null;
    this.#captureStoppedAt = null;
    this.#physicalChannelCount = device.hostApi === "ASIO" ? device.maxInputChannels : channelCount;
    this.#packets = 0;
    this.#minPacketBytes = Infinity;
    this.#maxPacketBytes = 0;
    this.#lastPacketAt = null;
    this.#lastPacketGapMs = this.#maxPacketGapMs = 0;
    this.#partialFrame = Buffer.alloc(this.#physicalChannelCount * 4);
    this.#partialFrameBytes = 0;

    if (device.id === "mock-studio-8") {
      for (let index = 0; index < channelCount; index += 1) {
        const id = `local-input:${index + 1}`;
        this.engine.addChannel(new AudioChannel(id, `STUDIO IN ${index + 1}`, "LocalMonoInput", new SineSource(220 + index * 55, -24), this.engine.blockSize, this.engine.sampleRate));
        this.#sourceIds.push(id);
      }
      this.#state = "READY";
      return;
    }
    if (!this.#portAudio) throw new Error("PortAudio input backendを読み込めません");
    // Capture and the JS graph run on separate clocks. Keep only a short,
    // bounded cushion so clock drift drops old audio instead of becoming
    // seconds of monitoring/TX latency.
    this.#sources = Array.from({ length: channelCount }, () => new PhysicalInputSource(this.engine.blockSize * PHYSICAL_INPUT_BUFFER_BLOCKS));
    this.#diagnosticSources = this.#sources;
    this.#captureStartedAt = performance.now();
    for (let index = 0; index < channelCount; index += 1) {
      const id = `local-input:${index + 1}`;
      this.engine.addChannel(new AudioChannel(id, `STUDIO IN ${index + 1}`, "LocalMonoInput", this.#sources[index], this.engine.blockSize, this.engine.sampleRate));
      this.#sourceIds.push(id);
    }
    if (device.hostApi === "ASIO") {
      if (!this.#asioDuplex) {
        this.failClosed("ASIO full-duplex backendを読み込めません");
        throw new Error(`入力デバイスを開けません: ${this.#error}`);
      }
      this.#state = "READY";
      try {
        this.#asioDuplex.selectInput(
          { deviceId: numericId!, channelCount, sampleRate: this.engine.sampleRate, blockSize: this.engine.blockSize },
          (buffer, physicalChannelCount) => { if (this.#state === "READY" && this.#selectedDeviceId === device.id) this.ingest(buffer, physicalChannelCount); },
          (message) => this.fail(device.id, message),
        );
      } catch (error) {
        this.failClosed(error instanceof Error ? error.message : String(error));
        throw new Error(`入力デバイスを開けません: ${this.#error}`);
      }
      return;
    }
    try {
      this.#closing = false;
      const generation = this.#streamGeneration + 1;
      const stream = new this.#portAudio.AudioIO({ inOptions: { channelCount, sampleFormat: this.#portAudio.SampleFormatFloat32, sampleRate: this.engine.sampleRate, deviceId: numericId!, framesPerBuffer: this.engine.blockSize, maxQueue: 8, closeOnError: true } });
      stream.on("data", (chunk) => {
        if (stream === this.#stream && generation === this.#streamGeneration && this.#state === "READY") this.ingest(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
      });
      stream.on("error", (error) => {
        if (stream === this.#stream && generation === this.#streamGeneration) this.fail(device.id, error instanceof Error ? error.message : String(error));
      });
      stream.on("close", () => {
        if (stream === this.#stream && generation === this.#streamGeneration && !this.#closing && this.#state === "READY") this.fail(device.id, "入力ストリームが終了しました");
      });
      this.#stream = stream;
      this.#streamGeneration = generation;
      this.#state = "READY";
      stream.start();
      if (stream === this.#stream && generation === this.#streamGeneration && this.#state === "READY") this.startPresenceMonitor(stream, generation);
    } catch (error) {
      this.fail(device.id, error instanceof Error ? error.message : String(error));
      throw new Error(`入力デバイスを開けません: ${this.#error}`);
    }
  }

  stop(): void {
    this.closeStreamAndSources();
    if (this.#state !== "UNSELECTED") this.#state = "STOPPED";
    this.#activeChannelCount = 0;
    this.#peak = 0;
  }

  /** Clears captured PCM and latches the input path closed until explicit device selection. */
  failClosed(message: string): void {
    this.closeStreamAndSources();
    this.#state = "FAULT";
    this.#error = message;
    this.#activeChannelCount = 0;
    this.#peak = 0;
  }

  snapshot(): AudioInputSnapshot {
    const now = this.#captureStoppedAt ?? performance.now();
    const captureTiming = this.#captureStartedAt === null ? null : {
      elapsedMs: Math.max(0, now - this.#captureStartedAt), physicalChannelCount: this.#physicalChannelCount,
      packets: this.#packets, minPacketBytes: this.#packets ? this.#minPacketBytes : 0, maxPacketBytes: this.#maxPacketBytes,
      lastPacketGapMs: this.#lastPacketGapMs, maxPacketGapMs: this.#maxPacketGapMs,
      lastPacketAgeMs: this.#lastPacketAt === null ? null : Math.max(0, now - this.#lastPacketAt),
      pendingFrameBytes: this.#partialFrameBytes,
      channels: this.#diagnosticSources.map((source, index) => ({ channel: index + 1, queuedFrames: source.queuedSamples,
        maxQueuedFrames: source.maxQueuedFrames, underruns: source.underruns, missingFrames: source.missingFrames, droppedFrames: source.droppedSamples })),
    };
    return { state: this.#state, selectedDeviceId: this.#selectedDeviceId, selectedDeviceName: this.#selectedDeviceName, selectedHostApi: this.#selectedDeviceIdentity?.hostApi ?? null, activeChannelCount: this.#activeChannelCount, sampleRate: this.engine.sampleRate, framesCaptured: this.#framesCaptured, captureTiming, peak: this.#peak, error: this.#error, devices: this.#devices.map((device) => ({ ...device })), windowsEndpointBinding: this.#windowsEndpointBinding ? { ...this.#windowsEndpointBinding } : null };
  }

  presenceMonitoringReady(): boolean {
    if (this.#selectedDeviceIdentity?.hostApi === "ASIO") return this.#state === "READY";
    if (this.#platform !== "win32" || !this.#selectedDeviceId?.startsWith("pa:")) return true;
    return this.#presenceProvider?.isAvailable() === true
      && this.#windowsEndpointBinding?.direction === "capture"
      && this.#windowsEndpointBinding.state === "ACTIVE"
      && this.#windowsEndpointBinding.monitoring === "ACTIVE";
  }

  private ingest(buffer: Buffer, physicalChannelCount = this.#sources.length): void {
    if (!buffer.length || physicalChannelCount < 1) return;
    const now = performance.now();
    if (this.#lastPacketAt !== null) {
      this.#lastPacketGapMs = Math.max(0, now - this.#lastPacketAt);
      this.#maxPacketGapMs = Math.max(this.#maxPacketGapMs, this.#lastPacketGapMs);
    }
    this.#lastPacketAt = now;
    this.#packets++;
    this.#minPacketBytes = Math.min(this.#minPacketBytes, buffer.length);
    this.#maxPacketBytes = Math.max(this.#maxPacketBytes, buffer.length);
    const stride = physicalChannelCount * 4;
    // Normally ASIO reads whole blocks. Preserve partial frames defensively:
    // discarding a byte remainder would permanently rotate the input lanes.
    let offset = 0;
    this.#peak = 0;
    if (this.#partialFrameBytes) {
      const count = Math.min(stride - this.#partialFrameBytes, buffer.length);
      buffer.copy(this.#partialFrame, this.#partialFrameBytes, 0, count);
      this.#partialFrameBytes += count;
      offset = count;
      if (this.#partialFrameBytes < stride) return;
      this.ingestFrames(this.#partialFrame, physicalChannelCount);
      this.#partialFrameBytes = 0;
    }
    const end = offset + Math.floor((buffer.length - offset) / stride) * stride;
    if (end > offset) this.ingestFrames(offset === 0 && end === buffer.length ? buffer : buffer.subarray(offset, end), physicalChannelCount);
    if (end < buffer.length) {
      this.#partialFrameBytes = buffer.copy(this.#partialFrame, 0, end);
    }
  }

  private ingestFrames(buffer: Buffer, physicalChannelCount: number): void {
    let peak = 0;
    for (let channel = 0; channel < this.#sources.length; channel += 1) this.#sources[channel].pushFloat32Le(buffer, channel, physicalChannelCount);
    for (let offset = 0; offset + 4 <= buffer.length; offset += 4) peak = Math.max(peak, Math.abs(buffer.readFloatLE(offset)));
    this.#peak = Math.max(this.#peak, peak);
    this.#framesCaptured += Math.floor(buffer.length / (4 * Math.max(1, physicalChannelCount)));
  }

  private fail(deviceId: string, message: string): void {
    if (this.#state === "FAULT") return;
    this.failClosed(message);
    this.onFault?.(deviceId, message);
  }

  private closeStreamAndSources(): void {
    if (this.#captureStartedAt !== null && this.#captureStoppedAt === null) this.#captureStoppedAt = performance.now();
    this.#partialFrameBytes = 0;
    this.stopPresenceMonitor();
    if (this.#selectedDeviceIdentity?.hostApi === "ASIO") this.#asioDuplex?.clearInput();
    this.#closing = true;
    this.#streamGeneration += 1;
    const stream = this.#stream;
    this.#stream = null;
    if (stream) {
      const generation = this.#streamGeneration;
      try {
        Promise.resolve(stream.abort()).catch((error) => {
          if (generation === this.#streamGeneration) this.fail(this.#selectedDeviceId ?? "unknown", String(error));
        });
      } catch (error) { this.#error = String(error); }
    }
    for (const source of this.#sources) source.clear();
    for (const id of this.#sourceIds) this.engine.removeChannel(id);
    this.#sourceIds = [];
    this.#sources = [];
  }

  private matchesSelectedDevice(device: AudioInputDevice): boolean {
    const selected = this.#selectedDeviceIdentity;
    return selected !== null
      && device.id === selected.id
      && device.name === selected.name
      && device.hostApi === selected.hostApi
      && device.maxInputChannels === selected.maxInputChannels
      && device.defaultSampleRate === selected.defaultSampleRate;
  }

  private bindingForSelection(device: AudioInputDevice, endpointId?: string): WindowsEndpointBindingSnapshot | null {
    if (!device.id.startsWith("pa:") || this.#platform !== "win32" || device.hostApi === "ASIO") return null;
    if (!this.#presenceProvider?.isAvailable()) {
      throw new Error("Windows endpoint presence provider is unavailable");
    }
    if (!endpointId) throw new Error("Windows capture endpoint binding is required");
    const endpoint = this.#presenceProvider.cachedEndpoint(endpointId, "capture");
    if (!endpoint || endpoint.state !== "ACTIVE") {
      throw new Error("Selected Windows capture endpoint is not active");
    }
    return { endpointId: endpoint.id, endpointName: endpoint.name, direction: endpoint.direction, state: endpoint.state, monitoring: "ACTIVE" };
  }

  private startPresenceMonitor(stream: IoStreamRead, generation: number): void {
    this.stopPresenceMonitor();
    const endpointId = this.#windowsEndpointBinding?.endpointId;
    const provider = this.#presenceProvider;
    if (this.#platform !== "win32") {
      const timer = setInterval(() => {
        if (stream === this.#stream && generation === this.#streamGeneration && this.#state === "READY") this.refreshDevices();
      }, this.#presencePollIntervalMs);
      timer.unref();
      this.#presenceTimer = timer;
      return;
    }
    if (!endpointId || !provider) return;
    this.#presenceUnavailableUnsubscribe = provider.onUnavailable?.(() => {
      if (stream !== this.#stream || generation !== this.#streamGeneration || this.#state !== "READY") return;
      if (this.#windowsEndpointBinding) this.#windowsEndpointBinding = { ...this.#windowsEndpointBinding, monitoring: "UNAVAILABLE" };
      this.fail(this.#selectedDeviceId ?? "unknown", "Windows input presence provider is unavailable");
    }) ?? null;
    const check = async () => {
      if (this.#presencePollPending || stream !== this.#stream || generation !== this.#streamGeneration || this.#state !== "READY") return;
      this.#presencePollPending = true;
      try {
        const endpoints = await provider.refreshEndpoints();
        if (stream !== this.#stream || generation !== this.#streamGeneration || this.#state !== "READY" || endpointId !== this.#windowsEndpointBinding?.endpointId) return;
        const endpoint = endpoints.find((candidate) => candidate.id === endpointId && candidate.direction === "capture");
        if (!endpoint || endpoint.state !== "ACTIVE") {
          if (this.#windowsEndpointBinding) this.#windowsEndpointBinding = { ...this.#windowsEndpointBinding, state: endpoint?.state ?? "NOT_PRESENT" };
          this.fail(this.#selectedDeviceId ?? "unknown", "Selected Windows input endpoint is unavailable");
        }
      } catch {
        if (stream === this.#stream && generation === this.#streamGeneration && this.#state === "READY") {
          if (this.#windowsEndpointBinding) this.#windowsEndpointBinding = { ...this.#windowsEndpointBinding, monitoring: "UNAVAILABLE" };
          this.fail(this.#selectedDeviceId ?? "unknown", "Windows input presence provider is unavailable");
        }
      } finally {
        if (stream === this.#stream && generation === this.#streamGeneration) this.#presencePollPending = false;
      }
    };
    const timer = setInterval(() => void check(), this.#presencePollIntervalMs);
    timer.unref();
    this.#presenceTimer = timer;
    void check();
  }

  private stopPresenceMonitor(): void {
    if (this.#presenceTimer) clearInterval(this.#presenceTimer);
    this.#presenceTimer = null;
    this.#presenceUnavailableUnsubscribe?.();
    this.#presenceUnavailableUnsubscribe = null;
    this.#presencePollPending = false;
  }
}

import { createRequire } from "node:module";
import type { DeviceInfo, IoStreamWrite } from "naudiodon2";
import type {
  AudioOutputDevice,
  AudioOutputSnapshot,
  AudioFaultClassification,
  AudioFaultDiagnostic,
  WindowsEndpointBindingSnapshot,
} from "../../../packages/shared-types/src/index.ts";
import type { WindowsDevicePresenceProvider } from "./windows-device-presence.ts";
import type { AsioDuplexStream } from "./asio-duplex.ts";
import { OutputWriteTiming } from "./audio-timing.ts";

interface PortAudioModule {
  AudioIO: new (options: {
    outOptions: {
      channelCount: number;
      sampleFormat: 1;
      sampleRate: number;
      deviceId: number;
      framesPerBuffer: number;
      maxQueue: number;
      closeOnError: boolean;
    };
  }) => IoStreamWrite;
  SampleFormatFloat32: 1;
  getDevices(): DeviceInfo[];
}

const DEVICE_PRESENCE_POLL_INTERVAL_MS = 1_000;

function loadPortAudio(): PortAudioModule | null {
  try {
    return createRequire(import.meta.url)("naudiodon2") as PortAudioModule;
  } catch {
    return null;
  }
}

export class AudioOutputManager {
  readonly sampleRate: number;
  readonly blockSize: number;
  readonly maximumChannels: number;
  onFault?: (deviceId: string, message: string, diagnostic: AudioFaultDiagnostic) => void;
  #portAudio: PortAudioModule | null;
  #devices: AudioOutputDevice[] = [];
  #stream: IoStreamWrite | null = null;
  #buffers: Buffer[] = [];
  #availableBuffers: Buffer[] = [];
  #closing = false;
  #state: AudioOutputSnapshot["state"] = "READY";
  #selectedDeviceId: string | null = "mock-64";
  #selectedDeviceName: string | null = "Mock 64ch Output";
  #activeChannelCount: number;
  #framesWritten = 0;
  #backpressureDrops = 0;
  #peak = 0;
  #error: string | null = null;
  #streamGeneration = 0;
  #selectedDeviceIdentity: AudioOutputDevice | null = null;
  #windowsEndpointBinding: WindowsEndpointBindingSnapshot | null = null;
  #presenceTimer: NodeJS.Timeout | null = null;
  #presencePollIntervalMs: number;
  #presenceProvider: WindowsDevicePresenceProvider | null;
  #platform: NodeJS.Platform;
  #presencePollPending = false;
  #presenceUnavailableUnsubscribe: (() => void) | null = null;
  #asioDuplex: AsioDuplexStream | null;
  #writeTiming: OutputWriteTiming | null = null;
  #writeViews = new Map<Buffer, readonly Buffer[]>();
  #backlogEwma = 1.5;
  #primingRemaining = 0;

  constructor(sampleRate: number, blockSize: number, maximumChannels: number, portAudio = loadPortAudio(), presencePollIntervalMs = DEVICE_PRESENCE_POLL_INTERVAL_MS, presenceProvider: WindowsDevicePresenceProvider | null = null, platform: NodeJS.Platform = process.platform, asioDuplex: AsioDuplexStream | null = null) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
    this.maximumChannels = maximumChannels;
    this.#activeChannelCount = maximumChannels;
    this.#portAudio = portAudio;
    this.#presencePollIntervalMs = Math.max(1, Math.trunc(presencePollIntervalMs));
    this.#presenceProvider = presenceProvider;
    this.#platform = platform;
    this.#asioDuplex = asioDuplex;
    this.refreshDevices();
  }

  refreshDevices(): AudioOutputDevice[] {
    const devices: AudioOutputDevice[] = [{
      id: "mock-64",
      name: "Mock 64ch Output",
      backend: "mock",
      hostApi: "Simulator",
      maxOutputChannels: this.maximumChannels,
      defaultSampleRate: this.sampleRate,
    }];
    if (this.#portAudio) {
      try {
        for (const device of this.#portAudio.getDevices()) {
          if (device.maxOutputChannels < 1) continue;
          devices.push({
            id: `pa:${device.id}`,
            name: device.name,
            backend: "portaudio",
            hostApi: device.hostAPIName,
            maxOutputChannels: device.maxOutputChannels,
            defaultSampleRate: device.defaultSampleRate,
          });
        }
      } catch (error) {
        this.#error = `デバイス一覧を取得できません: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    this.#devices = devices;
    if (this.#platform !== "win32" && this.#selectedDeviceId?.startsWith("pa:") && this.#state === "READY" && !devices.some((device) => this.matchesSelectedDevice(device))) {
      this.fail(this.#selectedDeviceId, "選択中の出力デバイスが見つかりません", "DEVICE_UNAVAILABLE");
    }
    return devices.map((device) => ({ ...device }));
  }

  selectDevice(deviceId: string, windowsEndpointId?: string): void {
    const device = this.#devices.find((candidate) => candidate.id === deviceId);
    if (!device) throw new Error(`不明な出力デバイスです: ${deviceId}`);
    const numericId = device.backend === "portaudio" ? Number(device.id.slice(3)) : null;
    if (device.hostApi === "ASIO") this.#asioDuplex?.assertSelectable(numericId!);
    const binding = this.bindingForSelection(device, windowsEndpointId);
    this.stop();
    this.#writeTiming = null;
    this.#error = null;
    this.#framesWritten = 0;
    this.#backpressureDrops = 0;
    this.#peak = 0;
    if (device.backend === "mock") {
      this.#selectedDeviceId = device.id;
      this.#selectedDeviceName = device.name;
      this.#selectedDeviceIdentity = { ...device };
      this.#windowsEndpointBinding = null;
      this.#activeChannelCount = device.maxOutputChannels;
      this.#state = "READY";
      return;
    }
    if (!this.#portAudio) throw new Error("PortAudio backendを読み込めません");

    const channelCount = Math.min(this.maximumChannels, device.maxOutputChannels);
    if (device.hostApi === "ASIO") {
      if (!this.#asioDuplex) throw new Error("ASIO full-duplex backendを読み込めません");
      this.#selectedDeviceId = device.id;
      this.#selectedDeviceName = device.name;
      this.#selectedDeviceIdentity = { ...device };
      this.#windowsEndpointBinding = null;
      this.#activeChannelCount = channelCount;
      this.#state = "READY";
      try {
        this.#asioDuplex.selectOutput({ deviceId: numericId!, channelCount, sampleRate: this.sampleRate, blockSize: this.blockSize }, (message) => this.fail(device.id, message, "ASIO_FAULT"));
      } catch (error) {
        this.failClosed(error instanceof Error ? error.message : String(error));
        throw new Error(`出力デバイスを開けません: ${this.#error}`);
      }
      return;
    }
    try {
      this.#closing = false;
      const generation = this.#streamGeneration + 1;
      const wasapi = /WASAPI/i.test(device.hostApi);
      const stream = new this.#portAudio.AudioIO({
        outOptions: {
          channelCount,
          sampleFormat: this.#portAudio.SampleFormatFloat32,
          sampleRate: this.sampleRate,
          deviceId: numericId!,
          framesPerBuffer: this.blockSize,
          maxQueue: wasapi ? 6 : 8,
          closeOnError: true,
        },
      });
      stream.on("error", (error) => {
        if (stream === this.#stream && generation === this.#streamGeneration) this.fail(device.id, error instanceof Error ? error.message : String(error), "STREAM_ERROR");
      });
      stream.on("close", () => {
        if (stream === this.#stream && generation === this.#streamGeneration && !this.#closing && this.#state === "READY") this.fail(device.id, "出力ストリームが終了しました", "STREAM_ENDED");
      });
      this.#buffers = Array.from({ length: 8 }, () => Buffer.allocUnsafe((this.blockSize + (wasapi ? 1 : 0)) * channelCount * 4));
      this.#writeViews.clear();
      if (wasapi) for (const buffer of this.#buffers) {
        this.#writeViews.set(buffer, [-1, 0, 1].map(delta => buffer.subarray(0, (this.blockSize + delta) * channelCount * 4)));
      }
      this.#availableBuffers = [...this.#buffers];
      this.#stream = stream;
      this.#streamGeneration = generation;
      this.#selectedDeviceId = device.id;
      this.#selectedDeviceName = device.name;
      this.#selectedDeviceIdentity = { ...device };
      this.#windowsEndpointBinding = binding;
      this.#activeChannelCount = channelCount;
      this.#state = "READY";
      this.#backlogEwma = 1.5;
      this.#primingRemaining = wasapi ? 6 : 0;
      if (wasapi) {
        this.#writeTiming = new OutputWriteTiming();
        // Fill the six native queue slots with silence before enabling control.
        // Keep ownership of each JS buffer until its write callback returns.
        for (let i = 0; i < 6; i++) {
          if (this.#stream !== stream || this.#state !== "READY") throw new Error(this.#error ?? "Output stopped during priming");
          const buffer = this.#availableBuffers.pop()!;
          buffer.fill(0);
          this.writeBuffer(buffer, this.blockSize, true);
        }
      }
      if (this.#stream !== stream || this.#state !== "READY") throw new Error(this.#error ?? "Output stopped during priming");
      if (!wasapi) {
        stream.start();
      }
      if (stream === this.#stream && generation === this.#streamGeneration && this.#state === "READY") this.startPresenceMonitor(stream, generation);
    } catch (error) {
      this.#selectedDeviceId = device.id;
      this.#selectedDeviceName = device.name;
      this.failClosed(error instanceof Error ? error.message : String(error));
      throw new Error(`出力デバイスを開けません: ${this.#error}`);
    }
  }

  writeBlock(outputs: readonly Float32Array[]): void {
    if (this.#state !== "READY") return;
    if (this.#selectedDeviceId === "mock-64") {
      let peak = 0;
      for (let channel = 0; channel < this.#activeChannelCount; channel += 1) {
        const source = outputs[channel];
        if (!source) continue;
        for (let frame = 0; frame < source.length; frame += 1) peak = Math.max(peak, Math.abs(source[frame]));
      }
      this.#peak = peak;
      this.#framesWritten += this.blockSize;
      return;
    }
    if (this.#selectedDeviceIdentity?.hostApi === "ASIO") {
      const result = this.#asioDuplex?.writeBlock(outputs) ?? { accepted: false, peak: 0 };
      this.#peak = result.peak;
      if (result.accepted) this.#framesWritten += this.blockSize;
      else this.#backpressureDrops += 1;
      return;
    }
    const stream = this.#stream;
    const timing = this.#writeTiming;
    const backlog = this.#buffers.length - this.#availableBuffers.length;
    let adjustment = 0;
    if (timing) {
      timing.observeInFlight(backlog, performance.now());
      if (this.#primingRemaining === 0) {
        this.#backlogEwma += 0.02 * (backlog - this.#backlogEwma);
        adjustment = this.#backlogEwma > 2.25 ? -1 : this.#backlogEwma < 0.75 ? 1 : 0;
      }
    }
    const buffer = this.#availableBuffers.pop();
    if (!stream || !buffer) {
      this.#backpressureDrops += 1;
      timing?.drop(performance.now());
      return;
    }
    let peak = 0;
    let offset = 0;
    const frames = this.blockSize + adjustment;
    for (let frame = 0; frame < frames; frame += 1) {
      // End-point preserving interpolation: neighbouring blocks keep precisely
      // their original boundary samples. A zero correction is bit-identical.
      const position = frame === frames - 1 ? this.blockSize - 1 : frame * (this.blockSize - 1) / (frames - 1);
      const left = adjustment ? Math.floor(position) : frame;
      const fraction = adjustment ? position - left : 0;
      for (let channel = 0; channel < this.#activeChannelCount; channel += 1) {
        const source = outputs[channel];
        const a = source?.[left] ?? 0;
        const sample = fraction ? a + ((source?.[left + 1] ?? a) - a) * fraction : a;
        peak = Math.max(peak, Math.abs(sample));
        buffer.writeFloatLE(sample, offset);
        offset += 4;
      }
    }
    this.#peak = peak;
    timing?.correction(adjustment, this.blockSize, this.#backlogEwma);
    this.writeBuffer(buffer, frames);
  }

  private writeBuffer(buffer: Buffer, frames: number, priming = false): void {
    const stream = this.#stream!, timing = this.#writeTiming;
    this.#framesWritten += frames;
    if (priming) timing!.primingFrames += frames;
    try {
      const generation = this.#streamGeneration;
      const writeAt = timing ? performance.now() : 0;
      const view = this.#writeViews.get(buffer)?.[frames - this.blockSize + 1] ?? buffer;
      stream.write(view, () => {
        if (generation === this.#streamGeneration && this.#state === "READY") {
          if (timing) { const now = performance.now(); timing.callback(now - writeAt, now); }
          this.#availableBuffers.push(buffer);
          if (priming && --this.#primingRemaining === 0) {
            try {
              stream.start();
            } catch (error) { this.fail(this.#selectedDeviceId ?? "unknown", String(error), "STREAM_ERROR"); }
          }
        }
      });
    } catch (error) {
      this.#availableBuffers.push(buffer);
      this.fail(this.#selectedDeviceId ?? "unknown", error instanceof Error ? error.message : String(error), "STREAM_ERROR");
    }
  }

  stop(): void {
    this.closeStream();
    this.#state = "STOPPED";
    this.#activeChannelCount = 0;
    this.#peak = 0;
  }

  /** Synchronously rejects new blocks and aborts the backend queue. Re-selection is required. */
  emergencyStop(): void {
    if (this.#selectedDeviceIdentity?.hostApi === "ASIO") this.#asioDuplex?.emergencyStop();
    this.stop();
    this.#error = "Emergency mute latched; explicitly re-select the output device before release";
  }

  /** Latches a physical output fault without selecting or starting a fallback. */
  failClosed(message: string): void {
    if (this.#selectedDeviceIdentity?.hostApi === "ASIO") this.#asioDuplex?.emergencyStop();
    this.closeStream();
    this.#state = "FAULT";
    this.#error = message;
    this.#activeChannelCount = 0;
    this.#peak = 0;
  }

  meters() {
    return { state: this.#state, peak: this.#peak, framesWritten: this.#framesWritten, backpressureDrops: this.#backpressureDrops };
  }

  snapshot(includeHistory = true): AudioOutputSnapshot {
    return {
      state: this.#state,
      selectedDeviceId: this.#selectedDeviceId,
      selectedDeviceName: this.#selectedDeviceName,
      selectedHostApi: this.#selectedDeviceIdentity?.hostApi ?? null,
      activeChannelCount: this.#activeChannelCount,
      sampleRate: this.sampleRate,
      framesWritten: this.#framesWritten,
      backpressureDrops: this.#backpressureDrops,
      ...(includeHistory ? { writeTiming: this.#writeTiming?.snapshot(this.#framesWritten, this.#buffers.length - this.#availableBuffers.length) ?? null } : {}),
      peak: this.#peak,
      error: this.#error,
      devices: this.#devices.map((device) => ({ ...device })),
      windowsEndpointBinding: this.#windowsEndpointBinding ? { ...this.#windowsEndpointBinding } : null,
    };
  }

  presenceMonitoringReady(): boolean {
    if (this.#selectedDeviceIdentity?.hostApi === "ASIO") return this.#state === "READY";
    if (this.#platform !== "win32" || !this.#selectedDeviceId?.startsWith("pa:")) return true;
    return this.#presenceProvider?.isAvailable() === true
      && this.#windowsEndpointBinding?.direction === "render"
      && this.#windowsEndpointBinding.state === "ACTIVE"
      && this.#windowsEndpointBinding.monitoring === "ACTIVE";
  }

  physicalReady(): boolean {
    return this.#state === "READY" && this.#selectedDeviceId?.startsWith("pa:") === true;
  }

  private fail(deviceId: string, message: string, classification: AudioFaultClassification = "UNKNOWN"): void {
    if (this.#state === "FAULT") return;
    const diagnostic = { classification, hostApi: this.#selectedDeviceIdentity?.hostApi ?? null };
    this.failClosed(message);
    this.onFault?.(deviceId, message, diagnostic);
  }

  private closeStream(): void {
    this.#writeTiming?.stop(performance.now());
    this.stopPresenceMonitor();
    if (this.#selectedDeviceIdentity?.hostApi === "ASIO") this.#asioDuplex?.clearOutput();
    const stream = this.#stream;
    this.#closing = true;
    this.#stream = null;
    this.#streamGeneration += 1;
    if (stream) {
      const generation = this.#streamGeneration;
      try {
        Promise.resolve(stream.abort()).catch((error) => {
          if (generation === this.#streamGeneration) this.fail(this.#selectedDeviceId ?? "unknown", String(error), "STREAM_ERROR");
        });
      } catch (error) { this.#error = String(error); }
    }
    this.#buffers = [];
    this.#availableBuffers = [];
    this.#writeViews.clear();
    this.#primingRemaining = 0;
  }

  private matchesSelectedDevice(device: AudioOutputDevice): boolean {
    const selected = this.#selectedDeviceIdentity;
    return selected !== null
      && device.id === selected.id
      && device.name === selected.name
      && device.hostApi === selected.hostApi
      && device.maxOutputChannels === selected.maxOutputChannels
      && device.defaultSampleRate === selected.defaultSampleRate;
  }

  private bindingForSelection(device: AudioOutputDevice, endpointId?: string): WindowsEndpointBindingSnapshot | null {
    if (device.backend !== "portaudio" || this.#platform !== "win32" || device.hostApi === "ASIO") return null;
    if (!this.#presenceProvider?.isAvailable()) {
      throw new Error("Windows endpoint presence provider is unavailable");
    }
    if (!endpointId) throw new Error("Windows render endpoint binding is required");
    const endpoint = this.#presenceProvider.cachedEndpoint(endpointId, "render");
    if (!endpoint || endpoint.state !== "ACTIVE") {
      throw new Error("Selected Windows render endpoint is not active");
    }
    return { endpointId: endpoint.id, endpointName: endpoint.name, direction: endpoint.direction, state: endpoint.state, monitoring: "ACTIVE" };
  }

  private startPresenceMonitor(stream: IoStreamWrite, generation: number): void {
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
      this.fail(this.#selectedDeviceId ?? "unknown", "Windows output presence provider is unavailable", "PRESENCE_PROVIDER_UNAVAILABLE");
    }) ?? null;
    const check = async () => {
      if (this.#presencePollPending || stream !== this.#stream || generation !== this.#streamGeneration || this.#state !== "READY") return;
      this.#presencePollPending = true;
      try {
        const endpoints = await provider.refreshEndpoints();
        if (stream !== this.#stream || generation !== this.#streamGeneration || this.#state !== "READY" || endpointId !== this.#windowsEndpointBinding?.endpointId) return;
        const endpoint = endpoints.find((candidate) => candidate.id === endpointId && candidate.direction === "render");
        if (!endpoint || endpoint.state !== "ACTIVE") {
          if (this.#windowsEndpointBinding) this.#windowsEndpointBinding = { ...this.#windowsEndpointBinding, state: endpoint?.state ?? "NOT_PRESENT" };
          this.fail(this.#selectedDeviceId ?? "unknown", "Selected Windows output endpoint is unavailable", "DEVICE_UNAVAILABLE");
        }
      } catch {
        if (stream === this.#stream && generation === this.#streamGeneration && this.#state === "READY") {
          if (this.#windowsEndpointBinding) this.#windowsEndpointBinding = { ...this.#windowsEndpointBinding, monitoring: "UNAVAILABLE" };
          this.fail(this.#selectedDeviceId ?? "unknown", "Windows output presence provider is unavailable", "PRESENCE_PROVIDER_UNAVAILABLE");
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

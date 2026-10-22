import { createRequire } from "node:module";
import type { DeviceInfo, IoStreamDuplex } from "naudiodon2";

interface AudioOptions {
  channelCount: number;
  sampleFormat: 1;
  sampleRate: number;
  deviceId: number;
  framesPerBuffer: number;
  maxQueue: number;
  closeOnError: boolean;
  highwaterMark?: number;
}

export interface AsioPortAudioModule {
  AudioIO: new (options: { inOptions?: AudioOptions; outOptions?: AudioOptions }) => IoStreamDuplex;
  SampleFormatFloat32: 1;
  getDevices(): DeviceInfo[];
}

interface Direction {
  deviceId: number;
  channelCount: number;
  sampleRate: number;
  blockSize: number;
}

function loadPortAudio(): AsioPortAudioModule | null {
  try { return createRequire(import.meta.url)("naudiodon2") as AsioPortAudioModule; }
  catch { return null; }
}

export class AsioDuplexStream {
  onOutputReady?: () => void;
  #portAudio: AsioPortAudioModule | null;
  #stream: IoStreamDuplex | null = null;
  #input: Direction | null = null;
  #output: Direction | null = null;
  #onInput: ((buffer: Buffer, physicalChannelCount: number) => void) | null = null;
  #onInputFault: ((message: string) => void) | null = null;
  #onOutputFault: ((message: string) => void) | null = null;
  #buffers: Buffer[] = [];
  #availableBuffers: Buffer[] = [];
  #generation = 0;
  #closing = false;
  #streamDeviceId: number | null = null;
  #streamInputChannels = 0;
  #streamOutputChannels = 0;
  #streamSampleRate = 0;
  #streamBlockSize = 0;
  #silenceImmediate: NodeJS.Immediate | null = null;
  #silenceWritePending = false;
  #openedDeviceId: number | null = null;
  #stopPending = false;
  #stopError: string | null = null;

  constructor(portAudio = loadPortAudio()) {
    this.#portAudio = portAudio;
  }

  assertSelectable(deviceId: number): void {
    if (this.#stopError) throw new Error(`ASIO停止に失敗しました。アプリを再起動してください: ${this.#stopError}`);
    if (this.#stopPending) throw new Error("ASIO停止処理中です。完了後にもう一度開いてください");
    if (this.#openedDeviceId !== null && this.#openedDeviceId !== deviceId) {
      throw new Error("ASIOドライバを変更するにはアプリを再起動してください");
    }
  }

  selectOutput(options: Direction, onFault: (message: string) => void): void {
    this.assertSelectable(options.deviceId);
    this.#output = options;
    this.#onOutputFault = onFault;
    this.openFor(options);
    this.stopSilence();
    this.requestOutputBlock();
  }

  selectInput(options: Direction, onInput: (buffer: Buffer, physicalChannelCount: number) => void, onFault: (message: string) => void): void {
    this.assertSelectable(options.deviceId);
    this.#input = options;
    this.#onInput = onInput;
    this.#onInputFault = onFault;
    this.openFor(options);
    if (!this.#output) this.startSilence();
  }

  clearOutput(): void {
    if (!this.#output) return;
    this.#output = null;
    this.#onOutputFault = null;
    if (this.#input) this.startSilence();
    else this.closeStream();
  }

  /** Unlike ordinary output detachment, emergency shutdown must discard the
   * shared native queue, even when input still owns the duplex stream. */
  emergencyStop(): void {
    // The output manager owns its STOPPED/FAULT state. Notify the input owner
    // that its shared stream is gone, after invalidating all callbacks.
    this.#onOutputFault = null;
    this.fail("ASIO duplex stopped by emergency mute; explicitly re-select the input device");
  }

  clearInput(): void {
    if (!this.#input) return;
    this.#input = null;
    this.#onInput = null;
    this.#onInputFault = null;
    if (!this.#output) this.closeStream();
  }

  writeBlock(outputs: readonly Float32Array[]): { accepted: boolean; peak: number } {
    const stream = this.#stream;
    const buffer = this.#availableBuffers.pop();
    if (!stream || !buffer || this.#streamOutputChannels < 1) return { accepted: false, peak: 0 };
    const outputWasActive = this.#output !== null;
    let peak = 0;
    let offset = 0;
    for (let frame = 0; frame < this.#streamBlockSize; frame += 1) {
      for (let channel = 0; channel < this.#streamOutputChannels; channel += 1) {
        const sample = this.#output ? outputs[channel]?.[frame] ?? 0 : 0;
        peak = Math.max(peak, Math.abs(sample));
        buffer.writeFloatLE(sample, offset);
        offset += 4;
      }
    }
    const generation = this.#generation;
    try {
      stream.write(buffer, (error?: Error | null) => {
        if (stream !== this.#stream || generation !== this.#generation) return;
        this.#availableBuffers.push(buffer);
        if (!outputWasActive) this.#silenceWritePending = false;
        if (error) { this.fail(error.message); return; }
        if (outputWasActive && this.#output) this.requestOutputBlock();
        if (!this.#output) this.startSilence();
      });
      return { accepted: true, peak };
    } catch (error) {
      this.#availableBuffers.push(buffer);
      this.fail(error instanceof Error ? error.message : String(error));
      return { accepted: false, peak };
    }
  }

  private openFor(direction: Direction): void {
    if (!this.#portAudio) throw new Error("PortAudio ASIO backendを読み込めません");
    this.assertSelectable(direction.deviceId);
    if (this.#stream) {
      if (direction.deviceId === this.#streamDeviceId && direction.sampleRate === this.#streamSampleRate && direction.blockSize === this.#streamBlockSize) return;
      this.closeStream();
      this.assertSelectable(direction.deviceId);
    }
    if (this.#input && this.#output && this.#input.deviceId !== this.#output.deviceId) {
      return this.failAndThrow("ASIOの入出力は同じデバイスを選択してください");
    }
    if (this.#input && this.#output && (this.#input.sampleRate !== this.#output.sampleRate || this.#input.blockSize !== this.#output.blockSize)) {
      return this.failAndThrow("ASIOの入出力は同じサンプルレートとブロックサイズが必要です");
    }
    const device = this.#portAudio.getDevices().find((candidate) => candidate.id === direction.deviceId);
    if (!device) return this.failAndThrow("選択したASIOデバイスが見つかりません");
    this.#streamInputChannels = device.maxInputChannels;
    this.#streamOutputChannels = device.maxOutputChannels;
    this.#streamDeviceId = direction.deviceId;
    this.#streamSampleRate = direction.sampleRate;
    this.#streamBlockSize = direction.blockSize;
    const audioOptions = (channelCount: number): AudioOptions => ({
      channelCount,
      sampleFormat: this.#portAudio!.SampleFormatFloat32,
      sampleRate: this.#streamSampleRate,
      deviceId: this.#streamDeviceId!,
      framesPerBuffer: this.#streamBlockSize,
      maxQueue: 8,
      closeOnError: true,
    });
    const options: { inOptions?: AudioOptions; outOptions?: AudioOptions } = {};
    if (this.#streamInputChannels > 0) {
      options.inOptions = { ...audioOptions(this.#streamInputChannels),
        // naudiodon spells this option highwaterMark. Its default byte-sized
        // reads can split interleaved frames and batch several graph blocks.
        highwaterMark: this.#streamBlockSize * this.#streamInputChannels * 4 };
    }
    if (this.#streamOutputChannels > 0) options.outOptions = audioOptions(this.#streamOutputChannels);
    try {
      this.#openedDeviceId = direction.deviceId;
      const stream = new this.#portAudio.AudioIO(options);
      const generation = this.#generation;
      this.#stream = stream;
      this.#closing = false;
      if (this.#streamOutputChannels > 0) {
        this.#buffers = Array.from({ length: 8 }, () => Buffer.allocUnsafe(this.#streamBlockSize * this.#streamOutputChannels * 4));
        this.#availableBuffers = [...this.#buffers];
      }
      stream.on("data", (chunk) => {
        if (stream === this.#stream && generation === this.#generation && this.#input) this.#onInput?.(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk), this.#streamInputChannels);
      });
      stream.on("error", (error) => {
        if (stream === this.#stream && generation === this.#generation) this.fail(error instanceof Error ? error.message : String(error));
      });
      stream.on("close", () => {
        if (stream === this.#stream && generation === this.#generation && !this.#closing) this.fail("ASIOストリームが終了しました");
      });
      if (this.#streamOutputChannels > 0) stream.write(Buffer.alloc(this.#streamBlockSize * this.#streamOutputChannels * 4));
      stream.start();
      if (!this.#output) this.startSilence();
    } catch (error) {
      this.failAndThrow(error instanceof Error ? error.message : String(error));
    }
  }

  private failAndThrow(message: string): never {
    this.fail(message);
    throw new Error(message);
  }

  private fail(message: string): void {
    const outputFault = this.#onOutputFault;
    const inputFault = this.#onInputFault;
    this.#output = null;
    this.#input = null;
    this.#onOutputFault = null;
    this.#onInputFault = null;
    this.#onInput = null;
    this.closeStream();
    outputFault?.(message);
    inputFault?.(message);
  }

  private closeStream(): void {
    this.stopSilence();
    const stream = this.#stream;
    this.#closing = true;
    this.#stream = null;
    this.#generation += 1;
    this.#silenceWritePending = false;
    if (stream) {
      this.#stopPending = true;
      try {
        Promise.resolve(stream.abort()).then(
          () => { this.#stopPending = false; },
          (error) => {
            this.#stopError = error instanceof Error ? error.message : String(error);
            this.#stopPending = false;
          },
        );
      } catch (error) {
        this.#stopError = error instanceof Error ? error.message : String(error);
        this.#stopPending = false;
      }
    }
    this.#buffers = [];
    this.#availableBuffers = [];
    this.#streamDeviceId = null;
    this.#streamInputChannels = 0;
    this.#streamOutputChannels = 0;
    this.#streamSampleRate = 0;
    this.#streamBlockSize = 0;
  }

  private startSilence(): void {
    if (this.#silenceImmediate || this.#silenceWritePending || this.#output || !this.#input || !this.#stream || this.#streamOutputChannels < 1) return;
    // The driver's duplex callback waits when its output queue is empty, even
    // for input-only use. Refill at native enqueue completion, not a PC timer:
    // maxQueue bounds native silence and only one extra JS write may wait.
    // Yield between completions (which may be synchronous in test streams).
    this.#silenceImmediate = setImmediate(() => {
      this.#silenceImmediate = null;
      if (this.#output || !this.#input || !this.#stream) return;
      this.#silenceWritePending = true;
      if (!this.writeBlock(EMPTY_OUTPUTS).accepted) this.#silenceWritePending = false;
    });
    this.#silenceImmediate.unref();
  }

  private stopSilence(): void {
    if (this.#silenceImmediate) clearImmediate(this.#silenceImmediate);
    this.#silenceImmediate = null;
  }

  outputClockActive(): boolean {
    return this.#output !== null && this.#stream !== null && this.#streamOutputChannels > 0;
  }

  private requestOutputBlock(): void {
    const generation = this.#generation;
    queueMicrotask(() => {
      if (generation === this.#generation && this.outputClockActive()) this.onOutputReady?.();
    });
  }
}

const EMPTY_OUTPUTS: readonly Float32Array[] = [];

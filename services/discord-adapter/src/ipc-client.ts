import { createConnection, type Socket } from "node:net";
import type { DiscordRxIpcSnapshot } from "../../../packages/shared-types/src/index.ts";
import {
  DiscordFrameType,
  DiscordFrameDecoder,
  defaultDiscordIpcEndpoint,
  encodeDiscordFrame,
  type DiscordIpcFrame,
} from "../../../packages/discord-ipc/src/index.ts";

export class DiscordIpcClient {
  readonly endpoint: string;
  #socket: Socket | null = null;
  #queue: Buffer[] = [];
  #reconnectTimer: NodeJS.Timeout | null = null;
  #closed = false;
  #handlers = new Set<(frame: DiscordIpcFrame) => void>();
  #connectedHandlers = new Set<() => void>();
  #disconnectedHandlers = new Set<() => void>();
  droppedFrames = 0;
  #opusDroppedFrames = 0;
  #backpressureWrites = 0;
  #maxWritableBytes = 0;

  constructor(endpoint = process.env.DISCORD_IPC_ENDPOINT ?? defaultDiscordIpcEndpoint()) {
    this.endpoint = endpoint;
  }

  start(): void {
    this.#closed = false;
    this.connect();
  }

  onFrame(handler: (frame: DiscordIpcFrame) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  onConnected(handler: () => void): () => void {
    this.#connectedHandlers.add(handler);
    return () => this.#connectedHandlers.delete(handler);
  }

  onDisconnected(handler: () => void): () => void {
    this.#disconnectedHandlers.add(handler);
    return () => this.#disconnectedHandlers.delete(handler);
  }

  send(frame: DiscordIpcFrame): void {
    const encoded = encodeDiscordFrame(frame);
    if (this.#socket?.writable && !this.#socket.connecting) {
      const accepted = this.#socket.write(encoded);
      if (frame.type === DiscordFrameType.OPUS) {
        // write(false) means queued, not discarded. Observe without changing RX flow.
        if (!accepted) this.#backpressureWrites += 1;
        this.#maxWritableBytes = Math.max(this.#maxWritableBytes, this.#socket.writableLength);
      }
      return;
    }
    // Never replay stale speech after Core reconnects. Missing live RX must become silence.
    if (frame.type === DiscordFrameType.OPUS || frame.type === DiscordFrameType.USER_META || frame.type === DiscordFrameType.USER_LEFT || frame.type === DiscordFrameType.PING) {
      this.droppedFrames += 1;
      if (frame.type === DiscordFrameType.OPUS) this.#opusDroppedFrames += 1;
      return;
    }
    if (this.#queue.length >= 512) {
      this.#queue.shift();
      this.droppedFrames += 1;
    }
    this.#queue.push(encoded);
  }

  rxDiagnostics(): DiscordRxIpcSnapshot {
    return {
      opusDroppedFrames: this.#opusDroppedFrames,
      backpressureWrites: this.#backpressureWrites,
      writableBytes: this.#socket?.writableLength ?? 0,
      maxWritableBytes: this.#maxWritableBytes,
    };
  }

  close(): void {
    this.#closed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#socket?.destroy();
    this.#socket = null;
  }

  private connect(): void {
    if (this.#closed || this.#socket) return;
    const socket = createConnection(this.endpoint);
    const decoder = new DiscordFrameDecoder();
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.once("connect", () => {
      console.log(`Discord IPC connected: ${this.endpoint}`);
      for (const frame of this.#queue.splice(0)) socket.write(frame);
      for (const handler of this.#connectedHandlers) {
        try {
          handler();
        } catch (error) {
          console.error(`Discord IPC resync hook failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
    socket.on("data", (chunk) => {
      try {
        for (const frame of decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)) {
          for (const handler of this.#handlers) handler(frame);
        }
      } catch (error) {
        console.error(`Discord IPC receive failed: ${error instanceof Error ? error.message : String(error)}`);
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.once("close", () => {
      if (this.#socket === socket) this.#socket = null;
      for (const handler of this.#disconnectedHandlers) {
        try { handler(); }
        catch (error) { console.error(`Discord IPC fail-closed hook failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (!this.#closed) this.#reconnectTimer = setTimeout(() => this.connect(), 1_000);
    });
  }
}

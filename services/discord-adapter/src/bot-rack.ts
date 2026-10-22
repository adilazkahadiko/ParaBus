import {
  DiscordFrameType,
  type DiscordBotControlPayload,
  type DiscordIpcFrame,
} from "../../../packages/discord-ipc/src/index.ts";
import { DiscordBotConnection } from "./bot-connection.ts";
import {
  loadBotRackEnvironment,
  loadBotRackProfiles,
  type DiscordBotProfile,
} from "./bot-config.ts";
import type { DiscordIpcClient } from "./ipc-client.ts";

export interface ManagedDiscordBot {
  readonly profile: DiscordBotProfile;
  start(): Promise<void>;
  close(): Promise<void>;
  disconnect(): Promise<void>;
  ingest(frame: DiscordIpcFrame): void;
  resync(): void;
  stopTxImmediately?(): void;
}

export interface DiscordBotRackOptions {
  loadProfiles?: () => DiscordBotProfile[];
  createConnection?: (profile: DiscordBotProfile) => ManagedDiscordBot;
}

function profileId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(value)) {
    throw new Error("Discord Bot profile IDが不正です");
  }
  return value;
}

export class DiscordBotRack {
  readonly bots = new Map<string, ManagedDiscordBot>();
  readonly ipc: DiscordIpcClient;
  readonly ignoredUserIds: Set<string>;
  readonly loadProfiles: () => DiscordBotProfile[];
  readonly createConnection: (profile: DiscordBotProfile) => ManagedDiscordBot;
  #operations = new Map<string, Promise<void>>();
  #removeConnectedHandler: (() => void) | null = null;
  #removeDisconnectedHandler: (() => void) | null = null;

  constructor(ipc: DiscordIpcClient, ignoredUserIds: Set<string>, options: DiscordBotRackOptions = {}) {
    this.ipc = ipc;
    this.ignoredUserIds = ignoredUserIds;
    this.loadProfiles = options.loadProfiles ?? (() => loadBotRackProfiles(loadBotRackEnvironment()));
    this.createConnection = options.createConnection ?? ((profile) => new DiscordBotConnection(profile, ipc, ignoredUserIds));
    if (typeof (ipc as Partial<DiscordIpcClient>).onConnected === "function") {
      this.#removeConnectedHandler = ipc.onConnected(() => this.resync());
    }
    if (typeof (ipc as Partial<DiscordIpcClient>).onDisconnected === "function") {
      this.#removeDisconnectedHandler = ipc.onDisconnected(() => this.stopAllTxImmediately());
    }
  }

  ingest(frame: DiscordIpcFrame): void {
    if (frame.type === DiscordFrameType.BOT_CONTROL) {
      void this.handleControl(frame).catch((error) => {
        console.error(`Discord Bot control failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    for (const bot of this.bots.values()) bot.ingest(frame);
  }

  connect(id: string): Promise<void> {
    const validated = profileId(id);
    return this.enqueue(validated, async () => {
      const existing = this.bots.get(validated);
      if (existing) {
        existing.resync();
        return;
      }
      const profile = this.loadProfiles().find((candidate) => candidate.profileId === validated);
      if (!profile) throw new Error(`${validated}が有効なBot設定にありません。設定を保存してから接続してください`);
      await this.connectProfile(profile);
    });
  }

  disconnect(id: string): Promise<void> {
    const validated = profileId(id);
    return this.enqueue(validated, async () => {
      const bot = this.bots.get(validated);
      if (!bot) return;
      await bot.disconnect();
      this.bots.delete(validated);
      console.log(`[${validated}] Discord Bot disconnected by operator`);
    });
  }

  async close(): Promise<void> {
    this.#removeConnectedHandler?.();
    this.#removeConnectedHandler = null;
    this.#removeDisconnectedHandler?.();
    this.#removeDisconnectedHandler = null;
    await Promise.allSettled([...this.bots.values()].map((bot) => bot.close()));
    this.bots.clear();
  }

  resync(): void {
    for (const bot of this.bots.values()) {
      try {
        bot.resync();
      } catch (error) {
        console.error(`Discord Bot resync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private stopAllTxImmediately(): void {
    for (const bot of this.bots.values()) bot.stopTxImmediately?.();
  }

  private async handleControl(frame: DiscordIpcFrame): Promise<void> {
    const decoded = JSON.parse(Buffer.from(frame.payload ?? []).toString("utf8")) as Partial<DiscordBotControlPayload>;
    const id = profileId(decoded.profileId);
    if (decoded.action === "CONNECT") await this.connect(id);
    else if (decoded.action === "DISCONNECT") await this.disconnect(id);
    else throw new Error("unknown Discord Bot control action");
  }

  private async connectProfile(profile: DiscordBotProfile): Promise<void> {
    if (this.bots.has(profile.profileId)) return;
    const bot = this.createConnection(profile);
    this.bots.set(profile.profileId, bot);
    try {
      await bot.start();
    } catch (error) {
      this.bots.delete(profile.profileId);
      await bot.close();
      throw error;
    }
  }

  private enqueue(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.#operations.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.#operations.set(id, current);
    void current.finally(() => {
      if (this.#operations.get(id) === current) this.#operations.delete(id);
    }).catch(() => {});
    return current;
  }
}

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ReceiverOwnerRecord {
  guildId: string;
  voiceChannelId: string;
  profileId: string;
}

const SNOWFLAKE = /^\d{17,20}$/;
const PROFILE_ID = /^[A-Za-z0-9_-]{1,32}$/;

function key(guildId: string, voiceChannelId: string): string {
  return `${guildId}:${voiceChannelId}`;
}

export class ReceiverOwnershipStore {
  readonly path: string;
  readonly #owners = new Map<string, ReceiverOwnerRecord>();

  constructor(root: string) {
    this.path = join(root, "receiver-owners.json");
    this.load();
  }

  get(guildId: string, voiceChannelId: string): string | null {
    return this.#owners.get(key(guildId, voiceChannelId))?.profileId ?? null;
  }

  set(guildId: string, voiceChannelId: string, profileId: string): void {
    if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(voiceChannelId) || !PROFILE_ID.test(profileId)) {
      throw new Error("Receiver Owner identity is invalid");
    }
    this.#owners.set(key(guildId, voiceChannelId), { guildId, voiceChannelId, profileId });
    this.flush();
  }

  snapshot(): ReceiverOwnerRecord[] {
    return [...this.#owners.values()].map((entry) => ({ ...entry }))
      .sort((a, b) => key(a.guildId, a.voiceChannelId).localeCompare(key(b.guildId, b.voiceChannelId)));
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const decoded = JSON.parse(readFileSync(this.path, "utf8")) as { owners?: unknown };
    if (!Array.isArray(decoded.owners)) return;
    for (const value of decoded.owners) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<ReceiverOwnerRecord>;
      if (!SNOWFLAKE.test(entry.guildId ?? "") || !SNOWFLAKE.test(entry.voiceChannelId ?? "") || !PROFILE_ID.test(entry.profileId ?? "")) continue;
      this.#owners.set(key(entry.guildId!, entry.voiceChannelId!), {
        guildId: entry.guildId!, voiceChannelId: entry.voiceChannelId!, profileId: entry.profileId!,
      });
    }
  }

  private flush(): void {
    const temporary = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, owners: this.snapshot() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}

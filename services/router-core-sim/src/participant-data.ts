import { join } from "node:path";
import type { ControlPlane } from "./control-plane.ts";
import type { DiscordIngestServer } from "./discord-ingest.ts";
import { UserProfileStore } from "./user-profile-store.ts";
import { UserSessionRegistry } from "./user-session-registry.ts";
import { SceneStore } from "./scene-store.ts";
import { OperationalLog } from "./operational-log.ts";
import { deleteDirectFiles, SUPPORT_FILE } from "./data-file-deletion.ts";

export const PARTICIPANT_CONNECTED = "この参加者は接続中です。VCから退出したあとに削除してください。";
export const PARTICIPANT_STALE = "退出したのに画面にその人のストリップが残っている場合は、録音の保存完了を確認してParaBusを通常終了・起動し直し、その人がVCにいないことを確認してから削除してください。";
export const DELETION_FAILED = "削除を完了できませんでした。一部のデータが削除済みの場合があります。保存先の権限を確認して、もう一度実行してください。";
export class ParticipantDataError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function sceneParticipantId(parameter: string): string | null {
  return /^channel\.discord-user:[^:]+:[^:]+:(\d{17,20})\./.exec(parameter)?.[1] ?? null;
}
export interface SavedParticipant { discordUserId: string; displayName: string; updatedAt: string | null }
export interface ParticipantDataOptions {
  root: string;
  profiles: UserProfileStore;
  sessions: UserSessionRegistry;
  scenes: SceneStore;
  control: ControlPlane;
  ingest: Pick<DiscordIngestServer, "runtimes" | "forgetOfflineParticipant">;
  log: OperationalLog;
  bundleBusy: () => boolean;
}

export class ParticipantDataManager {
  readonly options: ParticipantDataOptions;
  #deleting = false;
  #diagnosticsBusy = false;
  constructor(options: ParticipantDataOptions) { this.options = options; }
  get diagnosticsBusy(): boolean { return this.#diagnosticsBusy; }

  list(): SavedParticipant[] {
    const rows = new Map<string, SavedParticipant>();
    for (const profile of this.options.profiles.snapshot()) rows.set(profile.discordUserId, {
      discordUserId: profile.discordUserId, displayName: profile.displayName, updatedAt: profile.updatedAt,
    });
    // Include scene-only identities left behind by older manual profile deletions.
    for (const scene of this.options.control.scenes.values()) for (const [key, value] of Object.entries(scene.values)) {
      const id = sceneParticipantId(key);
      if (!id) continue;
      if (!rows.has(id)) rows.set(id, { discordUserId: id, displayName: "名前未保存（シーン内のみ）", updatedAt: null });
      const row = rows.get(id)!;
      if (row.updatedAt === null && row.displayName === "名前未保存（シーン内のみ）" && key.endsWith(".label") && typeof value === "string") row.displayName = value;
    }
    return [...rows.values()].sort((a, b) => a.discordUserId.localeCompare(b.discordUserId));
  }

  private requireSetup(): void {
    if (this.options.control.state === "ON_AIR" || this.options.control.state === "FAULT") throw new ParticipantDataError(409, "ON AIRまたはFAULT中はデータを削除できません");
  }
  private requireOffline(discordUserId: string): void {
    const { sessions, ingest, control } = this.options;
    const channels = [...control.engine.channels.values()].filter(channel => channel.discordUserId === discordUserId);
    if (sessions.sessions.get(discordUserId)?.online || [...ingest.runtimes.values()].some(runtime => runtime.userId === discordUserId) || channels.some(channel => !channel.stale)) throw new ParticipantDataError(409, PARTICIPANT_CONNECTED);
    if (channels.length) throw new ParticipantDataError(409, PARTICIPANT_STALE);
  }
  async deleteParticipant(discordUserId: unknown): Promise<void> {
    if (typeof discordUserId !== "string" || !/^\d{17,20}$/.test(discordUserId)) throw new ParticipantDataError(400, "Discord IDは17〜20桁の数字で指定してください");
    this.requireSetup();
    if (this.#deleting) throw new ParticipantDataError(409, "参加者データを削除中です");
    const { sessions, ingest, control, scenes, profiles } = this.options;
    this.requireOffline(discordUserId);
    this.#deleting = true;
    try {
      // Scrub before yielding so concurrent scene saves use the new values. Membership
      // keeps flowing normally; if the participant rejoins, refuse success and let the
      // operator retry after they leave, rather than losing a membership notification.
      for (const scene of control.scenes.values()) for (const key of Object.keys(scene.values)) if (sceneParticipantId(key) === discordUserId) delete scene.values[key];
      for (const key of control.recallSafe) if (sceneParticipantId(key) === discordUserId) control.recallSafe.delete(key);
      await scenes.saveConfirmed([...control.scenes.values()], control.currentSceneId);
      this.requireOffline(discordUserId);
      await profiles.deleteConfirmed(discordUserId);
      this.requireOffline(discordUserId);
      ingest.forgetOfflineParticipant(discordUserId);
      sessions.forgetOffline(discordUserId);
      control.recordExternalEvent("INFO", "参加者データを1件削除しました");
    } catch (error) {
      this.requireOffline(discordUserId);
      if (error instanceof ParticipantDataError) throw error;
      throw new ParticipantDataError(500, DELETION_FAILED);
    } finally { this.#deleting = false; }
  }

  async deleteDiagnostics(): Promise<void> {
    this.requireSetup();
    if (this.#diagnosticsBusy || this.options.bundleBusy()) throw new ParticipantDataError(409, "診断ZIPを作成中または削除中です。完了後に実行してください。");
    this.#diagnosticsBusy = true;
    try {
      await this.options.log.clearFiles();
      await deleteDirectFiles(join(this.options.root, "support"), SUPPORT_FILE);
    } catch { throw new ParticipantDataError(500, DELETION_FAILED); }
    finally { this.#diagnosticsBusy = false; }
  }
}

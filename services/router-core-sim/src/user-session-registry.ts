import { randomBytes } from "node:crypto";
import type { ParticipantApprovalState, PersistentUserProfileSnapshot, UserSessionSnapshot } from "../../../packages/shared-types/src/index.ts";
import type { AudioChannel } from "./audio-engine.ts";
import { UserProfileStore } from "./user-profile-store.ts";
import { StaleSafetyStateError } from "./stale-state.ts";

export interface UserJoinEvent {
  kind: "JOINED" | "REJOIN_RESTORED";
  automaticApproval: boolean;
}

export interface SessionApprovalReset {
  discordUserId: string;
  label: string;
}

export class UserSessionRegistry {
  readonly profiles: UserProfileStore;
  readonly sessions = new Map<string, UserSessionSnapshot>();
  readonly #activeChannels = new Map<string, AudioChannel>();
  readonly #joinListeners = new Set<(channel: AudioChannel, profile: PersistentUserProfileSnapshot, event: UserJoinEvent) => void>();
  readonly #leaveListeners = new Set<(channel: AudioChannel) => void>();
  #nextSessionGeneration = initialSessionGeneration();

  constructor(profiles: UserProfileStore) {
    this.profiles = profiles;
  }

  join(channel: AudioChannel, discordUserId: string, currentVC: string, displayName: string): void {
    channel.discordUserId = discordUserId;
    channel.currentVoiceChannelId = currentVC;
    const current = this.sessions.get(discordUserId);
    if (current?.online && current.currentChannelId === channel.id) {
      channel.approvalGateOpen = current.sessionApproval === "APPROVED";
      this.#activeChannels.set(discordUserId, channel);
      this.sessions.set(discordUserId, { ...current, currentVC, audioActive: channel.approvalGateOpen });
      return;
    }
    const profile = this.profiles.restoreOrCreate(channel, discordUserId, displayName);
    const sessionApproval: ParticipantApprovalState = current?.sessionApproval ?? (profile.trusted ? "APPROVED" : "PENDING");
    channel.approvalGateOpen = sessionApproval === "APPROVED";
    channel.preferredStripPosition = profile.preferredStripPosition;
    this.sessions.set(discordUserId, {
      discordUserId,
      sessionGeneration: current?.sessionGeneration ?? this.allocateSessionGeneration(),
      approvalRevision: current?.approvalRevision ?? 1,
      currentChannelId: channel.id,
      currentVC,
      currentStripSlot: profile.preferredStripPosition,
      online: true,
      temporaryAlert: null,
      sessionApproval,
      audioActive: channel.approvalGateOpen,
    });
    this.#activeChannels.set(discordUserId, channel);
    const event: UserJoinEvent = {
      kind: current ? "REJOIN_RESTORED" : "JOINED",
      automaticApproval: !current && profile.trusted,
    };
    for (const listener of this.#joinListeners) listener(channel, profile, event);
  }

  leave(channel: AudioChannel): void {
    const discordUserId = channel.discordUserId;
    if (!discordUserId) return;
    const session = this.sessions.get(discordUserId);
    if (!session || session.currentChannelId !== channel.id) return;
    this.profiles.captureChannel(channel);
    channel.approvalGateOpen = false;
    for (const listener of this.#leaveListeners) listener(channel);
    this.#activeChannels.delete(discordUserId);
    this.sessions.set(discordUserId, {
      ...session,
      currentChannelId: null,
      currentVC: null,
      online: false,
      temporaryAlert: null,
      audioActive: false,
    });
  }

  captureChannel(channel: AudioChannel): void {
    this.profiles.captureChannel(channel);
  }

  setChannelColor(channel: AudioChannel, color: string): void {
    this.profiles.setChannelColor(channel, color);
  }

  setRecallSafe(channel: AudioChannel, parameter: string, safe: boolean): void {
    this.profiles.setRecallSafe(channel, parameter, safe);
  }

  setApproval(channel: AudioChannel, discordUserId: string, expectedSessionGeneration: number, expectedApprovalRevision: number, approved: boolean): boolean {
    const session = this.requireCurrentSession(channel);
    if (
      channel.discordUserId !== discordUserId
      || session.discordUserId !== discordUserId
      || session.sessionGeneration !== expectedSessionGeneration
      || session.approvalRevision !== expectedApprovalRevision
    ) {
      throw new StaleSafetyStateError(
        "participant-approval",
        { sessionGeneration: expectedSessionGeneration, approvalRevision: expectedApprovalRevision },
        { sessionGeneration: session.sessionGeneration, approvalRevision: session.approvalRevision },
      );
    }
    const next: ParticipantApprovalState = approved ? "APPROVED" : "PENDING";
    const changed = session.sessionApproval !== next || channel.approvalGateOpen !== approved;
    channel.approvalGateOpen = approved;
    this.sessions.set(session.discordUserId, { ...session, approvalRevision: session.approvalRevision + 1, sessionApproval: next, audioActive: approved && session.online });
    return changed;
  }

  setTrusted(channel: AudioChannel, trusted: boolean): boolean {
    this.requireCurrentSession(channel);
    return this.profiles.setTrusted(channel, trusted);
  }

  resetSessionApprovals(): SessionApprovalReset[] {
    const reset: SessionApprovalReset[] = [];
    for (const [discordUserId, session] of this.sessions) {
      const trusted = this.profiles.isTrusted(discordUserId);
      const next: ParticipantApprovalState = trusted ? "APPROVED" : "PENDING";
      const channel = this.#activeChannels.get(discordUserId);
      if (!trusted && session.sessionApproval === "APPROVED") {
        reset.push({ discordUserId, label: channel?.label ?? this.profiles.profiles.get(discordUserId)?.channelName ?? "Discord User" });
      }
      if (channel) channel.approvalGateOpen = trusted;
      this.sessions.set(discordUserId, {
        ...session,
        sessionGeneration: this.allocateSessionGeneration(),
        approvalRevision: 1,
        sessionApproval: next,
        audioActive: Boolean(channel && session.online && trusted),
      });
    }
    return reset;
  }

  onJoin(listener: (channel: AudioChannel, profile: PersistentUserProfileSnapshot, event: UserJoinEvent) => void): void {
    this.#joinListeners.add(listener);
  }

  onLeave(listener: (channel: AudioChannel) => void): void {
    this.#leaveListeners.add(listener);
  }

  setStripOrder(discordUserIds: readonly string[]): void {
    this.profiles.setStripOrder(discordUserIds);
    this.syncStripSlots();
  }

  resetStripOrder(): void {
    this.profiles.resetStripOrder();
    this.syncStripSlots();
  }

  removeBus(busId: string): void {
    this.profiles.removeBus(busId);
  }

  snapshot(): UserSessionSnapshot[] {
    return [...this.sessions.values()].map((session) => ({ ...session }));
  }

  private syncStripSlots(): void {
    const positions = new Map(this.profiles.snapshot().map((profile) => [profile.discordUserId, profile.preferredStripPosition]));
    for (const [discordUserId, session] of this.sessions) {
      const position = positions.get(discordUserId) ?? session.currentStripSlot;
      this.sessions.set(discordUserId, { ...session, currentStripSlot: position });
      const channel = this.#activeChannels.get(discordUserId);
      if (channel) channel.preferredStripPosition = position;
    }
  }

  private requireCurrentSession(channel: AudioChannel): UserSessionSnapshot {
    const discordUserId = channel.discordUserId;
    const session = discordUserId ? this.sessions.get(discordUserId) : undefined;
    if (!discordUserId || !session || !session.online || session.currentChannelId !== channel.id) {
      throw new Error("Channel has no current Discord User session");
    }
    return session;
  }

  private allocateSessionGeneration(): number {
    const generation = this.#nextSessionGeneration;
    this.#nextSessionGeneration = this.#nextSessionGeneration >= Number.MAX_SAFE_INTEGER ? 1 : this.#nextSessionGeneration + 1;
    return generation;
  }
}

function initialSessionGeneration(): number {
  return randomBytes(6).readUIntBE(0, 6) || 1;
}

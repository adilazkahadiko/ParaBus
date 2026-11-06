import { randomUUID } from "node:crypto";
import type { DiscordIngestSnapshot } from "../../../packages/shared-types/src/index.ts";
import type { ControlPlane } from "./control-plane.ts";
import type { ExternalDevice } from "./external-device-store.ts";
import { canonical, dependencyKey as dep, fail, fields, revision, textId } from "./external-protocol.ts";

const displayName = (name: string) => name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 80);
export class ExternalState {
  readonly instanceId = randomUUID();
  readonly control: ControlPlane;
  readonly ingest: () => DiscordIngestSnapshot;
  revision = 1;
  participantsRevision = 1;
  targetsRevision = 1;
  selectionKind: "profiles" | "destinations" | "allTeams" = "profiles";
  #participants = ""; #targets = ""; #state = "";
  #armed = "";
  #internalTargetsRevision = 1;
  #appearance = 0;
  #identities = new WeakMap<object, number>();
  #identity = 0;
  #dependencies = new Map<string, { value: string; generation: number }>();
  #dependencyClock = 0;
  #userAppearances = new Map<string, number>();
  readonly txIdentities: () => readonly object[];
  readonly configuredTx: readonly { profileId: string; destination: string | null }[];
  constructor(control: ControlPlane, ingest: () => DiscordIngestSnapshot, txIdentities: () => readonly object[] = () => [], configuredTx: readonly { profileId: string; destination: string | null }[] = []) {
    this.control = control; this.ingest = ingest;
    this.txIdentities = txIdentities;
    this.configuredTx = configuredTx;
    const appearance = (channel: { discordUserId?: string }) => {
      this.#appearance++;
      if (channel.discordUserId) this.#userAppearances.set(channel.discordUserId, this.#appearance);
    };
    control.userSessions?.onJoin(appearance);
    control.userSessions?.onLeave(appearance);
    this.observe();
  }
  private identity(object: object) {
    let id = this.#identities.get(object); if (!id) { id = ++this.#identity; this.#identities.set(object, id); } return id;
  }
  channels() {
    return [...this.control.engine.channels.values()].filter(channel => channel.kind === "DiscordUser" && /^\d{17,20}$/.test(channel.discordUserId ?? ""))
      .sort((a, b) => ((a.preferredStripPosition ?? 0) - (b.preferredStripPosition ?? 0)) || a.discordUserId!.localeCompare(b.discordUserId!));
  }
  orders() {
    const channels = this.channels();
    return [{ scope: { kind: "all" as const }, users: channels.map(c => c.discordUserId!) },
      ...[...this.control.engine.buses.values()].filter(b => b.groupSourceIds === null && b.linkedDiscordVoiceChannelId)
        .map(b => ({ scope: { kind: "bus" as const, busId: b.id }, users: channels.filter(c => c.currentVoiceChannelId === b.linkedDiscordVoiceChannelId
          && (!b.linkedDiscordGuildId || c.id.startsWith(`discord-user:${b.linkedDiscordGuildId}:`))).map(c => c.discordUserId!) }))];
  }
  observe() {
    const ingest = this.ingest(), channels = this.channels(), engine = this.control.engine;
    const values = new Map<string, unknown>();
    values.set("lock", this.control.state);
    values.set("emergency", this.control.emergencyEpoch);
    for (const c of channels) {
      values.set(dep("channel", c.id), [this.identity(c), c.currentVoiceChannelId, this.#userAppearances.get(c.discordUserId!)]);
      values.set(dep("channel", c.id, "fader"), c.faderDb);
      for (const [busId, send] of c.vcSends) {
        values.set(dep("send", c.id, busId), this.identity(send));
        values.set(dep("send", c.id, busId, "fader"), send.gainDb);
      }
    }
    for (const b of engine.buses.values()) {
      values.set(dep("bus", b.id), [this.identity(b), b.linkedDiscordGuildId, b.linkedDiscordVoiceChannelId, b.groupSourceIds]);
      values.set(dep("bus", b.id, "fader"), b.masterDb);
      values.set(dep("bus", b.id, "limiter"), b.limiter.enabled);
      for (const [key, value] of Object.entries({ enabled: b.compressorEnabled, thresholdDb: b.compressor.thresholdDb,
        ratio: b.compressor.ratio, attackMs: b.compressor.attackMs, releaseMs: b.compressor.releaseMs, makeupDb: b.compressor.makeupDb })) values.set(dep("bus", b.id, "compressor", key), value);
    }
    const identities = this.txIdentities();
    for (const bot of ingest.txStems) if (bot.profileId) {
      values.set(dep("tx", bot.profileId), [identities.filter(b => (b as { profileId?: string }).profileId === bot.profileId).map(b => this.identity(b)),
        bot.destination, bot.state, bot.active, bot.sourceInputChannelId, bot.sourceInputRightChannelId, bot.sourceOutput,
        ingest.bots.filter(b => b.profileId === bot.profileId).map(b => [b.botId, b.voiceChannelId])]);
      values.set(dep("tx", bot.profileId, "fader"), bot.masterDb ?? 0);
    }
    for (const key of this.#dependencies.keys()) if (!values.has(key)) values.set(key, null);
    for (const [key, value] of values) {
      const serialized = canonical(value), previous = this.#dependencies.get(key);
      if (!previous || previous.value !== serialized) this.#dependencies.set(key, { value: serialized, generation: ++this.#dependencyClock });
    }
    const participants = canonical([this.#appearance, channels.map(c => [c.discordUserId, this.identity(c), c.currentVoiceChannelId, c.preferredStripPosition]),
      [...engine.buses.values()].map(b => [b.id, this.identity(b), b.linkedDiscordGuildId, b.linkedDiscordVoiceChannelId, b.groupSourceIds]), this.orders()]);
    if (this.#participants && participants !== this.#participants) this.participantsRevision++;
    this.#participants = participants;
    const internalRevision = ingest.txTargetsRevision ?? 1;
    const armed = canonical([...(ingest.txTargets?.armed ?? [])].sort());
    const targets = canonical([internalRevision, ingest.txTargets, this.txIdentities().map(b => this.identity(b)),
      ingest.txStems.map(b => [b.profileId, b.destination, b.state, b.active, b.sourceInputChannelId, b.sourceInputRightChannelId, b.sourceOutput]),
      ingest.bots.filter(b => b.role === "TX" || b.role === "DUPLEX").map(b => [b.profileId, b.botId, b.voiceChannelId])]);
    if (this.#targets && targets !== this.#targets) {
      this.targetsRevision++;
      if (armed !== this.#armed) this.selectionKind = "profiles";
    }
    this.#targets = targets; this.#armed = armed; this.#internalTargetsRevision = internalRevision;
    const { revision: _revision, ...projection } = this.project({ readDisplayNames: true, allowedTierBOperations: [] }, true, ingest);
    const state = canonical([projection, participants,
      channels.map(c => [this.identity(c), c.approvalGateOpen]), [...engine.buses.values()].map(b => this.identity(b))]);
    if (this.#state && state !== this.#state) this.revision++;
    this.#state = state;
  }
  selected(kind: ExternalState["selectionKind"]) {
    this.observe();
    if (this.selectionKind !== kind) { this.selectionKind = kind; this.targetsRevision++; }
    this.observe();
  }
  internalTargetsRevision() { return this.#internalTargetsRevision; }
  dependencies(keys: string[]) { return canonical(keys.map(key => [key, this.#dependencies.get(key)?.generation ?? 0])); }
  /** No old target/slot revision may survive an interval in which mutations were not observed. */
  resume() { this.revision++; this.participantsRevision++; this.targetsRevision++; this.observe(); }
  resolveTarget(value: unknown) {
    const target = fields(value, ["kind"], ["discordUserId", "scope", "index", "expectedParticipantsRevision"]);
    let userId: string;
    if (target.kind === "user") {
      fields(value, ["kind", "discordUserId"]); userId = textId(target.discordUserId, 20);
      if (!/^\d{17,20}$/.test(userId)) fail("INVALID");
      if (!this.control.userSessions?.profiles.profiles.has(userId)) fail("NOT_FOUND");
    } else if (target.kind === "slot") {
      fields(value, ["kind", "scope", "index", "expectedParticipantsRevision"]);
      const expected = revision(target.expectedParticipantsRevision), index = revision(target.index);
      const scope = fields(target.scope, ["kind"], ["busId"]);
      if (scope.kind === "all") fields(scope, ["kind"]);
      else if (scope.kind === "bus") {
        fields(scope, ["kind", "busId"]); textId(scope.busId);
        const bus = this.control.engine.buses.get(scope.busId as string);
        if (!bus) fail("NOT_FOUND");
        if (bus.groupSourceIds !== null || !bus.linkedDiscordVoiceChannelId) fail("INVALID");
      } else fail("INVALID");
      if (expected !== this.participantsRevision) fail("STALE_REVISION");
      const order = this.orders().find(o => o.scope.kind === scope.kind && (scope.kind === "all" || ("busId" in o.scope && o.scope.busId === scope.busId)));
      userId = order?.users[index - 1] ?? fail("NOT_FOUND");
    } else return fail("INVALID");
    return this.channels().find(c => c.discordUserId === userId) ?? fail("NOT_FOUND");
  }
  project(device: Pick<ExternalDevice, "readDisplayNames" | "allowedTierBOperations">, enabled: boolean, ingest = this.ingest()) {
    const engine = this.control.engine, channels = this.channels();
    const bots = ingest.txStems.filter(b => b.profileId).map(b => ({
      profileId: b.profileId!, destination: b.destination ?? null, state: b.state, active: b.active, masterDb: b.masterDb ?? 0,
      sourceInputChannelIds: [b.sourceInputChannelId, b.sourceInputRightChannelId].filter((id): id is string => typeof id === "string"),
      sourceMode: b.sourceInputChannelId === undefined ? "legacyMatrix" as const : b.sourceInputChannelId === null ? "unassigned" as const : "localInput" as const,
    }));
    for (const configured of this.configuredTx) if (!bots.some(b => b.profileId === configured.profileId)) {
      bots.push({ profileId: configured.profileId, destination: configured.destination, state: "NO_BOT", active: false, masterDb: 0, sourceInputChannelIds: [], sourceMode: "unassigned" });
    }
    const armed = ingest.txTargets?.armed ?? [], teams = ingest.txTargets?.allTeams ?? [];
    const monitor = engine.monitorSourceId, channel = channels.find(c => c.id === monitor);
    const pfl = channel ? { kind: "channel" as const, target: { kind: "user" as const, discordUserId: channel.discordUserId! } }
      : monitor && engine.buses.has(monitor) ? { kind: "bus" as const, busId: monitor } : null;
    return {
      instanceId: this.instanceId, revision: this.revision, participantsRevision: this.participantsRevision, enabled,
      state: this.control.state, settingsLocked: this.control.state === "ON_AIR", emergencyMuted: engine.emergencyMuted, emergencyEpoch: this.control.emergencyEpoch,
      outputCount: Math.min(64, this.control.outputManager?.snapshot(false).activeChannelCount ?? engine.outputChannelCount),
      participants: channels.map(c => ({ discordUserId: c.discordUserId!, faderDb: c.faderDb, mute: c.mute,
        sends: [...c.vcSends].map(([busId, s]) => ({ busId, db: s.gainDb, mute: s.mute })),
        ...(device.readDisplayNames ? { displayName: displayName(c.label) } : {}) })),
      registeredUsers: [...(this.control.userSessions?.profiles.profiles.values() ?? [])].map(p => ({ discordUserId: p.discordUserId,
        online: channels.some(c => c.discordUserId === p.discordUserId), ...(device.readDisplayNames ? { displayName: displayName(p.displayName) } : {}) })),
      participantOrders: this.orders(),
      buses: [...engine.buses.values()].map(b => ({ busId: b.id, kind: b.groupSourceIds !== null ? "group" : b.linkedDiscordVoiceChannelId ? "vc" : "other",
        masterDb: b.masterDb, mute: b.mute, limiterEnabled: b.limiter.enabled,
        compressor: { enabled: b.compressorEnabled, thresholdDb: b.compressor.thresholdDb, ratio: b.compressor.ratio,
          attackMs: b.compressor.attackMs, releaseMs: b.compressor.releaseMs, makeupDb: b.compressor.makeupDb } })),
      pfl, tx: { targetsRevision: this.targetsRevision, armedProfileIds: [...armed], liveProfileIds: [...(ingest.txTargets?.live ?? [])],
        selectionKind: this.selectionKind, allTeams: teams.length > 0 && teams.every(id => armed.includes(id)), takeTier: armed.length ? "A" as const : null, bots },
      recorder: { state: this.control.recorder?.snapshot().state ?? "IDLE" },
      scenes: [...this.control.scenes.keys()].map(sceneId => ({ sceneId })), currentSceneId: this.control.currentSceneId,
      permissions: { allowedTierBOperations: [...device.allowedTierBOperations], readDisplayNames: device.readDisplayNames },
    };
  }
}

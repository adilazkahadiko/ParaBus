import { randomUUID } from "node:crypto";
import type { ControlCommand, DiscordIngestSnapshot } from "../../../packages/shared-types/src/index.ts";
import type { ControlPlane } from "./control-plane.ts";
import type { ExternalDevice, ExternalDeviceStore } from "./external-device-store.ts";
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
  #dependencies = new Map<string, { value: string; generation: number; read: () => unknown; groups: Set<string> }>();
  #dependencyGroups = new Map<string, Set<string>>();
  #dependencyClock = 0;
  #userAppearances = new Map<string, number>();
  #publicBusIds = new Map<string, string>();
  #internalBusIds = new Map<string, string>();
  #collidingBusAliases = new Set<string>();
  #busAliasStore?: Pick<ExternalDeviceStore, "available" | "busAlias">;
  #log: (message: string) => void;
  readonly txIdentities: () => readonly object[];
  readonly configuredTx: readonly { profileId: string; destination: string | null }[];
  constructor(control: ControlPlane, ingest: () => DiscordIngestSnapshot, txIdentities: () => readonly object[] = () => [], configuredTx: readonly { profileId: string; destination: string | null }[] = [],
    busAliasStore?: Pick<ExternalDeviceStore, "available" | "busAlias">, log: (message: string) => void = () => {}) {
    this.control = control; this.ingest = ingest;
    this.txIdentities = txIdentities;
    this.configuredTx = configuredTx;
    this.#busAliasStore = busAliasStore; this.#log = log;
    const appearance = (channel: { discordUserId?: string }) => {
      this.#appearance++;
      if (channel.discordUserId) this.#userAppearances.set(channel.discordUserId, this.#appearance);
    };
    control.userSessions?.onJoin(appearance);
    control.userSessions?.onLeave(appearance);
    if (!busAliasStore || busAliasStore.available) this.observe();
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
    this.captureDependencies();
    this.observeMappings(ingest, channels);
    const { revision: _revision, ...projection } = this.project({ readDisplayNames: true, allowedTierBOperations: [] }, true, ingest);
    const state = canonical([projection, this.#participants,
      channels.map(c => [this.identity(c), c.approvalGateOpen]), [...engine.buses.values()].map(b => this.identity(b))]);
    if (this.#state && state !== this.#state) this.revision++;
    this.#state = state;
  }
  private observeMappings(ingest = this.ingest(), channels = this.channels()) {
    const engine = this.control.engine;
    const participants = canonical([this.#appearance, channels.map(c => [c.discordUserId, this.identity(c), c.currentVoiceChannelId, c.preferredStripPosition]),
      [...engine.buses.values()].map(b => [b.id, this.identity(b), b.linkedDiscordGuildId, b.linkedDiscordVoiceChannelId, b.groupSourceIds]), this.orders()]);
    if (this.#participants && participants !== this.#participants) { this.participantsRevision++; this.revision++; }
    this.#participants = participants;
    const internalRevision = ingest.txTargetsRevision ?? 1;
    const armed = canonical([...(ingest.txTargets?.armed ?? [])].sort());
    const targets = canonical([internalRevision, ingest.txTargets, this.txIdentities().map(b => this.identity(b)),
      ingest.txStems.map(b => [b.profileId, b.destination, b.state, b.active, b.sourceInputChannelId, b.sourceInputRightChannelId, b.sourceOutput]),
      ingest.bots.filter(b => b.role === "TX" || b.role === "DUPLEX").map(b => [b.profileId, b.botId, b.voiceChannelId])]);
    if (this.#targets && targets !== this.#targets) {
      this.targetsRevision++;
      this.revision++;
      if (armed !== this.#armed) this.selectionKind = "profiles";
    }
    this.#targets = targets; this.#armed = armed; this.#internalTargetsRevision = internalRevision;
  }
  selected(kind: ExternalState["selectionKind"]) {
    this.observe();
    if (this.selectionKind !== kind) { this.selectionKind = kind; this.targetsRevision++; }
    this.observe();
  }
  internalTargetsRevision() { return this.#internalTargetsRevision; }
  identityOf(value: object | undefined | null) { return value ? this.identity(value) : null; }
  /** Keep ordinary IDs compatible, but never publish Discord topology encoded inside an ID. */
  publicBusId(id: string) {
    if (!/discord-(?:vc|user):|\d{17,20}|^external-bus:/.test(id)) return id;
    let alias = this.#publicBusIds.get(id);
    if (!alias) {
      alias = this.#busAliasStore?.busAlias(id) ?? fail("UNAVAILABLE");
      const previous = this.#internalBusIds.get(alias);
      if (previous !== undefined && previous !== id) {
        if (!this.#collidingBusAliases.has(alias)) this.#log("External control Bus alias collision");
        this.#collidingBusAliases.add(alias); this.#internalBusIds.delete(alias);
      } else if (!this.#collidingBusAliases.has(alias)) this.#internalBusIds.set(alias, id);
      this.#publicBusIds.set(id, alias);
    }
    return alias;
  }
  get busAliasCollision() { return this.#collidingBusAliases.size > 0; }
  assertBusAliasIntegrity() {
    if (this.#busAliasStore && !this.#busAliasStore.available) fail("UNAVAILABLE");
    for (const id of this.control.engine.buses.keys()) this.publicBusId(id);
    if (this.busAliasCollision) fail("UNAVAILABLE");
  }
  resolveBusId(value: unknown) { const id = textId(value); this.assertBusAliasIntegrity(); return this.#internalBusIds.get(id) ?? id; }
  watch(key: string, read: () => unknown, groups: string[] = [key]) {
    let entry = this.#dependencies.get(key);
    if (entry) entry.read = read;
    else { entry = { read, value: "", generation: 0, groups: new Set() }; this.#dependencies.set(key, entry); }
    for (const group of groups) {
      let keys = this.#dependencyGroups.get(group); if (!keys) { keys = new Set(); this.#dependencyGroups.set(group, keys); } keys.add(key);
      entry.groups.add(group);
    }
    this.updateDependency(key); return key;
  }
  private updateDependency(key: string) {
    const entry = this.#dependencies.get(key); if (!entry) return false;
    const value = canonical(entry.read());
    if (value !== entry.value) { entry.value = value; entry.generation = ++this.#dependencyClock; return true; }
    return false;
  }
  private captureDependencies() { let changed = false; for (const key of this.#dependencies.keys()) if (this.updateDependency(key)) changed = true; return changed; }
  /** Fader commands update only the affected value and any previews watching it, synchronously, including ABA. */
  changed(command?: ControlCommand, valueChanged?: boolean) {
    let groups: string[] | undefined;
    if (command?.type === "SET_CHANNEL_FADER") groups = [dep("channel", command.channelId, "fader")];
    if (command?.type === "SET_BUS_MASTER") groups = [dep("bus", command.busId, "fader")];
    if (command?.type === "SET_TX_MASTER") groups = [dep("tx", command.profileId!, "fader")];
    if (command?.type === "SET_VC_SEND") groups = [dep("send", command.channelId, command.busId, "fader"), dep("send", command.channelId, command.busId, "mute")];
    if (groups) {
      for (const group of groups) for (const key of this.#dependencyGroups.get(group) ?? []) this.updateDependency(key);
    }
    else { if (this.captureDependencies()) this.revision++; this.observeMappings(); }
    if (valueChanged) this.revision++;
  }
  dependencies(keys: string[]) {
    for (const key of keys) {
      if (!this.#dependencies.has(key)) this.watch(key, () => this.readDependency(key));
      else this.updateDependency(key);
    }
    return canonical(keys.map(key => [key, this.#dependencies.get(key)!.generation]));
  }
  pruneSceneDependencies(used: Set<string>) {
    for (const [key, entry] of this.#dependencies) if (key.startsWith('["scene') && !used.has(key)) {
      this.#dependencies.delete(key);
      for (const group of entry.groups) { const keys = this.#dependencyGroups.get(group)!; keys.delete(key); if (!keys.size) this.#dependencyGroups.delete(group); }
    }
  }
  private readDependency(key: string): unknown {
    const engine = this.control.engine;
    if (key === "lock") return this.control.state;
    if (key === "emergency") return this.control.emergencyEpoch;
    if (key === "recorder") return [this.identityOf(this.control.recorder), this.control.recorder?.generation, this.control.recorder?.state];
    const [family, id, field, extra] = JSON.parse(key) as string[];
    if (family === "output") {
      const count = this.control.outputManager?.snapshot(false).activeChannelCount ?? engine.outputChannelCount;
      return Number(id) < count ? this.identityOf(engine.outputs[Number(id)]) : null;
    }
    if (family === "channel") {
      const c = engine.channels.get(id); return field === "fader" ? c?.faderDb : [this.identityOf(c), c?.currentVoiceChannelId,
        this.#userAppearances.get(c?.discordUserId ?? ""), this.control.userSessions?.sessions.get(c?.discordUserId ?? "")?.online];
    }
    if (family === "bus") {
      const b = engine.buses.get(id); if (!b) return null;
      if (field === "fader") return b.masterDb;
      if (field === "limiter") return b.limiter.enabled;
      if (field === "compressor") return extra === "enabled" ? b.compressorEnabled : (b.compressor as unknown as Record<string, unknown>)[extra];
      return [this.identity(b), b.linkedDiscordGuildId, b.linkedDiscordVoiceChannelId, b.groupSourceIds];
    }
    if (family === "send") { const send = engine.channels.get(id)?.vcSends.get(field); return extra === "fader" ? send?.gainDb : this.identityOf(send); }
    if (family === "tx") {
      if (field === "fader") return this.control.txController?.txMasterDb?.(id) ?? this.ingest().txStems.find(b => b.profileId === id)?.masterDb ?? 0;
      const ingest = this.ingest(), bot = ingest.txStems.find(b => b.profileId === id);
      return [this.txIdentities().filter(b => (b as { profileId?: string }).profileId === id).map(b => this.identity(b)), bot?.destination, bot?.state,
        bot?.active, bot?.sourceInputChannelId, bot?.sourceInputRightChannelId, bot?.sourceOutput, ingest.bots.filter(b => b.profileId === id).map(b => [b.botId, b.voiceChannelId])];
    }
    return null;
  }
  /** No old target/slot revision may survive an interval in which mutations were not observed. */
  resume() { this.revision++; this.participantsRevision++; this.targetsRevision++; this.observe(); }
  resolveTarget(value: unknown) {
    this.validateTarget(value);
    const target = fields(value, ["kind"], ["discordUserId", "scope", "index", "expectedParticipantsRevision"]);
    let userId: string;
    if (target.kind === "user") {
      fields(value, ["kind", "discordUserId"]); userId = textId(target.discordUserId, 20);
      if (!/^\d{17,20}$/.test(userId)) fail("INVALID");
      if (!this.control.userSessions?.profiles.profiles.has(userId)) fail("NOT_FOUND");
    } else if (target.kind === "slot") {
      fields(value, ["kind", "scope", "index", "expectedParticipantsRevision"]);
      const expected = revision(target.expectedParticipantsRevision), index = revision(target.index);
      const scope = { ...fields(target.scope, ["kind"], ["busId"]) };
      if (scope.kind === "all") fields(scope, ["kind"]);
      else if (scope.kind === "bus") {
        fields(scope, ["kind", "busId"]); scope.busId = this.resolveBusId(scope.busId);
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
  validateTarget(value: unknown) {
    const target = fields(value, ["kind"], ["discordUserId", "scope", "index", "expectedParticipantsRevision"]);
    if (target.kind === "user") {
      fields(target, ["kind", "discordUserId"]); if (!/^\d{17,20}$/.test(textId(target.discordUserId, 20))) fail("INVALID");
    } else if (target.kind === "slot") {
      fields(target, ["kind", "scope", "index", "expectedParticipantsRevision"]); revision(target.index); revision(target.expectedParticipantsRevision);
      const scope = fields(target.scope, ["kind"], ["busId"]);
      if (scope.kind === "all") fields(scope, ["kind"]);
      else if (scope.kind === "bus") { fields(scope, ["kind", "busId"]); textId(scope.busId); }
      else fail("INVALID");
    } else fail("INVALID");
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
      : monitor && engine.buses.has(monitor) ? { kind: "bus" as const, busId: this.publicBusId(monitor) } : null;
    return {
      instanceId: this.instanceId, revision: this.revision, participantsRevision: this.participantsRevision, enabled,
      state: this.control.state, settingsLocked: this.control.state === "ON_AIR", emergencyMuted: engine.emergencyMuted, emergencyEpoch: this.control.emergencyEpoch,
      outputCount: Math.min(64, this.control.outputManager?.snapshot(false).activeChannelCount ?? engine.outputChannelCount),
      participants: channels.map(c => ({ discordUserId: c.discordUserId!, faderDb: c.faderDb, mute: c.mute,
        sends: [...c.vcSends].map(([busId, s]) => ({ busId: this.publicBusId(busId), db: s.gainDb, mute: s.mute })),
        ...(device.readDisplayNames ? { displayName: displayName(c.label) } : {}) })),
      registeredUsers: [...(this.control.userSessions?.profiles.profiles.values() ?? [])].map(p => ({ discordUserId: p.discordUserId,
        online: channels.some(c => c.discordUserId === p.discordUserId), ...(device.readDisplayNames ? { displayName: displayName(p.displayName) } : {}) })),
      participantOrders: this.orders().map(order => ({ ...order, scope: order.scope.kind === "bus"
        ? { kind: "bus" as const, busId: this.publicBusId(order.scope.busId) } : order.scope })),
      buses: [...engine.buses.values()].map(b => ({ busId: this.publicBusId(b.id), kind: b.groupSourceIds !== null ? "group" : b.linkedDiscordVoiceChannelId ? "vc" : "other",
        masterDb: b.masterDb, mute: b.mute, limiterEnabled: b.limiter.enabled,
        compressor: { enabled: b.compressorEnabled, thresholdDb: b.compressor.thresholdDb, ratio: b.compressor.ratio,
          attackMs: b.compressor.attackMs, releaseMs: b.compressor.releaseMs, makeupDb: b.compressor.makeupDb } })),
      pfl, tx: { targetsRevision: this.targetsRevision, armedProfileIds: [...armed], liveProfileIds: [...(ingest.txTargets?.live ?? [])],
        selectionKind: this.selectionKind, allTeams: teams.length > 0 && teams.every(id => armed.includes(id)), takeTier: armed.length ? "A" as const : null, bots },
      recorder: { state: this.control.recorder?.state ?? "IDLE" },
      scenes: [...this.control.scenes.keys()].map(sceneId => ({ sceneId })), currentSceneId: this.control.currentSceneId,
      permissions: { allowedTierBOperations: [...device.allowedTierBOperations], readDisplayNames: device.readDisplayNames },
    };
  }
}

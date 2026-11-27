import type { ExternalDevice } from './external-device-store.ts';
import { ExternalControlServer } from './external-control.ts';
import { ipv4, matchesLanAddress, lanAddresses, LanControlStore, LanSecretStore, readLanScope, type LanGroup } from './lan-control-store.ts';
import { encodeConnectionCode } from './lan-client.ts';
import { boolean, fail, fields, type RecordValue } from './external-protocol.ts';
import { sanitizeOperatorMessage } from './operator-sanitize.ts';
import type { TokenProtection } from '../../discord-adapter/src/token-protection.ts';

const GROUP_OPERATIONS: Record<LanGroup, readonly string[]> = {
  mix: ['bus.fader.adjust', 'bus.fader.set', 'bus.mute.set', 'bus.mute.toggle', 'send.fader.adjust', 'send.fader.set', 'send.mute.set', 'send.mute.toggle', 'tx.fader.adjust', 'tx.fader.set'],
  cue: ['pfl.set'], emergency: ['emergency.set'],
  tx: ['tx.start', 'tx.stop', 'tx.clear', 'tx.targets.set', 'tx.take'],
  recording: ['recording.start', 'recording.stop'], scenes: ['scene.preview', 'scene.recall'],
};
export class LanControl {
  readonly store: LanControlStore;
  readonly secrets: LanSecretStore;
  readonly local: ExternalControlServer;
  readonly addresses: () => string[];
  readonly reservedPorts: () => number[];
  readonly warn: (message: string) => void;
  #api?: ExternalControlServer;
  #closing: Promise<unknown> = Promise.resolve();
  #epoch = 0;
  #error: string | null = null;
  constructor(root: string, local: ExternalControlServer, reservedPorts: () => number[], addresses = lanAddresses, protection?: TokenProtection, warn = (message: string) => local.options.log(message)) {
    this.store = new LanControlStore(root); this.local = local; this.reservedPorts = reservedPorts; this.addresses = addresses;
    this.warn = warn; this.secrets = new LanSecretStore(root, warn, protection);
    void this.secrets.retainTokens(new Set(local.store.list().filter(device => !device.revoked && this.store.scope(device.deviceId).enabled).map(device => device.deviceId)))
      .catch(() => this.warn('LAN機器の不要な鍵を削除できません。保存先を確認してください。'));
    const previous = local.options.onManagementChange;
    local.options.onManagementChange = (action, id, result) => {
      previous?.(action, id, result);
      if (action === 'stop') this.stop();
      else if (id) {
        this.#api?.invalidateDevice(id);
        if (action === 'delete') {
          try { this.store.removeDevice(id); } catch { this.local.options.log('LAN機器の設定を削除できません。保存先を確認してください。'); }
          void this.secrets.forget(id).catch(() => this.local.options.log('LAN機器の鍵を削除できません。保存先を確認してください。'));
        }
        if (action === 'revoke') void this.secrets.forget(id).catch(() => this.warn('LAN機器の鍵を削除できません。保存先を確認してください。'));
        const token = (result as { token?: string } | undefined)?.token;
        if (token && this.store.scope(id).enabled) void this.secrets.remember(id, token).catch(() => this.local.options.log('LAN機器の鍵を保存できません。接続コードを再発行してください。'));
      }
    };
  }
  get api() { return this.#api; }
  noteChange() { this.#api?.noteChange(); }
  async start() { if (this.store.snapshot().enabled) await this.listen(); }
  private detach() {
    const api = this.#api; this.#api = undefined;
    if (api) { const closed = api.close(); this.#closing = Promise.all([this.#closing, closed]); }
    return this.#closing;
  }
  stop() { this.#epoch++; void this.detach(); this.store.stop(); this.#error = this.store.error; }
  async close() { this.#epoch++; await this.detach(); await this.secrets.flush(); }
  snapshot() {
    const settings = this.store.snapshot();
    let selectors: Array<{ selectorId: string; name: string }> = [];
    try { selectors = [...this.local.options.control.engine.buses.values()].filter(bus => bus.selector).map(bus => ({ selectorId: this.local.state.publicBusId(bus.id), name: bus.label })); }
    catch { this.#error ??= '外部操作の機器登録・Bus別名を利用できません。登録ファイルを確認してください。'; }
    return { enabled: settings.enabled, address: settings.address, port: settings.port, addresses: this.addresses(), listening: this.#api?.available ?? false,
      error: this.#error ?? this.store.error ?? this.secrets.error, fingerprint: this.secrets.fingerprint(), protectionWarning: this.secrets.protectionWarning,
      state: this.local.options.control.state,
      selectors,
      devices: this.local.store.list().map(device => ({ deviceId: device.deviceId, name: device.name, revoked: device.revoked, ...this.store.scope(device.deviceId) })) };
  }
  async manage(input: unknown): Promise<unknown> {
    const value = fields(input, ['action'], ['enabled', 'address', 'port', 'deviceId', 'scope', 'confirmed', 'reissue']);
    if (value.action === 'status') { fields(value, ['action']); return this.snapshot(); }
    if (value.action === 'stop') { fields(value, ['action']); this.stop(); return this.snapshot(); }
    if (this.local.options.control.state !== 'SETUP') fail('LOCKED');
    if (value.action === 'configure') {
      fields(value, ['action', 'enabled', 'address', 'port']);
      const enabled = boolean(value.enabled);
      if (!ipv4(value.address) || !this.addresses().includes(value.address) || !Number.isInteger(value.port) || Number(value.port) < 1024 || Number(value.port) > 65535 || this.reservedPorts().includes(Number(value.port))) fail('INVALID');
      const epoch = ++this.#epoch; await this.detach();
      if (enabled) {
        try { await this.secrets.credentials(value.address); }
        catch { this.#error = 'LANの証明書・秘密鍵を準備できません。証明書と保存先の権限を確認してください。'; this.warn(this.#error); return this.snapshot(); }
      }
      if (epoch !== this.#epoch || this.local.options.control.state !== 'SETUP') fail('LOCKED');
      this.store.configure(enabled, value.address, Number(value.port)); this.#error = null;
      if (enabled) await this.listen(); return this.snapshot();
    }
    if (value.action === 'scope') {
      fields(value, ['action', 'deviceId', 'scope']);
      const device = this.local.store.list().find(device => device.deviceId === value.deviceId && !device.revoked); if (!device) fail('NOT_FOUND');
      const scope = readLanScope(value.scope);
      scope.selectorIds = scope.selectorIds.map(selectorId => {
        const id = this.local.state.resolveBusId(selectorId); if (!this.local.options.control.engine.buses.get(id)?.selector) fail('NOT_FOUND');
        return this.local.state.publicBusId(id);
      });
      this.store.setScope(device.deviceId, scope); this.#api?.invalidateDevice(device.deviceId);
      if (!scope.enabled) await this.secrets.forget(device.deviceId);
      return this.snapshot();
    }
    if (value.action === 'rotate') {
      fields(value, ['action', 'confirmed']); if (value.confirmed !== true) fail('CONFIRMATION_REQUIRED');
      const settings = this.store.snapshot(); if (!ipv4(settings.address) || !this.addresses().includes(settings.address)) fail('INVALID');
      const epoch = ++this.#epoch; await this.detach(); await this.secrets.credentials(settings.address, true);
      if (epoch !== this.#epoch) fail('LOCKED');
      if (settings.enabled) await this.listen(); return this.snapshot();
    }
    if (value.action === 'connection-code') {
      fields(value, ['action', 'deviceId'], ['reissue']); if (value.reissue !== undefined) boolean(value.reissue);
      const device = this.local.store.list().find(device => device.deviceId === value.deviceId && !device.revoked); if (!device) fail('NOT_FOUND');
      const settings = this.store.snapshot(), fingerprint = this.secrets.fingerprint();
      if (!this.store.scope(device.deviceId).enabled) fail('LOCKED');
      if (!fingerprint || !ipv4(settings.address)) fail('LOCKED');
      let token = await this.secrets.token(device.deviceId);
      if (!token || this.local.store.authenticate(token)?.deviceId !== device.deviceId) {
        if (!value.reissue) return { requiresReissue: true };
        const result = this.local.manage({ action: 'reissue', deviceId: device.deviceId }) as { token: string };
        await this.secrets.flush(); token = result.token;
      }
      return { connectionCode: encodeConnectionCode({ v: 1, address: settings.address, port: settings.port, token, fingerprint }) };
    }
    return fail('INVALID');
  }
  private async listen() {
    const settings = this.store.snapshot(), epoch = this.#epoch;
    try {
      if (!this.store.available || !ipv4(settings.address) || !this.addresses().includes(settings.address)) throw new Error('ADDRESS');
      if (this.reservedPorts().includes(settings.port)) throw new Error('PORT');
      const credentials = await this.secrets.credentials(settings.address);
      if (epoch !== this.#epoch || !this.store.snapshot().enabled) return;
      const api = new ExternalControlServer({ ...this.local.options, onManagementChange: undefined,
        transport: { address: settings.address, port: settings.port, tls: { cert: credentials.certificate, key: credentials.key }, enabled: () => this.store.snapshot().enabled,
          authorize: (device, ip) => { const scope = this.store.scope(device.deviceId); return scope.enabled && scope.addresses.some(rule => matchesLanAddress(rule, ip)); },
          allowOperation: (device, operation, args) => this.allow(device, operation, args),
          projectData: (device, data) => this.project(device, data),
          audit: (device, ip, operation, result) => this.local.options.log(`LAN control action device=${JSON.stringify(sanitizeOperatorMessage(device.name, 'Device'))} ip=${ip} operation=${operation} result=${result}`),
        } });
      this.#api = api; await api.start();
      if (epoch !== this.#epoch) { await this.detach(); return; }
      if (!api.available) { await this.detach(); this.#error = 'LANのポートを使用できません。ほかのアプリの使用状況とアドレスを確認してください。'; }
      else this.#error = null;
    } catch {
      await this.detach();
      this.#error = !this.addresses().includes(settings.address) ? '保存したIPv4アドレスをこのPCで使用できません。SETUPで選び直してください。'
        : this.reservedPorts().includes(settings.port) ? 'LANのポートが既存のポートと重複しています。別のポートを選んでください。'
          : 'LANの待ち受けを開始できません。証明書・秘密鍵・保存先の権限を確認してください。';
    }
    if (this.#error) this.warn(this.#error);
  }
  private operationGroup(operation: string): LanGroup | undefined { return (Object.keys(GROUP_OPERATIONS) as LanGroup[]).find(group => GROUP_OPERATIONS[group].includes(operation)); }
  private participantAccess(device: ExternalDevice, groups: readonly LanGroup[]) { return groups.includes('mix') || groups.includes('cue') || groups.includes('recording') && device.allowedTierBOperations.includes('recording.start'); }
  private allow(device: ExternalDevice, operation: string, args: RecordValue) {
    const scope = this.store.scope(device.deviceId), api = this.#api;
    if (!api) fail('DISABLED');
    if (operation === 'selector.select' || operation === 'selector.off') {
      const id = api.state.publicBusId(api.state.resolveBusId(args.selectorId));
      if (!scope.selectorIds.includes(id)) fail('TIER_FORBIDDEN'); return;
    }
    const group = this.operationGroup(operation); if (!group || !scope.groups.includes(group)) fail('TIER_FORBIDDEN');
    const checkSelector = (id: unknown) => {
      const internal = api.state.resolveBusId(id), bus = api.options.control.engine.buses.get(internal);
      if (bus?.selector && !scope.selectorIds.includes(api.state.publicBusId(internal))) fail('TIER_FORBIDDEN');
    };
    if (args.busId !== undefined) checkSelector(args.busId);
    const source = args.source as { kind?: unknown; busId?: unknown } | undefined;
    if (source?.kind === 'bus') checkSelector(source.busId);
    const selection = args.selection as { busIds?: unknown } | undefined;
    if (Array.isArray(selection?.busIds)) selection.busIds.forEach(checkSelector);
    if (group === 'scenes' && typeof args.sceneId === 'string') {
      const scene = api.options.control.scenes.get(args.sceneId);
      for (const parameter of Object.keys(scene?.values ?? {})) {
        const match = /^bus\.([^.]+)\./.exec(parameter); if (match) checkSelector(match[1]);
      }
    }
  }
  private project(device: ExternalDevice, data: unknown): unknown {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    const value = data as Record<string, any>, scope = this.store.scope(device.deviceId);
    if (Array.isArray(value.operations)) {
      const features = ['state.ws', 'selectors'];
      if (scope.groups.includes('mix')) features.push('fader.relative', 'fader.absolute');
      if (this.participantAccess(device, scope.groups)) features.push('participants.slot', 'participants.user');
      if (scope.groups.includes('tx')) features.push('tx.targets');
      if (scope.groups.includes('recording')) features.push('recording.selection');
      if (scope.groups.includes('scenes')) features.push('scene.preview', 'scene.recall');
      if (device.allowedTierBOperations.some(operation => scope.groups.includes(this.operationGroup(operation)!))) features.push('confirmation.arm-execute');
      return { ...value, features,
      operations: value.operations.filter((entry: { name: string }) => entry.name.startsWith('selector.') || scope.groups.includes(this.operationGroup(entry.name)!)),
      permissions: { ...value.permissions, allowedTierBOperations: device.allowedTierBOperations.filter(operation => scope.groups.includes(this.operationGroup(operation)!)) } };
    }
    if (Array.isArray(value.selectors) && value.instanceId) {
      const selectors = value.selectors.filter((selector: any) => scope.selectorIds.includes(selector.selectorId));
      const ids = new Set<string>(selectors.flatMap((selector: any) => [selector.selectorId, ...selector.sourceBusIds]));
      const participants = this.participantAccess(device, scope.groups);
      const recordingStart = scope.groups.includes('recording') && device.allowedTierBOperations.includes('recording.start');
      const allBuses = scope.groups.some(group => ['mix', 'cue', 'scenes'].includes(group)) || recordingStart;
      const selected = new Set(value.selectors.map((selector: any) => selector.selectorId));
      const buses = value.buses.filter((bus: any) => (!selected.has(bus.busId) || scope.selectorIds.includes(bus.busId)) && (allBuses || ids.has(bus.busId)))
        .map((bus: any) => ({ busId: bus.busId, ...(Object.hasOwn(bus, 'label') ? { label: bus.label } : {}),
          ...(allBuses ? { kind: bus.kind } : {}), ...(scope.groups.includes('mix') ? { masterDb: bus.masterDb, mute: bus.mute } : {}) }));
      const result: Record<string, unknown> = {};
      for (const key of ['instanceId', 'revision', 'enabled', 'state', 'settingsLocked', 'emergencyMuted', 'emergencyEpoch']) result[key] = value[key];
      result.selectors = selectors; result.buses = buses;
      if (participants) {
        result.participantsRevision = value.participantsRevision; result.participantOrders = value.participantOrders;
        result.participants = value.participants.map((participant: any) => scope.groups.includes('mix') ? participant : { discordUserId: participant.discordUserId, ...(Object.hasOwn(participant, 'displayName') ? { displayName: participant.displayName } : {}) });
        result.registeredUsers = value.registeredUsers.filter((user: any) => user.online);
      }
      if (scope.groups.includes('cue')) result.pfl = value.pfl && value.pfl.kind === 'bus' && !buses.some((bus: any) => bus.busId === value.pfl.busId) ? null : value.pfl;
      if (scope.groups.includes('mix') || scope.groups.includes('tx')) result.tx = { ...value.tx, bots: value.tx.bots.map((bot: any) => ({ profileId: bot.profileId, destination: bot.destination, state: bot.state, active: bot.active, ...(scope.groups.includes('mix') ? { masterDb: bot.masterDb } : {}) })) };
      if (scope.groups.includes('recording') && device.allowedTierBOperations.some(operation => operation === 'recording.start' || operation === 'recording.stop')) result.recorder = value.recorder;
      if (recordingStart) result.outputCount = value.outputCount;
      if (scope.groups.includes('scenes')) { result.scenes = value.scenes; result.currentSceneId = value.currentSceneId; }
      result.permissions = { readDisplayNames: device.readDisplayNames, allowedTierBOperations: device.allowedTierBOperations.filter(operation => scope.groups.includes(this.operationGroup(operation)!)) };
      return result;
    }
    if (this.participantAccess(device, scope.groups)) return data;
    // Scene previews/arm summaries keep internal dependency checks, but do not
    // reveal participant targets or their values to a scene-only controller.
    const clean = (entry: any): any => Array.isArray(entry) ? entry.filter(item => item?.target?.kind !== 'channel').map(clean)
      : entry && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry).filter(([key]) => !['excludedParticipantCount', 'discordUserId', 'channelId'].includes(key)).map(([key, child]) => [key, clean(child)])) : entry;
    return clean(data);
  }
}

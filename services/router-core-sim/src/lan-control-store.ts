import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { writePrivateFile, writePrivateFileSync } from "./private-files.ts";
import { tokenProtection, PROTECTED_TOKEN_PREFIX, type TokenProtection } from "../../discord-adapter/src/token-protection.ts";
import { boolean, fail, fields, strictJson, textId, uuid } from "./external-protocol.ts";
import { generateLanCertificate } from "./lan-certificate.ts";

export const LAN_GROUPS = ['mix', 'cue', 'emergency', 'tx', 'recording', 'scenes'] as const;
export type LanGroup = typeof LAN_GROUPS[number];
export interface LanDeviceScope { enabled: boolean; addresses: string[]; selectorIds: string[]; groups: LanGroup[] }
export interface LanSettings { version: 1; enabled: boolean; address: string; port: number; devices: Record<string, LanDeviceScope> }
export const emptyLanScope = (): LanDeviceScope => ({ enabled: false, addresses: [], selectorIds: [], groups: [] });
export function ipv4(value: unknown): value is string { return typeof value === 'string' && isIP(value) === 4 && value !== '0.0.0.0' && Number(value.split('.')[0]) < 224; }
export function lanAddresses(): string[] {
  return [...new Set(Object.values(networkInterfaces()).flatMap(entries => (entries ?? []).filter(entry => !entry.internal && entry.family === 'IPv4' && ipv4(entry.address)).map(entry => entry.address)))].sort();
}
export function readLanScope(input: unknown): LanDeviceScope {
  const raw = fields(input, ['enabled', 'addresses', 'selectorIds', 'groups']);
  const array = (value: unknown, max: number) => {
    if (!Array.isArray(value) || value.length > max || new Set(value).size !== value.length) return fail('INVALID');
    return value;
  };
  const addresses = array(raw.addresses, 8); if (!addresses.every(ipv4)) fail('INVALID');
  const selectorIds = array(raw.selectorIds, 8).map(id => textId(id));
  const groups = array(raw.groups, LAN_GROUPS.length); if (!groups.every(group => LAN_GROUPS.includes(group as LanGroup))) fail('INVALID');
  return { enabled: boolean(raw.enabled), addresses, selectorIds, groups: groups as LanGroup[] };
}

export class LanControlStore {
  readonly path: string;
  available = true;
  error: string | null = null;
  #value: LanSettings = { version: 1, enabled: false, address: '', port: 4176, devices: {} };
  constructor(root: string) {
    this.path = join(root, 'lan-control.json');
    if (!existsSync(this.path)) return;
    try {
      const text = readFileSync(this.path, 'utf8'); if (Buffer.byteLength(text) > 262144) throw new Error();
      const raw = fields(strictJson(text), ['version', 'enabled', 'address', 'port', 'devices']);
      if (raw.version !== 1 || typeof raw.address !== 'string' || raw.address !== '' && !ipv4(raw.address) || !raw.devices || typeof raw.devices !== 'object' || Array.isArray(raw.devices)) throw new Error();
      const devices = Object.entries(raw.devices); if (devices.length > 128) throw new Error();
      this.#value = { version: 1, enabled: boolean(raw.enabled), address: raw.address, port: this.port(raw.port), devices: Object.fromEntries(devices.map(([id, scope]) => [uuid(id), readLanScope(scope)])) };
    } catch { this.available = false; this.error = 'LAN操作の設定ファイルを読み込めません。設定ファイルとアクセス権を確認してください。'; }
  }
  snapshot(): LanSettings { return structuredClone(this.#value); }
  scope(id: string): LanDeviceScope { return structuredClone(this.#value.devices[id] ?? emptyLanScope()); }
  configure(enabled: boolean, address: string, port: number) { this.save({ ...this.#value, enabled, address, port: this.port(port) }); }
  setScope(id: string, scope: LanDeviceScope) { this.save({ ...this.#value, devices: { ...this.#value.devices, [uuid(id)]: readLanScope(scope) } }); }
  removeDevice(id: string) { if (!this.#value.devices[id]) return; const devices = { ...this.#value.devices }; delete devices[id]; this.save({ ...this.#value, devices }); }
  stop() {
    this.#value.enabled = false;
    try { this.save(this.#value); } catch { this.error = 'LAN操作は停止しましたが、OFFの保存に失敗しました。'; }
  }
  private port(value: unknown): number { if (!Number.isInteger(value) || Number(value) < 1024 || Number(value) > 65535) return fail('INVALID'); return Number(value); }
  private save(value: LanSettings) {
    if (!this.available) fail('UNAVAILABLE');
    try { writePrivateFileSync(this.path, JSON.stringify(value, null, 2) + '\n'); this.#value = structuredClone(value); this.error = null; }
    catch { fail('UNAVAILABLE'); }
  }
}

interface Secrets { version: 1; certificate: string; key: string; tokens: Record<string, string> }
export class LanSecretStore {
  readonly path: string;
  readonly protection: TokenProtection;
  readonly warn: (message: string) => void;
  protectionWarning: string | null = null;
  #pending: Promise<unknown> = Promise.resolve();
  #value: Secrets | undefined;
  #unreadable = false;
  constructor(root: string, warn: (message: string) => void, protection = tokenProtection) {
    this.path = join(root, 'lan-control-secrets.json'); this.warn = warn; this.protection = protection;
    if (!existsSync(this.path)) return;
    try {
      const text = readFileSync(this.path, 'utf8'); if (Buffer.byteLength(text) > 1048576) throw new Error();
      const raw = fields(strictJson(text), ['version', 'certificate', 'key', 'tokens']);
      if (raw.version !== 1 || typeof raw.certificate !== 'string' || typeof raw.key !== 'string' || !raw.tokens || typeof raw.tokens !== 'object' || Array.isArray(raw.tokens) || Object.keys(raw.tokens).length > 128) throw new Error();
      this.#value = { version: 1, certificate: raw.certificate, key: raw.key, tokens: Object.fromEntries(Object.entries(raw.tokens).map(([id, value]) => [uuid(id), textId(value, 16384)])) };
      new X509Certificate(raw.certificate);
      if (!raw.key.startsWith(PROTECTED_TOKEN_PREFIX)) this.fallbackWarning();
    } catch { this.#unreadable = true; this.#value = undefined; }
  }
  private fallbackWarning() {
    if (this.protectionWarning) return;
    this.protectionWarning = 'LAN操作の秘密鍵・機器の鍵を暗号化できないため、アクセス権で保護して保存します。保存先の権限を確認してください。';
    this.warn(this.protectionWarning);
  }
  get error(): string | null { return this.#unreadable ? 'LAN操作の証明書・秘密鍵を読めません。SETUPで証明書を作り直してください。' : null; }
  private async protect(value: string): Promise<string> {
    const result = (await this.protection.protect([value]))[0];
    if (!result?.startsWith(PROTECTED_TOKEN_PREFIX)) this.fallbackWarning();
    return result ?? value;
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#pending.then(operation); this.#pending = pending.catch(() => {}); return pending;
  }
  fingerprint(): string | null { return this.#value ? new X509Certificate(this.#value.certificate).fingerprint256.replaceAll(':', '').toLowerCase() : null; }
  credentials(address: string, rotate = false): Promise<{ certificate: string; key: string }> {
    return this.enqueue(async () => {
      if (this.#unreadable && !rotate) throw new Error('LAN操作の秘密鍵を読み込めません。SETUPで証明書を作り直してください。');
      if (!this.#value || rotate) {
        const generated = await generateLanCertificate(address), value: Secrets = { version: 1, certificate: generated.certificate, key: await this.protect(generated.key), tokens: this.#value?.tokens ?? {} };
        await writePrivateFile(this.path, JSON.stringify(value, null, 2) + '\n'); this.#value = value; this.#unreadable = false;
      }
      const key = (await this.protection.unprotect([this.#value.key]))[0];
      const certificate = new X509Certificate(this.#value.certificate);
      if (!key || !certificate.checkPrivateKey(createPrivateKey(key))) throw new Error('LAN操作の秘密鍵を読めません。証明書を作り直してください。');
      return { certificate: this.#value.certificate, key };
    });
  }
  remember(id: string, token: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.#value || this.#unreadable) return; // Codes can explicitly reissue a legacy token after first enable.
      const tokens = { ...this.#value.tokens, [uuid(id)]: await this.protect(token) };
      const value = { ...this.#value, tokens }; await writePrivateFile(this.path, JSON.stringify(value, null, 2) + '\n'); this.#value = value;
    });
  }
  token(id: string): Promise<string | null> {
    return this.enqueue(async () => this.#value?.tokens[id] ? (await this.protection.unprotect([this.#value.tokens[id]]))[0] : null);
  }
  forget(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.#value?.tokens[id]) return;
      const tokens = { ...this.#value.tokens }; delete tokens[id]; const value = { ...this.#value, tokens };
      await writePrivateFile(this.path, JSON.stringify(value, null, 2) + '\n'); this.#value = value;
    });
  }
  flush(): Promise<unknown> { return this.#pending; }
}

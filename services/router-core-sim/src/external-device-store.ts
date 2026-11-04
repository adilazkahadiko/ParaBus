import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { boolean, fields, fail, revision, strictJson, textId } from "./external-protocol.ts";

export interface ExternalDevice {
  deviceId: string; name: string; tokenHash: string; readDisplayNames: boolean;
  allowedTierBOperations: string[]; createdAt: string; revoked: boolean;
}
interface Registration { version: 1; enabled: boolean; port: number; devices: ExternalDevice[] }
export class ExternalDeviceStore {
  readonly path: string;
  available = true;
  #value: Registration = { version: 1, enabled: false, port: 4175, devices: [] };
  constructor(root: string) {
    this.path = join(root, "external-control.json");
    try {
      if (!existsSync(this.path)) return;
      const raw = fields(strictJson(readFileSync(this.path, "utf8")), ["version", "enabled", "port", "devices"]);
      if (raw.version !== 1 || !Array.isArray(raw.devices) || raw.devices.length > 128) fail("INVALID");
      const enabled = boolean(raw.enabled), port = this.validPort(raw.port);
      const devices = raw.devices.map(value => {
        const d = fields(value, ["deviceId", "name", "tokenHash", "readDisplayNames", "allowedTierBOperations", "createdAt", "revoked"]);
        if (!/^[a-f0-9]{64}$/.test(textId(d.tokenHash, 64)) || !Array.isArray(d.allowedTierBOperations)) fail("INVALID");
        return { deviceId: textId(d.deviceId, 36), name: this.validName(d.name), tokenHash: d.tokenHash as string,
          readDisplayNames: boolean(d.readDisplayNames), allowedTierBOperations: [], createdAt: textId(d.createdAt, 32), revoked: boolean(d.revoked) };
      });
      if (new Set(devices.map(d => d.deviceId)).size !== devices.length || new Set(devices.map(d => d.tokenHash)).size !== devices.length) fail("INVALID");
      this.#value = { version: 1, enabled, port, devices };
    } catch { this.available = false; }
  }
  get enabled() { return this.available && this.#value.enabled; }
  get port() { return this.#value.port; }
  summary() { return { deviceCount: this.#value.devices.filter(d => !d.revoked).length, enabled: this.enabled }; }
  list() { return this.#value.devices.map(({ tokenHash: _hash, ...device }) => ({ ...device, allowedTierBOperations: [] })); }
  authenticate(token: string): ExternalDevice | undefined {
    if (!this.available) return undefined;
    const digest = createHash("sha256").update(token).digest();
    let match: ExternalDevice | undefined;
    for (const device of this.#value.devices) {
      if (timingSafeEqual(digest, Buffer.from(device.tokenHash, "hex")) && !device.revoked) match = device;
    }
    return match ? { ...match, allowedTierBOperations: [] } : undefined;
  }
  setEnabled(enabled: boolean) {
    // A failed disk write must never leave the running listener enabled after Stop.
    if (!enabled) this.#value = { ...this.#value, enabled: false };
    this.save({ ...this.#value, enabled });
  }
  setPort(port: unknown) { this.save({ ...this.#value, port: this.validPort(port) }); }
  register(name: unknown, readDisplayNames: unknown = false) {
    if (this.#value.devices.length >= 128) fail("RATE_LIMITED");
    const token = randomBytes(32).toString("base64url");
    const device: ExternalDevice = { deviceId: randomUUID(), name: this.validName(name), tokenHash: this.hash(token),
      readDisplayNames: boolean(readDisplayNames), allowedTierBOperations: [], createdAt: new Date().toISOString(), revoked: false };
    this.save({ ...this.#value, devices: [...this.#value.devices, device] });
    return { deviceId: device.deviceId, token };
  }
  change(id: unknown, action: "revoke" | "reissue" | "permissions", readDisplayNames?: unknown) {
    const deviceId = textId(id, 36), current = this.#value.devices.find(d => d.deviceId === deviceId && !d.revoked);
    if (!current) fail("NOT_FOUND");
    const token = action === "reissue" ? randomBytes(32).toString("base64url") : undefined;
    const next = { ...current, revoked: action === "revoke", ...(token ? { tokenHash: this.hash(token) } : {}),
      ...(action === "permissions" ? { readDisplayNames: boolean(readDisplayNames), allowedTierBOperations: [] } : {}) };
    this.save({ ...this.#value, devices: this.#value.devices.map(d => d.deviceId === deviceId ? next : d) });
    return token ? { deviceId, token } : {};
  }
  private validName(value: unknown) { const name = textId(value, 80).trim(); return name.length ? name : fail("INVALID"); }
  private validPort(value: unknown) { const port = revision(value); return port <= 65535 ? port : fail("INVALID"); }
  private hash(token: string) { return createHash("sha256").update(token).digest("hex"); }
  private save(next: Registration) {
    if (!this.available) fail("UNAVAILABLE");
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      if (process.platform === "win32") {
        // Restrict before publishing the file; do not put hashes in process arguments.
        const identity = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
        execFileSync("icacls.exe", [temporary, "/inheritance:r", "/grant:r", `${identity}:F`], { windowsHide: true, stdio: "ignore" });
      }
      renameSync(temporary, this.path); this.#value = next;
    } catch { fail("UNAVAILABLE"); }
    finally { rmSync(temporary, { force: true }); }
  }
}

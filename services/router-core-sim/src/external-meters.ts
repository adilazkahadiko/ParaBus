import type { ExternalState } from "./external-state.ts";
import { canonical, fail, fields, finite, textId, LIMITS } from "./external-protocol.ts";

type Meter = { peak: number; rms: number | null; clip: boolean | null; stale: boolean };
type Source = { kind: "channel"; target: { kind: "user"; discordUserId: string } } | { kind: "bus"; busId: string } | { kind: "tx"; profileId: string };
export type TxMeter = { profileId?: string | null; peak: number };
export interface MeterBinding { source: Source; read: (tx: readonly TxMeter[] | undefined, identities: Set<object> | undefined) => Meter }
const missing = (): Meter => ({ peak: 0, rms: null, clip: null, stale: true });
export class ExternalMeters {
  readonly state: ExternalState; readonly tx: () => readonly TxMeter[];
  constructor(state: ExternalState, tx: () => readonly TxMeter[]) { this.state = state; this.tx = tx; }
  subscribe(value: unknown) {
    const message = fields(value, ["type", "requestId", "sources", "hz"]);
    const hz = finite(message.hz, 1, LIMITS.maxMeterHz); if (!Number.isInteger(hz)) fail("INVALID");
    if (!Array.isArray(message.sources) || message.sources.length > LIMITS.maxMeterSources) fail("INVALID");
    let tx: readonly TxMeter[] | undefined;
    const bindings = message.sources.map((value): MeterBinding => {
      const s = fields(value, ["kind"], ["target", "busId", "profileId"]);
      if (s.kind === "channel") {
        fields(s, ["kind", "target"]); const target = fields(s.target, ["kind", "discordUserId"]);
        if (target.kind !== "user") fail("INVALID");
        const channel = this.state.resolveTarget(target);
        if (this.state.control.userSessions?.sessions.get(channel.discordUserId!)?.online === false) fail("NOT_FOUND");
        return { source: { kind: "channel", target: { kind: "user", discordUserId: channel.discordUserId! } }, read: () => {
          if (this.state.control.engine.channels.get(channel.id) !== channel || this.state.control.userSessions?.sessions.get(channel.discordUserId!)?.online === false) return missing();
          const meter = channel.outputMeter; return { peak: meter.peak, rms: meter.rms, clip: meter.clip, stale: channel.stale };
        } };
      }
      if (s.kind === "bus") {
        fields(s, ["kind", "busId"]); const busId = textId(s.busId), bus = this.state.control.engine.buses.get(busId) ?? fail("NOT_FOUND");
        return { source: { kind: "bus", busId }, read: () => this.state.control.engine.buses.get(busId) !== bus ? missing()
          : { peak: bus.meter.peak, rms: bus.meter.rms, clip: bus.meter.clip, stale: false } };
      }
      if (s.kind === "tx") {
        fields(s, ["kind", "profileId"]); const profileId = textId(s.profileId, 32);
        if (!/^[A-Za-z0-9_-]+$/.test(profileId)) fail("INVALID");
        tx ??= this.tx(); if (!tx.some(b => b.profileId === profileId)) fail("NOT_FOUND");
        const identity = this.state.txIdentities().find(b => (b as { profileId?: string }).profileId === profileId);
        return { source: { kind: "tx", profileId }, read: (tx, identities) => {
          const value = tx?.find(b => b.profileId === profileId);
          return !value || identity && !identities?.has(identity) ? missing() : { peak: value.peak, rms: null, clip: null, stale: false };
        } };
      }
      return fail("INVALID");
    });
    if (new Set(bindings.map(b => canonical(b.source))).size !== bindings.length) fail("INVALID");
    return { bindings, hz };
  }
  values(bindings: MeterBinding[]) {
    // This is the only TX meter read at delivery time. No subscriber means this method is never called.
    const tx = bindings.some(b => b.source.kind === "tx") ? this.tx() : undefined;
    const identities = tx ? new Set(this.state.txIdentities()) : undefined;
    return bindings.map(binding => ({ source: binding.source, ...binding.read(tx, identities) }));
  }
}

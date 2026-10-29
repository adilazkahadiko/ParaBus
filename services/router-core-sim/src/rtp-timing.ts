import { WindowHistogram } from "./window-histogram.ts";

export type GapKind = "loss" | "senderPause" | "delayed" | "fillBurst" | "unknown";
export interface PacketProvenance { sequence: number; timestamp: number; real: boolean; reset?: boolean }
/** RTP is evidence, not proof of the location of loss. No headers/SSRC/IDs leave this object. */
export class RtpTiming {
  #last: (PacketProvenance & { at: number }) | null = null;
  #candidate: { gap: number; at: number; serial: number } | null = null;
  #hist: Record<GapKind, WindowHistogram>;
  counts: Record<GapKind, number> = { loss: 0, senderPause: 0, delayed: 0, fillBurst: 0, unknown: 0 };
  missingPackets = 0;
  realPackets = 0;
  syntheticPackets = 0;
  serial = 0;
  constructor(now: number) {
    this.#hist = Object.fromEntries(Object.keys(this.counts).map(k => [k, new WindowHistogram(60_000, 30, 1, 1000, now)])) as Record<GapKind, WindowHistogram>;
  }
  observe(packet: PacketProvenance | undefined, now: number) {
    let kind: GapKind = "unknown", confirmedSerial: number | null = null;
    const previous = this.#last;
    const gap = previous ? now - previous.at : 0;
    const real = packet?.real === true;
    if (real) this.realPackets++; else this.syntheticPackets++;
    const comparable = real && previous?.real && !packet.reset;
    const sequenceDelta = comparable ? (packet.sequence - previous.sequence + 65536) % 65536 : 0;
    const timestampDelta = comparable ? (packet.timestamp - previous.timestamp) >>> 0 : 0;
    if (this.#candidate) {
      const candidate = this.#candidate;
      if (comparable && sequenceDelta === 1 && timestampDelta === 960 && gap <= 5) {
        kind = "delayed"; confirmedSerial = candidate.serial;
        this.counts.delayed++; this.#hist.delayed.record(candidate.gap, candidate.at);
      } else { this.counts.unknown++; this.#hist.unknown.record(candidate.gap, candidate.at); }
      this.#candidate = null;
    }
    const serial = ++this.serial;
    if (previous && (gap > 30 || (comparable && sequenceDelta > 1 && sequenceDelta < 32768) || timestampDelta > 960 && timestampDelta < 0x80000000)) {
      if (comparable && sequenceDelta > 1 && sequenceDelta < 32768) {
        kind = "loss"; this.missingPackets += sequenceDelta - 1;
      } else if (comparable && sequenceDelta === 1 && timestampDelta > 960 && timestampDelta < 0x80000000) kind = "senderPause";
      else if (comparable && sequenceDelta === 1 && timestampDelta === 960) {
        this.#candidate = { gap, at: now, serial }; kind = "unknown";
      } else kind = "unknown";
      if (!this.#candidate) { this.counts[kind]++; this.#hist[kind].record(gap, now); }
    } else if (comparable && gap <= 30 && confirmedSerial === null) kind = "fillBurst";
    this.#last = packet ? { ...packet, at: now } : { real: false, sequence: 0, timestamp: 0, at: now };
    return { kind, serial, confirmedSerial };
  }
  snapshot(now: number, details: boolean) {
    if (this.#candidate && now - this.#candidate.at > 5) {
      this.counts.unknown++; this.#hist.unknown.record(this.#candidate.gap, this.#candidate.at); this.#candidate = null;
    }
    return { realPackets: this.realPackets, syntheticPackets: this.syntheticPackets, missingPackets: this.missingPackets,
      counts: { ...this.counts, unknown: this.counts.unknown + (this.#candidate ? 1 : 0) },
      ...(details ? { gapWindows: Object.fromEntries(Object.entries(this.#hist).map(([kind, hist]) => [kind, hist.windows(now).map(({ slot, ...v }) => v)])) } : {}) };
  }
}

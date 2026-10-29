import { EventEmitter } from "node:events";

export interface RtpHeader { sequence: number; timestamp: number; ssrc: number }
export function rtpHeader(packet: Buffer): RtpHeader | null {
  if (packet.length < 12 || packet[0] >>> 6 !== 2 || (packet[1] & 127) !== 120) return null;
  return { sequence: packet.readUInt16BE(2), timestamp: packet.readUInt32BE(4), ssrc: packet.readUInt32BE(8) };
}

/** Passive listeners only. Never decrypt, replace a library method, or queue unauthenticated headers.
 * A header is usable ONLY while the pinned synchronous receiver handler is emitting that datagram.
 * Buffered/deferred stream data, changed internals, and reconnects fall back to synthetic counters.
 */
export class RtpObserver {
  #udp: EventEmitter | null = null;
  #receiver: any;
  #active: { userId: string; header: RtpHeader } | null = null;
  #consumed = false;
  #before = (packet: Buffer) => {
    this.#active = null; this.#consumed = false;
    try {
      const header = rtpHeader(packet);
      const user = header && this.#receiver.ssrcMap.get(header.ssrc);
      if (header && typeof user?.userId === "string") this.#active = { userId: user.userId, header };
    } catch { /* diagnostics failure must never interrupt VoiceReceiver */ }
  };
  #after = () => { this.#active = null; };
  bind(connection: unknown): void {
    this.detach();
    try {
      const candidate = connection as any;
      const udp = candidate.state.networking.state.udp;
      const receiver = candidate.receiver;
      if (!(udp instanceof EventEmitter) || typeof receiver?.ssrcMap?.get !== "function"
        || typeof receiver.onUdpMessage !== "function" || !udp.listeners("message").includes(receiver.onUdpMessage)) return;
      this.#receiver = receiver; this.#udp = udp;
      udp.prependListener("message", this.#before);
      udp.on("message", this.#after);
    } catch { /* unsupported internal layout: synthetic metadata remains available */ }
  }
  take(userId: string): RtpHeader | null {
    if (!this.#active || this.#active.userId !== userId || this.#consumed) return null;
    // If the pinned handler was detached/reordered, a header must not be attributed to another packet.
    const listeners = this.#udp?.listeners("message") ?? [];
    const receiverIndex = listeners.indexOf(this.#receiver.onUdpMessage);
    if (receiverIndex <= listeners.indexOf(this.#before) || receiverIndex >= listeners.indexOf(this.#after)) return null;
    this.#consumed = true;
    return this.#active.header;
  }
  detach(): void {
    this.#udp?.off("message", this.#before); this.#udp?.off("message", this.#after);
    this.#udp = null; this.#active = null;
  }
}

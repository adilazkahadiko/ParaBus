export const MAX_WEBSOCKET_PENDING_BYTES = 1024 * 1024;

interface Peer {
  readonly destroyed: boolean;
  readonly writableLength: number;
  write(frame: Buffer): unknown;
}

export function encodeWebSocketFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.allocUnsafe(payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10);
  header[0] = 0x81;
  if (header.length === 2) header[1] = payload.length;
  else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([header, payload]);
}

/** Build once, only when a client can receive it. Never accumulate another
 * frame behind a slow client; healthy clients continue at their normal rate. */
export function broadcastWebSocket(peers: Iterable<Peer>, message: () => unknown): void {
  let frame: Buffer | undefined;
  for (const peer of peers) {
    if (peer.destroyed || peer.writableLength >= MAX_WEBSOCKET_PENDING_BYTES) continue;
    frame ??= encodeWebSocketFrame(JSON.stringify(message()));
    // An idle peer must receive even a large initial state. Never queue another
    // frame behind that oversized write until it has drained.
    if (peer.writableLength === 0 || peer.writableLength + frame.length <= MAX_WEBSOCKET_PENDING_BYTES) peer.write(frame);
  }
}

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/** Shared by the desktop and the dedicated external listener, without sharing authentication. */
export function acceptWebSocket(request: IncomingMessage, socket: Duplex, extraHeaders = "") {
  const key = request.headers["sec-websocket-key"];
  if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket"
    || !request.headers.connection?.toLowerCase().split(/\s*,\s*/).includes("upgrade")
    || request.headers["sec-websocket-version"] !== "13" || typeof key !== "string"
    || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return false;
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
    + `Sec-WebSocket-Accept: ${accept}\r\n${extraHeaders}\r\n`);
  return true;
}

export function controlFrame(opcode: number, payload: Buffer = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}
export function closeWebSocket(socket: Duplex, code: number) {
  if (!socket.destroyed) {
    const payload = Buffer.alloc(2); payload.writeUInt16BE(code); socket.end(controlFrame(8, payload));
    const timeout = setTimeout(() => socket.destroy(), 1000); timeout.unref(); socket.once("close", () => clearTimeout(timeout));
  }
}

/** Bounded, masked client frames. Partial TCP frames are retained, fragmented messages are rejected. */
export function websocketReceiver(maxBytes: number, onFrame: (opcode: number, payload: Buffer) => void) {
  let pending = Buffer.alloc(0);
  return (data: Buffer) => {
    pending = Buffer.concat([pending, data]);
    while (pending.length >= 2) {
      const opcode = pending[0] & 0x0f;
      if ((pending[0] & 0xf0) !== 0x80 || !(pending[1] & 0x80) || ![1, 2, 8, 9, 10].includes(opcode)) throw new Error("Invalid WebSocket frame");
      let length = pending[1] & 0x7f, offset = 2;
      if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
      else if (length === 127) {
        if (pending.length < 10) return;
        const size = pending.readBigUInt64BE(2); if (size > BigInt(maxBytes)) throw new RangeError("WebSocket message too large");
        length = Number(size); offset = 10;
      }
      if (length > maxBytes) throw new RangeError("WebSocket message too large");
      if (opcode >= 8 && length > 125) throw new Error("Invalid WebSocket control frame");
      if (pending.length < offset + 4 + length) return;
      const payload = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i++) payload[i] = pending[offset + 4 + i] ^ pending[offset + i % 4];
      pending = pending.subarray(offset + 4 + length);
      onFrame(opcode, payload);
    }
  };
}

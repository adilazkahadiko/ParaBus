import { createConnection } from "node:net";
export function clientFrame(text: string, opcode = 1) {
  const payload = Buffer.from(text), mask = Buffer.from([1, 2, 3, 4]), header = payload.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | payload.length]) : Buffer.from([0x80 | opcode, 0xfe, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([header, mask, Buffer.from(payload.map((v, i) => v ^ mask[i % 4]))]);
}
export async function connectWs(port: number, authorization?: string, extra = "") {
  const socket = createConnection(port, "127.0.0.1"); let buffer = Buffer.alloc(0), status = 0, upgraded = false;
  const messages: any[] = [], waiters: Array<(value: any) => void> = [];
  const deliver = (value: any) => { const waiter = waiters.shift(); if (waiter) waiter(value); else messages.push(value); };
  await new Promise<void>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`GET /external/v1/ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ZGJyLXRlc3Qta2V5LTEyMw==\r\n${authorization ? `Authorization: ${authorization}\r\n` : ""}${extra}\r\n`));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n"); if (end < 0) return;
        status = Number(buffer.toString("latin1", 0, end).split(" ")[1]); if (status !== 101) { socket.destroy(); resolve(); return; }
        buffer = buffer.subarray(end + 4); upgraded = true; resolve();
      }
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15, n = buffer[1] & 127; let length = n, offset = 2;
        if (n === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (n === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length); buffer = buffer.subarray(offset + length);
        deliver(opcode === 1 ? JSON.parse(payload.toString()) : opcode === 8 ? { closeCode: payload.readUInt16BE() } : { opcode });
      }
    });
  });
  const next = async (): Promise<any> => messages.length ? messages.shift() : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS message timed out")), 3000); waiters.push(value => { clearTimeout(timer); resolve(value); });
  });
  return { socket, status, next };
}

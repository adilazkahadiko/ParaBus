import { connect } from "node:tls";
import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { connect as connectTcp, isIP } from "node:net";
import { fields, strictJson } from "./external-protocol.ts";

export interface LanConnection { v: 1; address: string; port: number; token: string; fingerprint: string }
export function parseConnectionCode(code: string): LanConnection {
  try {
    if (typeof code !== "string" || code.length > 4096 || !/^parabus1:[A-Za-z0-9_-]+$/.test(code)) throw new Error();
    const encoded = code.slice(9), bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error();
    const value = fields(strictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), ["v", "address", "port", "token", "fingerprint"]);
    if (value.v !== 1 || typeof value.address !== "string" || isIP(value.address) !== 4 || value.address === "0.0.0.0"
      || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535
      || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.token)
      || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw new Error();
    return value as unknown as LanConnection;
  } catch { throw new Error("接続コードの形式が正しくありません"); }
}
export function encodeConnectionCode(value: LanConnection): string {
  const code = `parabus1:${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
  parseConnectionCode(code); return code;
}

/** Reference client: authenticate the pinned peer BEFORE transmitting credentials.
 * rejectUnauthorized:false is intentional for the self-signed certificate, and
 * is paired with mandatory raw-certificate SHA-256 verification here. */
export async function pinnedLanRequest(code: string, method: "GET" | "POST", path: string, body?: unknown, localAddress?: string): Promise<{ status: number; body: any }> {
  const target = parseConnectionCode(code);
  if (!["/external/v1/info", "/external/v1/state", "/external/v1/actions", "/external/v1/arm", "/external/v1/execute"].includes(path)) throw new Error("接続先のパスが正しくありません");
  return new Promise((resolve, reject) => {
    const transport = connectTcp({ host: target.address, port: target.port, localAddress });
    const socket = connect({ socket: transport, rejectUnauthorized: false, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
    let data = Buffer.alloc(0), settled = false;
    const fail = () => { if (settled) return; settled = true; socket.destroy(); reject(new Error("証明書の指紋またはLAN接続を確認してください")); };
    transport.on('error', fail);
    socket.setTimeout(5000, fail); socket.on('error', fail);
    socket.once('secureConnect', () => {
      try {
        const raw = socket.getPeerCertificate().raw;
        if (!raw || socket.getProtocol() !== 'TLSv1.3' || !timingSafeEqual(createHash('sha256').update(raw).digest(), Buffer.from(target.fingerprint, 'hex'))) return fail();
        const certificate = new X509Certificate(raw), now = Date.now();
        const from = Date.parse(certificate.validFrom), to = Date.parse(certificate.validTo);
        if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now > to || !certificate.verify(certificate.publicKey)) return fail();
        const payload = body === undefined ? '' : JSON.stringify(body);
        socket.write(`${method} ${path} HTTP/1.1\r\nHost: ${target.address}:${target.port}\r\nAuthorization: Bearer ${target.token}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
      } catch { fail(); }
    });
    socket.on('data', (chunk: Buffer) => { data = Buffer.concat([data, chunk]); if (data.length > 1048576) fail(); });
    socket.once('end', () => {
      if (settled) return;
      try {
        const split = data.indexOf('\r\n\r\n'), header = data.subarray(0, split).toString('ascii'), match = /^HTTP\/1\.1 (\d{3}) /.exec(header);
        if (split < 0 || !match) return fail();
        const value = JSON.parse(data.subarray(split + 4).toString('utf8'));
        settled = true; resolve({ status: Number(match[1]), body: value });
      } catch { fail(); }
    });
    socket.once('close', () => { if (!settled) fail(); });
  });
}

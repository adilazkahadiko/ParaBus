import { generateKeyPair, randomBytes, sign, X509Certificate, createPrivateKey } from "node:crypto";
import { promisify } from "node:util";
import { isIP } from "node:net";

// X.509 v3 / RFC 5280: only the DER primitives needed for a pinned, self-signed
// ECDSA P-256 server certificate. No external executable or npm dependency.
const der = (tag: number, bytes: Buffer): Buffer => {
  const length = bytes.length < 128 ? Buffer.from([bytes.length]) : (() => {
    let hex = bytes.length.toString(16); if (hex.length % 2) hex = `0${hex}`;
    const size = Buffer.from(hex, "hex"); return Buffer.concat([Buffer.from([0x80 | size.length]), size]);
  })();
  return Buffer.concat([Buffer.from([tag]), length, bytes]);
};
const sequence = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts));
const oid = (hex: string) => der(0x06, Buffer.from(hex, "hex"));
const octets = (bytes: Buffer) => der(0x04, bytes);
const bits = (bytes: Buffer, unused = 0) => der(0x03, Buffer.concat([Buffer.from([unused]), bytes]));
const algorithm = () => sequence(oid("2a8648ce3d040302")); // ecdsa-with-SHA256
const name = () => sequence(der(0x31, sequence(oid("550403"), der(0x0c, Buffer.from("ParaBus LAN Control")))));
const time = (value: Date) => {
  const full = value.toISOString().replace(/[-:T]/g, "").replace(/\.\d{3}Z$/, "Z");
  const utcTime = value.getUTCFullYear() >= 1950 && value.getUTCFullYear() < 2050;
  return der(utcTime ? 0x17 : 0x18, Buffer.from(utcTime ? full.slice(2) : full));
};
const pem = (bytes: Buffer) => `-----BEGIN CERTIFICATE-----\n${bytes.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;

export async function generateLanCertificate(address: string, now = new Date()) {
  if (isIP(address) !== 4 || address === "0.0.0.0") throw new Error("IPv4 address required");
  const pair = await promisify(generateKeyPair)("ec", { namedCurve: "prime256v1" });
  const serial = randomBytes(20); serial[0] &= 0x7f; serial[0] |= 1;
  const extension = (id: string, value: Buffer, critical = false) => sequence(oid(id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), octets(value));
  const extensions = der(0xa3, sequence(
    extension("551d13", sequence(), true), // basicConstraints: CA=false
    extension("551d0f", bits(Buffer.from([0x80]), 7), true), // digitalSignature
    extension("551d25", sequence(oid("2b06010505070301"))), // serverAuth
    extension("551d11", sequence(der(0x87, Buffer.from(address.split('.').map(Number))))),
  ));
  const tbs = sequence(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), algorithm(), name(),
    sequence(time(new Date(now.getTime() - 300000)), time(new Date(now.getTime() + 3650 * 86400000))), name(),
    pair.publicKey.export({ format: "der", type: "spki" }), extensions);
  const certificate = pem(sequence(tbs, algorithm(), bits(sign("sha256", tbs, pair.privateKey))));
  const key = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const parsed = new X509Certificate(certificate);
  if (!parsed.verify(parsed.publicKey) || !parsed.checkPrivateKey(createPrivateKey(key)) || parsed.checkIP(address) !== address || !Number.isFinite(Date.parse(parsed.validFrom)) || !Number.isFinite(Date.parse(parsed.validTo))) throw new Error("Certificate validation failed");
  return { certificate, key, fingerprint: parsed.fingerprint256.replaceAll(":", "").toLowerCase() };
}

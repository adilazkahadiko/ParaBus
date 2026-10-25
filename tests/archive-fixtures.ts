import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

export function writeArchive(path: string, entries: { path: string; bytes?: string | Buffer; type?: string; link?: string }[]): void {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512), bytes = Buffer.from(entry.bytes ?? "");
    assert.ok(Buffer.byteLength(entry.path) < 100);
    header.write(entry.path, 0, 100); header.write("0000644\0", 100);
    header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136); header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156); if (entry.link) header.write(entry.link, 157, 100);
    header.write("ustar\0", 257); header.write("00", 263);
    header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  writeFileSync(path, gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)])));
}

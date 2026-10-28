// Test helper: writes ZIP files byte by byte, including the ones a careful writer would never produce (names with
// «..», backslashes, duplicates, wrong CRCs), to check that the APK reader and verifier refuse them.
import zlib from "node:zlib";
import { crc32 } from "../server/apkzip.mjs";

// entries: [{ name, data, method? (0 stored, 8 deflated; default 0), crc? (override), localName? }]
export function makeZip(entries, { comment = "" } = {}) {
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    const method = e.method ?? 0;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(e.name, "utf8"), localName = Buffer.from(e.localName ?? e.name, "utf8");
    const crc = e.crc ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(localName.length, 26);
    parts.push(local, localName, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(e.flags ?? 0, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + localName.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(Buffer.byteLength(comment), 20);
  return Buffer.concat([...parts, cd, end, Buffer.from(comment)]);
}

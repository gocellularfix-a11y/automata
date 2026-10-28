// A strict ZIP reader for APK files, with no dependencies. An APK is a ZIP, and the point of reading it here (and
// not trusting a tool's summary) is to refuse anything odd: a damaged central directory, entries that overlap,
// names that could escape a folder, encrypted or ZIP64 entries, bombs, data that does not match its CRC.
// Every refusal is a ZipError with a stable `code` so callers can report it in plain words.
import zlib from "node:zlib";

export class ZipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

export const ZIP_LIMITS = { maxBytes: 256 * 1024 * 1024, maxEntries: 5000, maxEntryBytes: 128 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, maxRatio: 200 };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// Adler-32, the checksum a DEX header carries over everything after itself.
export function adler32(buffer, from = 0) {
  let a = 1, b = 0;
  for (let i = from; i < buffer.length; i++) {
    a = (a + buffer[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Why an entry name is not acceptable, or null. APK entries are relative, use «/» and stay inside the archive.
export function unsafeEntryName(name) {
  if (!name) return "nombre vacío";
  if (name.length > 255) return "nombre demasiado largo";
  if (/[\u0000-\u001f\u007f]/.test(name)) return "caracteres de control";
  if (name.includes("\\")) return "barra invertida";
  if (name.startsWith("/")) return "ruta absoluta";
  if (/^[a-zA-Z]:/.test(name)) return "unidad de disco";
  const parts = name.replace(/\/$/, "").split("/");
  if (parts.some((part) => part === "..")) return "sale de la carpeta («..»)";
  if (parts.some((part) => part === "." || part === "")) return "segmento vacío o «.»";
  return null;
}

// Parses the archive and validates its structure; it does not decompress anything. Returns { size, entries }.
export function openZip(buffer, limits = ZIP_LIMITS) {
  if (!Buffer.isBuffer(buffer)) throw new ZipError("not-buffer", "Se esperaba el contenido del archivo.");
  if (buffer.length < 22) throw new ZipError("too-small", "El archivo es demasiado pequeño para ser un ZIP/APK.");
  if (buffer.length > limits.maxBytes) throw new ZipError("too-large", "El archivo es demasiado grande.");
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw new ZipError("not-zip", "El archivo no empieza como un ZIP (falta la firma PK).");

  // End of central directory: it must be the very end of the file (no trailing bytes after the comment).
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError("no-eocd", "No se encuentra el final del ZIP: el archivo está truncado o tiene datos añadidos.");
  const disk = buffer.readUInt16LE(eocd + 4), cdDisk = buffer.readUInt16LE(eocd + 6);
  const onDisk = buffer.readUInt16LE(eocd + 8), total = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12), cdOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw new ZipError("multi-disk", "ZIP en varias partes: no es un APK válido.");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("zip64", "ZIP64 no está soportado.");
  if (total > limits.maxEntries) throw new ZipError("too-many", `El archivo declara ${total} entradas (máximo ${limits.maxEntries}).`);
  if (cdOffset + cdSize > eocd) throw new ZipError("bad-directory", "El directorio central apunta fuera del archivo.");

  const entries = [], names = new Set(), lowered = new Set();
  let at = cdOffset, totalBytes = 0;
  for (let n = 0; n < total; n++) {
    if (at + 46 > cdOffset + cdSize || buffer.readUInt32LE(at) !== 0x02014b50) throw new ZipError("bad-directory", `La entrada ${n + 1} del directorio central está dañada.`);
    const flags = buffer.readUInt16LE(at + 8), method = buffer.readUInt16LE(at + 10), crc = buffer.readUInt32LE(at + 16);
    const csize = buffer.readUInt32LE(at + 20), usize = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28), extraLength = buffer.readUInt16LE(at + 30), commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    if (at + 46 + nameLength + extraLength + commentLength > cdOffset + cdSize) throw new ZipError("bad-directory", `La entrada ${n + 1} sale del directorio central.`);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    const problem = unsafeEntryName(name);
    if (problem) throw new ZipError("unsafe-path", `Ruta insegura en el paquete (${problem}): ${JSON.stringify(name.slice(0, 80))}`);
    if (names.has(name)) throw new ZipError("duplicate", `Entrada repetida en el paquete: ${name}`);
    if (lowered.has(name.toLowerCase())) throw new ZipError("duplicate", `Dos entradas solo se distinguen por mayúsculas: ${name}`);
    names.add(name);
    lowered.add(name.toLowerCase());
    if (flags & 1) throw new ZipError("encrypted", `Entrada cifrada no permitida: ${name}`);
    if (method !== 0 && method !== 8) throw new ZipError("method", `Método de compresión no soportado (${method}) en ${name}`);
    if (csize === 0xffffffff || usize === 0xffffffff) throw new ZipError("zip64", `ZIP64 no está soportado (${name}).`);
    const directory = name.endsWith("/");
    if (directory && (csize !== 0 || usize !== 0)) throw new ZipError("bad-entry", `La carpeta ${name} tiene datos.`);
    if (usize > limits.maxEntryBytes) throw new ZipError("too-large", `La entrada ${name} es demasiado grande.`);
    if (usize > 1024 * 1024 && usize > csize * limits.maxRatio) throw new ZipError("bomb", `La entrada ${name} se descomprime desproporcionadamente.`);
    if (method === 0 && csize !== usize) throw new ZipError("bad-entry", `La entrada ${name} dice ir sin comprimir pero sus tamaños no coinciden.`);
    totalBytes += usize;
    if (totalBytes > limits.maxTotalBytes) throw new ZipError("too-large", "El contenido descomprimido es demasiado grande.");

    if (localOffset + 30 > cdOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipError("bad-local", `La cabecera local de ${name} no existe o está dañada.`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26), localExtraLength = buffer.readUInt16LE(localOffset + 28);
    if (localNameLength !== nameLength || buffer.toString("utf8", localOffset + 30, localOffset + 30 + localNameLength) !== name) throw new ZipError("bad-local", `La cabecera local de ${name} no coincide con el directorio central.`);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + csize > cdOffset) throw new ZipError("bad-local", `Los datos de ${name} salen del área permitida.`);
    entries.push({ name, directory, method, crc, compressedSize: csize, size: usize, localOffset, dataOffset, end: dataOffset + csize });
  }
  if (at !== cdOffset + cdSize) throw new ZipError("bad-directory", "El directorio central tiene bytes sobrantes.");

  // Entries must not overlap (a classic way to hide data or build a bomb).
  const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].localOffset < sorted[i - 1].end) throw new ZipError("overlap", `Las entradas ${sorted[i - 1].name} y ${sorted[i].name} se solapan.`);
  return { size: buffer.length, entries, byName: new Map(entries.map((e) => [e.name, e])), cdOffset };
}

// The uncompressed content of an entry, checked against its declared size and CRC-32.
export function readEntry(buffer, entry) {
  if (entry.directory) return Buffer.alloc(0);
  const raw = buffer.subarray(entry.dataOffset, entry.end);
  let data;
  if (entry.method === 0) data = raw;
  else {
    try {
      data = zlib.inflateRawSync(raw, { maxOutputLength: entry.size + 1 });
    } catch (error) {
      throw new ZipError("corrupt", `No se puede descomprimir ${entry.name}: ${error.code ?? error.message}`);
    }
  }
  if (data.length !== entry.size) throw new ZipError("corrupt", `El tamaño de ${entry.name} no coincide con el declarado.`);
  if (crc32(data) !== entry.crc) throw new ZipError("corrupt", `El contenido de ${entry.name} está dañado (CRC distinto).`);
  return data;
}

// A new ZIP made of the entries of `base` (copied byte for byte, still compressed) plus `additions`
// [{ name, data }]. Names are written exactly as given, always with «/», dates are fixed (so the same input gives
// the same bytes) and nothing else is added. This is how the APK is assembled: aapt2 on Windows writes asset names
// with «\», which Android would never find, so the web files and the DEX are added here instead.
const DOS_DATE = 0x0021; // 1980-01-01 00:00:00
export function addToZip(base, additions) {
  const zip = openZip(base);
  const parts = [], central = [];
  let offset = 0;
  const put = (name, method, crc, csize, usize, raw) => {
    const nameBytes = Buffer.from(name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(csize, 18);
    header.writeUInt32LE(usize, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    parts.push(header, nameBytes, raw);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(csize, 20);
    entry.writeUInt32LE(usize, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + raw.length;
  };
  const taken = new Set();
  for (const e of zip.entries) {
    if (e.directory) continue;
    taken.add(e.name);
    put(e.name, e.method, e.crc, e.compressedSize, e.size, base.subarray(e.dataOffset, e.end));
  }
  for (const { name, data: given } of additions) {
    const data = Buffer.from(given);
    const problem = unsafeEntryName(name);
    if (problem || name.endsWith("/")) throw new ZipError("unsafe-path", `Nombre de entrada no válido (${problem ?? "carpeta"}): ${name}`);
    if (taken.has(name)) throw new ZipError("duplicate", `Entrada repetida: ${name}`);
    taken.add(name);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    if (deflated.length < data.length) put(name, 8, crc32(data), deflated.length, data.length, deflated);
    else put(name, 0, crc32(data), data.length, data.length, data);
  }
  const cdOffset = offset, cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  const out = Buffer.concat([...parts, cd, end]);
  openZip(out); // what was written must read back
  return out;
}

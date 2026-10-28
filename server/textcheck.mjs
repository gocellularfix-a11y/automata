// Is the text in the project really broken, or does it only look broken where someone read it? Windows PowerShell 5.1
// shows UTF-8 files as «Ã³» when it reads them with its default code page (Get-Content without -Encoding UTF8), so a
// reviewer that reads files that way sees corruption that is not in the file. This reads the bytes: a file is wrong
// only if it is not valid UTF-8, holds replacement characters or was saved twice with the wrong code page.
import fs from "node:fs";
import path from "node:path";

const TEXT = /\.(?:html?|css|m?js|cjs|json|md|txt|svg|cmd|bat)$/i;
const SKIP = new Set(["node_modules", ".git", "artifacts", "dist", "build", "coverage"]);
// «Ã» followed by a Latin-1 symbol, «Â» followed by a symbol, «â€» + punctuation: UTF-8 text that was read as Windows-1252 and saved again.
const DOUBLE_ENCODED = /Ã[\u0080-¿]|Â[ -¿]|â€[\u0090-¿™œ˜]/;
const decoder = new TextDecoder("utf-8", { fatal: true });

export function checkProjectText(directory, { maxFiles = 300, maxBytes = 600000, language = "es" } = {}) {
  const en = language === "en";
  const result = { status: "ok", files: 0, withAccents: 0, problems: [] };
  const queue = [directory];
  while (queue.length && result.files < maxFiles) {
    const folder = queue.shift();
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) { if (!SKIP.has(entry.name) && !entry.name.startsWith(".")) queue.push(path.join(folder, entry.name)); continue; }
      if (!entry.isFile() || !TEXT.test(entry.name) || result.files >= maxFiles) continue;
      const file = path.join(folder, entry.name), name = path.relative(directory, file).split(path.sep).join("/");
      let bytes;
      try { if (fs.statSync(file).size > maxBytes) continue; bytes = fs.readFileSync(file); } catch { continue; }
      result.files++;
      const problem = (kind, detail) => result.problems.push({ file: name, kind, detail });
      let text;
      try { text = decoder.decode(bytes); } catch {
        problem("invalid", en ? "is not valid UTF-8 (it was probably saved with the Windows ANSI code page); accents would show broken." : "no es UTF-8 válido (probablemente se guardó con la página de códigos ANSI de Windows); los acentos se verían rotos.");
        continue;
      }
      // TextDecoder keeps a leading byte-order mark out of the text unless asked to: read it from the bytes.
      const hasBom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
      if (/[^\x00-\x7F]/.test(text)) result.withAccents++;
      if (hasBom && /\.json$/i.test(name)) problem("bom", en ? "starts with a byte-order mark; JSON.parse fails on it." : "empieza con una marca de orden de bytes (BOM); JSON.parse falla con ella.");
      const replaced = (text.match(/�/g) ?? []).length;
      if (replaced) problem("replacement", en ? `has ${replaced} replacement character(s) (�): the original letters were lost when it was saved.` : `tiene ${replaced} carácter(es) de reemplazo (�): las letras originales se perdieron al guardarlo.`);
      const double = DOUBLE_ENCODED.exec(text);
      if (double) problem("double-encoded", en ? `has text saved twice with the wrong code page (for example «${double[0]}»): accents were turned into symbols inside the file.` : `tiene texto guardado dos veces con la página de códigos equivocada (por ejemplo «${double[0]}»): los acentos se convirtieron en símbolos dentro del archivo.`);
      // A launcher is read by cmd.exe with the console's code page, not as UTF-8.
      if (/\.(?:cmd|bat)$/i.test(name) && /[^\x00-\x7F]/.test(text) && !/chcp\s+65001/i.test(text)) problem("launcher-accents", en ? "has accents or special characters and cmd.exe will show them broken; use plain letters or start with «chcp 65001 >nul»." : "tiene acentos o caracteres especiales y cmd.exe los mostrará rotos; usa letras sin acento o empieza con «chcp 65001 >nul».");
    }
  }
  if (result.problems.length) result.status = "problems";
  return result;
}
// What a reader on Windows PowerShell 5.1 must know before calling a file corrupt.
export const READING_NOTE = {
  es: "Si al leer un archivo con PowerShell 5.1 ves «Ã³», «Ã¡» o «â€» en lugar de acentos, es solo cómo se muestra: Get-Content sin -Encoding UTF8 lee UTF-8 como ANSI. Lee con  Get-Content -Raw -Encoding UTF8 <archivo>  o con  node -e \"process.stdout.write(require('fs').readFileSync('<archivo>','utf8'))\". Solo es un error real lo que figura en CODIFICACIÓN.",
  en: "If reading a file with PowerShell 5.1 shows «Ã³», «Ã¡» or «â€» instead of accents, it is only how it is displayed: Get-Content without -Encoding UTF8 reads UTF-8 as ANSI. Read with  Get-Content -Raw -Encoding UTF8 <file>  or with  node -e \"process.stdout.write(require('fs').readFileSync('<file>','utf8'))\". Only what is listed under ENCODING is a real error."
};

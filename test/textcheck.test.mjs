// P4 stabilization: UTF-8 false alarms. The files are fine; Windows PowerShell 5.1 reads them with the ANSI code page.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { checkProjectText, READING_NOTE } from "../server/textcheck.mjs";

function project(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-text-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}
const GUIDE = "# Cómo usar\n\nEs una página web que se abre en tu navegador. Sirve para apuntar lo que gastas, categoría por categoría. ¿Programación? No hace falta.\n";

test("un archivo UTF-8 correcto con acentos no es un error, aunque otro lector lo vea roto", (t) => {
  const dir = project(t, { "COMO_USAR.md": GUIDE, "index.html": '<meta charset="utf-8"><title>Categoría</title>', "app.js": "const msg = 'Descripción obligatoria';" });
  const result = checkProjectText(dir);
  assert.equal(result.status, "ok");
  assert.equal(result.files, 3);
  assert.equal(result.withAccents, 3);
  assert.deepEqual(result.problems, []);
});

test("los errores reales sí se detectan: ANSI, caracteres de reemplazo, texto guardado dos veces, BOM en JSON y acentos en el lanzador", (t) => {
  const dir = project(t, {
    "ansi.js": Buffer.from("const a = 'descripci\xf3n';", "latin1"),
    "reemplazo.md": "Descripci�n del gasto",
    "doble.md": "# CÃ³mo usar\nCategorÃ­a y programaciÃ³n",
    "datos.json": Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('{"a":1}')]),
    "Abrir.cmd": "@echo off\r\necho Falta el navegador, canción\r\nstart \"\" \"%~dp0index.html\"\r\n",
    "bom.md": Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("# Con BOM pero es Markdown\n")]),
    "limpio.js": "const ok = 1;"
  });
  const result = checkProjectText(dir);
  assert.equal(result.status, "problems");
  const kinds = Object.fromEntries(result.problems.map((p) => [p.file, p.kind]));
  assert.deepEqual(kinds, { "ansi.js": "invalid", "reemplazo.md": "replacement", "doble.md": "double-encoded", "datos.json": "bom", "Abrir.cmd": "launcher-accents" });
  assert.match(result.problems.find((p) => p.file === "doble.md").detail, /«Ã³»|«Ã­»|«Ã/);
});

test("un lanzador con chcp 65001 puede tener acentos; node_modules y las carpetas ocultas no se leen", (t) => {
  const dir = project(t, { "Abrir.cmd": "@echo off\r\nchcp 65001 >nul\r\necho canción\r\n", "node_modules/x/index.js": Buffer.from("'\xf3'", "latin1"), ".git/config.txt": Buffer.from("\xf3", "latin1") });
  assert.equal(checkProjectText(dir).status, "ok");
});

test("en inglés los motivos también están en inglés", (t) => {
  const dir = project(t, { "ansi.js": Buffer.from("'\xf3'", "latin1") });
  assert.match(checkProjectText(dir, { language: "en" }).problems[0].detail, /is not valid UTF-8/);
});

// The real cause of the false alarms, shown with the real shell: only on Windows, where PowerShell 5.1 lives.
test("PowerShell 5.1 muestra «Ã³» al leer un UTF-8 correcto; con -Encoding UTF8 (o con node) se lee bien, y la lectura de Automata dice que no hay error", { skip: process.platform !== "win32" && "solo Windows tiene PowerShell 5.1" }, (t) => {
  const dir = project(t, { "COMO_USAR.md": GUIDE });
  const file = path.join(dir, "COMO_USAR.md");
  const ps = (command) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`], { encoding: "utf8" }).stdout;
  const naive = ps(`Get-Content -Raw -LiteralPath '${file}'`);
  const proper = ps(`Get-Content -Raw -Encoding UTF8 -LiteralPath '${file}'`);
  const viaNode = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `node -e "process.stdout.write(require('fs').readFileSync('${file.replace(/\\/g, "/")}','utf8'))"`], { encoding: "utf8" }).stdout;
  assert.match(naive, /CÃ³mo|Ã³/, "sin -Encoding, PowerShell 5.1 ve el acento roto");
  assert.match(proper, /Cómo usar/);
  assert.match(viaNode, /Cómo usar/);
  assert.equal(checkProjectText(dir).status, "ok", "el archivo está bien: lo que se ve roto es la lectura");
  assert.match(READING_NOTE.es, /Get-Content -Raw -Encoding UTF8/);
});

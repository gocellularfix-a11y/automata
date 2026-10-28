import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { exercisePage } from "../scripts/real-delivery-checks.mjs";

const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));
const page = (body, script = "") => `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}<script>${script}</script></body></html>`;
// The way a delivered calculator behaves: a result for good data, a message for bad data.
const CALC = page('<label>Total <input id="total"></label><label>Personas <input id="personas"></label><label>Propina % <input id="propina"></label><button id="go">Calcular</button><p id="out"></p>', `document.getElementById("go").onclick = () => { const t = Number(document.getElementById("total").value), p = Number(document.getElementById("personas").value), x = Number(document.getElementById("propina").value); document.getElementById("out").textContent = t > 0 && p > 0 && x >= 0 ? "Cada quien paga " + (t * (1 + x / 100) / p).toFixed(2) : "Revisa los datos: escribe números válidos."; };`);
const SILENT = page('<label>Total <input id="total"></label><button id="go">Calcular</button><p id="out"></p>', `document.getElementById("go").onclick = () => { document.getElementById("out").textContent = "Resultado " + Number(document.getElementById("total").value); };`);
const BROKEN = page('<input id="total"><button id="go">Calcular</button>', `document.getElementById("go").onclick = () => { throw new Error("se rompió"); };`);

test("el uso real de una página entregada distingue una calculadora que avisa, una que no avisa y una que se rompe", { skip: !chrome && "no hay Chrome ni Edge" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-rdc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const run = async (name, html) => {
    const file = path.join(dir, name + ".html");
    fs.writeFileSync(file, html);
    const p = await browser.newPage();
    try { return await exercisePage(p, pathToFileURL(file).href); } finally { await p.close(); }
  };
  const good = await run("good", CALC);
  assert.equal(good.fields, 3);
  assert.equal(good.buttons, 1);
  assert.match(good.valid, /Cada quien paga 27\.50/, "100 entre 4 personas con 10 % de propina");
  assert.equal(good.validShowsSomething, true);
  assert.match(good.invalid.texto, /Revisa los datos/);
  assert.match(good.invalid.negativo, /Revisa los datos/);
  assert.equal(good.invalidHandled, true);
  assert.deepEqual(good.errors, []);
  const silent = await run("silent", SILENT);
  assert.equal(silent.validShowsSomething, true);
  assert.match(silent.invalid.texto, /Resultado NaN/, "una página que no valida muestra basura y se ve");
  const broken = await run("broken", BROKEN);
  assert.match(broken.errors.join(" "), /error de programa: Error: se rompió|se rompió/);
  assert.ok(broken.pageErrorsOnInvalid >= 1);
});

// Memory panel in a real Chrome: list, search, add, correct, retire, restore, errors with their fix, phone width.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "artifacts", "smoke-memory-" + new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(output, { recursive: true });
const app = await createServer({ port: 0, demo: true, dataDir: path.join(output, "data") });
const memory = app.coordinator.memory;
memory.addFact("demo", { kind: "decision", text: "El saludo se genera en greet.mjs sin dependencias", source: "director", runId: "run-demo", round: 1 });
memory.addFact("demo", { kind: "env", text: "Node 24 en Windows 11", source: "coder", runId: "run-demo", round: 1 });
memory.addFact("demo", { kind: "gotcha", text: "PowerShell 5.1 muestra mal el UTF-8; los archivos están bien", source: "director", runId: "run-demo", round: 2 });
memory.addFact("demo", { kind: "note", text: "Clave de prueba: password=" + "Sup3rS3cret0!", source: "user" });
memory.recordChecks("demo", { runId: "run-demo", round: 1, checks: [{ command: "node --test", passed: false, output: "✖ saludo de Automata\n  Error: Cannot find module './greet.mjs'", stderr: "" }] });
memory.recordChecks("demo", { runId: "run-demo", round: 2, checks: [{ command: "node --test", passed: true, output: "ℹ pass 1" }], files: ["greet.mjs", "greet.test.mjs"], report: "Creé greet.mjs y su prueba." });
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find((p) => p && fs.existsSync(p));
const browser = await chromium.launch({ executablePath: chrome, channel: chrome ? undefined : "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1480, height: 1020 }, reducedMotion: "reduce" });
const errors = [], external = [], report = { at: new Date().toISOString(), checks: [], screenshots: [] };
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => { if (new URL(r.url()).origin !== app.origin) external.push(r.url()); });
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, detail });
  if (!ok) throw new Error(name + ": " + JSON.stringify(detail));
};
const shot = async (name) => {
  const file = path.join(output, name + ".png");
  await page.screenshot({ path: file });
  report.screenshots.push(file);
};
const items = () => page.locator("#memoryContent .memory-item").count();
try {
  await page.goto(app.origin + "/#token=" + app.token);
  await page.waitForFunction(() => document.querySelector("#projectName").textContent === "Hola, Automata");
  await page.click("#memoryButton");
  await page.waitForSelector("#memoryContent .memory-item");
  const text = await page.locator("#memoryContent").innerText();
  check("muestra decisiones, entorno, trampas y notas", ["greet.mjs sin dependencias", "Node 24", "PowerShell 5.1"].every((s) => text.includes(s)), text.slice(0, 300));
  check("el secreto no se guardó ni se muestra", !text.includes("Sup3rS3cret0!") && text.includes("[credencial omitida]"));
  check("el error aparece resuelto con su solución", /Resuelto/.test(text) && text.includes("greet.mjs, greet.test.mjs"));
  check("contadores", /4\s*recuerdos activos/.test(await page.locator("#memoryStats").innerText()));
  await shot("01-memoria");
  await page.fill("#memoryForm [name=text]", "La prueba usa node:test");
  await page.selectOption("#memoryForm [name=kind]", "decision");
  await page.click("#memoryForm button[type=submit]");
  await page.waitForFunction(() => document.querySelector("#memoryContent").innerText.includes("La prueba usa node:test"));
  check("agregar un recuerdo", true);
  // Once editing, the text lives in an input, so the item is found by its id.
  const gotchaId = await page.locator(".memory-item", { hasText: "PowerShell 5.1" }).getAttribute("data-fact");
  const gotcha = page.locator(`[data-fact="${gotchaId}"]`);
  await gotcha.locator("[data-edit]").click();
  await gotcha.locator("input").fill("PowerShell 5.1 muestra mal el UTF-8 (solo la consola)");
  await gotcha.locator("[data-save]").click();
  await page.waitForFunction(() => document.querySelector("#memoryContent").innerText.includes("(solo la consola)"));
  check("corregir un recuerdo", true);
  const before = await items();
  await page.locator(".memory-item", { hasText: "Node 24" }).locator("[data-retire]").click();
  await page.waitForFunction((n) => document.querySelectorAll("#memoryContent .memory-item").length === n - 1, before);
  check("retirar lo saca de la lista activa", true);
  check("lo retirado ya no va a los agentes", !app.coordinator.memory.brief("demo").text.includes("Node 24"));
  await page.selectOption("#memoryStatus", "retired");
  await page.waitForFunction(() => document.querySelector("#memoryContent").innerText.includes("Node 24"));
  await shot("02-retirados");
  await page.locator(".memory-item", { hasText: "Node 24" }).locator("[data-restore]").click();
  await page.selectOption("#memoryStatus", "active");
  await page.waitForFunction(() => document.querySelector("#memoryContent").innerText.includes("Node 24"));
  check("restaurar", app.coordinator.memory.brief("demo").text.includes("Node 24"));
  await page.fill("#memorySearch", "consola");
  await page.waitForFunction(() => document.querySelectorAll("#memoryContent .memory-item").length === 1);
  check("buscar filtra", true);
  await page.fill("#memorySearch", "");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  check("sin desbordamiento horizontal en el teléfono", await page.evaluate(() => {
    const d = document.querySelector("#memoryDialog");
    return d.scrollWidth <= d.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1;
  }));
  await shot("03-telefono");
  check("sin errores de la página", errors.length === 0, errors);
  check("sin peticiones externas", external.length === 0, external);
  report.ok = true;
} catch (e) {
  report.ok = false;
  report.error = e.message;
  await shot("error").catch(() => {});
} finally {
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  await app.close();
}
console.log(JSON.stringify({ ok: report.ok, checks: report.checks.map((c) => `${c.ok ? "✔" : "✖"} ${c.name}`), error: report.error, output }, null, 1));
process.exit(report.ok ? 0 : 1);

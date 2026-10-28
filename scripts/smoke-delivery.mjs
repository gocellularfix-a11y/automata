// The delivery of an app in a real Chrome, as a person who does not program would see it: the proposal says what
// they will get, the first approval of the work is sent back because there is no launcher or guide, and when the app
// is ready a row offers Abrir aplicación, Guía y detalles and Abrir carpeta. Simulated agents (no AI) that write real
// files; Automata's own checks (a real Chrome opens the page) run for real. Nothing is opened on the screen:
// the system opener is replaced by a recorder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.mjs";
import { AuthManager } from "../server/auth.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "artifacts", "smoke-delivery-" + new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(output, { recursive: true });
const projects = fs.mkdtempSync(path.join(os.tmpdir(), "automata-smoke-projects-"));
const auth = new AuthManager({ find: (role) => ({ command: role, args: [] }), run: async (role) => ({ code: 0, stdout: role === "coder" ? '{"loggedIn":true,"authMethod":"claude.ai"}' : "", stderr: role === "auditor" ? "Logged in using ChatGPT" : role === "github" ? "Logged in to github.com account test-user" : "" }) });
const BASE = ["Calcula la propina y el total por persona.", "Avisa si el importe no es un número válido.", "Divide entre el número de personas."];
const proposal = () => ({
  name: "Calculadora de propinas", summary: "Una página para repartir la cuenta entre amigos, con la propina incluida.", objective: "Una calculadora web para repartir la cuenta con propina entre varias personas, que se abre en el navegador.",
  features: ["Calcular la propina", "Dividir entre personas"], criteria: BASE, checks: ["node --test"], platform: "página web local en el navegador",
  plan: [{ title: "Preparar el proyecto y sus pruebas", detail: "", criterion: "", dependsOn: [] }, { title: "Calcular la propina", detail: "", criterion: BASE[0], dependsOn: ["N1"] }, { title: "Avisar si el importe no es válido", detail: "", criterion: BASE[1], dependsOn: ["N2"] }, { title: "Dividir entre personas", detail: "", criterion: BASE[2], dependsOn: ["N2"] }],
  risks: ["No guarda un historial de cuentas.", "No tiene versión para teléfono."], questions: []
});
const GUIDE = `# Calculadora de propinas

## Instalar
No hay nada que instalar: solo necesitas un navegador como Chrome o Edge, que ya tiene tu computadora.

## Abrir
Haz doble clic en el archivo Abrir.cmd de esta carpeta. Se abre la calculadora en tu navegador.

## Usar
Escribe el total de la cuenta y cuántas personas son; la calculadora te dice cuánto paga cada una.

## Respaldar tus datos
La calculadora no guarda datos: no hay nada que respaldar. Si cambias la carpeta de lugar, cópiala completa.

## Qué funciona
Calcula la propina y el total por persona; avisa si el dato no es válido.

## Qué queda pendiente
No guarda un historial y no tiene versión para teléfono.
`;
const PAGE = '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Calculadora de propinas</title><link rel="stylesheet" href="style.css"></head><body><h1>Propinas</h1><label>Total <input id="total" inputmode="decimal"></label><button id="calcular">Calcular</button><p id="resultado"></p><script src="app.js"></script></body></html>';
const APP = 'document.getElementById("calcular").addEventListener("click", () => { const n = Number(document.getElementById("total").value.replace(",", ".")); document.getElementById("resultado").textContent = Number.isFinite(n) && n > 0 ? "Cada quien paga " + (n * 1.1).toFixed(2) : "Escribe un importe válido."; });';
const review = (project, decision, extra = {}) => ({ decision, summary: `Revisión ${decision}.`, nextPrompt: decision === "continue" ? "Haz la tarea." : "", task: "", files: [], findings: [], criteria: project.criteria.map((criterion) => ({ criterion, met: decision === "complete", evidence: decision === "complete" ? "Comprobado en el código y en las pruebas." : "" })), git: { commit: false, message: "", push: false, branch: "", merge_into: "" }, run: { ready: false, command: "", url: "", note: "" }, memory: { add: [], retire: [] }, plan: { add: [], update: [] }, ...extra });
const opened = [];
let coderCalls = 0, release;
const hold = new Promise((r) => release = r);
const app = await createServer({ port: 0, dataDir: path.join(output, "data"), auth, opener: (target) => opened.push(target), checks: async (p) => p.checks.map((command) => ({ command, passed: true, code: 0, output: "ok" })), evidence: async () => "", agents: { async run(a) {
  await new Promise((r) => setTimeout(r, 200));
  if (a.phase === "define") return { proposal: proposal() };
  if (a.role === "coder") {
    await hold;
    coderCalls++;
    const dir = a.project.directory;
    fs.writeFileSync(path.join(dir, "index.html"), PAGE);
    fs.writeFileSync(path.join(dir, "style.css"), "body { font-family: sans-serif; }");
    fs.writeFileSync(path.join(dir, "app.js"), APP);
    // The first time Claude forgets the launcher and the guide; Automata sends the work back.
    if (coderCalls >= 2) {
      fs.writeFileSync(path.join(dir, "Abrir.cmd"), '@echo off\r\nstart "" "%~dp0index.html"\r\n');
      fs.writeFileSync(path.join(dir, "COMO_USAR.md"), GUIDE);
    }
    return { text: "Hecho." };
  }
  if (a.phase === "plan") return { review: review(a.project, "continue", { task: "T1" }) };
  return { review: review(a.project, "complete", { plan: { add: [], update: Array.from({ length: 6 }, (_, i) => ({ id: i + 1, status: "done", evidence: "Comprobado.", note: "" })) } }) };
} } });
app.coordinator.updateSettings({ ...app.coordinator.settings, projectsRoot: projects, gitMode: "off" });
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
const text = (selector) => page.locator(selector).textContent();
try {
  await page.goto(app.origin + "/#token=" + app.token);
  await page.waitForFunction(() => document.querySelector("#accountsDialog")?.open);
  await page.click("#accountsDialog [data-close]");
  report.step = "proposal";
  await page.click("#newIdeaTop");
  await page.waitForFunction(() => document.querySelector("#ideaDialog").open);
  await page.fill("#ideaText", "Quiero una calculadora de propinas para repartir la cuenta entre mis amigos");
  await page.click("#ideaForm button[type=submit]");
  await page.waitForFunction(() => !document.querySelector("#ideaCard").hidden, null, { timeout: 15e3 });
  const card = await text("#ideaCard");
  check("la propuesta incluye el lanzador y la guía entre lo que se comprobará", card.includes("Abrir.cmd") && card.includes("COMO_USAR.md"), card.slice(0, 400));
  check("avisa qué recibirá la persona al terminar", card.includes("botón para abrirla") && card.includes("lanzador de doble clic") && card.includes("guía sencilla"));
  check("la plataforma web no muestra avisos de herramientas faltantes", !card.includes("En esta PC falta"));
  check("la lista de pasos trae las dos tareas de entrega", card.includes("Crear Abrir.cmd para abrir la aplicación") && card.includes("Escribir la guía COMO_USAR.md"));
  await shot("01-propuesta");
  report.step = "approve";
  await page.click("#ideaAccept");
  await page.waitForFunction(() => !document.querySelector("#ideaDialog").open, null, { timeout: 15e3 });
  const project = app.coordinator.projects.at(-1);
  check("el proyecto nació con 5 criterios y 6 tareas", project.criteria.length === 5 && app.coordinator.plan.list(project.id).length === 6, [project.criteria.length]);
  release();
  report.step = "send back";
  await page.waitForFunction(() => [...document.querySelectorAll(".activity-entry")].some((e) => e.textContent.includes("todavía no está lista para entregarse")), null, { timeout: 30e3 });
  const warning = await page.locator(".activity-entry", { hasText: "todavía no está lista para entregarse" }).first().textContent();
  check("el primer intento se devuelve con el motivo en palabras sencillas", /intento 1 de 3/.test(warning) && warning.includes("Falta Abrir.cmd") && warning.includes("Falta COMO_USAR.md"), warning);
  check("no hay botón de abrir mientras falta la entrega", await page.locator(".delivery-row").count() === 0);
  await page.waitForFunction(() => document.querySelector("#runState").textContent === "Completado", null, { timeout: 60e3 });
  report.step = "ready row";
  await page.waitForSelector(".delivery-row");
  const row = await text(".delivery-row");
  check("aparece «Tu aplicación está lista» con dónde se guardó", row.includes("Tu aplicación está lista") && row.includes(project.directory.split(path.sep).pop()), row);
  const labels = await page.locator(".delivery-row button").allTextContents();
  check("ofrece Abrir aplicación, Guía y detalles y Abrir carpeta", labels.join("|") === "Abrir aplicación|Guía y detalles|Abrir carpeta", labels);
  check("la barra se llama «Entrega» y no «El director propone»", (await text("#gitBarTitle")) === "Entrega" && (await text("#gitBarNote")).includes("lista para usar"));
  check("no queda la pregunta «¿Correr la app?»", !(await text("#gitItems")).includes("¿Quieres correr la app?"));
  check("el estado del trabajo dice Completado", (await text("#runState")) === "Completado");
  await shot("02-lista");
  report.step = "details";
  await page.click(".delivery-row [data-delivery=details]");
  await page.waitForFunction(() => document.querySelector("#deliveryDialog").open && document.querySelector("#deliveryContent").textContent.includes("Respaldar tus datos"), null, { timeout: 10e3 });
  const details = await text("#deliveryContent");
  for (const part of ["Dónde está", project.directory, "Haz doble clic en Abrir.cmd", "Qué funciona", "Calcula la propina y el total por persona.", "Qué queda pendiente", "No guarda un historial de cuentas.", "no garantizan calidad comercial", "Guía para usarla", "Instalar", "Respaldar tus datos", "Cómo se comprobó", "El lanzador está y no instala nada", "La guía tiene todas sus secciones", "Los archivos que usa están completos"]) check(`los detalles muestran «${part.length > 50 ? part.slice(0, 50) + "…" : part}»`, details.includes(part));
  check("explica que se abrió en un navegador de prueba o dice que no se pudo", details.includes("Se abrió en el navegador sin errores") || details.includes("No se pudo abrir en un navegador de prueba"));
  check("los detalles no usan jerga técnica en lo principal", !/\b(npm|node|powershell|exit code|stack)\b/i.test(details.split("Cómo se comprobó")[0]));
  await shot("03-detalles");
  await page.click("#deliveryDialog [data-close]");
  report.step = "open";
  await page.click(".delivery-row [data-delivery=open]");
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Abriendo la aplicación"), null, { timeout: 10e3 });
  check("Abrir aplicación abre la página principal de la carpeta", opened.at(-1) === path.join(project.directory, "index.html"), opened);
  await page.click(".delivery-row [data-delivery=folder]");
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Abriendo la carpeta"), null, { timeout: 10e3 });
  check("Abrir carpeta abre la carpeta del proyecto", opened.at(-1) === project.directory, opened);
  report.step = "english";
  app.coordinator.updateSettings({ ...app.coordinator.settings, language: "en" });
  await page.reload();
  await page.waitForSelector(".delivery-row");
  const english = await text(".delivery-row");
  check("en inglés la fila se entiende", english.includes("Your app is ready") && english.includes("Open app") && english.includes("Guide and details") && english.includes("Open folder"), english);
  check("y la barra dice Delivery", (await text("#gitBarTitle")) === "Delivery");
  app.coordinator.updateSettings({ ...app.coordinator.settings, language: "es" });
  await page.reload();
  await page.waitForSelector(".delivery-row");
  report.step = "phone";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector("#accountsDialog")?.close());
  check("sin desbordamiento horizontal en el teléfono", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const inside = await page.evaluate(() => [...document.querySelectorAll(".delivery-row button")].every((b) => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
  check("los botones de la entrega caben en la pantalla del teléfono", inside);
  await shot("04-telefono");
  check("sin errores de la página", errors.length === 0, errors);
  check("sin peticiones externas", external.length === 0, external);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = `${report.step ?? ""}: ${error.message}`;
  await shot("error").catch(() => {});
} finally {
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  release?.();
  await browser.close();
  await app.close();
  fs.rmSync(projects, { recursive: true, force: true });
}
console.log(JSON.stringify({ pageErrors: errors, ok: report.ok, passed: report.checks.filter((c) => c.ok).length, total: report.checks.length, error: report.error, output }, null, 2));
process.exit(report.ok ? 0 : 1);

// From an idea to a project in a real Chrome, as a person who does not program would use it:
// write the idea, read the proposal in plain words, adjust it, approve once, and watch what is
// being built and what is left. Simulated agents (no AI), real Git, real folder safety.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.mjs";
import { AuthManager } from "../server/auth.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "artifacts", "smoke-ideas-" + new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(output, { recursive: true });
// Projects go outside Automata: its own folder (the safety rules refuse anything inside Automata).
const projects = fs.mkdtempSync(path.join(os.tmpdir(), "automata-smoke-projects-"));
const auth = new AuthManager({ find: (role) => ({ command: role, args: [] }), run: async (role) => ({ code: 0, stdout: role === "coder" ? '{"loggedIn":true,"authMethod":"claude.ai"}' : "", stderr: role === "auditor" ? "Logged in using ChatGPT" : role === "github" ? "Logged in to github.com account test-user" : "" }) });
const CRITERIA = ["agregarProducto valida nombre y cantidad.", "La CLI lista el inventario en JSON.", "Hay una alerta cuando quedan menos de 5 unidades.", "README.md explica cómo usarlo."];
const proposal = (alerts) => ({
  name: "Inventario de la tienda", summary: "Un programa sencillo para saber qué productos tienes y cuántos quedan.", objective: "Una aplicación de consola para registrar productos y existencias de una tienda pequeña, guardando los datos en esta PC.",
  features: ["Registrar productos con su cantidad", "Ver el inventario", ...alerts ? ["Avisar cuando quede poco de un producto"] : []],
  criteria: alerts ? CRITERIA : CRITERIA.filter((c) => !c.includes("alerta")), checks: ["node --test"], platform: "Consola de Windows",
  plan: [
    { title: "Preparar el proyecto y sus pruebas", detail: "", criterion: "", dependsOn: [] },
    { title: "Registrar productos", detail: "", criterion: CRITERIA[0], dependsOn: ["N1"] },
    { title: "Listar el inventario", detail: "", criterion: CRITERIA[1], dependsOn: ["N2"] },
    ...alerts ? [{ title: "Alerta de existencias bajas", detail: "", criterion: CRITERIA[2], dependsOn: ["N2"] }] : [],
    { title: "Escribir el README", detail: "", criterion: CRITERIA[3], dependsOn: ["N3"] }
  ],
  risks: ["No incluye ventas en línea ni lector de códigos de barras.", "Los datos se guardan solo en esta PC."], questions: []
});
const review = (decision, extra = {}) => ({ decision, summary: `Revisión ${decision}.`, nextPrompt: decision === "continue" ? "Haz la tarea." : "", task: "", files: [], findings: [], criteria: CRITERIA.map((criterion) => ({ criterion, met: decision === "complete", evidence: decision === "complete" ? "Comprobado." : "" })), git: { commit: false, message: "", push: false, branch: "", merge_into: "" }, run: { ready: false, command: "", url: "", note: "" }, memory: { add: [], retire: [] }, plan: { add: [], update: [] }, ...extra });
let drafts = 0, reviews = 0, release;
const gate = new Promise((r) => release = r);
const app = await createServer({ port: 0, dataDir: path.join(output, "data"), auth, checks: async (p) => p.checks.map((command) => ({ command, passed: true, code: 0, output: "ok" })), evidence: async () => "", agents: { async run(a) {
  await new Promise((r) => setTimeout(r, 300));
  if (a.phase === "define") return { proposal: proposal(++drafts > 1) };
  if (a.role === "coder") { await gate; return { text: "Hecho." }; }
  if (a.phase === "plan") return { review: review("continue", { task: "T1" }) };
  reviews++;
  const next = [2, 3, 4, 5][reviews - 1];
  if (reviews < 5) return { review: review("continue", { task: `T${next}`, plan: { add: [], update: [{ id: next - 1, status: "done", evidence: "Comprobado.", note: "" }] } }) };
  return { review: review("complete", { plan: { add: [], update: [{ id: 5, status: "done", evidence: "Comprobado.", note: "" }] } }) };
} } });
app.coordinator.updateSettings({ ...app.coordinator.settings, projectsRoot: projects });
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
  check("el botón principal es Nueva idea", await page.locator("#newIdeaTop").isVisible() && (await text("#newIdeaTop")).includes("Nueva idea"));
  await page.click("#newIdeaTop");
  await page.waitForFunction(() => document.querySelector("#ideaDialog").open);
  // A casual message never starts anything.
  await page.fill("#ideaText", "¡Buen trabajo, jóvenes!");
  await page.click("#ideaForm button[type=submit]");
  await page.waitForFunction(() => document.querySelector("#ideaError").textContent.includes("no parece una idea"));
  check("un mensaje casual no inicia nada", drafts === 0 && app.coordinator.proposals.length === 0);
  await page.fill("#ideaText", "Quiero una aplicación para administrar el inventario de mi tienda");
  await page.click("#ideaForm button[type=submit]");
  await page.waitForFunction(() => !document.querySelector("#ideaWorking").hidden);
  check("muestra que el director está preparando la propuesta", true);
  await page.waitForFunction(() => !document.querySelector("#ideaCard").hidden, null, { timeout: 15e3 });
  const card = await text("#ideaCard");
  for (const part of ["Inventario de la tienda", "Lo que hará", "Cómo sabremos que funciona", "Dónde se usará", "Consola de Windows", "Pasos del plan", "después de", "Ten en cuenta", "lector de códigos", "Dónde se guardará", "no garantiza calidad comercial", "única aprobación"]) check(`la propuesta explica «${part}»`, card.includes(part), card.slice(0, 200));
  check("la carpeta propuesta es propia, dentro de la carpeta de proyectos", card.includes(path.join(projects, "inventario-de-la-tienda")));
  check("los comandos quedan en detalles técnicos, cerrados", !await page.locator("#ideaCard details").evaluate((d) => d.open));
  await shot("01-propuesta");
  // Adjust it in plain words.
  await page.click("#ideaAdjustOpen");
  await page.fill("#ideaAdjust", "También quiero que me avise cuando quede poco de un producto.");
  await page.click("#ideaAdjustForm button[type=submit]");
  await page.waitForFunction(() => document.querySelector("#ideaCard").textContent.includes("Avisar cuando quede poco"), null, { timeout: 15e3 });
  check("el ajuste cambia la propuesta", drafts === 2 && (await text("#ideaCard")).includes("Alerta de existencias bajas"));
  await shot("02-ajustada");
  // One approval.
  await page.click("#ideaAccept");
  await page.waitForFunction(() => !document.querySelector("#ideaDialog").open, null, { timeout: 15e3 });
  const project = app.coordinator.projects.at(-1);
  check("se creó el proyecto en su carpeta con Git", project?.name === "Inventario de la tienda" && fs.existsSync(path.join(project.directory, ".git")) && path.dirname(project.directory) === fs.realpathSync(projects), project?.directory);
  check("el plan aprobado quedó en el proyecto", app.coordinator.plan.list(project.id).length === 5);
  await page.waitForFunction(() => document.querySelector("#bottomStatus").textContent.includes("Construyendo"), null, { timeout: 15e3 });
  const status = await text("#bottomStatus");
  check("dice qué se está construyendo y cuánto falta", /Construyendo: «Preparar el proyecto y sus pruebas» · faltan 5 tareas de 5/.test(status), status);
  check("el contador del plan acompaña", (await text("#planCount")) === "PLAN 0/5");
  await shot("03-construyendo");
  release();
  await page.waitForFunction(() => document.querySelector("#runState").textContent === "Completado", null, { timeout: 30e3 });
  check("termina con el plan hecho", (await text("#planCount")) === "PLAN 5/5");
  await shot("04-completado");
  // A dangerous folder is refused in the manual dialog too, with a plain explanation.
  report.step = "abrir manual"; await page.click("#newProjectTop"); await page.waitForTimeout(500); report.debug = await page.evaluate(() => ({ dialogs: [...document.querySelectorAll("dialog[open]")].map((d) => d.id), toast: document.querySelector("#toast").textContent }));
  await page.waitForFunction(() => document.querySelector("#projectDialog").open);
  report.step = "llenar"; await page.fill("#projectForm [name=name]", "Peligroso");
  await page.fill("#projectForm [name=directory]", root);
  await page.fill("#projectForm [name=objective]", "Algo");
  await page.fill("#projectForm [name=criteria]", "Algo comprobable");
  report.step = "enviar"; await page.click("#projectForm button[type=submit]");
  await page.waitForFunction(() => document.querySelector("#projectError").textContent.trim(), null, { timeout: 10e3 });
  const refusal = await text("#projectError");
  check("una carpeta peligrosa se rechaza con una explicación sencilla", /es Automata/.test(refusal) && app.coordinator.projects.length === 1, refusal);
  await page.click("#projectDialog [data-close]");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click("#newIdeaTop").catch(() => {});
  await page.waitForTimeout(300);
  check("sin desbordamiento horizontal en el teléfono", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await shot("05-telefono");
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
console.log(JSON.stringify({ debug: report.debug, pageErrors: errors, ok: report.ok, passed: report.checks.filter((c) => c.ok).length, total: report.checks.length, error: report.error, output }, null, 2));
process.exit(report.ok ? 0 : 1);

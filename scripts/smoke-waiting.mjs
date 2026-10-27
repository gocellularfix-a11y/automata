// The waiting state in a real Chrome: why Automata waits, when it resumes, which agent, and that
// Continuar ahora, Pausar and Detener stay available. Simulated agents; no AI calls.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "artifacts", "smoke-waiting-" + new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(output, { recursive: true });
const review = (decision) => ({ decision, summary: `Revisión ${decision}.`, nextPrompt: decision === "continue" ? "Crea greet.mjs y su prueba." : "", findings: [], criteria: [{ criterion: "El saludo incluye el nombre y la prueba pasa.", met: decision === "complete", evidence: "node --test en verde." }], git: { commit: false, message: "", push: false, branch: "", merge_into: "" }, run: { ready: false, command: "", url: "", note: "" }, memory: { add: [], retire: [] } });
let reviews = 0, failCoder = true;
const resetAt = Date.now() + 20 * 6e4;
const app = await createServer({ port: 0, demo: true, dataDir: path.join(output, "data"), backoff: { transient: [500], limit: [500], margin: 0 }, agents: { async run(a) {
  if (a.role === "coder") {
    if (failCoder) {
      failCoder = false;
      throw Object.assign(new Error("You've hit your usage limit · resets " + new Date(resetAt).toISOString()), { role: "coder", agent: true, rateLimit: { status: "rejected", resets_at: Math.floor(resetAt / 1e3) } });
    }
    fs.writeFileSync(path.join(a.project.directory, "greet.mjs"), "export const greet = (n) => `Hola, ${n}.`;\n");
    fs.writeFileSync(path.join(a.project.directory, "greet.test.mjs"), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { greet } from './greet.mjs'; test('saludo', () => assert.equal(greet('compa'), 'Hola, compa.'));\n");
    return { text: "Creé greet.mjs y su prueba." };
  }
  return { review: review(a.phase === "review" && ++reviews >= 1 ? "complete" : "continue") };
} } });
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
try {
  await page.goto(app.origin + "/#token=" + app.token);
  await page.waitForFunction(() => document.querySelector("#projectName").textContent === "Hola, Automata");
  await page.click("#startButton");
  await page.waitForFunction(() => document.querySelector("#runState").textContent === "Esperando para continuar", null, { timeout: 15e3 });
  const clock = new Date(resetAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const status = await page.locator("#bottomStatus").textContent();
  check("la barra inferior dice por qué espera, qué agente y cuándo sigue", status.includes("Límite de uso de Claude") && status.includes("sigue a las " + clock) && /intento 1\/8/.test(status) && status.includes("Motivo:"), status);
  const coder = await page.locator("#coderStatus").textContent(), coderLine = await page.locator("#coderSubtitle").textContent();
  check("el panel de Claude muestra la espera con la hora", /En espera/.test(coder) && coderLine.includes("Límite de uso de Claude") && coderLine.includes(clock), { coder, coderLine });
  const auditorLine = await page.locator("#auditorSubtitle").textContent();
  check("el panel de Codex espera a Claude", auditorLine.includes("Espera a que Claude pueda continuar"), auditorLine);
  check("Continuar ahora, Pausar y Detener están disponibles", await page.locator("#startButton span").textContent() === "Continuar ahora" && !await page.locator("#pauseButton").isDisabled() && !await page.locator("#stopButton").isDisabled());
  const feed = await page.locator("#coderFeed").innerText();
  check("la actividad registra la espera", /ESPERA/.test(feed) && /Límite de uso de Claude/.test(feed), feed.slice(-300));
  await shot("01-esperando");
  // English: the same explanation, translated.
  await page.click("#settingsButton");
  check("la configuración ofrece reanudar solo y los reintentos", await page.locator("#settingsForm [name=autoResume]").isChecked() && await page.locator("#settingsForm [name=maxRetries]").inputValue() === "4" && await page.locator("#autoStartRow").isHidden());
  await page.selectOption("#settingsForm [name=language]", "en");
  await page.click("#settingsForm button[type=submit]");
  await page.waitForFunction(() => document.documentElement.lang === "en" && !document.querySelector("#settingsDialog").open);
  await page.waitForFunction(() => document.querySelector("#runState").textContent === "Waiting to continue");
  const english = await page.locator("#bottomStatus").textContent();
  check("en inglés la espera se explica igual", english.includes("Usage limit of Claude") && english.includes("resumes at") && english.includes("Reason:"), english);
  await shot("02-waiting-en");
  await page.click("#settingsButton");
  await page.selectOption("#settingsForm [name=language]", "es");
  await page.click("#settingsForm button[type=submit]");
  await page.waitForFunction(() => document.documentElement.lang === "es");
  // Pause beats the retry; Continuar resumes; the run finishes without repeating the task.
  await page.click("#pauseButton");
  await page.waitForFunction(() => document.querySelector("#runState").textContent === "En pausa");
  check("pausar durante la espera cancela la cita", app.coordinator.active.status === "paused" && !app.coordinator.active.resumeAt);
  await shot("03-pausado");
  await page.click("#startButton");
  await page.waitForFunction(() => document.querySelector("#runState").textContent === "Completado", null, { timeout: 25e3 });
  check("al continuar el trabajo termina solo", app.coordinator.active.status === "complete" && app.coordinator.active.round === 1 && app.coordinator.active.checks[0]?.passed, { round: app.coordinator.active.round, checks: app.coordinator.active.checks });
  await shot("04-completado");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  check("sin desbordamiento horizontal en el teléfono", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check("sin errores de la página", errors.length === 0, errors);
  check("sin peticiones externas", external.length === 0, external);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.message;
  await shot("error").catch(() => {});
} finally {
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  await app.close();
}
console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter((c) => c.ok).length, total: report.checks.length, error: report.error, output }, null, 2));
process.exit(report.ok ? 0 : 1);

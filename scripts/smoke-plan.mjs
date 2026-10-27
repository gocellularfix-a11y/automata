// The Plan panel and the conversation controls in a real Chrome, with the demo agents: add a task
// linked to a criterion and a free one, correct, reorder, drop and restore, run the cycle and see
// the director's task confirmed, the PLAN counter, "Nueva conversación", English and the phone.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "artifacts", "smoke-plan-" + new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(output, { recursive: true });
const app = await createServer({ port: 0, demo: true, dataDir: path.join(output, "data") });
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find((p) => p && fs.existsSync(p));
const browser = await chromium.launch({ executablePath: chrome, channel: chrome ? undefined : "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1480, height: 1020 }, reducedMotion: "reduce" });
const errors = [], external = [], report = { at: new Date().toISOString(), checks: [], screenshots: [] };
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => { if (new URL(r.url()).origin !== app.origin) external.push(r.url()); });
page.on("dialog", (dialog) => dialog.accept("ya no hace falta"));
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, detail });
  if (!ok) throw new Error(name + ": " + JSON.stringify(detail));
};
const shot = async (name) => {
  const file = path.join(output, name + ".png");
  await page.screenshot({ path: file });
  report.screenshots.push(file);
};
const items = () => page.locator("#planContent .plan-item").count();
try {
  await page.goto(app.origin + "/#token=" + app.token);
  await page.waitForFunction(() => document.querySelector("#projectName").textContent === "Hola, Automata");
  check("el contador del plan empieza vacío", await page.locator("#planCount").textContent() === "PLAN —");
  await page.click("#planButton");
  await page.waitForFunction(() => document.querySelector("#planContent").textContent.includes("Todavía no hay tareas"));
  await page.fill("#planForm [name=title]", "Probar el saludo con otro nombre");
  await page.selectOption("#planForm [name=criterion]", { index: 1 });
  await page.click("#planForm button[type=submit]");
  await page.waitForFunction(() => document.querySelectorAll("#planContent .plan-item").length === 1);
  await page.fill("#planForm [name=title]", "Escribir un README");
  await page.click("#planForm button[type=submit]");
  await page.waitForFunction(() => document.querySelectorAll("#planContent .plan-item").length === 2);
  const text = await page.locator("#planContent").textContent();
  check("tarea ligada y tarea libre con sus etiquetas", /Criterio: El saludo/.test(text) && /Libre/.test(text) && /Tú/.test(text), text.slice(0, 300));
  await page.waitForFunction(() => document.querySelector("#planCount").textContent === "PLAN 0/2", null, { timeout: 5000 });
  check("el contador refleja el plan", true);
  await shot("01-plan");
  // Correct the free task's title.
  const freeId = await page.locator(".plan-item", { hasText: "Escribir un README" }).getAttribute("data-task");
  const free = page.locator(`[data-task="${freeId}"]`);
  await free.locator("[data-task-edit]").click();
  await free.locator("input").fill("Escribir un README en español");
  await free.locator("[data-task-save]").click();
  await page.waitForFunction(() => document.querySelector("#planContent").textContent.includes("README en español"));
  check("corregir una tarea", true);
  // Move it up, then drop and restore it.
  await page.locator(".plan-item", { hasText: "README en español" }).locator("[data-task-up]").click();
  await page.waitForFunction(() => document.querySelector("#planContent .plan-item")?.textContent.includes("README en español"));
  check("reordenar", true);
  await page.locator(".plan-item", { hasText: "README en español" }).locator("[data-task-drop]").click();
  await page.waitForFunction(() => document.querySelector("#planContent").textContent.includes("Descartadas"));
  check("descartar con motivo, sin borrar", (await page.locator("#planContent").textContent()).includes("ya no hace falta") && await items() === 2);
  await page.locator(".plan-item.retired").locator("[data-task-restore]").click();
  await page.waitForFunction(() => !document.querySelector("#planContent").textContent.includes("Descartadas"));
  check("restaurar", true);
  // The linked user task would keep the goal open: drop it so the demo director can complete.
  await page.locator(".plan-item", { hasText: "Probar el saludo" }).locator("[data-task-drop]").click();
  await page.waitForFunction(() => document.querySelector("#planContent").textContent.includes("Descartadas"));
  await page.click("#planDialog [data-close]");
  await page.click("#startButton");
  await page.waitForFunction(() => document.querySelector("#runState").textContent === "Completado", null, { timeout: 25e3 });
  check("el director creó y confirmó su tarea", app.coordinator.plan.list("demo").some((task) => task.source === "director" && task.status === "done"));
  await page.waitForFunction(() => document.querySelector("#planCount").textContent === "PLAN 1/2", null, { timeout: 5000 });
  check("el contador cuenta lo hecho", true);
  const feed = await page.locator("#auditorFeed").innerText();
  check("la actividad muestra el plan del director", /PLAN\s*\n?.*1 tarea\(s\) nueva\(s\)/.test(feed) || feed.includes("1 tarea(s) nueva(s)"), feed.slice(-400));
  await page.click("#planButton");
  await page.waitForFunction(() => document.querySelector("#planContent").textContent.includes("Hechas"));
  const after = await page.locator("#planContent").textContent();
  check("la tarea del director aparece hecha con evidencia", /Hecha/.test(after) && /Evidencia: node --test aprobado/.test(after) && /Codex/.test(after), after.slice(0, 400));
  await shot("02-plan-hecho");
  await page.click("#planDialog [data-close]");
  // Conversation controls: a casual message gets a local answer; the reset button is acknowledged.
  await page.fill("#chatText", "buen trabajo jóvenes");
  await page.click("#chatForm button[type=submit]");
  await page.waitForFunction(() => document.querySelector("#auditorFeed").innerText.includes("no pide ningún cambio"));
  check("un mensaje casual no llama a los agentes", app.coordinator.messages.at(-1).casual === true);
  await page.click("#chatReset");
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Conversación con Codex reiniciada"));
  check("nueva conversación", true);
  await shot("03-chat");
  // English and the settings field.
  await page.click("#settingsButton");
  check("el ajuste de renovación de sesiones está en la configuración", await page.locator("#settingsForm [name=sessionRefreshRounds]").inputValue() === "8");
  await page.selectOption("#settingsForm [name=language]", "en");
  await page.click("#settingsForm button[type=submit]");
  await page.waitForFunction(() => document.documentElement.lang === "en" && !document.querySelector("#settingsDialog").open);
  await page.click("#planButton");
  await page.waitForFunction(() => document.querySelector("#planContent").textContent.includes("Done"));
  const english = await page.locator("#planContent").textContent();
  check("el panel se traduce", /Done/.test(english) && /Criterion:/.test(english) && /Dropped/.test(english), english.slice(0, 300));
  await shot("04-plan-en");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  check("sin desbordamiento en el teléfono", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await shot("05-phone");
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

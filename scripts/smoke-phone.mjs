import fs from "node:fs";
import path from "node:path";
import { _android } from "playwright-core";
import { createServer } from "../server/index.mjs";
const output = path.resolve("artifacts", "phone-" + Date.now());
fs.mkdirSync(output, { recursive: true });
const devices = await _android.devices({ host: "127.0.0.1", port: 5037 });
if (devices.length !== 1) throw new Error("Conecta exactamente un teléfono autorizado por ADB.");
const device = devices[0];
console.log("Teléfono: " + device.model());
const app = await createServer({ port: 4780, demo: true, dataDir: path.join(output, "data") });
let keep = false;
const report = { model: device.model(), checks: [], at: (/* @__PURE__ */ new Date()).toISOString() };
const check = (name, ok) => {
  report.checks.push({ name, ok: !!ok });
  if (!ok) throw new Error(name);
};
try {
  await device.installApk(fs.readFileSync("dist/Automata-Android.apk"));
  console.log("APK instalado.");
  const reverse = await device.open("reverse:forward:tcp:4780;tcp:4780");
  await reverse.close().catch(() => {
  });
  console.log((await device.shell("am start -n app.automata.workspace/.MainActivity")).toString().trim());
  const webview = await device.webView({ pkg: "app.automata.workspace", timeout: 2e4 });
  const page = await webview.page();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector("#connection");
  await page.click("#connection");
  await page.fill("#connectionForm [name=origin]", "http://127.0.0.1:4780");
  await page.fill("#connectionForm [name=token]", app.token);
  await page.click("#connectionForm button[type=submit]");
  await page.waitForFunction(() => document.querySelector("#projectName").textContent === "Hola, Automata", null, { timeout: 2e4 });
  check("APK conectado por USB al coordinador de la PC", true);
  check("sin desbordamiento horizontal", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, "01-android.png") });
  await page.click("#startButton");
  await page.waitForFunction(() => document.querySelector("#runState").textContent === "Completado", null, { timeout: 25e3 });
  check("ciclo completo iniciado desde el teléfono", app.coordinator.active.status === "complete" && app.coordinator.active.checks[0].passed);
  await page.click("[data-agent-tab=auditor]");
  await page.screenshot({ path: path.join(output, "02-android-audit.png") });
  check("sin errores JavaScript", errors.length === 0);
  report.ok = true;
  console.log(JSON.stringify({ ok: true, output, checks: report.checks.length }));
  keep = process.argv.includes("--keep");
} catch (e) {
  report.ok = false;
  report.error = e.message;
  throw e;
} finally {
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await device.close();
  if (!keep) await app.close();
}
if (keep) {
  console.log("Coordinador de demostración activo en el puerto 4780. El teléfono puede seguir conectado.");
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => void app.close().then(() => process.exit(0)));
}

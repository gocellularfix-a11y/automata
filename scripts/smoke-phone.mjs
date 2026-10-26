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
const app = await createServer({ port: 4781, demo: true, dataDir: path.join(output, "data") });
let keep = false;
const report = { model: device.model(), checks: [], at: (/* @__PURE__ */ new Date()).toISOString() };
const check = (name, ok) => {
  report.checks.push({ name, ok: !!ok });
  if (!ok) throw new Error(name);
};
try {
  await device.installApk(fs.readFileSync("dist/Automata-Android.apk"));
  console.log("APK instalado.");
  const reverse = await device.open("reverse:forward:tcp:4781;tcp:4781");
  await reverse.close().catch(() => {
  });
  console.log((await device.shell("am start -n app.automata.workspace/.MainActivity")).toString().trim());
  const webview = await device.webView({ pkg: "app.automata.workspace", timeout: 2e4 });
  const page = await webview.page();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector("#connection");
  for (const dialog of await page.locator('dialog[open]').all()) await dialog.evaluate(node => node.close());
  await page.click("#connection");
  await page.fill("#connectionForm [name=origin]", "http://127.0.0.1:4781");
  await page.fill("#connectionForm [name=token]", app.token);
  await page.click("#connectionForm button[type=submit]");
  await page.waitForFunction(() => document.querySelector("#projectName").textContent === "Hola, Automata", null, { timeout: 2e4 });
  check("APK conectado por USB al coordinador de la PC", true);
  check("sin desbordamiento horizontal", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, "01-android.png"), timeout: 10000 });
  await page.click("#startButton");
  await page.waitForFunction(() => document.querySelector("#runState").textContent === "Completado", null, { timeout: 25e3 });
  check("ciclo completo iniciado desde el teléfono", app.coordinator.active.status === "complete" && app.coordinator.active.checks[0].passed);
  await page.click("[data-agent-tab=auditor]");
  await page.screenshot({ path: path.join(output, "02-android-audit.png"), timeout: 10000 });
  await page.click('#mobileSettings');
  await page.selectOption('#settingsForm [name=language]', 'en');
  await page.click('#settingsForm button[type=submit]');
  await page.waitForFunction(() => document.documentElement.lang === 'en' && !document.querySelector('#settingsDialog').open);
  check('English and full access work on physical Android', await page.locator('#accessMode option:checked').textContent() === 'Full access' && await page.locator('#chatKind').inputValue() === 'task');
  await page.click('#mobileSettings');
  check('all Settings sections available on phone', await page.locator('#settingsForm [name]').count() === 9 && await page.locator('#settingsAccounts').isVisible());
  await page.screenshot({ path: path.join(output, '03-android-settings-en.png'), timeout: 10000 });
  await page.selectOption('#settingsForm [name=language]', 'es');
  await page.click('#settingsForm button[type=submit]');
  await page.waitForFunction(() => document.documentElement.lang === 'es' && !document.querySelector('#settingsDialog').open);
  check('Español restored and saved', app.coordinator.settings.language === 'es');
  const packageInfo = (await device.shell('dumpsys package app.automata.workspace')).toString();
  check('installed package is version 0.4.0', /versionName=0\.4\.0/.test(packageInfo));
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
  console.log("Coordinador de demostración activo en el puerto 4781. El teléfono puede seguir conectado.");
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => void app.close().then(() => process.exit(0)));
}

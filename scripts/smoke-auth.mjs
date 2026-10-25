import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chromium } from "playwright-core";
import { AuthManager } from "../server/auth.mjs";
import { createServer } from "../server/index.mjs";

const output = path.resolve("artifacts", "accounts-" + Date.now());
fs.mkdirSync(output, { recursive: true });
const connected = { coder: false, auditor: false, github: false }, children = {};
const auth = new AuthManager({
  find: role => ({ command: role, args: [] }),
  run: async role => role === "github" ? { code: connected.github ? 0 : 1, stdout: "", stderr: connected.github ? "Logged in to github.com account test-user" : "You are not logged into any GitHub hosts. Run gh auth login." } : role === "coder" ? { code: connected.coder ? 0 : 1, stdout: JSON.stringify({ loggedIn: connected.coder, authMethod: connected.coder ? "claude.ai" : "none" }), stderr: "" } : { code: connected.auditor ? 0 : 1, stdout: "", stderr: connected.auditor ? "Logged in using ChatGPT" : "Not logged in" },
  spawnLogin: (role, args) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    children[role] = child;
    child.stdin.on("data", () => { connected[role] = true; child.emit("close", 0); });
    setTimeout(() => child.stdout.write(role === "github" ? "https://github.com/login/device\nABCD-GHJK\n" : role === "coder" ? "https://claude.ai/oauth/authorize?state=simulated-login\nPaste code here if prompted: " : args.includes("--device-auth") ? "https://auth.openai.com/codex/device\nABCD-EFGHI\n" : "https://auth.openai.com/oauth/authorize?state=simulated-login\n"), 20);
    return child;
  },
  stop: async child => child.emit("close", -1)
});
const app = await createServer({ port: 0, dataDir: path.join(output, "data"), auth });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1480, height: 1020 }, reducedMotion: "reduce" });
const errors = [], checks = [];
page.on("pageerror", error => errors.push(error.message));
function check(name, ok) { checks.push({ name, ok: !!ok }); if (!ok) throw new Error(name); }
try {
  await page.goto(app.origin + "/#token=" + app.token);
  await page.waitForSelector("#accountsDialog[open]");
  await page.waitForFunction(() => document.querySelector("#coderAccountState").textContent === "Sin conectar");
  check("login visible en el primer inicio real", await page.locator("#accountsContinue").isDisabled());
  await page.screenshot({ path: path.join(output, "01-connect-your-team.png") });
  await page.click("[data-login=coder]");
  await page.waitForSelector("#claudeCodeForm:not([hidden])");
  check("Claude ofrece su página oficial y permite el código de retorno", (await page.locator("#coderAuthLink").getAttribute("href")).startsWith("https://claude.ai/"));
  await page.fill("#claudeCodeForm input", "simulated-code#state");
  await page.click("#claudeCodeForm button");
  await page.waitForFunction(() => document.querySelector("#coderAccountState").textContent === "Conectado");
  check("conectar Claude no conecta ficticiamente a Codex", await page.locator("#accountsContinue").isDisabled());
  await page.click("[data-login=auditor]");
  await page.waitForSelector("#auditorAuthLink:not([hidden])");
  await page.click("[data-auth-cancel=auditor]");
  await page.waitForFunction(() => document.querySelector("#auditorAccountState").textContent === "Sin conectar");
  check("cancelar vuelve a permitir un nuevo intento", await page.locator("[data-login=auditor]").isVisible());
  await page.click("#auditorAccount summary");
  await page.click("#deviceLoginButton");
  await page.waitForSelector("#deviceCodeSection:not([hidden])");
  check("alternativa de dispositivo muestra el código", await page.locator("#deviceCode").textContent() === "ABCD-EFGHI");
  connected.auditor = true;
  children.auditor.emit("close", 0);
  await page.waitForFunction(() => document.querySelector("#auditorAccountState").textContent === "Conectado");
  check("continuar se habilita al verificar ambas sesiones", await page.locator("#accountsContinue").isEnabled());
  check("GitHub sin conectar no impide continuar con las AI", await page.locator("#githubAccountState").textContent() === "Sin conectar");
  await page.click("[data-login=github]");
  await page.waitForFunction(() => document.querySelector("#githubDeviceCode").textContent === "ABCD-GHJK");
  check("login opcional de GitHub muestra su código oficial", await page.locator("#githubAuthLink").getAttribute("href") === "https://github.com/login/device");
  connected.github = true;
  children.github.emit("close", 0);
  await page.waitForFunction(() => document.querySelector("#githubAccountState").textContent === "Conectado");
  check("GitHub conectado no altera el contador de las dos AI", await page.locator("#accountCount").textContent() === "2/2");
  await page.click("#accountsContinue");
  check("el estado de las dos cuentas queda visible en el espacio", await page.locator("#accountCount").textContent() === "2/2");
  check("no se guardan códigos ni URLs OAuth en localStorage", !await page.evaluate(() => JSON.stringify(Object.values(localStorage)).match(/simulated-login|simulated-code|ABCD-EFGHI/)));
  connected.auditor = false;
  auth.checkedAt.auditor = 0;
  await page.click("#startButton");
  await page.waitForSelector("#accountsDialog[open]");
  check("una sesión que falta vuelve a pedir conexión antes de trabajar", app.coordinator.runs.length === 0);
  await page.setViewportSize({ width: 390, height: 844 });
  check("login móvil sin desbordamiento", await page.evaluate(() => document.querySelector("#accountsDialog").scrollWidth <= document.querySelector("#accountsDialog").clientWidth && document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, "02-mobile-accounts.png") });
  check("sin errores de JavaScript", errors.length === 0);
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ ok: true, simulatedProviderLogin: true, checks, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, checks: checks.length, simulatedProviderLogin: true, output }, null, 2));
} finally { await browser.close(); await app.close(); }

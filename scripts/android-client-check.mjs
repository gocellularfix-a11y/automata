// Validates the Automata CLIENT app (app.automata.workspace, already installed) against a throwaway coordinator on this
// PC, over USB (`adb reverse`: nothing is opened on the network and no firewall rule is needed). It only reads and drives
// the client; it never installs or removes anything. The coordinator is a second, demo instance with its own data folder.
//   node scripts/android-client-check.mjs --serial <adb serial> [--out <folder>] [--port 4781]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveToolchain, runTool } from "../server/androidbuild.mjs";
import { openWebView } from "./adb-webview.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const at = args.indexOf("--" + name); return at >= 0 ? args[at + 1] : undefined; };
const serial = flag("serial"), port = Number(flag("port") ?? 4781);
const out = path.resolve(flag("out") ?? path.join("artifacts", "client-" + Date.now()));
const PKG = "app.automata.workspace";
if (!serial) { console.error("Uso: node scripts/android-client-check.mjs --serial <serie> [--out <carpeta>] [--port 4781]"); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tc = await resolveToolchain();
const adb = (...a) => runTool(tc.adb, ["-s", serial, ...a], { timeoutMs: 60000 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { at: new Date().toISOString(), serial, checks: [] };
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); console.log(`${ok ? "ok   " : "FALLA"} ${name}${detail ? ": " + String(detail).slice(0, 220) : ""}`); return !!ok; };

// ---- The throwaway coordinator (own data folder, demo mode, loopback only) ----
const data = fs.mkdtempSync(path.join(os.tmpdir(), "automata-client-check-"));
let server = null;
const startServer = async () => {
  server = spawn(process.execPath, [path.join(root, "server", "index.mjs"), "--demo", "--port", String(port), "--data", data], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  server.stdout.on("data", (c) => { text += c; });
  server.stderr.on("data", (c) => { text += c; });
  for (let i = 0; i < 100; i++) { if (/Código de conexión local/.test(text)) break; if (server.exitCode !== null) throw new Error("El coordinador de prueba no arrancó: " + text.slice(0, 300)); await wait(100); }
  await wait(300);
};
const stopServer = async () => { if (server && server.exitCode === null) { const done = new Promise((r) => server.once("exit", r)); server.kill(); await Promise.race([done, wait(5000)]); } server = null; };
const token = () => fs.readFileSync(path.join(data, "access-token"), "utf8").trim();
const origin = `http://127.0.0.1:${port}`;
const api = async (route, { auth = token(), headers = {}, method = "GET", body } = {}) => { const r = await fetch(`${origin}/api/${route}`, { method, headers: { ...auth ? { Authorization: "Bearer " + auth } : {}, ...body ? { "Content-Type": "application/json" } : {}, ...headers }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };

let view = null;
const until = async (fn, ms = 20000, step = 250) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch { /* page busy */ } await wait(step); } return last; };
const clientText = (selector) => view.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? null`);
const screenshot = async (name) => { const png = await new Promise((resolve) => execFile(tc.adb, ["-s", serial, "exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 20 * 1024 * 1024 }, (e, so) => resolve(e ? null : so))); if (png?.length > 1000) fs.writeFileSync(path.join(out, name), png); };
const connectionState = () => view.evaluate(`JSON.stringify({ offline: document.querySelector("#connection").classList.contains("offline"), text: document.querySelector("#connection").lastElementChild.textContent.trim() })`).then(JSON.parse);
const closeDialogs = () => view.evaluate(`document.querySelectorAll("dialog[open]").forEach((d) => d.close()); 0`);
const openConnection = async (originValue, tokenValue) => {
  await closeDialogs();
  await view.evaluate(`document.querySelector("#connection").click(); 0`);
  await wait(400);
  await view.evaluate(`(() => { const f = document.querySelector("#connectionForm"); const set = (n, v) => { const el = f.elements[n]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }; set("origin", ${JSON.stringify(originValue)}); set("token", ${JSON.stringify(tokenValue)}); f.querySelector("button[type=submit]").click(); })()`);
};

const clientBefore = (await adb("shell", `dumpsys package ${PKG} | grep -E "versionCode|lastUpdateTime"`)).stdout.replace(/\r/g, "");
const finish = async () => {
  await view?.close().catch(() => {});
  await adb("reverse", "--remove", `tcp:${port}`);
  await stopServer();
  const after = (await adb("shell", `dumpsys package ${PKG} | grep -E "versionCode|lastUpdateTime"`)).stdout.replace(/\r/g, "");
  check("el cliente sigue instalado y sin reinstalarse durante la prueba", after === clientBefore);
  await adb("shell", "input", "keyevent", "KEYCODE_HOME");
  try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* temp folder */ }
  report.ok = report.checks.every((c) => c.ok);
  fs.writeFileSync(path.join(out, "client-report.json"), JSON.stringify(report, null, 2));
  console.log(report.ok ? "Cliente: todas las comprobaciones correctas." : "Cliente: hay fallos.");
  process.exit(report.ok ? 0 : 1);
};

try {
  await startServer();
  const reversed = await adb("reverse", `tcp:${port}`, `tcp:${port}`);
  check("USB: el teléfono llega al coordinador de la PC (adb reverse)", reversed.code === 0, reversed.stderr.trim());
  await adb("shell", "am", "force-stop", PKG);
  const start = await adb("shell", "am", "start", "-W", "-n", `${PKG}/.MainActivity`);
  check("el cliente arranca", /Status: ok/.test(start.stdout), start.stdout.replace(/\r?\n/g, " | ").slice(0, 160));
  await wait(2500);
  view = await openWebView({ adb: tc.adb, serial, pkg: PKG, pickHost: "automata.local" });
  report.webview = view.info;
  console.log(`WebView ${view.info.ua.match(/Chrome\/[\d.]+/)?.[0]} · ${view.info.width}x${view.info.height} · ${view.info.href}`);
  const bundled = JSON.parse(await view.evaluate(`(async () => { const text = await Promise.all(["/app.js", "/index.html"].map((f) => fetch(f).then((r) => r.text()))); return JSON.stringify({ lang: document.documentElement.lang, newUi: text.join("").includes("Tu aplicación está lista") }); })()`));
  check("el cliente trae la interfaz actual empaquetada (fila «Tu aplicación está lista»)", bundled.lang === "es" && bundled.newUi, JSON.stringify(bundled));
  await closeDialogs();

  // Connection: a wrong code must not connect or be saved; the right one connects.
  const savedBefore = await view.evaluate(`localStorage.getItem("automata.connection")`);
  await openConnection(origin, "0".repeat(64));
  await wait(1500);
  const wrong = await connectionState();
  const saved = await view.evaluate(`localStorage.getItem("automata.connection")`);
  const wrongSaved = !!saved && saved.includes("0".repeat(64));
  check("código incorrecto: no conecta y no sustituye lo guardado", wrong.offline && !wrongSaved && saved === savedBefore, JSON.stringify(wrong) + " · el código erróneo " + (wrongSaved ? "SE GUARDÓ" : "no se guardó"));
  await openConnection(origin, token());
  const online = await until(async () => { const s = await connectionState(); return !s.offline && /Conectado/.test(s.text) ? s : null; });
  check("código correcto: «Conectado a tu PC»", !!online, JSON.stringify(online));
  await closeDialogs();
  const truth = (await api("state")).body;
  const activeRun = (s) => s.runs?.find((r) => r.id === s.activeId) ?? s.runs?.at(-1) ?? null;
  const seenName = await clientText("#projectName");
  check("proyecto: el cliente muestra el del coordinador", !!truth.projects?.[0]?.name && seenName?.includes(truth.projects[0].name), `coordinador=${truth.projects?.map((p) => p.name)} · cliente=${seenName}`);
  check("sin desbordamiento horizontal en el teléfono", await view.evaluate("document.documentElement.scrollWidth <= innerWidth"), `${view.info.width}px`);
  await screenshot("01-conectado.png");

  // Progress: a full demo cycle started from the phone, seen from the coordinator.
  await view.evaluate(`document.querySelector("#startButton").click(); 0`);
  const done = await until(async () => (await clientText("#runState")) === "Completado", 30000, 400);
  const finalState = (await api("state")).body;
  const run = activeRun(finalState);
  check("ciclo completo iniciado desde el teléfono", !!done && run?.status === "complete", `cliente=${await clientText("#runState")} · coordinador=${run?.status}`);
  report.progress = { coordinator: { status: run?.status, keys: Object.keys(run ?? {}), events: finalState.events?.length }, clientRunState: await clientText("#runState") };
  await screenshot("02-ciclo-completo.png");

  // Approvals: the director's offer to run the app waits for a person. Declining on the phone must reach the coordinator
  // (the one source of truth), disappear from the client, and be refused if someone answers it a second time.
  const offerOf = (s) => (s.runs ?? []).flatMap((r) => r.runOffers ?? []).find((o) => o.status === "pending");
  const offer = offerOf((await api("state")).body);
  check("aprobaciones: hay una propuesta pendiente del director y el cliente la muestra", !!offer && await until(() => view.evaluate(`!!document.querySelector('.run-offer[data-offer="${offer?.id}"]')`), 8000), offer ? offer.id : "ninguna pendiente");
  if (offer) {
    await view.evaluate(`[...document.querySelectorAll('.run-offer[data-offer="${offer.id}"] button')].find((b) => /Ahora no/.test(b.textContent))?.click(); 0`);
    const declined = await until(async () => (await api("state")).body.runs.flatMap((r) => r.runOffers ?? []).find((o) => o.id === offer.id)?.status === "declined", 8000);
    check("aprobaciones: «Ahora no» en el teléfono queda registrado en el coordinador", !!declined);
    check("aprobaciones: la fila desaparece del cliente", !!(await until(() => view.evaluate(`!document.querySelector('.run-offer[data-offer="${offer.id}"]')`), 8000)));
    const again = await api("app", { method: "POST", body: { decision: "approve", runId: offer.runId, offerId: offer.id } });
    check("aprobaciones: responder otra vez (otro cliente atrasado) se rechaza con un mensaje claro", again.status >= 400 && /ya se resolvió|No se encontró/.test(again.body?.error ?? ""), `${again.status} ${again.body?.error ?? ""}`);
    check("aprobaciones: nada se ejecutó sin una persona (la app no corre)", (await api("state")).body.app?.status !== "running", JSON.stringify((await api("state")).body.app ?? null));
  }

  // Reconnection: stop the coordinator, the client must notice and come back by itself when it returns.
  await stopServer();
  const lost = await until(async () => { const s = await connectionState(); return s.offline ? s : null; }, 20000, 500);
  check("al caer el coordinador, el cliente lo avisa (Reconectando / Sin conexión)", !!lost, JSON.stringify(lost));
  await screenshot("03-sin-conexion.png");
  await startServer();
  const back = await until(async () => { const s = await connectionState(); return !s.offline && /Conectado/.test(s.text) ? s : null; }, 30000, 500);
  check("al volver el coordinador, el cliente se reconecta solo", !!back, JSON.stringify(back));
  check("tras reconectar sigue mostrando el ciclo completo (estado guardado en la PC)", (await until(async () => (await clientText("#runState")) === "Completado", 10000)) === true);

  // Security, from the PC against the same coordinator: nothing without the right code or from another web origin.
  check("sin código: 401", (await api("state", { auth: null })).status === 401);
  check("código ajeno: 401", (await api("state", { auth: "f".repeat(64) })).status === 401);
  check("origen web ajeno: 403", (await api("state", { headers: { Origin: "https://evil.example" } })).status === 403);
  check("método no permitido sobre archivos: 405", (await fetch(`${origin}/index.html`, { method: "DELETE" })).status === 405);
  const pairing = await api("pairing");
  report.note = `Por USB (adb reverse) las peticiones del teléfono llegan como locales: /api/pairing responde ${pairing.status}. Es por diseño de la conexión USB; por Wi-Fi sería 403.`;
  console.log("nota: " + report.note);
  await finish();
} catch (error) {
  check("la prueba terminó sin error", false, error.stack?.split("\n").slice(0, 3).join(" | ") ?? error.message);
  await finish();
}

// Opens a page in the Chrome or Edge the PC already has, without a window, and reports what a person would hit:
// scripts that throw, resources that do not load, an empty page. It is a start check, not a test of the app's
// behaviour (the project's own tests do that). No dependency: it talks to the browser's debugging port with the
// WebSocket that comes with Node. The browser is registered with Automata's children so a hard close cleans it up.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { killTree } from "./agents.mjs";
import { trackChild, releaseChild } from "./procs.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A tiny DevTools session: send(method, params) and the events that arrive.
function session(url) {
  const ws = new WebSocket(url);
  let next = 0;
  const pending = new Map(), listeners = [];
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("No se pudo hablar con el navegador.")), { once: true });
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result ?? {});
    } else if (message.method) for (const listener of listeners) listener(message);
  });
  ws.addEventListener("close", () => { for (const { reject } of pending.values()) reject(new Error("El navegador se cerró.")); pending.clear(); });
  return {
    ready,
    on: (listener) => listeners.push(listener),
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...sessionId ? { sessionId } : {} }));
    }),
    close: () => { try { ws.close(); } catch { /* already closed */ } }
  };
}

// Returns { ok, title, textLength, controls, problems: [plain text], browser } or { ok: null, skipped: reason } when
// no browser could be started (that is not a failure of the app).
export async function checkInBrowser(url, { executable, timeoutMs = 20000, settleMs = 700, extraArgs = [] } = {}) {
  if (!executable || !fs.existsSync(executable)) return { ok: null, skipped: "No hay un navegador compatible para abrir la aplicación." };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "automata-browser-"));
  let child, cdp;
  const deadline = Date.now() + timeoutMs;
  try {
    child = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--remote-debugging-port=0", `--user-data-dir=${profile}`, ...extraArgs, "about:blank"], { windowsHide: true, stdio: "ignore", detached: process.platform !== "win32" });
    child.on("error", () => {});
    trackChild(child, { role: "delivery", command: path.basename(executable) });
    // Chrome writes the debugging port to a file in the profile when it is ready.
    let port = null, browserPath = null;
    while (Date.now() < deadline && !port) {
      try {
        const [first, second] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/);
        if (Number(first) > 0 && second) { port = Number(first); browserPath = second; }
      } catch { /* not there yet */ }
      if (!port) await wait(100);
    }
    if (!port) return { ok: null, skipped: "El navegador no llegó a iniciar a tiempo." };
    cdp = session(`ws://127.0.0.1:${port}${browserPath}`);
    await cdp.ready;
    const problems = [], seen = new Set();
    const note = (text) => { if (!seen.has(text) && problems.length < 8) { seen.add(text); problems.push(text); } };
    let loaded, loadedPromise = new Promise((resolve) => { loaded = resolve; });
    let targetSession = null;
    cdp.on((m) => {
      if (m.sessionId && targetSession && m.sessionId !== targetSession) return;
      if (m.method === "Page.loadEventFired") loaded();
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        note(`Un error de programa al abrir la página: ${String(d.exception?.description ?? d.text ?? "error").split("\n")[0].slice(0, 200)}`);
      }
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") note(`La página mostró un error: ${m.params.args?.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200)}`);
      if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/favicon/i.test(m.params.entry.url ?? m.params.entry.text)) note(`No se pudo cargar un recurso: ${(m.params.entry.url ?? m.params.entry.text).slice(0, 200)}`);
    });
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    targetSession = attached.sessionId;
    const s = (method, params) => cdp.send(method, params, targetSession);
    await Promise.all([s("Page.enable"), s("Runtime.enable"), s("Log.enable"), s("Network.enable")]);
    await s("Page.navigate", { url });
    await Promise.race([loadedPromise, wait(Math.max(1000, deadline - Date.now()))]);
    await wait(settleMs);
    const evaluated = await s("Runtime.evaluate", { returnByValue: true, expression: `JSON.stringify({ title: document.title, text: (document.body?.innerText || "").trim().length, controls: document.querySelectorAll("input, button, select, textarea, a[href]").length, children: document.body?.children.length || 0 })` });
    const page = JSON.parse(evaluated.result?.value ?? "{}");
    if (!page.children && !page.text) note("La página se abre en blanco.");
    return { ok: problems.length === 0, title: page.title ?? "", textLength: page.text ?? 0, controls: page.controls ?? 0, problems, browser: path.basename(executable) };
  } catch (error) {
    return { ok: null, skipped: `No se pudo comprobar en el navegador (${String(error.message).slice(0, 120)}).` };
  } finally {
    if (cdp) {
      try { await Promise.race([cdp.send("Browser.close"), wait(500)]); } catch { /* it may already be gone */ }
      cdp.close();
    }
    if (child?.pid) {
      await killTree(child);
      releaseChild(child.pid);
    }
    // Windows keeps the profile locked for a moment after the process ends.
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await wait(200); }
    }
  }
}

// Opens a page in the Chrome or Edge the PC already has, without a window, and reports what a person would hit:
// scripts that throw, resources that do not load, an empty page. With a scenario file it also does what a person
// would do (type, press, reload) and reports what appeared. It is a start check plus a small functional probe; the
// project's own tests still check the logic. No dependency: it talks to the browser's debugging port with the
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
    ws.addEventListener("error", () => reject(new Error("browser-unreachable")), { once: true });
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result ?? {});
    } else if (message.method) for (const listener of listeners) listener(message);
  });
  ws.addEventListener("close", () => { for (const { reject } of pending.values()) reject(new Error("browser-closed")); pending.clear(); });
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

// ---- Scenario steps ----
// Each step runs inside the page. They only touch the page being checked, in a throwaway browser profile.
const quote = (value) => JSON.stringify(String(value ?? ""));
const FIND = (selector) => `(() => { const el = document.querySelector(${quote(selector)}); if (!el) return { ok: false, message: "missing" }; `;
const SETTERS = `const set = (el, value) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value); };`;
export function stepExpression(step) {
  if ("fill" in step) return `${FIND(step.fill)}${SETTERS} set(el, ${quote(step.value)}); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return { ok: true }; })()`;
  if ("select" in step) return `${FIND(step.select)}${SETTERS} const text = ${quote(step.value)}; const option = [...(el.options || [])].find((o) => o.value === text || o.textContent.trim() === text); if (!option) return { ok: false, message: "no-option" }; set(el, option.value); el.dispatchEvent(new Event("change", { bubbles: true })); return { ok: true }; })()`;
  if ("click" in step) return `${FIND(step.click)} el.click(); return { ok: true }; })()`;
  if ("expectVisible" in step) return `${FIND(step.expectVisible)} const box = el.getBoundingClientRect(), style = getComputedStyle(el); return { ok: box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none", message: "hidden" }; })()`;
  if ("expectValue" in step) return `${FIND(step.expectValue)} return { ok: String(el.value ?? el.textContent).trim() === ${quote(step.value)}, message: "value", seen: String(el.value ?? el.textContent).trim().slice(0, 80) }; })()`;
  if ("expectCount" in step) return `(() => { const n = document.querySelectorAll(${quote(step.expectCount)}).length; return { ok: n === ${Number(step.count)}, message: "count", seen: String(n) }; })()`;
  if ("expectText" in step) return `(() => { const text = (document.body?.innerText || ""); return { ok: text.includes(${quote(step.expectText)}), message: "text", seen: text.replace(/\\s+/g, " ").trim().slice(0, 160) }; })()`;
  if ("expectNoText" in step) return `(() => { const text = (document.body?.innerText || ""); return { ok: !text.includes(${quote(step.expectNoText)}), message: "no-text" }; })()`;
  return null;
}
export const STEP_KEYS = ["fill", "select", "click", "reload", "wait", "expectVisible", "expectValue", "expectCount", "expectText", "expectNoText"];
const describeStep = (step) => { const key = STEP_KEYS.find((k) => k in step); return key ? `${key} ${typeof step[key] === "string" ? step[key] : ""}${"value" in step ? " = " + String(step.value).slice(0, 40) : ""}`.trim() : "?"; };
function stepMessage(step, outcome, en) {
  const label = describeStep(step);
  switch (outcome.message) {
    case "missing": return en ? `${label}: the element does not exist on the page.` : `${label}: el elemento no existe en la página.`;
    case "no-option": return en ? `${label}: that option is not in the list.` : `${label}: esa opción no está en la lista.`;
    case "hidden": return en ? `${label}: the element is not visible.` : `${label}: el elemento no se ve.`;
    case "text": return en ? `${label}: that text did not appear. The page said: «${outcome.seen}»` : `${label}: ese texto no apareció. La página decía: «${outcome.seen}»`;
    case "no-text": return en ? `${label}: that text should not be there.` : `${label}: ese texto no debería estar.`;
    case "value": return en ? `${label}: the value was «${outcome.seen}».` : `${label}: el valor era «${outcome.seen}».`;
    case "count": return en ? `${label}: ${outcome.seen} found, ${step.count} expected.` : `${label}: se encontraron ${outcome.seen} y se esperaban ${step.count}.`;
    default: return label;
  }
}

// Returns { ok, title, textLength, controls, resources, errors, storageKeys, scenarios, problems, browser } or
// { ok: null, skipped: reason } when no browser could be started (that is not a failure of the app).
// scenarios: [{ name, steps: [...] }] already validated (scenarios.mjs).
export async function checkInBrowser(url, { executable, timeoutMs = 20000, settleMs = 700, extraArgs = [], scenarios = [], language = "es" } = {}) {
  const en = language === "en";
  if (!executable || !fs.existsSync(executable)) return { ok: null, skipped: en ? "There is no compatible browser to open the app." : "No hay un navegador compatible para abrir la aplicación." };
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
    if (!port) return { ok: null, skipped: en ? "The browser did not start in time." : "El navegador no llegó a iniciar a tiempo." };
    cdp = session(`ws://127.0.0.1:${port}${browserPath}`);
    await cdp.ready;
    const problems = [], seen = new Set();
    const note = (text) => { if (!seen.has(text) && problems.length < 8) { seen.add(text); problems.push(text); } };
    // Every file the page asked for, and whether it arrived: the proof that its scripts and styles loaded.
    const requests = new Map();
    const dialogs = [];
    let loaded, loadedPromise = new Promise((resolve) => { loaded = resolve; });
    let targetSession = null;
    const s = (method, params) => cdp.send(method, params, targetSession);
    // Registered before the navigation starts, so a page that loads instantly is not missed.
    const nextLoad = (ms = 5000) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); cdp.on((m) => { if (m.method === "Page.loadEventFired" && (!m.sessionId || m.sessionId === targetSession)) { clearTimeout(timer); resolve(); } }); });
    const shortName = (u) => { try { const x = new URL(u); return x.protocol === "file:" ? decodeURIComponent(x.pathname.split("/").pop() || x.pathname) : x.pathname === "/" ? x.origin : x.pathname.split("/").pop() || x.origin; } catch { return String(u).slice(0, 80); } };
    cdp.on((m) => {
      if (m.sessionId && targetSession && m.sessionId !== targetSession) return;
      if (m.method === "Page.loadEventFired") loaded();
      if (m.method === "Page.javascriptDialogOpening") {
        dialogs.push(String(m.params.message ?? "").slice(0, 160));
        s("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      }
      if (m.method === "Network.requestWillBeSent" && !/^(?:data|about|blob|chrome-extension):/i.test(m.params.request.url) && !/favicon/i.test(m.params.request.url)) requests.set(m.params.requestId, { name: shortName(m.params.request.url), type: m.params.type ?? "", state: "pending" });
      if (m.method === "Network.loadingFinished" && requests.has(m.params.requestId)) requests.get(m.params.requestId).state = "loaded";
      if (m.method === "Network.responseReceived" && requests.has(m.params.requestId) && m.params.response.status >= 400) requests.get(m.params.requestId).state = "failed";
      if (m.method === "Network.loadingFailed" && requests.has(m.params.requestId)) requests.get(m.params.requestId).state = "failed";
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        note(en ? `A program error when opening the page: ${String(d.exception?.description ?? d.text ?? "error").split("\n")[0].slice(0, 200)}` : `Un error de programa al abrir la página: ${String(d.exception?.description ?? d.text ?? "error").split("\n")[0].slice(0, 200)}`);
      }
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") note(en ? `The page showed an error: ${m.params.args?.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200)}` : `La página mostró un error: ${m.params.args?.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200)}`);
      if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/favicon/i.test(m.params.entry.url ?? m.params.entry.text)) note(en ? `A resource could not be loaded: ${(m.params.entry.url ?? m.params.entry.text).slice(0, 200)}` : `No se pudo cargar un recurso: ${(m.params.entry.url ?? m.params.entry.text).slice(0, 200)}`);
    });
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    targetSession = attached.sessionId;
    await Promise.all([s("Page.enable"), s("Runtime.enable"), s("Log.enable"), s("Network.enable")]);
    await s("Page.navigate", { url });
    await Promise.race([loadedPromise, wait(Math.max(1000, deadline - Date.now()))]);
    await wait(settleMs);
    const evaluate = async (expression) => (await s("Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression })).result?.value;
    const page = JSON.parse(await evaluate(`JSON.stringify({ title: document.title, text: (document.body?.innerText || "").trim().length, controls: document.querySelectorAll("input, button, select, textarea, a[href]").length, children: document.body?.children.length || 0 })`) ?? "{}");
    if (!page.children && !page.text) note(en ? "The page opens blank." : "La página se abre en blanco.");
    const resources = { total: requests.size, loaded: [...requests.values()].filter((x) => x.state === "loaded").length, failed: [...requests.values()].filter((x) => x.state === "failed").map((x) => x.name), files: [...new Set([...requests.values()].map((x) => x.name))].slice(0, 30) };
    for (const name of resources.failed.slice(0, 4)) note(en ? `A file did not load: ${name}` : `Un archivo no cargó: ${name}`);

    // ---- What a person would do ----
    const results = [];
    const scenarioDeadline = Date.now() + 30000;
    for (const scenario of scenarios.slice(0, 12)) {
      // Each scenario starts like a first visit: no saved data from the previous one.
      await evaluate(`try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} 0`);
      const fresh = nextLoad();
      await s("Page.navigate", { url });
      await fresh;
      await wait(250);
      const outcome = { name: scenario.name, ok: true, steps: scenario.steps.length, failed: null };
      for (const [index, step] of scenario.steps.entries()) {
        if (Date.now() > scenarioDeadline) { outcome.ok = false; outcome.failed = { index, step: describeStep(step), message: en ? "Time ran out before this step." : "Se acabó el tiempo antes de este paso." }; break; }
        if ("wait" in step) { await wait(Math.min(Math.max(Number(step.wait) || 0, 0), 1000)); continue; }
        if ("reload" in step) {
          const again = nextLoad();
          await s("Page.reload");
          await again;
          await wait(250);
          continue;
        }
        let result;
        try { result = await evaluate(stepExpression(step)); } catch (error) { result = { ok: false, message: "error", seen: String(error.message).slice(0, 100) }; }
        if (!result?.ok) { outcome.ok = false; outcome.failed = { index, step: describeStep(step), message: stepMessage(step, result ?? {}, en) }; break; }
        await wait(step.click !== undefined || step.fill !== undefined || step.select !== undefined ? 120 : 20);
      }
      results.push(outcome);
    }
    // A scenario that fails is a failed behaviour, not a page that does not open: kept apart from the start problems.
    const scenarioProblems = results.filter((x) => !x.ok).map((failed) => en ? `In the scenario «${failed.name}», step ${failed.failed.index + 1}: ${failed.failed.message}` : `En el escenario «${failed.name}», paso ${failed.failed.index + 1}: ${failed.failed.message}`);
    const storageKeys = JSON.parse(await evaluate(`JSON.stringify((() => { try { return Object.keys(localStorage); } catch (e) { return []; } })())`) ?? "[]");
    return { ok: problems.length === 0, title: page.title ?? "", textLength: page.text ?? 0, controls: page.controls ?? 0, resources, storageKeys, scenarios: results, scenarioProblems, dialogs: dialogs.slice(0, 5), problems, browser: path.basename(executable) };
  } catch (error) {
    const reason = /^browser-(?:unreachable|closed)$/.test(error.message) ? (en ? "the browser stopped answering" : "el navegador dejó de responder") : String(error.message).slice(0, 120);
    return { ok: null, skipped: en ? `The app could not be checked in the browser (${reason}).` : `No se pudo comprobar en el navegador (${reason}).` };
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

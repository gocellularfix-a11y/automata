// Delivery (P4): what makes an app something a person can open without knowing commands. For a local web app that
// is a launcher they double-click (Abrir.cmd), a guide in plain words (COMO_USAR.md) and proof that it really starts.
// Automata does not build these: Claude does, as tasks of the plan the person approved. This file defines the
// criteria, and checks the result without trusting anyone's report. Nothing here publishes, installs or deletes.
import fs from "node:fs";
import path from "node:path";
import { platformKind, VERIFIED_TARGETS } from "./environment.mjs";
import { checkInBrowser } from "./browsercheck.mjs";
import { AppRunner } from "./apprun.mjs";

export const LAUNCHER = "Abrir.cmd";
export const GUIDE = "COMO_USAR.md";
export const MAX_DELIVERY_ATTEMPTS = 3;
const clip = (text, max) => { const value = String(text ?? "").replace(/\s+/g, " ").trim(); return value.length > max ? value.slice(0, max - 1) + "…" : value; };
const readText = (file, max = 200000) => { try { return fs.readFileSync(file, "utf8").slice(0, max); } catch { return null; } };
// A file in the folder, whatever its capitalisation (Windows does not care, a test on another system might).
const findFile = (directory, name) => { try { return fs.readdirSync(directory).find((f) => f.toLowerCase() === name.toLowerCase()) ?? null; } catch { return null; } };

// ---- What the proposal promises ----
// The sections the guide must have, in the words a person looks for (Spanish or English headings are accepted).
export const GUIDE_SECTIONS = [
  { key: "install", es: "Instalar", en: "Install", test: /instal|install|requisit|necesit/i },
  { key: "open", es: "Abrir", en: "Open", test: /abrir|open|iniciar|arrancar|start/i },
  { key: "use", es: "Usar", en: "Use", test: /\busar\b|\buso\b|c[oó]mo se usa|\buse\b|using/i },
  { key: "backup", es: "Respaldar tus datos", en: "Back up your data", test: /respald|copia de seguridad|back ?up|guardar tus datos|save your data/i },
  { key: "works", es: "Qué funciona", en: "What works", test: /qu[eé] funciona|what works|funciones/i },
  { key: "pending", es: "Qué queda pendiente", en: "What is still pending", test: /pendiente|qu[eé] falta|todav[ií]a no|not yet|pending|limitaci/i }
];
export function deliveryCriteria(language = "es") {
  const en = language === "en";
  const names = GUIDE_SECTIONS.map((s) => en ? s.en : s.es).join(", ");
  return {
    launcher: en
      ? `The project folder has ${LAUNCHER}: double-clicking it opens the app in the browser without typing any command, and the start was checked.`
      : `La carpeta del proyecto incluye ${LAUNCHER}: con doble clic abre la aplicación en el navegador sin escribir ningún comando, y se comprobó que arranca.`,
    guide: en
      ? `The project folder has ${GUIDE}, written for someone who does not program, with the sections: ${names}.`
      : `La carpeta del proyecto incluye ${GUIDE}, escrito para alguien que no programa, con las secciones: ${names}.`
  };
}
// Detailed instructions for the two plan tasks: what Claude must leave, so that the checks below can pass.
function deliveryTasks(language) {
  const en = language === "en";
  return {
    launcher: en
      ? `Create ${LAUNCHER} in the project root. A static page (index.html, no server): the file contains only '@echo off' and 'start "" "%~dp0index.html"'. If the app needs a local server (Node): it starts it minimised, waits until it answers and opens http://localhost:PORT with 'start'; it works from any folder (%~dp0), says in plain words if Node is missing, and never installs or downloads anything. No absolute paths on this PC. Pages opened by double-click use file://, so use relative paths and plain scripts (no type="module", no fetch of local files) unless the app runs on a local server.`
      : `Crea ${LAUNCHER} en la raíz del proyecto. Página estática (index.html, sin servidor): el archivo solo contiene '@echo off' y 'start "" "%~dp0index.html"'. Si la app necesita un servidor local (Node): lo arranca minimizado, espera a que responda y abre http://localhost:PUERTO con 'start'; funciona desde cualquier carpeta (%~dp0), dice con palabras sencillas si falta Node y nunca instala ni descarga nada. Sin rutas absolutas de esta PC. Una página que se abre con doble clic usa file://, así que usa rutas relativas y scripts clásicos (sin type="module" ni fetch de archivos locales) salvo que la app corra en un servidor local.`,
    guide: en
      ? `Write ${GUIDE} for someone who does not program. One heading per section, exactly: ${GUIDE_SECTIONS.map((s) => "'" + s.en + "'").join(", ")}. "Open" must say to double-click ${LAUNCHER} and must not ask to type commands. "Back up your data" explains where the app keeps its data (or says it keeps none) and how to copy it. "What works" and "What is still pending" must be honest: list real limits; do not claim commercial quality.`
      : `Escribe ${GUIDE} para alguien que no programa. Un encabezado por sección, exactamente: ${GUIDE_SECTIONS.map((s) => "'" + s.es + "'").join(", ")}. «Abrir» debe decir que se hace doble clic en ${LAUNCHER} y no pedir escribir comandos. «Respaldar tus datos» explica dónde guarda sus datos la app (o dice que no guarda) y cómo copiarlos. «Qué funciona» y «Qué queda pendiente» deben ser honestos: enumera los límites reales y no afirmes calidad comercial.`
  };
}
// Adds the delivery criteria and their tasks to a validated proposal for a web app. Idempotent. The director is told
// not to write them itself (prompts.mjs), so each criterion gets exactly one task, quoted in full.
export function addDeliveryCriteria(draft, language = "es") {
  if (platformKind(draft.platform) !== "web" || !VERIFIED_TARGETS.includes("web")) return draft;
  const criteria = deliveryCriteria(language), tasks = deliveryTasks(language), en = language === "en";
  if (draft.criteria.includes(criteria.launcher)) return draft;
  const before = draft.plan.length;
  draft.criteria.push(criteria.launcher, criteria.guide);
  draft.plan.push(
    { title: en ? `Create ${LAUNCHER} to open the app` : `Crear ${LAUNCHER} para abrir la aplicación`, detail: tasks.launcher, criterion: criteria.launcher, dependsOn: before ? [`N${before}`] : [] },
    { title: en ? `Write the guide ${GUIDE}` : `Escribir la guía ${GUIDE}`, detail: tasks.guide, criterion: criteria.guide, dependsOn: [`N${before + 1}`] }
  );
  draft.delivery = { kind: "web", added: 2 };
  return draft;
}
// What the person is told about their platform before approving: honest about what Automata delivers today.
export function deliveryPlan(platformText, env, language = "es") {
  const en = language === "en";
  const kind = platformKind(platformText);
  const verified = VERIFIED_TARGETS.includes(kind);
  const target = env?.targets?.[kind];
  const missing = verified ? [] : target?.missing ?? [];
  const note = kind === "web"
    ? (en ? "When it is ready you will get a button to open it, a folder with a double-click launcher and a simple guide." : "Al terminar tendrás un botón para abrirla, una carpeta con un lanzador de doble clic y una guía sencilla.")
    : kind === "console"
      ? (en ? "Automata builds it and shows how to run it, but it does not check its delivery yet." : "Automata la construye y te dice cómo correrla, pero todavía no comprueba su entrega.")
      : kind === "android"
        ? (en ? "Automata does not build or check an installable APK yet. It can build the app's code, but you would have to ask for the APK separately." : "Automata todavía no genera ni comprueba un APK instalable. Puede construir el código de la app, pero tendrías que pedir el APK aparte.")
        : (en ? "Automata does not build or check a Windows installer yet. It can build the app's code, but you would have to ask for the installer separately." : "Automata todavía no genera ni comprueba un instalador de Windows. Puede construir el código de la app, pero tendrías que pedir el instalador aparte.");
  return { kind, verified, toolsReady: verified ? true : !!target?.ready, missing, note };
}

// ---- The guide ----
export function parseGuide(text) {
  const sections = [];
  let current = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const heading = /^#{1,4}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { current = { title: heading[1].replace(/[*_`]/g, "").trim(), body: [] }; sections.push(current); } else if (current) current.body.push(line);
  }
  return sections.map((s) => ({ title: s.title, body: s.body.join("\n").trim() }));
}
const TECHNICAL = /\b(?:npm|npx|node(?:\.js)?\s+\S+\.m?js|powershell|cmd\.exe|git\s+\w+|pip|python\s+\S+)\b/i;
export function checkGuide(text, language = "es") {
  const problems = [];
  if (text == null) return { ok: false, found: [], problems: [`Falta ${GUIDE} en la carpeta del proyecto.`] };
  const sections = parseGuide(text), en = language === "en", found = [];
  for (const wanted of GUIDE_SECTIONS) {
    const section = sections.find((s) => wanted.test.test(s.title));
    const name = en ? wanted.en : wanted.es;
    if (!section) { problems.push(`En ${GUIDE} falta la sección «${name}».`); continue; }
    if (section.body.replace(/\s+/g, "").length < 20) { problems.push(`En ${GUIDE} la sección «${section.title}» está vacía o es demasiado corta.`); continue; }
    found.push({ key: wanted.key, title: section.title });
    if (wanted.key === "open") {
      if (!new RegExp(LAUNCHER.replace(".", "\\."), "i").test(section.body)) problems.push(`En ${GUIDE} la sección «${section.title}» debe decir que se abre con doble clic en ${LAUNCHER}.`);
      if (TECHNICAL.test(section.body)) problems.push(`En ${GUIDE} la sección «${section.title}» pide escribir comandos; para una persona sin conocimientos técnicos debe bastar un doble clic en ${LAUNCHER}.`);
    }
  }
  return { ok: problems.length === 0, found, problems };
}

// ---- The launcher ----
// Commands that change the PC or download things have no place in something a person double-clicks.
const FORBIDDEN = [[/\bnpm\s+(?:install|i|ci)\b|\byarn\s+(?:add|install)\b|\bpip\s+install\b/i, "instala paquetes"], [/\bwinget\b|\bchoco\b|\bscoop\b|\bmsiexec\b/i, "instala programas"], [/\bcurl\b|invoke-webrequest|\biwr\b|bitsadmin|\bwget\b/i, "descarga archivos"], [/\breg\s+(?:add|delete)\b|\bschtasks\b|\bsc\s+create\b|\bnetsh\b/i, "cambia la configuración de Windows"], [/\brmdir\s+\/s\b|\bdel\s+\/[sq]\b|\bformat\s+[a-z]:|\brd\s+\/s\b/i, "borra archivos"]];
const ABSOLUTE_PATH = /(?<![%\w])[a-z]:\\(?!\\)/i;
export function parseLauncher(text) {
  const problems = [];
  if (text == null) return { ok: false, problems: [`Falta ${LAUNCHER} en la carpeta del proyecto.`] };
  if (text.replace(/\s+/g, "").length < 10) return { ok: false, problems: [`${LAUNCHER} está vacío.`] };
  for (const [pattern, what] of FORBIDDEN) if (pattern.test(text)) problems.push(`${LAUNCHER} ${what}; un lanzador de doble clic no debe hacerlo.`);
  if (ABSOLUTE_PATH.test(text)) problems.push(`${LAUNCHER} usa una ruta absoluta de esta PC (como C:\\…); usa %~dp0 para que funcione desde cualquier carpeta.`);
  const file = /\bstart\s+(?:\/\w+\s+)*""?\s*"?%~dp0([^"\r\n&|<>]+?\.html?)"?\s*(?:$|[\r\n&|])/im.exec(text);
  const url = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})(?:\/[^\s"'&|<>)]*)?/i.exec(text);
  if (file && !/^(?:https?:)/i.test(file[1])) return { ok: problems.length === 0, mode: "static", target: file[1].replace(/\\/g, "/"), problems };
  if (url) {
    // The command the launcher starts, made runnable from the project folder (%~dp0 is that folder).
    const script = /\bnode\s+"?(?:%~dp0)?([^\s"&|<>]+\.[cm]?js)"?/i.exec(text);
    return { ok: problems.length === 0, mode: "server", url: url[0], port: Number(url[1]), command: script ? `node ${script[1].replace(/\\/g, "/")}` : /\bnpm\s+(?:run\s+)?start\b/i.exec(text)?.[0] ?? null, problems };
  }
  problems.push(`${LAUNCHER} no abre nada reconocible: para una página usa  start "" "%~dp0index.html"  y para una app con servidor, abre http://localhost:PUERTO.`);
  return { ok: false, mode: null, problems };
}

// Files a page loads: the local ones must exist; remote ones are a limit, not a failure (the app needs the Internet).
export function pageReferences(html) {
  const local = [], remote = [];
  const re = /<(?:script|link|img|source|audio|video|iframe)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (let m; (m = re.exec(html));) {
    const ref = m[1].trim();
    if (!ref || ref.startsWith("#") || /^(?:data:|mailto:|tel:|javascript:|about:|blob:)/i.test(ref)) continue;
    const isRemote = /^(?:https?:)?\/\//i.test(ref);
    // A stylesheet link to an icon or a canonical URL is not a load the page depends on.
    if (isRemote) { if (/<script\b/i.test(m[0]) || /rel\s*=\s*["']?stylesheet/i.test(m[0])) remote.push(ref); continue; }
    local.push({ ref: ref.split(/[?#]/)[0], module: /type\s*=\s*["']module["']/i.test(m[0]), script: /^<script\b/i.test(m[0]) });
  }
  return { local, remote };
}

// ---- The check ----
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function answers(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(2500) });
    const body = await response.text();
    return { ok: response.status === 200 && body.trim().length > 0, status: response.status };
  } catch { return { ok: false, status: 0 }; }
}
// directory: the project folder. runCommand: what the director said starts the app (optional).
// env: detectEnvironment() result (for the browser). Returns the whole picture; ok means a person can open it.
export async function verifyDelivery({ directory, runCommand = "", env = null, language = "es", appFactory = () => new AppRunner(), fetchImpl = fetch, bootTimeoutMs = 20000, browser = checkInBrowser } = {}) {
  const steps = [], problems = [], notes = [];
  const step = (name, ok, detail = "") => steps.push({ name, ok, detail });
  const result = { kind: "web", mode: null, ok: false, steps, problems, notes, launcher: LAUNCHER, guide: GUIDE, open: null, browser: null, checkedAt: new Date().toISOString() };

  const launcherName = findFile(directory, LAUNCHER);
  const launcher = parseLauncher(launcherName ? readText(path.join(directory, launcherName), 20000) : null);
  step("launcher", launcher.ok, launcher.ok ? LAUNCHER : launcher.problems[0] ?? "");
  problems.push(...launcher.problems);
  const guideName = findFile(directory, GUIDE);
  const guide = checkGuide(guideName ? readText(path.join(directory, guideName), 100000) : null, language);
  step("guide", guide.ok, guide.ok ? `${guide.found.length} secciones` : guide.problems[0]);
  problems.push(...guide.problems);
  result.guideSections = guide.found.map((s) => s.title);
  if (!launcher.mode) return finish(result);
  result.mode = launcher.mode;
  const browserPath = env?.tools?.browser?.found ? env.tools.browser.path : null;
  const inBrowser = async (url) => {
    const seen = await browser(url, { executable: browserPath });
    result.browser = seen.ok === null ? { ran: false, note: seen.skipped } : { ran: true, name: seen.browser, title: seen.title, controls: seen.controls };
    if (seen.ok === null) { notes.push(`${seen.skipped} Se revisaron los archivos, pero no se vio abierta en pantalla.`); step("browser", true, "no disponible"); return; }
    step("browser", seen.ok, seen.ok ? seen.title || "abre sin errores" : seen.problems[0]);
    problems.push(...(seen.problems ?? []).map((p) => `Al abrir la aplicación en el navegador: ${p}`));
  };

  if (launcher.mode === "static") {
    const html = path.resolve(directory, launcher.target), root = path.resolve(directory);
    if (!html.toLowerCase().startsWith(root.toLowerCase() + path.sep)) problems.push(`${LAUNCHER} apunta fuera de la carpeta del proyecto.`);
    else if (!fs.existsSync(html)) problems.push(`${LAUNCHER} abre ${launcher.target}, pero ese archivo no existe.`);
    else {
      const page = readText(html);
      step("page", true, launcher.target);
      const refs = pageReferences(page);
      const missing = refs.local.filter((r) => !fs.existsSync(path.resolve(path.dirname(html), r.ref.replace(/^\/+/, ""))) || r.ref.startsWith("/"));
      for (const r of refs.local.filter((x) => x.ref.startsWith("/"))) problems.push(`${launcher.target} carga «${r.ref}» con una ruta que empieza con «/»; al abrir el archivo con doble clic no se encuentra. Usa rutas relativas (por ejemplo «${r.ref.replace(/^\/+/, "")}»).`);
      for (const r of missing.filter((x) => !x.ref.startsWith("/"))) problems.push(`${launcher.target} carga «${r.ref}», pero ese archivo no existe.`);
      // Opened by double-click, a page without a declared encoding shows accents as broken characters.
      const texts = [page, ...refs.local.filter((x) => /\.(?:js|css)$/i.test(x.ref) && !x.ref.startsWith("/")).map((x) => readText(path.resolve(path.dirname(html), x.ref), 300000) ?? "")];
      if (texts.some((x) => /[^\x00-\x7F]/.test(x)) && !/<meta[^>]+charset\s*=\s*["']?utf-?8/i.test(page.slice(0, 4096))) problems.push(`${launcher.target} tiene acentos o caracteres especiales pero no declara la codificación; en el navegador se verían rotos. Agrega <meta charset="utf-8"> dentro de <head>.`);
      for (const r of refs.local.filter((x) => x.module)) notes.push(`«${r.ref}» es un módulo; al abrir con doble clic algunos navegadores lo bloquean.`);
      step("files", missing.length === 0, missing.length ? `faltan ${missing.length}` : `${refs.local.length} archivos enlazados`);
      if (refs.remote.length) notes.push(`La página usa recursos de Internet (${clip(refs.remote.slice(0, 2).join(", "), 120)}); sin conexión puede verse incompleta.`);
      result.open = { type: "file", target: launcher.target, path: html };
      if (!missing.length) await inBrowser(new URL(`file:///${html.replace(/\\/g, "/")}`).href);
    }
    return finish(result);
  }

  // A page served by a local server: really start it and ask for the page the way the launcher does.
  const command = runCommand || launcher.command || (() => { try { return JSON.parse(readText(path.join(directory, "package.json")) ?? "{}").scripts?.start ? "npm start" : ""; } catch { return ""; } })();
  if (!command) { problems.push(`No encuentro cómo se arranca el servidor de la aplicación: define "scripts.start" en package.json o indica el comando que usa ${LAUNCHER}.`); return finish(result); }
  result.open = { type: "url", target: launcher.url, command };
  if ((await answers(launcher.url, fetchImpl)).ok) {
    notes.push(`El puerto ${launcher.port} ya estaba en uso en esta PC; no se pudo comprobar el arranque desde cero.`);
    step("start", true, "puerto ocupado");
    return finish(result);
  }
  const runner = appFactory();
  try {
    runner.start({ directory, command });
    let up = false;
    const limit = Date.now() + bootTimeoutMs;
    while (Date.now() < limit && !up) {
      if (runner.state?.status !== "running") break;
      up = (await answers(launcher.url, fetchImpl)).ok;
      if (!up) await wait(300);
    }
    const output = clip(runner.state?.output ?? "", 240);
    if (!up) {
      const other = runner.state?.url && runner.state.url !== launcher.url && (await answers(runner.state.url, fetchImpl)).ok;
      problems.push(other
        ? `${LAUNCHER} abre ${launcher.url}, pero la aplicación está escuchando en ${runner.state.url}. Haz que coincidan.`
        : runner.state?.status !== "running"
          ? `El servidor de la aplicación se cerró al arrancar (${command}). ${output ? "Dijo: " + output : ""}`
          : `El servidor de la aplicación no respondió en ${launcher.url} tras ${Math.round(bootTimeoutMs / 1000)} segundos (${command}). ${output ? "Dijo: " + output : ""}`);
      step("start", false, command);
    } else {
      step("start", true, launcher.url);
      await inBrowser(launcher.url);
    }
  } catch (error) {
    problems.push(`No se pudo arrancar la aplicación (${command}): ${clip(error.message, 160)}`);
    step("start", false, command);
  } finally {
    await runner.stop().catch(() => {});
  }
  return finish(result);
}
function finish(result) {
  result.ok = result.problems.length === 0;
  return result;
}
// What Claude receives to fix: plain, specific, and without touching anything else.
export function deliveryFixPrompt(problems, language = "es") {
  const list = problems.slice(0, 10).map((p) => "- " + p).join("\n");
  return language === "en"
    ? `The app is not ready to be handed to a person yet. Automata checked the delivery and found:\n${list}\nFix only this (the launcher ${LAUNCHER} and the guide ${GUIDE} are part of the product), do not change the acceptance criteria, and report what you did.`
    : `La aplicación todavía no está lista para entregarse a una persona. Automata comprobó la entrega y encontró:\n${list}\nCorrige solo esto (el lanzador ${LAUNCHER} y la guía ${GUIDE} forman parte del producto), no cambies los criterios de aceptación e informa qué hiciste.`;
}

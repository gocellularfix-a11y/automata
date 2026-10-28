// P4: the delivery gate in the real cycle. Simulated agents write real files into the project folder; Automata's own
// checks (delivery.mjs) read them. A launcher, a guide and a start are required before «Tu aplicación está lista».
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { validateProject } from "../server/config.mjs";
import { Store } from "../server/store.mjs";
import { Coordinator } from "../server/coordinator.mjs";
import { LAUNCHER, GUIDE, deliveryCriteria, verifyDelivery } from "../server/delivery.mjs";

const dirs = [];
const fixture = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "automata-dflow-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) if (path.resolve(d).startsWith(path.join(os.tmpdir(), "automata-dflow-"))) fs.rmSync(d, { recursive: true, force: true }); });
const settled = async (c) => { await c.pending; await c.proposalPending; while (c.busy) await new Promise((r) => setTimeout(r, 5)); };
const until = async (condition, ms = 8000) => { const limit = Date.now() + ms; while (!condition() && Date.now() < limit) await new Promise((r) => setTimeout(r, 10)); };

// A PC without a browser: the start check looks at files and skips the screen, which the unit tests cover with Chrome.
const ENV = { system: { name: "Windows 11" }, tools: { node: { version: "24.0.0" }, npm: { found: true }, git: { found: true }, powershell: { found: true }, browser: { found: false } }, targets: { web: { ready: true, missing: [], notes: [] }, windows: { ready: false, missing: ["Una herramienta para crear el instalador."] }, android: { ready: false, missing: ["Java (JDK 17 o 21)."] } } };
// The same PC with Chrome: the browser itself is replaced by the one the test hands over (the real one is covered in delivery.test.mjs).
const ENV_BROWSER = { ...ENV, tools: { ...ENV.tools, browser: { found: true, name: "Chrome", path: "C:/chrome.exe" } } };
const GUIDE_TEXT = `# Propinas
## Instalar
No hay nada que instalar: solo un navegador como Chrome o Edge.
## Abrir
Haz doble clic en Abrir.cmd, que está en esta carpeta, y se abre la calculadora.
## Usar
Escribe el total de la cuenta y cuántas personas son; te dice cuánto paga cada una.
## Respaldar tus datos
No guarda datos: no hay nada que respaldar. Si cambias la carpeta de lugar, cópiala completa.
## Qué funciona
Calcula la propina y avisa si el dato no es válido.
## Qué queda pendiente
No guarda un historial ni tiene versión para teléfono.
`;
const writeApp = (dir) => { fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><title>Propinas</title></head><body><input id="total"><script src="app.js"></script></body></html>'); fs.writeFileSync(path.join(dir, "app.js"), "document.getElementById('total');"); };
const writeDelivery = (dir) => { fs.writeFileSync(path.join(dir, LAUNCHER), '@echo off\r\nstart "" "%~dp0index.html"\r\n'); fs.writeFileSync(path.join(dir, GUIDE), GUIDE_TEXT); };

const BASE = ["Calcula la propina y el total por persona.", "Avisa si el importe no es un número válido.", "Divide entre el número de personas."];
const proposal = (platform = "página web local en el navegador") => ({
  name: "Propinas", summary: "Una calculadora de propinas.", objective: "Una calculadora web para repartir la cuenta con propina entre varias personas.", features: ["Calcular la propina"],
  criteria: BASE, checks: ["node --test"], platform,
  plan: [{ title: "Preparar", detail: "", criterion: "", dependsOn: [] }, { title: "Calcular", detail: "", criterion: BASE[0], dependsOn: ["N1"] }, { title: "Validar", detail: "", criterion: BASE[1], dependsOn: ["N2"] }, { title: "Dividir", detail: "", criterion: BASE[2], dependsOn: ["N2"] }],
  risks: ["No guarda un historial de cuentas."], questions: []
});
const reviewOf = (project, decision, tasks = 0, extra = {}) => ({ decision, summary: `Revisión ${decision}.`, nextPrompt: decision === "continue" ? "Haz la tarea." : "", task: "", files: [], findings: [], criteria: project.criteria.map((criterion) => ({ criterion, met: decision === "complete", evidence: decision === "complete" ? "visto en el código" : "" })), git: { commit: false, message: "", push: false, branch: "", merge_into: "" }, run: { ready: false, command: "", url: "", note: "" }, memory: { add: [], retire: [] }, plan: { add: [], update: Array.from({ length: tasks }, (_, i) => ({ id: i + 1, status: "done", evidence: "ok", note: "" })) }, ...extra });
const creator = (root) => async (input) => { const directory = path.join(root, "propinas"); fs.mkdirSync(directory, { recursive: true }); return validateProject({ ...input, directory, source: "local" }); };
const passing = async (p) => p.checks.map((command) => ({ command, passed: true, code: 0, output: "ok" }));

// coderWrites(dir, n): what Claude leaves in the folder on its n-th call. reviews: the director's prompts, for the evidence.
function setup(t, { platform, coderWrites, tasks = platform && !/web/i.test(platform) ? 4 : 6, seedPlan = false, director = null, browser = null, language = null } = {}) {
  const dir = fixture(), calls = { coder: [], auditor: [] }, opened = [];
  let reviews = 0;
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: passing, resumeDelayMs: 0, detect: async () => browser ? ENV_BROWSER : ENV, ...browser ? { verify: (o) => verifyDelivery({ ...o, browser }) } : {}, opener: (target) => opened.push(target), resources: null, agents: { async run(a) {
    calls[a.role]?.push({ phase: a.phase, prompt: a.prompt });
    if (a.phase === "define") return { proposal: proposal(platform) };
    if (a.role === "coder") { coderWrites?.(a.project.directory, calls.coder.length); return { text: "Hecho" }; }
    // A project with no plan yet (it did not come from an idea) gets one from the director, a task per criterion.
    const added = seedPlan ? { plan: { add: a.project.criteria.map((criterion) => ({ title: "Cumplir: " + criterion.slice(0, 40), detail: "", criterion, dependsOn: [] })), update: [] } } : {};
    // A test can script the director's answer to the n-th review; returning nothing leaves the usual one.
    const scripted = a.phase === "review" ? director?.(a, ++reviews) : null;
    if (scripted) return { review: scripted };
    return { review: a.phase === "plan" ? reviewOf(a.project, "continue", 0, { task: seedPlan ? "N1" : "T1", ...added }) : reviewOf(a.project, "complete", tasks) };
  } } });
  c.updateSettings({ ...c.settings, projectsRoot: path.join(dir, "projects"), gitMode: "off", maxRounds: 8, ...language ? { language } : {} });
  t.after(async () => { await c.close(); });
  return { c, dir, calls, opened };
}
async function create(c, dir) {
  c.propose({ idea: "Quiero una calculadora de propinas para repartir la cuenta entre mis amigos" });
  await settled(c);
  const ready = c.proposals[0];
  const accepted = await c.acceptProposal(ready.id, creator(path.join(dir, "projects")));
  return { ready, project: accepted.project };
}

test("a una propuesta web Automata le añade el lanzador y la guía, y avisa en palabras sencillas qué recibirá la persona", async (t) => {
  const { c, calls } = setup(t);
  c.propose({ idea: "Quiero una calculadora de propinas para repartir la cuenta entre mis amigos" });
  await settled(c);
  const p = c.proposals[0];
  assert.equal(p.status, "ready", p.error);
  const { launcher, guide } = deliveryCriteria();
  assert.deepEqual(p.draft.criteria, [...BASE, launcher, guide], "los criterios de entrega van al final de la lista que la persona aprueba");
  assert.equal(p.draft.plan.length, 6);
  assert.deepEqual([p.draft.plan[4].criterion, p.draft.plan[5].criterion], [launcher, guide]);
  assert.deepEqual([p.delivery.kind, p.delivery.verified, p.delivery.toolsReady], ["web", true, true]);
  assert.match(p.delivery.note, /botón para abrirla/);
  assert.equal(c.snapshot().proposals[0].delivery.kind, "web", "la interfaz recibe el aviso");
  assert.match(calls.auditor[0].prompt, /ENTORNO DISPONIBLE EN ESTA PC: Windows 11, Node\.js 24\.0\.0.*Automata construye y verifica la entrega de: página web local/);
  assert.match(calls.auditor[0].prompt, /Todavía NO entrega automáticamente, aunque existan las herramientas: instalador de Windows \(faltan herramientas\), APK de Android \(faltan herramientas\)/);
  assert.match(calls.auditor[0].prompt, /Para una página web local NO escribas criterios sobre cómo se abre/);
  assert.match(calls.auditor[0].prompt, /entradas inválidas/);
});

test("el director aprueba sin lanzador ni guía: la entrega vuelve al ciclo con el problema exacto, y al corregirla queda lista", async (t) => {
  const { c, dir, calls, opened } = setup(t, { coderWrites: (folder, n) => { writeApp(folder); if (n >= 2) writeDelivery(folder); } });
  const { project } = await create(c, dir);
  await settled(c);
  const r = c.active;
  assert.equal(r.status, "complete", r.error);
  assert.equal(calls.coder.length, 2, "Claude trabajó una vez de más, solo por la entrega");
  assert.match(calls.coder[1].prompt, /todavía no está lista para entregarse a una persona[\s\S]*- Falta Abrir\.cmd en la carpeta del proyecto\.[\s\S]*- Falta COMO_USAR\.md/);
  // The director is told, in the evidence, that the delivery is open — it cannot approve past it unnoticed.
  const reviews = calls.auditor.filter((x) => x.phase === "review");
  assert.equal(reviews.length, 2);
  assert.doesNotMatch(reviews[0].prompt, /ENTREGA \(la comprobó/, "sin lanzador ni guía todavía no hay nada que comprobar");
  // Round 2: both files exist, so Automata checks them before the director decides, and tells it that it cannot double-click.
  assert.match(reviews[1].prompt, /ENTREGA \(la comprobó Automata en la ronda 2: el lanzador Abrir\.cmd y el arranque real y la guía COMO_USAR\.md\): correcta[\s\S]*no pidas que una persona lo haga ni marques blocked por eso/);
  assert.equal(r.deliveryChecks.length, 2);
  assert.deepEqual(r.deliveryChecks.map((x) => x.ok), [false, true]);
  assert.equal(r.deliveryAttempts, 0);
  assert.equal(r.deliveryProblems, undefined);
  const d = r.delivery;
  assert.equal(d.status, "ready");
  assert.equal(d.folder, project.directory);
  assert.deepEqual([d.launcher, d.guide, d.mode], [LAUNCHER, GUIDE, "static"]);
  assert.deepEqual(d.open, { type: "file", target: "index.html" });
  assert.equal(d.works.length, 5, "lo que funciona sale de los criterios con su evidencia");
  assert.equal(d.works[0].evidence, "visto en el código");
  assert.ok(d.pending.includes("No guarda un historial de cuentas."), "lo pendiente incluye lo que la persona aceptó al aprobar");
  assert.ok(d.pending.some((x) => /no garantizan calidad comercial/.test(x)));
  assert.deepEqual(d.steps.map((s) => s.name), ["launcher", "guide", "page", "files", "browser"]);
  assert.equal(d.browser.ran, false, "sin navegador se dice, no se finge");
  assert.equal(d.guideSections.length, 6);
  const texts = c.events.map((e) => e.text);
  assert.ok(texts.some((x) => /La aplicación todavía no está lista para entregarse \(intento 1 de 3\)\. Falta Abrir\.cmd/.test(x)));
  assert.ok(texts.some((x) => /Tu aplicación está lista\. Se guardó en .*propinas\. Ábrela con el botón «Abrir aplicación»; la guía COMO_USAR\.md explica cómo usarla\./.test(x)));
  assert.equal((r.runOffers ?? []).filter((o) => o.final).length, 0, "no se vuelve a preguntar «¿Correr la app?»: el botón de la entrega ya lo hace");
  assert.ok(c.memory.listFacts(project.id).some((f) => /Entrega comprobada en la ronda 2: se abre con Abrir\.cmd \(página index\.html\)/.test(f.text)));
  assert.equal(c.snapshot().runs[0].delivery.status, "ready");
  // The buttons: the guide is readable from anywhere; opening belongs to this PC only.
  const guide = await c.deliveryAction(r.id, "guide");
  assert.equal(guide.name, GUIDE);
  assert.match(guide.text, /## Respaldar tus datos/);
  await assert.rejects(c.deliveryAction(r.id, "open"), /donde está Automata/);
  await assert.rejects(c.deliveryAction(r.id, "folder", { local: false }), /donde está Automata/);
  assert.deepEqual(await c.deliveryAction(r.id, "open", { local: true }), { opened: "file" });
  assert.deepEqual(await c.deliveryAction(r.id, "folder", { local: true }), { opened: "folder", folder: project.directory });
  assert.deepEqual(opened, [path.join(project.directory, "index.html"), project.directory]);
  await assert.rejects(c.deliveryAction(r.id, "explode", { local: true }), /Acción desconocida/);
  await assert.rejects(c.deliveryAction("no-existe", "guide"), /No se encontró ese trabajo/);
});

test("si tras tres intentos la entrega sigue mal, el trabajo se detiene con el motivo; Continuar reinicia la cuenta y puede cerrarla", async (t) => {
  let fixed = false;
  const { c, dir, calls } = setup(t, { coderWrites: (folder) => { writeApp(folder); if (fixed) writeDelivery(folder); } });
  await create(c, dir);
  await settled(c);
  const r = c.active;
  assert.equal(r.status, "blocked");
  assert.equal(r.stage, "review");
  assert.equal(r.deliveryAttempts, 3);
  assert.equal(r.delivery.status, "failed");
  assert.equal(r.delivery.attempts, 3);
  assert.match(c.events.at(-1).text, /Se necesita tu intervención: la aplicación no quedó lista para entregarse tras 3 intentos\. Falta Abrir\.cmd/);
  assert.equal(calls.coder.length, 3, "dos correcciones y el trabajo inicial; no se insiste sin límite");
  await assert.rejects(c.deliveryAction(r.id, "guide"), /todavía no está lista/);
  fixed = true;
  c.control("resume");
  await settled(c);
  assert.equal(c.active.status, "complete", c.active.error);
  assert.equal(c.active.deliveryAttempts, 0);
  assert.equal(c.active.delivery.status, "ready");
});

test("un proyecto que ya existía, sin los criterios de entrega, no se ve sorprendido con requisitos nuevos", async (t) => {
  const { c, dir } = setup(t, { tasks: 3, seedPlan: true });
  const folder = path.join(dir, "viejo");
  fs.mkdirSync(folder, { recursive: true });
  const project = c.addProject({ name: "Viejo", directory: folder, objective: "Un proyecto de P3 con una página web local.", criteria: BASE, checks: ["node --test"] }, { platform: "página web local" });
  const gate = c.deliveryManaged({ project });
  assert.equal(gate, false);
  c.start(project.id);
  await settled(c);
  assert.equal(c.active.status, "complete", c.active.error);
  assert.equal(c.active.delivery, undefined);
  assert.equal(c.active.deliveryChecks, undefined);
});

test("Android y Windows: el aviso dice que todavía no se entrega, no se añaden criterios y no hay compuerta", async (t) => {
  for (const [platform, expected] of [["App para Android", /todavía no genera ni comprueba un APK instalable/], ["Instalador de Windows", /todavía no genera ni comprueba un instalador de Windows/]]) {
    const { c, dir } = setup(t, { platform });
    c.propose({ idea: "Quiero una calculadora de propinas para repartir la cuenta entre mis amigos" });
    await settled(c);
    const p = c.proposals[0];
    assert.equal(p.status, "ready", p.error);
    assert.deepEqual(p.draft.criteria, BASE, `${platform}: ningún criterio de lanzador ni de guía`);
    assert.equal(p.delivery.verified, false);
    assert.match(p.delivery.note, expected);
    const { project } = await create(c, dir);
    await settled(c);
    assert.equal(c.active.status, "complete", c.active.error);
    assert.equal(c.active.delivery, undefined, "no se declara una entrega que no se comprobó");
    assert.equal(c.deliveryManaged({ project }), false);
  }
});

test("una app con servidor se abre desde el botón: la arranca, espera a que responda y devuelve su dirección", async (t) => {
  const dir = fixture();
  const probe = net.createServer();
  const port = await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => { const { port: p } = probe.address(); probe.close(() => resolve(p)); }));
  fs.writeFileSync(path.join(dir, "server.mjs"), `import http from "node:http"; http.createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end("<title>Hola</title><p>Hola</p>"); }).listen(${port}, "127.0.0.1");`);
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: passing, resources: null, detect: async () => ENV, agents: { async run() { return { text: "x" }; } } });
  t.after(async () => { await c.close(); });
  c.runs.push({ id: "r1", projectId: "p1", project: { directory: dir, name: "Hola" }, delivery: { status: "ready", name: "Hola", open: { type: "url", target: `http://localhost:${port}`, command: "node server.mjs" } } });
  const result = await c.deliveryAction("r1", "open", { local: true });
  assert.deepEqual(result, { opened: "url", url: `http://localhost:${port}` });
  assert.equal(c.app.view().status, "running");
  assert.equal(c.app.view().projectId, "p1");
  assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);
  // Pressing it again does not start a second copy.
  assert.deepEqual(await c.deliveryAction("r1", "open", { local: true }), { opened: "url", url: `http://localhost:${port}` });
  await c.appControl("stop");
  assert.equal(c.app.view().status, "stopped");
});

test("con el lanzador y la guía ya escritos, el director recibe la comprobación como evidencia; si algo falla, ve el problema, no «correcta»", async (t) => {
  let wrong = true;
  const { c, dir, calls } = setup(t, { coderWrites: (folder) => { writeApp(folder); writeDelivery(folder); if (wrong) fs.writeFileSync(path.join(folder, "index.html"), '<title>x</title><script src="falta.js"></script>'); } });
  await create(c, dir);
  await until(() => calls.auditor.filter((x) => x.phase === "review").length >= 1);
  const first = calls.auditor.find((x) => x.phase === "review");
  assert.match(first.prompt, /ENTREGA \(la comprobó Automata y sigue pendiente[\s\S]*carga «falta\.js», pero ese archivo no existe/);
  assert.doesNotMatch(first.prompt, /: correcta\./);
  wrong = false;
  await settled(c);
  assert.equal(c.active.status, "complete", c.active.error);
  assert.equal(c.active.deliveryCheck.ok, true);
  assert.equal(c.active.checks.length, 1, "la lista de verificaciones del proyecto no cambia de tamaño");
});

test("con solo el lanzador escrito (la guía es la tarea siguiente), el director ya recibe su comprobación como evidencia", async (t) => {
  const { c, dir, calls } = setup(t, { coderWrites: (folder, n) => { writeApp(folder); fs.writeFileSync(path.join(folder, LAUNCHER), '@echo off\r\nstart "" "%~dp0index.html"\r\n'); if (n >= 2) fs.writeFileSync(path.join(folder, GUIDE), GUIDE_TEXT); } });
  await create(c, dir);
  await settled(c);
  const first = calls.auditor.find((x) => x.phase === "review");
  assert.match(first.prompt, /ENTREGA \(la comprobó Automata en la ronda 1: el lanzador Abrir\.cmd y el arranque real\): correcta\. Es la evidencia de el criterio del lanzador \(la guía todavía no existe/);
  assert.doesNotMatch(first.prompt, /sigue pendiente; no apruebes/, "faltar la guía todavía no es un problema de entrega en pleno trabajo");
  assert.equal(c.active.status, "complete", c.active.error);
  assert.equal(c.active.delivery.status, "ready", "la compuerta final sí exige las dos cosas");
});

// What the real director wrote when it blocked three real runs (P4 drills of 28 Oct).
const REAL_BLOCKS = [
  "Abrir.cmd contiene el comando esperado, pero no se ha comprobado que abra la aplicación en Windows. La comprobación requiere que una persona haga doble clic en el archivo.",
  "T2: falta que alguien abra index.html, guarde el gasto de prueba y confirme que aparece con los datos indicados.",
  "Cuando alguien pueda hacer doble clic en Abrir.cmd y confirmar si aparece la página de gastos, registra el resultado."
];
test("si el director bloquea porque nadie puede abrir la página, se le devuelve una vez; si insiste, el bloqueo se respeta", async (t) => {
  for (const text of REAL_BLOCKS) {
    const { c, dir, calls } = setup(t, { coderWrites: (folder, n) => { writeApp(folder); writeDelivery(folder); }, director: (a, n) => n === 1 ? reviewOf(a.project, "blocked", 0, { summary: text, nextPrompt: text }) : null });
    await create(c, dir);
    await settled(c);
    const reviews = calls.auditor.filter((x) => x.phase === "review");
    assert.equal(c.active.status, "complete", `${text.slice(0, 40)}… → ${c.active.error}`);
    assert.equal(reviews.length, 2, "se le pidió de nuevo, una sola vez");
    assert.match(reviews[1].prompt, /Marcaste decision=blocked porque nadie puede abrir la aplicación[\s\S]*Claude puede añadir pruebas automáticas/);
    assert.ok(c.events.some((e) => /Revisión no válida \(1\/3\): Marcaste decision=blocked/.test(e.text)));
  }
  // It insists: the person is the one who decides.
  const { c, dir, calls } = setup(t, { coderWrites: (folder) => { writeApp(folder); writeDelivery(folder); }, director: (a) => reviewOf(a.project, "blocked", 0, { summary: REAL_BLOCKS[1], nextPrompt: REAL_BLOCKS[1] }) });
  await create(c, dir);
  await settled(c);
  assert.equal(c.active.status, "blocked");
  assert.equal(calls.auditor.filter((x) => x.phase === "review").length, 2, "no se insiste más: la segunda vez el bloqueo vale");
  // A block about something only the person can decide is not touched.
  const real = setup(t, { coderWrites: (folder) => { writeApp(folder); writeDelivery(folder); }, director: (a, n) => n === 1 ? reviewOf(a.project, "blocked", 0, { summary: "Falta saber en qué moneda debe mostrar los importes.", nextPrompt: "Decide la moneda." }) : null });
  await create(real.c, real.dir);
  await settled(real.c);
  assert.equal(real.c.active.status, "blocked");
  assert.equal(real.calls.auditor.filter((x) => x.phase === "review").length, 1, "un bloqueo legítimo no se cuestiona");
});

// ---- P4 stabilization: evidence for the director, blocks that Automata can resolve, messages in the configured language ----
const seenPage = (extra = {}) => ({ ok: true, title: "Propinas", controls: 2, browser: "chrome.exe", resources: { total: 2, loaded: 2, failed: [], files: ["index.html", "app.js"] }, storageKeys: [], scenarios: [], scenarioProblems: [], problems: [], ...extra });
// A browser that "runs" the scenarios it is given: those whose name has «malo» fail, the rest pass.
const fakeBrowser = (opened = []) => async (url, o) => {
  opened.push({ url, scenarios: o.scenarios ?? [] });
  const results = (o.scenarios ?? []).map((s) => ({ name: s.name, ok: !/malo/.test(s.name), steps: s.steps.length, failed: /malo/.test(s.name) ? { index: 1, step: "expectText x", message: "expectText x: ese texto no apareció." } : null }));
  return seenPage({ scenarios: results, scenarioProblems: results.filter((x) => !x.ok).map((x) => `En el escenario «${x.name}», paso 2: ${x.failed.message}`) });
};
const blockedOn = (project, text, extra = {}) => reviewOf(project, "blocked", 0, { summary: text, nextPrompt: text, task: "T1", plan: { add: [], update: [{ id: 1, status: "blocked", evidence: "", note: text }] }, ...extra });
const writeUi = (dir, name = "Guardar") => fs.writeFileSync(path.join(dir, "ui-check.json"), JSON.stringify({ scenarios: [{ name, steps: [{ fill: "#total", value: "10" }, { click: "button" }, { expectText: "5" }] }] }));

test("el director recibe, ronda a ronda, lo que Automata comprobó: pruebas, arranque, recursos, errores del navegador, interfaz y codificación", async (t) => {
  const opened = [];
  const { c, dir, calls } = setup(t, { browser: fakeBrowser(opened), coderWrites: (folder) => { writeApp(folder); fs.writeFileSync(path.join(folder, "nota.md"), "# Nota\nCon acentos: canción."); } });
  await create(c, dir);
  await settled(c);
  const first = calls.auditor.find((x) => x.phase === "review");
  assert.match(first.prompt, /COMPROBACIONES DE AUTOMATA \(ronda 1; las ejecutó Automata por su cuenta/);
  assert.match(first.prompt, /PRUEBAS: correcto · node --test → código 0/);
  assert.match(first.prompt, /ARRANQUE: correcto · la página se abrió en chrome\.exe sin ventana: «Propinas», 2 controles\./);
  assert.match(first.prompt, /RECURSOS: correcto · 2 de 2 archivos cargaron \(index\.html, app\.js\)/);
  assert.match(first.prompt, /ERRORES DEL NAVEGADOR: ninguno/);
  assert.match(first.prompt, /INTERFAZ: SIN ESCENARIOS · no hay ui-check\.json/);
  assert.match(first.prompt, /CODIFICACIÓN: correcto · \d+ archivos de texto leídos byte a byte/);
  assert.match(first.prompt, /PowerShell 5\.1 ves «Ã³»[\s\S]*Get-Content -Raw -Encoding UTF8/, "las reglas del director explican la lectura sin falsas alarmas");
  assert.ok(opened.some((o) => /index\.html$/.test(o.url)), "con solo index.html (aún sin lanzador) ya se abrió la página en el navegador");
  assert.equal(c.active.autoEvidence.tests.status, "ok");
  assert.equal(c.active.checks.length, 1, "las comprobaciones de Automata no cambian la lista de verificaciones del proyecto");
});

test("un escenario de interfaz que falla lo ve el director y la entrega vuelve a Claude con el paso exacto; al corregirlo queda lista", async (t) => {
  const opened = [];
  const { c, dir, calls } = setup(t, { browser: fakeBrowser(opened), coderWrites: (folder, n) => { writeApp(folder); writeDelivery(folder); writeUi(folder, n === 1 ? "Guardar malo" : "Guardar"); } });
  await create(c, dir);
  await until(() => calls.auditor.filter((x) => x.phase === "review").length >= 1);
  const first = calls.auditor.find((x) => x.phase === "review");
  assert.match(first.prompt, /INTERFAZ: FALLA · 1 escenario\(s\) hechos en un navegador real: «Guardar malo» \(falló el paso 2: expectText x: ese texto no apareció\.\)/);
  assert.match(first.prompt, /ENTREGA \(la comprobó Automata y sigue pendiente[\s\S]*Escenarios de interfaz \(ui-check\.json\): En el escenario «Guardar malo», paso 2/);
  await settled(c);
  assert.equal(c.active.status, "complete", c.active.error);
  assert.equal(c.active.delivery.status, "ready");
  assert.ok(opened.some((o) => o.scenarios.some((s) => s.name === "Guardar")), "los escenarios llegaron al navegador");
});

test("un ui-check.json ilegible es un problema de la entrega que Claude puede corregir, no un bloqueo", async (t) => {
  const { c, dir } = setup(t, { browser: fakeBrowser(), coderWrites: (folder, n) => { writeApp(folder); writeDelivery(folder); fs.writeFileSync(path.join(folder, "ui-check.json"), n === 1 ? "{ roto" : JSON.stringify({ scenarios: [{ name: "Ok", steps: [{ expectText: "Propinas" }] }] })); } });
  await create(c, dir);
  await settled(c);
  assert.equal(c.active.status, "complete", c.active.error);
  assert.ok(c.active.deliveryChecks.some((x) => !x.ok && x.problems.some((p) => /Escenarios de interfaz \(ui-check\.json\): ui-check\.json no es un JSON válido/.test(p))), "la compuerta final lo devolvió a Claude con el motivo");
});

test("con navegador, el director que bloquea por una prueba manual recibe dos reenvíos y, si insiste, el bloqueo pasa a ser una tarea para Claude; nunca se aprueba solo", async (t) => {
  for (const block of JSON.parse(fs.readFileSync(new URL("./fixtures/real-blocks.json", import.meta.url), "utf8"))) {
    const { c, dir, calls } = setup(t, { browser: fakeBrowser(), coderWrites: (folder) => { writeApp(folder); writeDelivery(folder); }, director: (a, n) => n <= 3 ? blockedOn(a.project, block.summary, { nextPrompt: block.nextPrompt }) : null });
    await create(c, dir);
    await settled(c);
    const reviews = calls.auditor.filter((x) => x.phase === "review");
    assert.equal(c.active.status, "complete", `${block.label}: ${c.active.error}`);
    assert.equal(reviews.length, 4, "dos reenvíos, un tercer bloqueo convertido en tarea y la revisión siguiente");
    assert.match(reviews[1].prompt, /AUTOMATA ejecuta esas comprobaciones por su cuenta[\s\S]*Lo que Automata YA comprobó y no debe repetir una persona: las pruebas del proyecto/);
    assert.equal(c.active.blockOverrides, 1);
    assert.ok(c.events.some((e) => /El director pidió que una persona repitiera una comprobación que Automata ya puede hacer \(ya comprobó: .*\)\. No hace falta tu intervención: Claude recibe la tarea[\s\S]*\(1 de 2\)/.test(e.text)));
    assert.ok(!c.events.some((e) => /^Se necesita tu intervención/.test(e.text)), "la persona no fue molestada");
    assert.ok(calls.coder.some((x) => /Automata ya hace esas comprobaciones por su cuenta[\s\S]*ui-check\.json/.test(x.prompt)), `${block.label}: Claude recibió la tarea de dejar el escenario`);
    assert.equal(c.active.review.decision, "complete");
    assert.equal(c.active.delivery.status, "ready");
  }
});

test("el director que sigue bloqueando después de dos conversiones deja el bloqueo a la persona; y un bloqueo sensible no se toca nunca", async (t) => {
  const stubborn = setup(t, { browser: fakeBrowser(), coderWrites: (folder) => { writeApp(folder); writeDelivery(folder); }, director: (a) => blockedOn(a.project, "Falta que alguien haga doble clic en Abrir.cmd y confirme que se abre la página.") });
  await create(stubborn.c, stubborn.dir);
  await settled(stubborn.c);
  assert.equal(stubborn.c.active.status, "blocked");
  assert.equal(stubborn.c.active.blockOverrides, 2, "como máximo dos conversiones por trabajo");
  assert.equal(stubborn.calls.auditor.filter((x) => x.phase === "review").length, 9, "tres consultas por ronda: dos reenvíos y la conversión o el bloqueo definitivo");
  assert.match(stubborn.c.events.at(-1).text, /Se necesita tu intervención: Falta que alguien haga doble clic/);
  for (const text of ["Falta la credencial de la API; alguien debe abrir la cuenta y entregarla.", "Falta saber en qué moneda debe mostrar los importes."]) {
    const legit = setup(t, { browser: fakeBrowser(), coderWrites: (folder) => { writeApp(folder); writeDelivery(folder); }, director: (a) => blockedOn(a.project, text) });
    await create(legit.c, legit.dir);
    await settled(legit.c);
    assert.equal(legit.c.active.status, "blocked");
    assert.equal(legit.calls.auditor.filter((x) => x.phase === "review").length, 1, "un bloqueo legítimo no se cuestiona");
    assert.equal(legit.c.active.blockOverrides ?? 0, 0);
  }
});

test("si la tarea que nombró el director no puede recibir el trabajo, su bloqueo se respeta en vez de romper el trabajo", async (t) => {
  const { c, dir } = setup(t, { browser: fakeBrowser(), coderWrites: (folder) => { writeApp(folder); writeDelivery(folder); }, director: (a, n) => n <= 3 ? blockedOn(a.project, "Falta que alguien haga doble clic en Abrir.cmd.", { task: "T6" }) : null });
  await create(c, dir);
  await settled(c);
  assert.notEqual(c.active.status, "error", c.active.error);
  assert.equal(c.active.status, "blocked", "T6 depende de tareas sin hacer: no admite el trabajo");
  assert.equal(c.active.blockOverrides ?? 0, 0);
});

test("en inglés, los problemas de entrega, los avisos y la orden a Claude están en inglés", async (t) => {
  const { c, dir, calls } = setup(t, { language: "en", coderWrites: (folder, n) => { writeApp(folder); fs.writeFileSync(path.join(folder, GUIDE), GUIDE_TEXT); if (n >= 2) fs.writeFileSync(path.join(folder, LAUNCHER), '@echo off\r\nstart "" "%~dp0index.html"\r\n'); } });
  await create(c, dir);
  await settled(c);
  assert.equal(c.active.status, "complete", c.active.error);
  const warning = c.events.find((e) => /not ready to hand over yet/.test(e.text));
  assert.match(warning.text, /The app is not ready to hand over yet \(attempt 1 of 3\)\. Abrir\.cmd is missing from the project folder\. Claude fixes it and it is checked again\./);
  const fix = calls.coder[1].prompt;
  assert.match(fix, /The app is not ready to be handed to a person yet\. Automata checked the delivery and found:\n- Abrir\.cmd is missing from the project folder\./);
  assert.ok(c.events.some((e) => /Your app is ready\. It was saved in/.test(e.text)));
  assert.doesNotMatch(c.active.deliveryChecks[0].problems.join(" "), /Falta /);
});

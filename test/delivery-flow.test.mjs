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
import { LAUNCHER, GUIDE, deliveryCriteria } from "../server/delivery.mjs";

const dirs = [];
const fixture = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "automata-dflow-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) if (path.resolve(d).startsWith(path.join(os.tmpdir(), "automata-dflow-"))) fs.rmSync(d, { recursive: true, force: true }); });
const settled = async (c) => { await c.pending; await c.proposalPending; while (c.busy) await new Promise((r) => setTimeout(r, 5)); };
const until = async (condition, ms = 8000) => { const limit = Date.now() + ms; while (!condition() && Date.now() < limit) await new Promise((r) => setTimeout(r, 10)); };

// A PC without a browser: the start check looks at files and skips the screen, which the unit tests cover with Chrome.
const ENV = { system: { name: "Windows 11" }, tools: { node: { version: "24.0.0" }, npm: { found: true }, git: { found: true }, powershell: { found: true }, browser: { found: false } }, targets: { web: { ready: true, missing: [], notes: [] }, windows: { ready: false, missing: ["Una herramienta para crear el instalador."] }, android: { ready: false, missing: ["Java (JDK 17 o 21)."] } } };
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
function setup(t, { platform, coderWrites, tasks = platform && !/web/i.test(platform) ? 4 : 6, seedPlan = false } = {}) {
  const dir = fixture(), calls = { coder: [], auditor: [] }, opened = [];
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: passing, resumeDelayMs: 0, detect: async () => ENV, opener: (target) => opened.push(target), resources: null, agents: { async run(a) {
    calls[a.role]?.push({ phase: a.phase, prompt: a.prompt });
    if (a.phase === "define") return { proposal: proposal(platform) };
    if (a.role === "coder") { coderWrites?.(a.project.directory, calls.coder.length); return { text: "Hecho" }; }
    // A project with no plan yet (it did not come from an idea) gets one from the director, a task per criterion.
    const added = seedPlan ? { plan: { add: a.project.criteria.map((criterion) => ({ title: "Cumplir: " + criterion.slice(0, 40), detail: "", criterion, dependsOn: [] })), update: [] } } : {};
    return { review: a.phase === "plan" ? reviewOf(a.project, "continue", 0, { task: seedPlan ? "N1" : "T1", ...added }) : reviewOf(a.project, "complete", tasks) };
  } } });
  c.updateSettings({ ...c.settings, projectsRoot: path.join(dir, "projects"), gitMode: "off", maxRounds: 8 });
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

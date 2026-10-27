import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { Store } from "../server/store.mjs";
import { Coordinator } from "../server/coordinator.mjs";
import { REVIEW_SCHEMA, normalizeRun, validateReview } from "../server/config.mjs";
import { observe, digest } from "../server/watch.mjs";
import { AppRunner } from "../server/apprun.mjs";
const temporaryDirectories = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-test-"));
  temporaryDirectories.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaryDirectories) if (path.resolve(dir).startsWith(path.join(os.tmpdir(), "automata-test-"))) fs.rmSync(dir, { recursive: true, force: true });
});
const projectInput = (directory) => ({ name: "Proyecto", directory, objective: "Una app.", criteria: ["La prueba pasa."], checks: [] });
const run = (ready, command = "npm start", url = "http://localhost:3000") => ({ ready, command: ready ? command : "", url: ready ? url : "", note: ready ? "Abre la página principal." : "" });
const review = (decision, extra = {}) => ({ decision, summary: `Revisión ${decision}.`, nextPrompt: decision === "continue" ? "Sigue." : "", findings: [], criteria: [{ criterion: "La prueba pasa.", met: decision === "complete", evidence: decision === "complete" ? "ok" : "pendiente" }], git: { commit: false, message: "", push: false, branch: "", merge_into: "" }, ...extra });
async function settled(c) {
  await c.pending;
  if (c.busy) await new Promise((r) => setTimeout(r, 5));
}
// An app runner that records what it was asked to run instead of starting processes.
function fakeApp() {
  const app = new EventEmitter();
  app.started = [];
  app.state = null;
  app.view = () => app.state ? { ...app.state } : null;
  app.start = (options) => {
    app.started.push(options);
    app.state = { ...options, status: "running", output: "" };
    app.emit("change");
    return app.view();
  };
  app.stop = async () => {
    if (app.state?.status === "running") app.state.status = "stopped";
    app.emit("change");
    return app.view();
  };
  app.dismiss = () => { app.state = null; };
  return app;
}

test("la bitácora resume lo que hizo el codificador: archivos, comandos con resultado y diffs", () => {
  const dir = path.join(os.tmpdir(), "proyecto");
  const log = [];
  observe(log, { kind: "tool", toolId: "1", tool: { name: "Read", path: path.join(dir, "src", "a.js") } });
  observe(log, { kind: "tool", toolId: "2", tool: { name: "Edit", path: path.join(dir, "src", "a.js"), diff: "- viejo\n+ nuevo" } });
  observe(log, { kind: "toolresult", toolId: "2", text: "ok" });
  observe(log, { kind: "tool", toolId: "3", tool: { name: "Write", path: path.join(dir, "b.js"), lines: 3, content: "uno\ndos\ntres" } });
  observe(log, { kind: "tool", toolId: "4", tool: { name: "Bash", command: "npm test" } });
  observe(log, { kind: "toolresult", toolId: "4", text: "1 test falló", error: true });
  observe(log, { kind: "message", text: "Ya casi termino." });
  const text = digest(log, dir);
  assert.match(text, /Editó: src\/a\.js/);
  assert.match(text, /Escribió \(crear o reemplazar\): b\.js/);
  assert.match(text, /Leyó: src\/a\.js/);
  assert.match(text, /\$ npm test ✕\n {2}1 test falló/);
  assert.match(text, /--- src\/a\.js\n- viejo\n\+ nuevo/);
  assert.match(text, /Ya casi termino/);
  assert.equal(digest([], dir), "");
  // A long session stays within budget.
  for (let i = 0; i < 1000; i++) observe(log, { kind: "tool", toolId: `e${i}`, tool: { name: "Edit", path: path.join(dir, `f${i}.js`), diff: "+ x".repeat(400) } });
  assert.ok(log.length <= 400);
  assert.ok(digest(log, dir, 5000).length <= 5000);
});

test("el director recibe la bitácora de la ronda y no la vuelve a recibir en la siguiente", async (t) => {
  const dir = fixture(), prompts = [];
  let reviews = 0, rounds = 0;
  const c = new Coordinator(new Store(path.join(dir, "data")), { app: fakeApp(), evidence: async () => "", checks: async () => [], agents: { async run(a) {
    if (a.role === "coder") {
      rounds++;
      a.emit({ role: "coder", kind: "tool", toolId: `t${rounds}`, tool: { name: "Edit", path: path.join(dir, `ronda${rounds}.js`), diff: `+ cambio de la ronda ${rounds}` }, text: "Edit" });
      a.emit({ role: "coder", kind: "toolresult", toolId: `t${rounds}`, text: "ok" });
      return { text: "Implementado" };
    }
    prompts.push({ phase: a.phase, prompt: a.prompt });
    return { review: review(a.phase === "review" && ++reviews === 2 ? "complete" : "continue") };
  } } });
  t.after(() => c.close());
  c.updateSettings({ ...c.settings, gitMode: "off" });
  c.start(c.addProject(projectInput(dir)).id);
  await settled(c);
  assert.equal(c.active.status, "complete");
  const [plan, first, second] = prompts;
  assert.equal(plan.phase, "plan");
  assert.doesNotMatch(plan.prompt, /LO QUE VISTE HACER AL CODIFICADOR/);
  assert.match(first.prompt, /LO QUE VISTE HACER AL CODIFICADOR[\s\S]*ronda1\.js[\s\S]*cambio de la ronda 1/);
  assert.match(first.prompt, /NO vuelvas a leer todo el proyecto/);
  assert.match(second.prompt, /cambio de la ronda 2/);
  assert.doesNotMatch(second.prompt, /cambio de la ronda 1/, "lo ya revisado no se repite");
  assert.equal(c.active.watch.length, 0);
  assert.equal("watch" in c.snapshot().runs[0], false);
  assert.ok(fs.existsSync(path.join(c.store.runDir(c.active.id), "round-01", "watch.txt")));
});

test("el trabajo pedido desde el chat durante un trabajo también entra en la bitácora", async (t) => {
  const dir = fixture();
  const c = new Coordinator(new Store(path.join(dir, "data")), { app: fakeApp(), evidence: async () => "", checks: async () => [], agents: { async run(a) {
    if (a.phase === "task") {
      a.emit({ role: "coder", kind: "tool", toolId: "chat1", tool: { name: "Bash", command: "npm install express" }, text: "Bash" });
      return { text: "Instalado" };
    }
    return { review: review("blocked") };
  } } });
  t.after(() => c.close());
  c.start(c.addProject(projectInput(dir)).id);
  await settled(c);
  await c.sendChat({ projectId: c.active.projectId, target: "coder", text: "instala express", kind: "task" });
  await c.chatPending;
  assert.equal(c.active.watch.at(-1).command, "npm install express");
});

test("el director pregunta si correr la app: una vez a mitad del trabajo y otra al terminar", async (t) => {
  const dir = fixture(), app = fakeApp();
  let reviews = 0;
  const c = new Coordinator(new Store(path.join(dir, "data")), { app, evidence: async () => "", checks: async () => [], agents: { async run(a) {
    if (a.role === "coder") return { text: "Implementado" };
    if (a.phase === "plan") return { review: review("continue", { run: run(false) }) };
    reviews++;
    return { review: review(reviews === 3 ? "complete" : "continue", { run: run(true) }) };
  } } });
  t.after(() => c.close());
  c.updateSettings({ ...c.settings, gitMode: "off" });
  c.start(c.addProject(projectInput(dir)).id);
  await settled(c);
  const r = c.active;
  assert.equal(r.status, "complete");
  const offers = c.events.filter((e) => e.kind === "runoffer");
  assert.equal(offers.length, 2, "no repite la misma pregunta en cada ronda");
  assert.match(offers[0].text, /ya se puede correr/);
  assert.match(offers[1].text, /Proyecto terminado/);
  assert.deepEqual(offers[1].offer, { command: "npm start", url: "http://localhost:3000", note: "Abre la página principal." });
  assert.deepEqual(r.runOffers.map((o) => o.status), ["superseded", "pending"]);
  assert.equal(app.started.length, 0, "nada corre sin permiso");
  const pending = r.runOffers[1];
  c.resolveRun(r.id, pending.id, "approve");
  assert.equal(pending.status, "started");
  assert.deepEqual(app.started[0], { directory: r.project.directory, command: "npm start", url: "http://localhost:3000", projectId: r.projectId, runId: r.id });
  assert.equal(c.snapshot().app.status, "running");
  assert.throws(() => c.resolveRun(r.id, pending.id, "approve"), /ya se resolvió/);
  await c.appControl("stop");
  assert.equal(c.snapshot().app.status, "stopped");
  assert.ok(c.events.some((e) => e.text === "App detenida."));
});

test("decir «Ahora no» no corre nada, y un trabajo nuevo descarta la pregunta anterior", async (t) => {
  const dir = fixture(), app = fakeApp();
  const c = new Coordinator(new Store(path.join(dir, "data")), { app, evidence: async () => "", checks: async () => [], agents: { async run(a) {
    if (a.role === "coder") return { text: "Implementado" };
    return { review: review(a.phase === "plan" ? "continue" : "complete", { run: run(a.phase !== "plan", "python main.py", "") }) };
  } } });
  t.after(() => c.close());
  c.updateSettings({ ...c.settings, gitMode: "off" });
  const project = c.addProject(projectInput(dir));
  c.start(project.id);
  await settled(c);
  const first = c.active, offer = first.runOffers[0];
  assert.equal(offer.url, "");
  c.resolveRun(first.id, offer.id, "reject");
  assert.equal(offer.status, "declined");
  assert.equal(app.started.length, 0);
  c.start(project.id);
  await settled(c);
  const pendingBefore = c.active.runOffers.find((o) => o.status === "pending");
  assert.ok(pendingBefore);
  c.start(project.id);
  await settled(c);
  assert.equal(c.runs[1].runOffers.find((o) => o.id === pendingBefore.id).status, "superseded");
});

test("la propuesta de correr la app solo acepta un comando de una línea y direcciones locales", () => {
  assert.ok(REVIEW_SCHEMA.required.includes("run"));
  assert.deepEqual(REVIEW_SCHEMA.properties.run.required, ["ready", "command", "url", "note"]);
  assert.deepEqual(normalizeRun({ ready: true, command: "npm start\nrm -rf /", url: "http://0.0.0.0:8080/", note: "x" }), { ready: true, command: "npm start", url: "http://localhost:8080/", note: "x" });
  assert.equal(normalizeRun({ ready: true, command: "npm start", url: "https://ejemplo.com" }).url, "");
  assert.equal(normalizeRun({ ready: true, command: "  " }).ready, false);
  assert.equal(normalizeRun({ ready: false, command: "npm start" }).command, "");
  assert.deepEqual(normalizeRun(undefined), { ready: false, command: "", url: "", note: "" });
  // Older sessions and the demo do not send the field: the review stays valid.
  const r = validateReview({ decision: "continue", summary: "s", nextPrompt: "n", findings: [], criteria: [] }, { criteria: ["c"] });
  assert.equal(r.run.ready, false);
});

test("AppRunner corre la app, encuentra su dirección local y la detiene", async () => {
  const dir = fixture(), runner = new AppRunner();
  const command = `node -e "console.log('Servidor listo en http://localhost:5179/inicio'); setInterval(() => {}, 1000)"`;
  const state = runner.start({ directory: dir, command });
  assert.equal(state.status, "running");
  assert.throws(() => runner.start({ directory: dir, command }), /Ya hay una app corriendo/);
  const deadline = Date.now() + 15e3;
  while (!runner.view().url && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(runner.view().url, "http://localhost:5179/inicio");
  assert.match(runner.view().output, /Servidor listo/);
  await runner.stop();
  assert.equal(runner.view().status, "stopped");
  runner.dismiss();
  assert.equal(runner.view(), null);
  // An app that ends on its own reports its exit code.
  runner.start({ directory: dir, command: "node -e \"process.exit(3)\"" });
  const end = Date.now() + 15e3;
  while (runner.running && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.equal(runner.view().status, "exited");
  assert.equal(runner.view().code, 3);
});

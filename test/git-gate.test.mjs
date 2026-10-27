import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Coordinator } from "../server/coordinator.mjs";
import { Store } from "../server/store.mjs";
import { GitOps } from "../server/git.mjs";

const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: { ...process.env, ...identity }, encoding: "utf8" }).trim();
const CRITERIA = ["Funciona la aplicación."];
const noGit = { commit: false, message: "", push: false, branch: "", merge_into: "" };
const review = (decision, gitDecision = {}) => ({ decision, summary: `Revisión ${decision}.`, nextPrompt: decision === "continue" ? "Haz la tarea." : "", task: "", files: [], findings: [], criteria: CRITERIA.map((criterion) => ({ criterion, met: decision === "complete", evidence: decision === "complete" ? "Probado." : "Pendiente." })), git: { ...noGit, ...gitDecision }, run: { ready: false, command: "", url: "", note: "" }, memory: { add: [], retire: [] }, plan: null });

// A real repository with one commit, a coordinator using the real GitOps, and a director that follows a script.
function setup(t, { decisions, extra = {}, settings = {}, project = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-gate-")), folder = path.join(dir, "app");
  fs.mkdirSync(folder);
  git(folder, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(folder, "README.md"), "# app\n");
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", "chore: inicio");
  const queue = [...decisions], prompts = [], pushes = [];
  const ops = new GitOps({ env: identity });
  const realPush = ops.push.bind(ops);
  ops.push = async (...args) => { pushes.push(args[0]); return realPush(...args); };
  const c = new Coordinator(new Store(path.join(dir, "data")), { git: ops, evidence: async () => "", checks: async () => [], agents: { async run(a) {
    if (a.role === "coder") {
      fs.appendFileSync(path.join(a.project.directory, "app.txt"), `trabajo ${Date.now()}\n`);
      return { text: "Implementado" };
    }
    prompts.push(a.prompt);
    const next = queue.shift() ?? decisions.at(-1);
    return { review: review(next.decision, next.git) };
  } }, ...extra });
  t.after(async () => { await c.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  c.updateSettings({ ...c.settings, gitMode: "ask-push", ...settings });
  const p = c.addProject({ name: "App", directory: folder, objective: "Una aplicación que funciona y se prueba.", criteria: CRITERIA, checks: [], ...project });
  return { c, p, folder, prompts, pushes, log: () => git(folder, "log", "--format=%s"), status: () => git(folder, "status", "--porcelain") };
}
async function settled(c) {
  await c.pending;
  await c.proposalPending;
  while (c.busy) await new Promise((r) => setTimeout(r, 5));
}

test("un hito verificado se guarda como commit local y el trabajo termina con la carpeta limpia", async (t) => {
  const s = setup(t, { decisions: [{ decision: "continue" }, { decision: "continue", git: { commit: true, message: "feat: primera versión" } }, { decision: "complete", git: { commit: true, message: "docs: entrega" } }] });
  s.c.start(s.p.id);
  await settled(s.c);
  assert.equal(s.c.active.status, "complete", s.c.active.error);
  assert.equal(s.status(), "", "nada queda sin guardar");
  assert.deepEqual(s.log().split("\n"), ["docs: entrega", "feat: primera versión", "chore: inicio"]);
  assert.ok(s.c.active.gitQueue.every((item) => item.kind === "commit" && !item.gate && item.status === "done"));
  assert.deepEqual(s.pushes, []);
});

test("si el director aprueba con cambios sin guardar y sin commit, se le pide una vez y entonces lo decide", async (t) => {
  const s = setup(t, { decisions: [{ decision: "continue" }, { decision: "complete" }, { decision: "complete", git: { commit: true, message: "feat: entrega" } }] });
  s.c.start(s.p.id);
  await settled(s.c);
  assert.equal(s.c.active.status, "complete", s.c.active.error);
  assert.match(s.prompts.at(-1), /RESPUESTA ANTERIOR RECHAZADA: .*cambios sin confirmar en Git/);
  assert.equal(s.prompts.length, 3, "plan, revisión que olvidó el commit y revisión corregida");
  assert.equal(s.status(), "");
  assert.equal(s.log().split("\n")[0], "feat: entrega");
});

test("si el director insiste en no guardar, el trabajo espera: no termina con cambios que nadie decidió", async (t) => {
  const s = setup(t, { decisions: [{ decision: "continue" }, { decision: "complete" }] });
  s.c.start(s.p.id);
  await settled(s.c);
  const r = s.c.active;
  assert.equal(r.status, "blocked");
  assert.equal(r.stage, "apply");
  const gate = r.gitQueue.find((item) => item.gate);
  assert.ok(gate && gate.status === "pending" && gate.kind === "commit");
  assert.match(gate.message, /^chore: guardar los cambios pendientes de App/);
  assert.ok(s.c.events.some((e) => e.kind === "warning" && /Se necesita tu intervención: .*app\.txt/.test(e.text)));
  assert.notEqual(s.status(), "", "los cambios siguen ahí, sin guardar");
  assert.equal(s.log().split("\n").length, 1, "ningún commit se hizo por su cuenta");
  // The person approves the commit: it is made and the work finishes by itself.
  await s.c.resolveGit(r.id, gate.id, "approve");
  await settled(s.c);
  assert.equal(r.status, "complete");
  assert.equal(s.status(), "");
  assert.match(s.log().split("\n")[0], /^chore: guardar los cambios pendientes/);
});

test("si el commit falla se muestra el problema, nada se da por guardado y se puede reintentar", async (t) => {
  const s = setup(t, { decisions: [{ decision: "continue" }, { decision: "complete", git: { commit: true, message: "feat: entrega" } }] });
  // A real failure: the repository's own hook refuses the commit.
  const hook = path.join(s.folder, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\necho 'pre-commit: las pruebas locales no pasan' >&2\nexit 1\n", { mode: 0o755 });
  s.c.start(s.p.id);
  await settled(s.c);
  const r = s.c.active;
  assert.equal(r.status, "blocked");
  const [attempt, gate] = r.gitQueue;
  assert.equal(attempt.status, "failed");
  assert.match(attempt.error, /las pruebas locales no pasan/);
  assert.match(r.gitProblem.error, /las pruebas locales no pasan/);
  assert.equal(gate.gate, true);
  assert.ok(s.c.events.some((e) => e.kind === "warning" && /no se pudo guardar un commit|las pruebas locales no pasan/.test(e.text)));
  // Retrying while the cause is still there fails again, visibly, and the run keeps waiting.
  await s.c.resolveGit(r.id, gate.id, "approve");
  assert.equal(gate.status, "failed");
  assert.equal(r.status, "blocked");
  assert.ok(s.c.events.some((e) => /El commit falló: .*las pruebas locales no pasan/.test(e.text)));
  assert.notEqual(s.status(), "");
  // The cause is fixed; the retry (same item) saves the work and the run completes.
  fs.rmSync(hook);
  await s.c.resolveGit(r.id, gate.id, "approve");
  await settled(s.c);
  assert.equal(r.status, "complete");
  assert.equal(gate.status, "done");
  assert.equal(s.status(), "");
  assert.equal(r.gitProblem, undefined, "el problema se olvida cuando un commit funciona");
});

test("dejar los cambios sin guardar es una decisión explícita que queda anotada", async (t) => {
  const s = setup(t, { decisions: [{ decision: "continue" }, { decision: "complete" }] });
  s.c.start(s.p.id);
  await settled(s.c);
  const r = s.c.active, gate = r.gitQueue.find((item) => item.gate);
  await s.c.resolveGit(r.id, gate.id, "reject");
  await settled(s.c);
  assert.equal(r.status, "complete");
  assert.equal(gate.status, "rejected");
  assert.ok(s.c.events.some((e) => /Decidiste dejar los cambios sin guardar/.test(e.text)));
  assert.ok(s.c.memory.listFacts(s.p.id, { status: "active" }).some((f) => /decidió dejar los últimos cambios sin guardar/.test(f.text)));
  assert.notEqual(s.status(), "");
});

test("los archivos sensibles nunca se confirman: se avisa y no bloquean el cierre", async (t) => {
  const s = setup(t, { decisions: [{ decision: "continue" }, { decision: "complete", git: { commit: true, message: "feat: entrega" } }], extra: {} });
  fs.writeFileSync(path.join(s.folder, ".env"), "TOKEN=secreto\n");
  s.c.start(s.p.id);
  await settled(s.c);
  const r = s.c.active;
  assert.equal(r.status, "complete", r.error);
  assert.ok(s.c.events.some((e) => /archivos sensibles que Automata nunca confirma: \.env/.test(e.text)));
  assert.equal(s.status(), "?? .env");
  assert.ok(!r.gitQueue.some((item) => item.gate));
  assert.doesNotMatch(git(s.folder, "ls-files"), /\.env/);
});

test("con Git desactivado el trabajo termina, y en una demostración o fuera de un repositorio no se pregunta nada", async (t) => {
  const off = setup(t, { decisions: [{ decision: "continue" }, { decision: "complete" }], settings: { gitMode: "off" } });
  off.c.start(off.p.id);
  await settled(off.c);
  assert.equal(off.c.active.status, "complete");
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "automata-gate-plain-"));
  const queue = [{ decision: "continue" }, { decision: "complete" }];
  const c = new Coordinator(new Store(path.join(plain, "data")), { git: new GitOps({ env: identity }), evidence: async () => "", checks: async () => [], agents: { async run(a) {
    if (a.role === "coder") return { text: "ok" };
    return { review: review(queue.shift().decision) };
  } } });
  t.after(async () => { await c.close(); fs.rmSync(plain, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(plain, "carpeta"));
  c.start(c.addProject({ name: "Sin git", directory: path.join(plain, "carpeta"), objective: "Una carpeta común sin repositorio.", criteria: CRITERIA, checks: [] }).id);
  await settled(c);
  assert.equal(c.active.status, "complete");
});

test("un proyecto creado desde una idea nunca hace push ni merge por su cuenta, ni siquiera en modo automático", async (t) => {
  const s = setup(t, { decisions: [{ decision: "continue" }, { decision: "complete", git: { commit: true, message: "feat: entrega", push: true } }], settings: { gitMode: "auto" }, project: { } });
  // Marked as born from an idea, like acceptProposal does.
  s.p.proposalId = "propuesta-1";
  s.c.start(s.p.id);
  await settled(s.c);
  const r = s.c.active;
  assert.equal(r.status, "complete", r.error);
  assert.deepEqual(s.pushes, [], "el push no se ejecutó");
  const push = r.gitQueue.find((item) => item.kind === "push");
  assert.equal(push.status, "pending", "espera la aprobación de la persona");
  assert.ok(r.gitQueue.find((item) => item.kind === "commit").status === "done");
  assert.ok(s.c.events.some((e) => e.kind === "approval" && e.git.kind === "push"));
  // And in a project of the user's own, automatic mode keeps working as chosen (the push fails here for lack of a remote).
  const own = setup(t, { decisions: [{ decision: "continue" }, { decision: "complete", git: { commit: true, message: "feat: entrega", push: true } }], settings: { gitMode: "auto" } });
  own.c.start(own.p.id);
  await settled(own.c);
  assert.equal(own.pushes.length, 1);
});

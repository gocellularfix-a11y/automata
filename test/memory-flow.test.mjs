import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.mjs";
import { Coordinator } from "../server/coordinator.mjs";
import { createServer } from "../server/index.mjs";
import { REVIEW_SCHEMA, validateReview } from "../server/config.mjs";
import { estimateTokens } from "../server/redact.mjs";

const temporary = [];
after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-memflow-"));
  temporary.push(dir);
  return dir;
}
async function settled(c) {
  await c.pending;
  while (c.busy) await new Promise((r) => setTimeout(r, 5));
}
const CRITERION = "La suma funciona.";
const projectInput = (directory, extra = {}) => ({ name: "Memoria", directory, objective: "Una función suma con su prueba.", criteria: [CRITERION], checks: ["npm test"], ...extra });
const review = (decision, extra = {}) => ({ decision, summary: `Revisión ${decision}.`, nextPrompt: decision === "continue" ? "Crea src/suma.mjs con su prueba." : "", findings: [], criteria: [{ criterion: CRITERION, met: decision === "complete", evidence: decision === "complete" ? "npm test pasa." : "" }], git: { commit: false, message: "", push: false, branch: "", merge_into: "" }, run: { ready: false, command: "", url: "", note: "" }, ...extra });
const FAIL = { command: "npm test", passed: false, code: 1, output: "▶ suma\n✖ suma devuelve el total (3.1ms)\n  Error: Cannot find module 'src/suma.mjs'\nℹ fail 1", stderr: "" };
const PASS = { command: "npm test", passed: true, code: 0, output: "ℹ pass 1\nℹ fail 0", stderr: "" };

// Each run: plan → code (checks fail) → quick fix (checks pass) → review complete.
function scripted(dir, calls) {
  let checks = 0;
  const agents = { async run(a) {
    calls.push({ role: a.role, phase: a.phase, prompt: a.prompt, resume: a.agent?.resume ?? null });
    if (a.role === "coder") {
      if (/fallaron/.test(a.prompt)) {
        a.emit({ role: "coder", kind: "tool", toolId: "w" + calls.length, tool: { name: "Write", path: path.join(dir, "src", "suma.mjs"), content: "export const suma = (a, b) => a + b;", lines: 1 } });
        a.emit({ role: "coder", kind: "toolresult", toolId: "w" + calls.length, text: "ok" });
        return { text: "Creé src/suma.mjs exportando suma.", sessionId: "c" + calls.length };
      }
      // A build that fails and then works inside the same call.
      a.emit({ role: "coder", kind: "tool", toolId: "b1", tool: { name: "Bash", command: "npm run build" } });
      a.emit({ role: "coder", kind: "toolresult", toolId: "b1", text: "ERROR: JAVA_HOME is not set", error: true });
      a.emit({ role: "coder", kind: "message", text: "Uso el JDK 21." });
      a.emit({ role: "coder", kind: "tool", toolId: "b2", tool: { name: "Bash", command: "npm run build" } });
      a.emit({ role: "coder", kind: "toolresult", toolId: "b2", text: "BUILD SUCCESSFUL" });
      return { text: "Preparé la prueba.\n\nPARA RECORDAR:\n- [entorno] La compilación necesita el JDK 21 en JAVA_HOME", sessionId: "c" + calls.length };
    }
    if (a.phase === "plan") return { review: review("continue"), sessionId: "d" + calls.length };
    return { review: review("complete", { memory: { add: [{ kind: "decision", text: "La suma trabaja en centavos enteros" }], retire: [] } }), sessionId: "d" + calls.length };
  } };
  return { agents, checks: async () => [++checks % 2 ? FAIL : PASS] };
}

test("una sesión nueva recupera decisiones, entorno y errores resueltos, y un error que reaparece trae su solución", async (t) => {
  const dir = fixture(), calls = [];
  fs.mkdirSync(path.join(dir, "src"));
  const { agents, checks } = scripted(dir, calls);
  const c = new Coordinator(new Store(path.join(dir, "data")), { agents, checks, evidence: async () => "" });
  t.after(() => c.close());
  const p = c.addProject(projectInput(dir));
  c.start(p.id);
  await settled(c);
  assert.equal(c.active.status, "complete");
  const first = c.memoryAction({ projectId: p.id });
  assert.deepEqual(first.facts.filter((f) => f.kind !== "progress").map((f) => `${f.kind}:${f.source}:${f.text}`).sort(), ["decision:director:La suma trabaja en centavos enteros", "env:coder:La compilación necesita el JDK 21 en JAVA_HOME"]);
  const checkError = first.errors.find((e) => e.origin === "check"), buildError = first.errors.find((e) => e.origin === "command");
  assert.equal(checkError.status, "resolved");
  assert.deepEqual(checkError.solutions[0].files, ["src/suma.mjs"]);
  assert.equal(checkError.solutions[0].round, 2);
  assert.equal(buildError.status, "resolved");
  assert.match(buildError.solutions[0].summary, /JDK 21/);

  // A new run of the same project starts new sessions, but not from zero.
  calls.length = 0;
  c.start(p.id);
  await settled(c);
  assert.equal(c.active.status, "complete");
  const plan = calls.find((call) => call.phase === "plan");
  assert.equal(plan.resume, null, "sesión nueva");
  assert.match(plan.prompt, /MEMORIA DEL PROYECTO/);
  assert.match(plan.prompt, /La suma trabaja en centavos enteros/);
  assert.match(plan.prompt, /JDK 21/);
  assert.match(plan.prompt, /ERRORES QUE YA SE RESOLVIERON ANTES/);
  // The same check fails again: the fix instruction carries the solution that worked last time.
  const fix = calls.find((call) => call.role === "coder" && /fallaron/.test(call.prompt));
  assert.match(fix.prompt, /SOLUCIONES CONOCIDAS PARA LO QUE FALLA AHORA:[\s\S]*el mismo error[\s\S]*src\/suma\.mjs/);
  assert.ok(c.events.some((e) => /Este error ya había pasado/.test(e.text)));
  assert.equal(c.memoryAction({ projectId: p.id }).errors.find((e) => e.id === checkError.id).occurrences, 2);
  // Prompts and the memory shown to each agent are saved with the round, next to the full history.
  const runDir = c.store.runDir(c.active.id);
  assert.ok(fs.existsSync(path.join(runDir, "round-00", "memory.txt")));
});

test("la memoria de un proyecto no aparece en otro, ni en el ciclo, ni en el chat, ni por la API", async (t) => {
  const dirA = fixture(), dirB = fixture(), prompts = [];
  const c = new Coordinator(new Store(path.join(dirA, "data")), { evidence: async () => "", checks: async () => [], agents: { async run(a) {
    prompts.push(a.prompt);
    return a.role === "coder" ? { text: "Hecho." } : { text: "Respuesta.\n\nPARA RECORDAR:\n- [trampa] El puerto 3000 ya está ocupado" };
  } } });
  t.after(() => c.close());
  const a = c.addProject(projectInput(dirA, { name: "A" })), b = c.addProject(projectInput(dirB, { name: "B" }));
  c.memoryAction({ projectId: a.id, action: "add", kind: "decision", text: "Secreto de diseño del proyecto A" });
  assert.equal(c.memoryAction({ projectId: b.id }).facts.length, 0);
  assert.equal(c.memoryAction({ projectId: b.id, action: "brief", q: "diseño" }).text, "");
  assert.throws(() => c.memoryAction({ projectId: "no-existe" }), /Selecciona un proyecto/);
  assert.throws(() => c.memoryAction({ projectId: a.id, action: "borrarTodo" }), /no válida/);
  // Ids are per project: retiring A's fact #1 through B does nothing to A.
  assert.throws(() => c.memoryAction({ projectId: b.id, action: "retire", id: 1 }), /No se encontró/);
  await c.sendChat({ projectId: b.id, target: "auditor", kind: "question", text: "¿Qué decidimos sobre el diseño?" });
  await c.chatPending;
  assert.doesNotMatch(prompts.at(-1), /Secreto de diseño/);
  await c.sendChat({ projectId: a.id, target: "auditor", kind: "question", text: "¿Qué decidimos sobre el diseño?" });
  await c.chatPending;
  assert.match(prompts.at(-1), /Secreto de diseño del proyecto A/);
  // What an agent marked to remember from the chat stays in that project only.
  assert.ok(c.memoryAction({ projectId: a.id }).facts.some((f) => f.kind === "gotcha" && /puerto 3000/.test(f.text)));
  assert.ok(c.memoryAction({ projectId: b.id }).facts.some((f) => f.kind === "gotcha"));
  assert.equal(c.memoryAction({ projectId: b.id }).facts.some((f) => /Secreto/.test(f.text)), false);
});

test("los recuerdos retirados no vuelven a los prompts y el bloque de memoria respeta su presupuesto", async (t) => {
  const dir = fixture(), prompts = [];
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: async () => [], agents: { async run(a) {
    prompts.push(a.prompt);
    return a.role === "coder" ? { text: "Hecho." } : { review: review(a.phase === "plan" ? "continue" : "complete") };
  } } });
  t.after(() => c.close());
  const p = c.addProject(projectInput(dir, { checks: [] }));
  for (let i = 0; i < 150; i++) c.memoryAction({ projectId: p.id, action: "add", kind: ["decision", "env", "gotcha", "pending"][i % 4], text: `Hecho ${i} ${"relleno ".repeat(30)}` });
  const wrong = c.memoryAction({ projectId: p.id, action: "add", kind: "env", text: "El proyecto usa Python 2" }).fact;
  c.memoryAction({ projectId: p.id, action: "retire", id: wrong.id, reason: "Falso" });
  c.start(p.id);
  await settled(c);
  for (const prompt of prompts) {
    const block = prompt.split(/MEMORIA DEL PROYECTO[^\n]*\n/)[1]?.split(/\n(?:CONTEXTO DE LA RONDA|REPORTE DEL CODIFICADOR|TAREA DEL DIRECTOR|CAMBIOS QUE YA)/)[0] ?? "";
    assert.ok(block.length > 0);
    assert.ok(estimateTokens(block) <= 1500, `tokens=${estimateTokens(block)}`);
    assert.doesNotMatch(prompt, /Python 2/);
  }
});

test("el esquema del director pide memoria, y las revisiones sin ella siguen siendo válidas", () => {
  assert.ok(REVIEW_SCHEMA.required.includes("memory"));
  assert.deepEqual(REVIEW_SCHEMA.properties.memory.required, ["add", "retire"]);
  const project = { criteria: [CRITERION] };
  assert.deepEqual(validateReview(review("continue"), project).memory, { add: [], retire: [] });
  const many = validateReview(review("continue", { memory: { add: [...Array(9)].map((_, i) => ({ kind: "note", text: `n${i}` })).concat([{ kind: "progress", text: "no permitido" }]), retire: [{ id: 3, reason: "x" }, { id: -1 }, { id: "4" }] } }), project).memory;
  assert.equal(many.add.length, 6);
  assert.deepEqual(many.retire, [{ id: 3, reason: "x" }]);
});

test("si la memoria falla, el trabajo sigue y se avisa una sola vez", async (t) => {
  const dir = fixture();
  const broken = new Proxy({}, { get: () => () => { throw new Error("disco lleno"); } });
  const c = new Coordinator(new Store(path.join(dir, "data")), { memory: broken, evidence: async () => "", checks: async () => [FAIL], agents: { async run(a) {
    return a.role === "coder" ? { text: "Hecho.\n\nPARA RECORDAR:\n- [nota] algo" } : { review: review(a.phase === "plan" ? "continue" : "blocked") };
  } } });
  t.after(() => c.close());
  c.start(c.addProject(projectInput(dir)).id);
  await settled(c);
  assert.equal(c.active.status, "blocked");
  assert.equal(c.events.filter((e) => /memoria del proyecto/.test(e.text ?? "")).length, 1);
});

test("la API de memoria exige el token y permite consultar, corregir, retirar y restaurar", async (t) => {
  const dir = fixture();
  const app = await createServer({ port: 0, demo: true, dataDir: dir });
  t.after(() => app.close());
  const call = (body, headers = { Authorization: "Bearer " + app.token }) => fetch(app.origin + "/api/memory", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await call({ projectId: "demo" }, {})).status, 401);
  const added = await (await call({ projectId: "demo", action: "add", kind: "decision", text: "Saludo en español" })).json();
  assert.equal(added.fact.source, "user");
  await call({ projectId: "demo", action: "update", id: added.fact.id, text: "Saludo en español e inglés" });
  await call({ projectId: "demo", action: "retire", id: added.fact.id, reason: "Cambió el objetivo" });
  let list = await (await call({ projectId: "demo", status: "all" })).json();
  assert.equal(list.facts[0].status, "retired");
  assert.equal(list.facts[0].text, "Saludo en español e inglés");
  await call({ projectId: "demo", action: "restore", id: added.fact.id });
  list = await (await call({ projectId: "demo", q: "inglés" })).json();
  assert.equal(list.facts.length, 1);
  assert.equal(list.stats.facts, 1);
  const history = await (await call({ projectId: "demo", action: "history", id: added.fact.id })).json();
  assert.deepEqual(history.history.map((h) => h.action), ["add", "update", "retire", "restore"]);
  assert.equal((await call({ projectId: "otro" })).status, 422);
});

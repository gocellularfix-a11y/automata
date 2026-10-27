// P2 in the coordinator: the director keeps the plan, Claude gets its task, sessions renew at safe
// points, the chat remembers, and all of it survives restarts. Simulated agents and CLIs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateSettings } from "../server/config.mjs";
import { Store } from "../server/store.mjs";
import { Coordinator } from "../server/coordinator.mjs";
import { createServer } from "../server/index.mjs";
import { isCasual } from "../server/chat.mjs";
import { estimateTokens } from "../server/redact.mjs";
const temporaryDirectories = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-test-"));
  temporaryDirectories.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaryDirectories) if (path.resolve(dir).startsWith(path.join(os.tmpdir(), "automata-test-"))) fs.rmSync(dir, { recursive: true, force: true });
});
const CRITERIA = ["La suma funciona.", "La CLI imprime JSON."];
const projectInput = (directory, extra = {}) => ({ name: "Plan", directory, objective: "Suma con CLI.", criteria: CRITERIA, checks: [], ...extra });
const base = (decision) => ({ decision, summary: `Revisión ${decision}.`, nextPrompt: decision === "continue" ? "Haz la tarea." : "", findings: [], criteria: CRITERIA.map((criterion) => ({ criterion, met: decision === "complete", evidence: decision === "complete" ? "comprobado" : "" })), git: { commit: false, message: "", push: false, branch: "", merge_into: "" }, run: { ready: false, command: "", url: "", note: "" }, memory: { add: [], retire: [] } });
const planning = { ...base("continue"), task: "N1", plan: { add: [{ title: "Módulo suma", detail: "src/suma.mjs", criterion: CRITERIA[0], dependsOn: [] }, { title: "CLI", detail: "src/cli.mjs", criterion: CRITERIA[1], dependsOn: ["N1"] }], update: [] } };
async function settled(c) {
  await c.pending;
  while (c.busy) await new Promise((r) => setTimeout(r, 5));
}
function coordinator(dir, agents, extra = {}) {
  return new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: async () => [], resumeDelayMs: 0, agents, ...extra });
}
// A director that plans two dependent tasks, assigns them in order, confirms each with evidence and completes.
function director() {
  let reviews = 0;
  return (a) => {
    if (a.phase === "plan") return { review: planning, sessionId: "d" };
    reviews++;
    if (reviews === 1) return { review: { ...base("continue"), task: "T2", plan: { add: [], update: [{ id: 1, status: "done", evidence: "suma.test en verde", note: "" }] } }, sessionId: "d" };
    return { review: { ...base("complete"), task: "", plan: { add: [], update: [{ id: 2, status: "done", evidence: "cli ok", note: "" }] } }, sessionId: "d" };
  };
}

test("el director crea el plan, Automata asigna cada tarea a Claude en orden y el plan queda hecho al completar", async (t) => {
  const dir = fixture(), prompts = [];
  const decide = director();
  const c = coordinator(dir, { async run(a) {
    prompts.push({ role: a.role, phase: a.phase, prompt: a.prompt, resume: a.agent.resume });
    if (a.role === "coder") return { text: "Hecho", sessionId: "c" };
    return decide(a);
  } });
  t.after(() => c.close());
  const p = c.addProject(projectInput(dir));
  c.start(p.id);
  await settled(c);
  assert.equal(c.active.status, "complete");
  const tasks = c.plan.list(p.id);
  assert.deepEqual(tasks.map((x) => [x.id, x.status, x.dependsOn, x.evidence]), [[1, "done", [], "suma.test en verde"], [2, "done", [1], "cli ok"]]);
  assert.deepEqual(c.plan.history(p.id, 1).map((h) => h.action + ":" + (h.after ?? "")), ["add:Módulo suma", "status:doing", "evidence:suma.test en verde", "status:done"]);
  const coderPrompts = prompts.filter((x) => x.role === "coder");
  assert.match(coderPrompts[0].prompt, /PLAN DEL PROYECTO \(0 de 2 tareas hechas; lo mantiene el director\)[\s\S]*TU TAREA AHORA: T1 «Módulo suma»[\s\S]*Criterio: La suma funciona\.[\s\S]*Detalle: src\/suma\.mjs/);
  assert.match(coderPrompts[0].prompt, /OTRAS TAREAS DEL PLAN \(no las hagas ahora\):\n- T2 «CLI»/);
  assert.match(coderPrompts[1].prompt, /TU TAREA AHORA: T2 «CLI»[\s\S]*Depende de T1 ✓/);
  const review = prompts.find((x) => x.role === "auditor" && x.phase === "review");
  assert.match(review.prompt, /PLAN DEL PROYECTO \(0 de 2 tareas hechas; lo mantienes tú[\s\S]*TAREA ASIGNADA: T1/);
  assert.match(review.prompt, /PLAN \(lo mantienes tú[\s\S]*actualiza en plan\.update/);
  assert.match(prompts[0].prompt, /descompón el objetivo en tareas/);
  assert.ok(c.events.some((e) => e.kind === "plan" && /2 tarea\(s\) nueva\(s\)/.test(e.text)));
  assert.equal(c.snapshot().plans[p.id].done, 2);
  assert.equal(fs.existsSync(path.join(c.store.runDir(c.active.id), "round-01", "plan-code.txt")), true);
  // A new run of the same project continues with the plan already done: the director sees it in its planning prompt.
  prompts.length = 0;
  c.start(p.id);
  await settled(c);
  assert.match(prompts[0].prompt, /HECHAS: T1, T2/);
});

test("una decisión que rompe el plan vuelve al director con el motivo y no deja rastro; a la tercera el trabajo se detiene", async (t) => {
  const dir = fixture(), prompts = [];
  let attempts = 0;
  const c = coordinator(dir, { async run(a) {
    prompts.push(a.prompt);
    if (a.role === "coder") return { text: "Hecho" };
    if (a.phase === "plan") {
      attempts++;
      if (attempts === 1) return { review: { ...planning, plan: { add: [{ title: "Solo suma", detail: "", criterion: CRITERIA[0], dependsOn: [] }], update: [] } } };
      if (attempts === 2) return { review: { ...planning, task: "N2" } };
      return { review: planning };
    }
    return { review: { ...base("complete"), task: "", plan: { add: [], update: [] } } };
  } });
  t.after(() => c.close());
  const p = c.addProject(projectInput(dir));
  c.start(p.id);
  await settled(c);
  assert.equal(attempts, 3);
  // Without a session the full prompt carries the reason; with one, the short correction prompt does.
  assert.match(prompts[1], /RESPUESTA ANTERIOR RECHAZADA: Cada criterio de aceptación necesita al menos una tarea[\s\S]*«La CLI imprime JSON\.»/);
  assert.match(prompts[2], /RESPUESTA ANTERIOR RECHAZADA: La tarea T2 depende de T1 \(pendiente\)/);
  assert.equal(c.plan.list(p.id).length, 2, "solo la decisión válida dejó tareas");
  // Approving with the plan open stops after three tries, with the reason.
  assert.equal(c.active.status, "error");
  assert.match(c.active.error, /quedan tareas ligadas a criterios sin cerrar: T1/);
  assert.deepEqual(c.plan.list(p.id).map((x) => x.status), ["doing", "todo"]);
});

test("las sesiones se renuevan cada N rondas en un punto seguro, con el plan y la memoria en el prompt completo, y se registra", async (t) => {
  const dir = fixture(), seen = [];
  let reviews = 0;
  const c = coordinator(dir, { async run(a) {
    seen.push({ role: a.role, phase: a.phase, resume: a.agent.resume, full: !/Seguimos en la misma sesión/.test(a.prompt), hasPlan: /PLAN DEL PROYECTO/.test(a.prompt), hasDone: /HECHAS: T1/.test(a.prompt) });
    if (a.role === "coder") return { text: "Hecho", sessionId: "c" + seen.length, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } };
    if (a.phase === "plan") return { review: { ...planning, plan: { add: [{ title: "Suma", detail: "", criterion: CRITERIA[0], dependsOn: [] }, { title: "CLI", detail: "", criterion: CRITERIA[1], dependsOn: [] }, { title: "Apoyo", detail: "", criterion: "", dependsOn: [] }], update: [] }, task: "N1" }, sessionId: "d1", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } };
    reviews++;
    const update = reviews === 1 ? [{ id: 1, status: "done", evidence: "ok", note: "" }] : reviews === 2 ? [{ id: 2, status: "done", evidence: "ok", note: "" }] : [{ id: 3, status: "done", evidence: "ok", note: "" }];
    const task = reviews === 1 ? "T2" : reviews === 2 ? "T3" : "";
    return { review: { ...base(reviews >= 3 ? "complete" : "continue"), task, plan: { add: [], update } }, sessionId: "d" + reviews, usage: { input_tokens: 200 * reviews, cached_input_tokens: 50, output_tokens: 20 } };
  } });
  t.after(() => c.close());
  c.updateSettings({ ...c.settings, sessionRefreshRounds: 2 });
  const p = c.addProject(projectInput(dir));
  c.start(p.id);
  await settled(c);
  assert.equal(c.active.status, "complete");
  assert.equal(c.active.round, 3);
  // Director: plan (round 0, new) → review round 1 (resume) → review round 2 (renewed: 2 rounds served) → review round 3 (resume).
  const director = seen.filter((x) => x.role === "auditor");
  assert.deepEqual(director.map((x) => [x.resume ? "resume" : "new", x.full]), [["new", true], ["resume", false], ["new", true], ["resume", false]]);
  assert.ok(director[2].hasPlan && director[2].hasDone, "la sesión nueva recibe el plan con lo hecho");
  // Coder: round 1 new, round 2 resume, round 3 renewed (started in round 1, 2 rounds served).
  const coder = seen.filter((x) => x.role === "coder");
  assert.deepEqual(coder.map((x) => x.resume ? "resume" : "new"), ["new", "resume", "new"]);
  assert.ok(coder[2].full && coder[2].hasPlan);
  assert.deepEqual(c.active.sessionLog.map((x) => [x.role, x.round, x.served]), [["auditor", 2, 2], ["coder", 3, 2]]);
  assert.ok(c.events.some((e) => e.kind === "session" && /Sesión de Codex renovada tras 2 rondas/.test(e.text)));
  const usage = c.snapshot().runs[0].usage;
  assert.equal(usage.refreshes, 2);
  assert.equal(usage.coder.calls, 3);
  assert.equal(usage.coder.context, 300, "contexto = entrada más caché");
  assert.equal(usage.auditor.context, 100 + 200 + 400 + 600);
  assert.equal(c.active.usageLog.filter((u) => u.resumed).length, 3);
  // 0 disables it.
  const d = coordinator(fixture(), { async run(a) { seen.push({ role: a.role, resume: a.agent.resume, off: true }); return a.role === "coder" ? { text: "x", sessionId: "c" } : { review: base(a.phase === "review" && seen.filter((x) => x.off && x.role === "auditor").length >= 4 ? "complete" : "continue"), sessionId: "d" }; } });
  t.after(() => d.close());
  d.updateSettings({ ...d.settings, sessionRefreshRounds: 0 });
  d.start(d.addProject(projectInput(dir)).id);
  await settled(d);
  assert.equal(seen.filter((x) => x.off && !x.resume).length, 2, "solo la primera llamada de cada agente abre sesión");
});

test("si Automata se cierra con la revisión ya entregada, al reabrir el plan no se aplica dos veces y la tarea asignada se conserva", async (t) => {
  const dir = fixture(), store = new Store(path.join(dir, "data"));
  const project = { ...projectInput(dir), id: "p" };
  store.write("projects.json", [project]);
  const runDir = store.runDir("run-1"), work = path.join(runDir, "round-00");
  fs.mkdirSync(work, { recursive: true });
  // The director had answered (its result file exists for the attempt in flight) and the plan was applied before the shutdown.
  fs.writeFileSync(path.join(work, "plan-result.json"), JSON.stringify({ attemptId: "att-1", review: planning, sessionId: "d" }));
  const calls = [];
  const first = new Coordinator(store, { evidence: async () => "", checks: async () => [], resumeDelayMs: 0, agents: { async run() { calls.push("x"); return { text: "x" }; } } });
  first.plan.apply("p", planning.plan, { by: "director", runId: "run-1", round: 0, key: "run-1:0:plan:0", criteria: CRITERIA, decision: "continue", task: "N1" });
  await first.close();
  store.write("runs.json", [{ id: "run-1", projectId: "p", project, settings: validateSettings(), status: "running", stage: "plan", round: 0, checks: [], sessions: {}, gitQueue: [], inflight: { id: "att-1", role: "auditor", phase: "plan", index: 0, dir: work, round: 0 } }]);
  const c = new Coordinator(store, { evidence: async () => "", checks: async () => [], resumeDelayMs: 0, agents: { async run(a) {
    calls.push(`${a.role}:${a.phase}`);
    if (a.role === "coder") return { text: "Hecho" };
    return { review: { ...base("complete"), task: "", plan: { add: [], update: [{ id: 1, status: "done", evidence: "ok", note: "" }, { id: 2, status: "done", evidence: "ok", note: "" }] } } };
  } } });
  t.after(() => c.close());
  c.startAutoResume();
  await new Promise((r) => setTimeout(r, 20));
  await settled(c);
  assert.equal(c.active.status, "complete");
  assert.equal(c.plan.list("p").length, 2, "las dos tareas no se duplicaron");
  assert.deepEqual(calls, ["coder:code", "auditor:review"], "el director no vuelve a planificar");
  assert.equal(c.active.taskId, 1);
});

test("el chat continúa la conversación por proyecto y agente, resume para una sesión nueva y aísla proyectos", async (t) => {
  const dir = fixture(), calls = [];
  const c = coordinator(dir, { async run(a) {
    calls.push({ role: a.role, phase: a.phase, resume: a.agent?.resume ?? null, prompt: a.prompt });
    return { text: `Respuesta ${calls.length}`, sessionId: `${a.role}-s1` };
  } });
  t.after(() => c.close());
  const p = c.addProject(projectInput(dir)), q = c.addProject({ ...projectInput(fixture()), name: "Otro" });
  await c.sendChat({ projectId: p.id, target: "auditor", kind: "question", text: "¿Cómo va la suma?" });
  await c.chatPending;
  await c.sendChat({ projectId: p.id, target: "auditor", kind: "question", text: "¿Y lo de antes?" });
  await c.chatPending;
  assert.equal(calls[0].resume, null);
  assert.equal(calls[1].resume, "auditor-s1", "la segunda consulta retoma la sesión");
  assert.match(calls[1].prompt, /^Seguimos en la misma conversación de este proyecto como Codex/);
  assert.match(calls[1].prompt, /CONSULTA DE SOLO LECTURA/);
  assert.ok(estimateTokens(calls[1].prompt) < estimateTokens(calls[0].prompt), "el prompt corto es corto");
  // Another project does not share the session nor the conversation.
  await c.sendChat({ projectId: q.id, target: "auditor", kind: "question", text: "Hola, ¿qué hay aquí?" });
  await c.chatPending;
  assert.equal(calls[2].resume, null);
  assert.doesNotMatch(calls[2].prompt, /suma/);
  // Reset: the next message opens a fresh session that carries the recent conversation summary.
  c.resetChat(p.id, "auditor");
  await c.sendChat({ projectId: p.id, target: "auditor", kind: "question", text: "¿Resumen?" });
  await c.chatPending;
  assert.equal(calls[3].resume, null);
  assert.match(calls[3].prompt, /CONVERSACIÓN RECIENTE EN ESTE PROYECTO[\s\S]*Tú: ¿Cómo va la suma\? → Respuesta 1[\s\S]*Tú: ¿Y lo de antes\? → Respuesta 2/);
  assert.equal(c.memory.recentExchanges(p.id).length, 3);
  assert.equal(c.memory.recentExchanges(q.id).length, 1);
  assert.equal(c.messages.filter((m) => m.projectId === p.id).length, 3);
});

test("consultas, tareas directas e instrucciones: solo las dos últimas entran al plan, y lo casual no llama a nadie", async (t) => {
  const dir = fixture(), calls = [];
  const c = coordinator(dir, { async run(a) {
    calls.push(`${a.role}:${a.phase}`);
    if (a.role === "coder") {
      a.emit({ role: "coder", kind: "tool", toolId: "w", tool: { name: "Write", path: path.join(dir, "README.md"), content: "x", lines: 1 }, text: "Write" });
      a.emit({ role: "coder", kind: "toolresult", toolId: "w", text: "ok" });
      return { text: "README creado" };
    }
    return { text: "Respuesta" };
  } });
  t.after(() => c.close());
  const p = c.addProject(projectInput(dir));
  for (const text of ["buen trabajo jóvenes!", "¡Buen trabajo, jóvenes!", "gracias", "Hola equipo", "ok", "Good job!", "¡¡Excelente!!"]) {
    const m = await c.sendChat({ projectId: p.id, target: "auditor", kind: "task", text });
    assert.equal(m.status, "answered", text);
    assert.equal(m.casual, true);
    assert.match(m.answers[0].text, /no pide ningún cambio/);
  }
  assert.deepEqual(calls, [], "ningún agente corrió");
  for (const text of ["haz un README", "¿cómo va?", "gracias, ahora agrega pruebas", "Revisa el archivo src/a.js"]) assert.equal(isCasual(text), false, text);
  await c.sendChat({ projectId: p.id, target: "auditor", kind: "question", text: "¿Falta algo?" });
  await c.chatPending;
  assert.equal(c.plan.list(p.id).length, 0, "una consulta no toca el plan");
  const task = await c.sendChat({ projectId: p.id, target: "coder", kind: "task", text: "Haz un README con instrucciones." });
  await c.chatPending;
  assert.equal(task.status, "answered");
  const [userTask] = c.plan.list(p.id);
  assert.deepEqual([userTask.source, userTask.status, userTask.title], ["user", "review", "Haz un README con instrucciones."]);
  assert.match(userTask.evidence, /README creado/);
  assert.equal(task.taskId, userTask.id);
  assert.deepEqual(c.memory.recentExchanges(p.id, { role: "coder" })[0].files, ["README.md"]);
  // An instruction during a run becomes a user task "todo" that the director sees as pending.
  let release;
  const gate = new Promise((r) => release = r);
  const d = coordinator(fixture(), { async run(a) {
    if (a.role === "coder") { await gate; return { text: "x" }; }
    calls.push(a.prompt);
    return { review: a.phase === "plan" ? planning : { ...base("complete"), task: "", plan: { add: [], update: [{ id: 1, status: "done", evidence: "ok", note: "" }, { id: 2, status: "done", evidence: "ok", note: "" }, { id: 3, status: "dropped", evidence: "", note: "ya existe" }] } } };
  } });
  t.after(() => d.close());
  const q = d.addProject(projectInput(dir));
  d.start(q.id);
  await new Promise((r) => setTimeout(r, 30));
  const instruction = await d.sendChat({ projectId: q.id, target: "auditor", kind: "instruction", text: "Agrega también un modo oscuro." });
  release();
  await settled(d);
  assert.equal(instruction.status, "delivered");
  assert.match(instruction.answer, /anotada en el plan como T3/);
  assert.match(calls.at(-1), /PEDIDAS POR EL USUARIO \(asígnalas o descártalas con motivo\):\n- T3 «Agrega también un modo oscuro\.»/);
  assert.match(calls.at(-1), /PETICIONES DEL USUARIO DESDE TU ÚLTIMA REVISIÓN[\s\S]*instrucción · Codex[\s\S]*modo oscuro/);
  assert.equal(d.active.status, "complete");
  assert.equal(d.plan.list(q.id).find((x) => x.id === 3).status, "dropped");
});

test("el panel y la API del plan: agregar ligado o libre, corregir, reordenar, descartar y restaurar, con historial y sin borrar", async (t) => {
  const dir = fixture();
  const app = await createServer({ port: 0, demo: true, dataDir: path.join(dir, "data") });
  t.after(() => app.close());
  const headers = { Authorization: "Bearer " + app.token, "Content-Type": "application/json" };
  const call = async (body) => {
    const response = await fetch(app.origin + "/api/plan", { method: "POST", headers, body: JSON.stringify({ projectId: "demo", ...body }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  };
  const criterion = app.coordinator.projects[0].criteria[0];
  const linked = await call({ action: "add", title: "Probar el saludo", criterion });
  assert.equal(linked.task.criterion, criterion);
  const free = await call({ action: "add", title: "Documentar", detail: "README" });
  assert.equal(free.task.criterion, "");
  await assert.rejects(call({ action: "add", title: "Mal", criterion: "inventado" }), /criterio que no existe/);
  await call({ action: "update", id: free.task.id, title: "Documentar en README", dependsOn: [`T${linked.task.id}`] });
  await assert.rejects(call({ action: "update", id: free.task.id, status: "doing" }), /depende de T1 \(pendiente\)/);
  await call({ action: "reorder", ids: [free.task.id, linked.task.id] });
  const dropped = await call({ action: "drop", id: free.task.id, note: "no hace falta" });
  assert.deepEqual(dropped.tasks.map((x) => [x.id, x.status, x.position]), [[2, "dropped", 1], [1, "todo", 2]]);
  const restored = await call({ action: "restore", id: free.task.id });
  assert.equal(restored.tasks[0].status, "todo");
  const history = await call({ action: "history", id: free.task.id });
  assert.deepEqual(history.history.map((h) => h.action), ["add", "dependencies", "title", "reorder", "note", "status", "status"]);
  assert.equal(history.history.every((h) => h.by === "user"), true);
  const listed = await call({ action: "list" });
  assert.equal(listed.stats.total, 2);
  const state = await (await fetch(app.origin + "/api/state", { headers })).json();
  assert.equal(state.plans.demo.total, 2);
  // The demo director keeps the plan too: it adds its task and confirms it when approving. The user's
  // task linked to the criterion would keep the goal open, so it is dropped first; the free one does not block.
  await call({ action: "drop", id: linked.task.id, note: "la hará el director" });
  app.coordinator.start("demo");
  await settled(app.coordinator);
  assert.equal(app.coordinator.active.status, "complete");
  assert.equal(app.coordinator.plan.list("demo").find((x) => x.source === "director")?.status, "done");
  assert.equal(app.coordinator.plan.list("demo").find((x) => x.id === free.task.id)?.status, "todo", "una tarea libre no impide completar");
  const reset = await fetch(app.origin + "/api/chat", { method: "POST", headers, body: JSON.stringify({ action: "reset", projectId: "demo" }) });
  assert.equal(reset.status, 200);
  const caps = await (await fetch(app.origin + "/api/capabilities", { headers })).json();
  assert.equal(caps.features.plan, true);
  assert.equal(validateSettings().sessionRefreshRounds, 8);
  assert.throws(() => validateSettings({ sessionRefreshRounds: 51 }), /sessionRefreshRounds/);
});

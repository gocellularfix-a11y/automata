// P2: the persistent plan store and the conversation memory, on their own.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../server/memory.mjs";
import { PlanStore, PLAN_BUDGET_TOKENS, MAX_TASKS, normalizePlanOps } from "../server/plan.mjs";
import { estimateTokens } from "../server/redact.mjs";
const temporary = [];
after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });
function stores() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-plan-"));
  temporary.push(dir);
  const memory = new MemoryStore(path.join(dir, "memory"));
  return { dir, memory, plan: new PlanStore(memory) };
}
const CRITERIA = ["La suma funciona.", "La CLI imprime JSON."];
const P = "proyecto-a";

test("las tareas se crean con dependencias entre nuevas y existentes, conservan ids e historial, y el plan sobrevive a reabrir el archivo", () => {
  const { dir, memory, plan } = stores();
  const first = plan.apply(P, { add: [{ title: "Módulo suma", criterion: CRITERIA[0] }, { title: "CLI", criterion: CRITERIA[1], dependsOn: ["N1"] }] }, { runId: "r1", round: 0, key: "r1:0:plan:0", criteria: CRITERIA, requireCoverage: true });
  assert.deepEqual(first.added, [1, 2]);
  const tasks = plan.list(P);
  assert.deepEqual(tasks.map((t) => [t.id, t.status, t.dependsOn, t.position]), [[1, "todo", [], 1], [2, "todo", [1], 2]]);
  // The same key again does nothing (a restart that re-applies the same review).
  assert.equal(plan.apply(P, { add: [{ title: "otra" }] }, { key: "r1:0:plan:0" }).skipped, true);
  assert.equal(plan.list(P).length, 2);
  plan.apply(P, { add: [{ title: "README", dependsOn: ["T2"] }], update: [{ id: 1, status: "doing" }] }, { runId: "r1", round: 1 });
  const reopened = new PlanStore(new MemoryStore(path.join(dir, "memory")));
  assert.deepEqual(reopened.list(P).map((t) => [t.id, t.status, t.dependsOn]), [[1, "doing", []], [2, "todo", [1]], [3, "todo", [2]]]);
  assert.deepEqual(reopened.history(P, 1).map((h) => [h.action, h.before, h.after]), [["add", null, "Módulo suma"], ["status", "todo", "doing"]]);
  assert.equal(memory.stats(P).facts, 0, "el plan no es un recuerdo");
  assert.equal(normalizePlanOps(null), null);
});

test("las transiciones, las dependencias, los ciclos y las referencias se validan y una decisión inválida no deja rastro", () => {
  const { plan } = stores();
  plan.apply(P, { add: [{ title: "A" }, { title: "B", dependsOn: ["N1"] }, { title: "C", dependsOn: ["N2"] }] }, {});
  const rejects = (ops, pattern) => {
    const before = JSON.stringify(plan.list(P));
    assert.throws(() => plan.apply(P, ops, { criteria: CRITERIA }), (e) => e.kind === "malformed" && pattern.test(e.message), pattern.source);
    assert.equal(JSON.stringify(plan.list(P)), before, "nada cambió");
  };
  rejects({ update: [{ id: 2, status: "doing" }] }, /T2 .* no puede estar en curso: depende de T1 \(pendiente\)/);
  rejects({ update: [{ id: 1, status: "done" }] }, /indica la evidencia/);
  rejects({ update: [{ id: 1, status: "dropped" }] }, /indica el motivo/);
  rejects({ update: [{ id: 1, status: "blocked" }] }, /indica qué falta/);
  rejects({ update: [{ id: 1, status: "flying" }] }, /estado «flying» no válido/);
  rejects({ update: [{ id: 9, status: "doing" }] }, /T9 no existe/);
  rejects({ update: [{ id: 1, dependsOn: ["T3"] }] }, /ciclo de dependencias: T1 → T3 → T2 → T1|ciclo/);
  rejects({ update: [{ id: 1, dependsOn: ["X1"] }] }, /referencia «X1» no válida/);
  rejects({ add: [{ title: "D", dependsOn: ["N5"] }] }, /no hay una tarea nueva N5/);
  rejects({ add: [{ title: "" }] }, /N1 no tiene título/);
  rejects({ add: [{ title: "E", criterion: "Un criterio inventado" }] }, /cita un criterio que no existe/);
  // A valid sequence: A done with evidence, then B can start; done cannot jump to dropped.
  plan.apply(P, { update: [{ id: 1, status: "done", evidence: "npm test en verde" }, { id: 2, status: "doing" }] }, {});
  assert.deepEqual(plan.list(P).map((t) => t.status), ["done", "doing", "todo"]);
  rejects({ update: [{ id: 1, status: "dropped", note: "x" }] }, /no puede pasar de hecha a descartada/);
  // Reopening a done task whose dependents are doing is refused by the dependency rule.
  rejects({ update: [{ id: 1, status: "todo" }] }, /T2 .* no puede estar en curso/);
  // At most 40 new tasks per decision and MAX_TASKS in the whole plan.
  assert.throws(() => { for (let i = 0; i < 4; i++) plan.apply(P, { add: Array.from({ length: 40 }, (_, j) => ({ title: `t${i}-${j}` })) }, {}); }, /más de/);
  assert.ok(plan.list(P).length <= MAX_TASKS);
});

test("la cobertura de criterios y las reglas de complete y continue: descartar no cumple un criterio", () => {
  const { plan } = stores();
  assert.throws(() => plan.apply(P, { add: [{ title: "Solo suma", criterion: CRITERIA[0] }] }, { criteria: CRITERIA, requireCoverage: true }), /Sin tarea: «La CLI imprime JSON\.»/);
  assert.equal(plan.list(P).length, 0);
  plan.apply(P, { add: [{ title: "Suma", criterion: CRITERIA[0] }, { title: "CLI", criterion: CRITERIA[1], dependsOn: ["N1"] }, { title: "Extra sin criterio" }] }, { criteria: CRITERIA, requireCoverage: true });
  assert.match(plan.problemFor(P, "continue", { task: "", criteria: CRITERIA }), /Indica en task la tarea del plan .* T1 o T2 o T3/);
  assert.match(plan.problemFor(P, "continue", { task: "T2", criteria: CRITERIA }), /T2 depende de T1 \(pendiente\)/);
  assert.equal(plan.problemFor(P, "continue", { task: "T1", criteria: CRITERIA }), null);
  assert.match(plan.problemFor(P, "continue", { task: "T7" }), /no existe/);
  assert.match(plan.problemFor(P, "complete", { criteria: CRITERIA }), /quedan tareas ligadas a criterios sin cerrar: T1/);
  plan.apply(P, { update: [{ id: 1, status: "done", evidence: "ok" }, { id: 2, status: "dropped", note: "no hace falta" }] }, {});
  assert.match(plan.problemFor(P, "complete", { criteria: CRITERIA }), /descartar una tarea no cumple su criterio.*«La CLI imprime JSON\.»/);
  plan.apply(P, { update: [{ id: 2, status: "todo" }] }, {});
  plan.apply(P, { update: [{ id: 2, status: "done", evidence: "cli ok" }] }, {});
  assert.equal(plan.problemFor(P, "complete", { criteria: CRITERIA }), null, "la tarea libre T3 no impide completar");
  assert.match(plan.problemFor(P, "continue", { task: "T1" }), /ya está hecha/);
  const stats = plan.stats(P, CRITERIA);
  assert.equal(stats.done, 2);
  assert.deepEqual(stats.byCriterion.map((c) => c.covered), [true, true]);
  assert.equal(new PlanStore(stores().memory).problemFor("otro", "complete", { criteria: CRITERIA }), null, "sin plan no hay reglas de plan");
});

test("el bloque del plan cabe en 800 tokens, pone primero la tarea actual y adapta el texto a Claude", () => {
  const { plan } = stores();
  // At most 40 tasks per decision; two decisions build a big plan.
  for (const batch of [0, 30]) plan.apply(P, { add: Array.from({ length: 30 }, (_, i) => ({ title: `Tarea número ${batch + i + 1} con un título razonablemente largo para ocupar espacio`, detail: "Detalle ".repeat(20), criterion: i % 2 ? CRITERIA[1] : CRITERIA[0] })) }, {});
  plan.apply(P, { update: [{ id: 1, status: "done", evidence: "ok" }, { id: 2, status: "doing" }, { id: 3, status: "blocked", note: "falta el JDK" }] }, {});
  plan.addUserTask(P, { title: "Quiero un modo oscuro", detail: "pedido en el chat" });
  const director = plan.brief(P, { current: 2 });
  assert.ok(director.tokens <= PLAN_BUDGET_TOKENS && estimateTokens(director.text) <= PLAN_BUDGET_TOKENS, String(director.tokens));
  assert.match(director.text, /^PLAN DEL PROYECTO \(1 de 61 tareas hechas; lo mantienes tú/);
  assert.match(director.text, /TAREA ASIGNADA: T2 «Tarea número 2/);
  assert.match(director.text, /PEDIDAS POR EL USUARIO \(asígnalas o descártalas con motivo\):\n- T61 «Quiero un modo oscuro»/);
  assert.match(director.text, /BLOQUEADAS:\n- T3 .*falta el JDK/);
  assert.match(director.text, /HECHAS: T1/);
  const coder = plan.brief(P, { current: 2, forCoder: true });
  assert.match(coder.text, /TU TAREA AHORA: T2/);
  assert.match(coder.text, /OTRAS TAREAS DEL PLAN \(no las hagas ahora\):/);
  assert.doesNotMatch(coder.text, /plan\.add/);
  assert.equal(plan.brief("sin-plan").text, "");
});

test("la memoria conversacional guarda sesiones por agente, intercambios resumidos y un bloque breve, aislados por proyecto", () => {
  const { memory } = stores();
  assert.equal(memory.chatSession(P, "coder"), null);
  memory.setChatSession(P, "coder", "s-1");
  memory.setChatSession(P, "coder", "s-1");
  assert.equal(memory.chatSession(P, "coder").turns, 2);
  memory.setChatSession(P, "coder", "s-2");
  assert.deepEqual([memory.chatSession(P, "coder").session_id, memory.chatSession(P, "coder").turns], ["s-2", 1]);
  memory.recordExchange(P, { role: "auditor", kind: "question", request: "¿Cómo va?", answer: "Bien; falta la CLI. password=Secreto123!", files: [] });
  memory.recordExchange(P, { role: "coder", kind: "task", request: "Haz un README", answer: "README.md creado", files: ["README.md", ".env"] });
  const rows = memory.recentExchanges(P, { limit: 5 });
  assert.deepEqual(rows.map((r) => [r.role, r.kind, r.files]), [["auditor", "question", []], ["coder", "task", ["README.md"]]]);
  assert.doesNotMatch(rows[0].answer, /Secreto123/);
  const brief = memory.conversationBrief(P);
  assert.match(brief, /CONVERSACIÓN RECIENTE[\s\S]*\[consulta · Codex[\s\S]*Tú: ¿Cómo va\? → Bien[\s\S]*\[trabajo · Claude/);
  assert.ok(estimateTokens(brief) <= 400);
  assert.equal(memory.conversationBrief("otro-proyecto"), "", "otro proyecto no ve nada");
  assert.equal(memory.chatSession("otro-proyecto", "coder"), null);
  assert.equal(memory.resetChatSession(P, "coder"), 1);
  assert.equal(memory.chatSession(P, "coder"), null);
  assert.equal(memory.recentExchanges(P, { since: new Date(Date.now() + 1000).toISOString() }).length, 0);
});

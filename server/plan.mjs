// The project plan: tasks the director keeps, each linked (or not) to an acceptance criterion,
// with dependencies, a status, evidence and a full history. It lives in the project's memory
// file (memory.mjs, schema 2), so it survives runs and restarts and never crosses projects.
//
// The director changes it through its review (plan.add / plan.update and the task it assigns);
// the user through the Plan panel. Every change is validated inside one transaction: a bad
// decision rolls back whole and goes back to the director with the reason (P1's correction loop).
import { redactSecrets, allocateBudget, estimateTokens } from "./redact.mjs";
export const TASK_STATUSES = ["todo", "doing", "review", "done", "blocked", "dropped"];
// From → allowed next states. "review": done according to Claude, waiting for the director to confirm.
const TRANSITIONS = {
  todo: ["doing", "review", "done", "blocked", "dropped"],
  doing: ["todo", "review", "done", "blocked", "dropped"],
  review: ["todo", "doing", "done", "blocked", "dropped"],
  done: ["todo", "doing"],
  blocked: ["todo", "doing", "dropped"],
  dropped: ["todo"]
};
export const PLAN_BUDGET_TOKENS = 800;
export const MAX_TASKS = 120;
const LABELS = { todo: "pendiente", doing: "en curso", review: "por confirmar", done: "hecha", blocked: "bloqueada", dropped: "descartada" };
const now = () => new Date().toISOString();
const clip = (text, max) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
};
const clean = (text, max) => clip(redactSecrets(String(text ?? "")), max);
// A plan problem is the director's to fix: same kind as an invalid review.
export const invalidPlan = (message) => Object.assign(new Error(message), { kind: "malformed", role: "auditor", plan: true });
const parseDeps = (row) => ({ ...row, dependsOn: JSON.parse(row.depends_on || "[]") });
// Dependency references in a review: "T12" (existing task) or "N2" (the second task of the same add list).
const REF = /^([TN])(\d+)$/i;
export function normalizePlanOps(plan) {
  if (!plan || typeof plan !== "object") return null;
  const add = (Array.isArray(plan.add) ? plan.add : []).slice(0, 40).map((item) => ({
    title: clean(item?.title, 140), detail: clean(item?.detail, 600), criterion: clean(item?.criterion, 2000),
    dependsOn: (Array.isArray(item?.dependsOn) ? item.dependsOn : []).map((ref) => String(ref).trim().toUpperCase()).filter(Boolean).slice(0, 12)
  }));
  const update = (Array.isArray(plan.update) ? plan.update : []).slice(0, 60).map((item) => ({
    id: Number(item?.id), status: item?.status ? String(item.status).trim().toLowerCase() : null,
    evidence: item?.evidence == null ? null : clean(item.evidence, 600), note: item?.note == null ? null : clean(item.note, 300),
    dependsOn: Array.isArray(item?.dependsOn) ? item.dependsOn.map((ref) => String(ref).trim().toUpperCase()).filter(Boolean).slice(0, 12) : null,
    // Text edits come from the Plan panel, not from the director.
    title: item?.title == null ? null : clean(item.title, 140), detail: item?.detail == null ? null : clean(item.detail, 600), criterion: item?.criterion == null ? null : clean(item.criterion, 2000)
  }));
  return { add, update };
}
// Rules a decision must satisfy once the changes are in: pure, so apply() can check them before committing.
// requireTask: false for reviews that do not carry a plan field (simulated agents): they may continue without naming a task.
export function planProblem(tasks, decision, { task = "", criteria = [], requireTask = true } = {}) {
  if (!tasks.length) return null;
  if (decision === "continue" && !requireTask && !REF.test(String(task ?? "").trim().toUpperCase())) return null;
  if (decision === "complete") {
    const open = tasks.filter((t) => ["todo", "doing", "review", "blocked"].includes(t.status) && t.criterion);
    if (open.length) return `No se puede completar: quedan tareas ligadas a criterios sin cerrar: ${open.slice(0, 5).map((t) => `T${t.id} «${clip(t.title, 50)}» (${LABELS[t.status]})`).join(", ")}.`;
    const missing = criteria.filter((criterion) => tasks.some((t) => t.criterion === criterion) && !tasks.some((t) => t.criterion === criterion && t.status === "done"));
    if (missing.length) return `No se puede completar: descartar una tarea no cumple su criterio. Criterios sin ninguna tarea hecha: ${missing.map((c) => `«${clip(c, 60)}»`).join("; ")}.`;
    return null;
  }
  if (decision === "continue") {
    const m = REF.exec(String(task ?? "").trim().toUpperCase());
    const open = tasks.filter((t) => ["todo", "doing", "review", "blocked"].includes(t.status));
    if (!m || m[1] !== "T") return open.length ? `Indica en task la tarea del plan que asignas a Claude (T<id>), por ejemplo ${open.slice(0, 3).map((t) => `T${t.id}`).join(" o ")}.` : "El plan no tiene tareas abiertas: agrega las que falten en plan.add y asigna una en task.";
    const target = tasks.find((t) => t.id === Number(m[2]));
    if (!target) return `La tarea ${m[0]} no existe en el plan.`;
    if (["done", "dropped"].includes(target.status)) return `La tarea T${target.id} ya está ${LABELS[target.status]}; asigna una tarea abierta.`;
    const blocking = target.dependsOn.map((id) => tasks.find((t) => t.id === id)).filter((dep) => dep && dep.status !== "done");
    if (blocking.length) return `La tarea T${target.id} depende de ${blocking.map((d) => `T${d.id} (${LABELS[d.status]})`).join(", ")}; asigna primero una de esas o cambia las dependencias.`;
  }
  return null;
}
export class PlanStore {
  constructor(memory) {
    this.memory = memory;
  }
  list(projectId, { status = "all" } = {}) {
    return this.memory.open(projectId, { write: false }, (db) => {
      if (!db) return [];
      const rows = status === "all" ? db.prepare("SELECT * FROM tasks ORDER BY position, id").all() : db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY position, id").all(status);
      return rows.map(parseDeps);
    });
  }
  get(projectId, id) {
    return this.list(projectId).find((t) => t.id === Number(id)) ?? null;
  }
  history(projectId, id) {
    return this.memory.open(projectId, { write: false }, (db) => db ? db.prepare("SELECT * FROM task_history WHERE task_id = ? ORDER BY id").all(Number(id)) : []);
  }
  // Counts for the UI and the prompts, plus the state of every acceptance criterion according to the plan.
  stats(projectId, criteria = []) {
    const tasks = this.list(projectId);
    const count = (status) => tasks.filter((t) => t.status === status).length;
    const byCriterion = criteria.map((criterion) => {
      const linked = tasks.filter((t) => t.criterion === criterion);
      const open = linked.filter((t) => ["todo", "doing", "review", "blocked"].includes(t.status)).length;
      const done = linked.filter((t) => t.status === "done").length;
      return { criterion, total: linked.length, done, open, covered: linked.length > 0 && open === 0 && done > 0 };
    });
    const active = tasks.filter((t) => t.status !== "dropped").length;
    return { total: tasks.length, active, todo: count("todo"), doing: count("doing"), review: count("review"), done: count("done"), blocked: count("blocked"), dropped: count("dropped"), byCriterion };
  }
  // Applies a set of changes atomically. key: once applied, the same key is ignored (restart safety).
  // Throws invalidPlan with the first problem found; nothing is written in that case.
  // decision/task: when given, the decision's own rules (planProblem) are checked before committing, so a
  // review refused for its task reference leaves the plan exactly as it was.
  apply(projectId, ops, { by = "director", runId = null, round = null, key = null, criteria = [], requireCoverage = false, decision = null, task = "", requireTask = true } = {}) {
    const plan = normalizePlanOps(ops) ?? { add: [], update: [] };
    return this.memory.transaction(projectId, (db) => {
      const already = key ? db.prepare("SELECT summary FROM plan_applied WHERE key = ?").get(key) : null;
      if (already) {
        // Applied before the restart: the same outcome (including the task that was assigned) is returned.
        let saved = {};
        try { saved = JSON.parse(already.summary); } catch {}
        const tasks = db.prepare("SELECT * FROM tasks ORDER BY position, id").all().map(parseDeps);
        return { applied: false, added: [], updated: [], skipped: true, taskId: saved.taskId ?? this.taskIdOf(task), tasks };
      }
      const at = now();
      const existing = () => db.prepare("SELECT * FROM tasks ORDER BY position, id").all().map(parseDeps);
      const before = existing();
      if (before.length + plan.add.length > MAX_TASKS) throw invalidPlan(`El plan no puede tener más de ${MAX_TASKS} tareas.`);
      const log = (taskId, action, prev, next) => db.prepare("INSERT INTO task_history (task_id, action, before, after, by, run_id, round, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(taskId, action, prev == null ? null : String(prev), next == null ? null : String(next), by, runId, round, at);
      // Adds first, so updates and dependencies can refer to the new ids.
      const newIds = [];
      let position = before.length ? Math.max(...before.map((t) => t.position)) + 1 : 1;
      for (const [index, item] of plan.add.entries()) {
        if (!item.title) throw invalidPlan(`La tarea nueva N${index + 1} no tiene título.`);
        if (item.criterion && criteria.length && !criteria.includes(item.criterion)) throw invalidPlan(`La tarea nueva N${index + 1} cita un criterio que no existe: «${clip(item.criterion, 80)}». Usa el texto exacto de un criterio o deja criterion vacío.`);
        const { lastInsertRowid } = db.prepare("INSERT INTO tasks (title, detail, criterion, status, depends_on, position, source, created_run, created_round, created_at, updated_at) VALUES (?, ?, ?, 'todo', '[]', ?, ?, ?, ?, ?, ?)").run(item.title, item.detail, item.criterion, position++, by, runId, round, at, at);
        newIds.push(Number(lastInsertRowid));
        log(Number(lastInsertRowid), "add", null, item.title);
      }
      const resolveRef = (ref, where) => {
        const m = REF.exec(String(ref));
        if (!m) throw invalidPlan(`${where}: referencia «${ref}» no válida. Usa T<id> para una tarea existente o N<n> para la n-ésima tarea nueva.`);
        if (m[1] === "N") {
          const id = newIds[Number(m[2]) - 1];
          if (!id) throw invalidPlan(`${where}: no hay una tarea nueva N${m[2]}.`);
          return id;
        }
        const id = Number(m[2]);
        if (!db.prepare("SELECT id FROM tasks WHERE id = ?").get(id)) throw invalidPlan(`${where}: la tarea T${id} no existe.`);
        return id;
      };
      for (const [index, item] of plan.add.entries()) {
        if (!item.dependsOn.length) continue;
        const deps = [...new Set(item.dependsOn.map((ref) => resolveRef(ref, `Tarea nueva N${index + 1}`)))].filter((id) => id !== newIds[index]);
        db.prepare("UPDATE tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify(deps), newIds[index]);
      }
      const updated = [];
      for (const item of plan.update) {
        if (!Number.isInteger(item.id)) throw invalidPlan("plan.update: cada cambio necesita el id numérico de una tarea existente.");
        const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(item.id);
        if (!task) throw invalidPlan(`plan.update: la tarea T${item.id} no existe.`);
        const where = `Tarea T${task.id} «${clip(task.title, 50)}»`;
        if (item.dependsOn) {
          const deps = [...new Set(item.dependsOn.map((ref) => resolveRef(ref, where)))].filter((id) => id !== task.id);
          db.prepare("UPDATE tasks SET depends_on = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(deps), at, task.id);
          log(task.id, "dependencies", task.depends_on, JSON.stringify(deps));
        }
        if (item.evidence != null && item.evidence !== task.evidence) {
          db.prepare("UPDATE tasks SET evidence = ?, updated_at = ? WHERE id = ?").run(item.evidence, at, task.id);
          log(task.id, "evidence", task.evidence, item.evidence);
        }
        if (item.note != null && item.note !== task.note) {
          db.prepare("UPDATE tasks SET note = ?, updated_at = ? WHERE id = ?").run(item.note, at, task.id);
          log(task.id, "note", task.note, item.note);
        }
        for (const field of ["title", "detail", "criterion"]) if (item[field] != null && item[field] !== task[field]) {
          if (field === "title" && !item.title) throw invalidPlan(`${where}: el título no puede quedar vacío.`);
          if (field === "criterion" && item.criterion && criteria.length && !criteria.includes(item.criterion)) throw invalidPlan(`${where}: el criterio debe ser el texto exacto de un criterio del proyecto, o vacío.`);
          db.prepare(`UPDATE tasks SET ${field} = ?, updated_at = ? WHERE id = ?`).run(item[field], at, task.id);
          log(task.id, field, task[field], item[field]);
        }
        if (item.status && item.status !== task.status) {
          if (!TASK_STATUSES.includes(item.status)) throw invalidPlan(`${where}: estado «${item.status}» no válido. Usa ${TASK_STATUSES.join(", ")}.`);
          if (!TRANSITIONS[task.status].includes(item.status)) throw invalidPlan(`${where}: no puede pasar de ${LABELS[task.status]} a ${LABELS[item.status]}.`);
          const evidence = item.evidence ?? task.evidence;
          if (item.status === "done" && !evidence.trim()) throw invalidPlan(`${where}: para marcarla hecha indica la evidencia comprobada.`);
          if (item.status === "dropped" && !(item.note ?? task.note).trim()) throw invalidPlan(`${where}: para descartarla indica el motivo en note.`);
          if (item.status === "blocked" && !(item.note ?? task.note).trim()) throw invalidPlan(`${where}: para bloquearla indica qué falta en note.`);
          const closing = ["done", "dropped"].includes(item.status);
          db.prepare("UPDATE tasks SET status = ?, closed_run = ?, closed_round = ?, updated_at = ? WHERE id = ?").run(item.status, closing ? runId : null, closing ? round : null, at, task.id);
          log(task.id, "status", task.status, item.status);
        }
        updated.push(task.id);
      }
      // Whole-plan rules, after every change: no cycles, and nothing "doing" or "done" with an open dependency.
      const after = existing();
      const byId = new Map(after.map((t) => [t.id, t]));
      const visiting = new Set(), finished = new Set();
      const visit = (task, trail) => {
        if (finished.has(task.id)) return;
        if (visiting.has(task.id)) throw invalidPlan(`Hay un ciclo de dependencias: ${[...trail, "T" + task.id].join(" → ")}.`);
        visiting.add(task.id);
        for (const dep of task.dependsOn) {
          const target = byId.get(dep);
          if (!target) throw invalidPlan(`Tarea T${task.id}: depende de T${dep}, que no existe.`);
          visit(target, [...trail, "T" + task.id]);
        }
        visiting.delete(task.id);
        finished.add(task.id);
      };
      for (const task of after) visit(task, []);
      for (const task of after) if (["doing", "done"].includes(task.status)) {
        const open = task.dependsOn.map((id) => byId.get(id)).filter((dep) => dep && dep.status !== "done");
        if (open.length) throw invalidPlan(`Tarea T${task.id} «${clip(task.title, 50)}» no puede estar ${LABELS[task.status]}: depende de ${open.map((d) => `T${d.id} (${LABELS[d.status]})`).join(", ")}.`);
      }
      if (requireCoverage && criteria.length) {
        const uncovered = criteria.filter((criterion) => !after.some((t) => t.criterion === criterion && t.status !== "dropped"));
        if (uncovered.length) throw invalidPlan(`Cada criterio de aceptación necesita al menos una tarea en el plan. Sin tarea: ${uncovered.map((c) => `«${clip(c, 70)}»`).join("; ")}.`);
      }
      let taskId = null;
      if (decision) {
        const ref = String(task ?? "").trim().toUpperCase();
        if (decision === "continue" && /^N\d+$/.test(ref)) taskId = resolveRef(ref, "task");
        const problem = planProblem(after, decision, { task: taskId ? `T${taskId}` : ref, criteria, requireTask });
        if (problem) throw invalidPlan(problem);
        if (decision === "continue") taskId ??= this.taskIdOf(ref);
      }
      if (key) db.prepare("INSERT INTO plan_applied (key, at, summary) VALUES (?, ?, ?)").run(key, at, JSON.stringify({ added: newIds, updated, taskId }));
      return { applied: true, added: newIds, updated, skipped: false, taskId, tasks: after };
    });
  }
  // What Automata itself records: the task sent to Claude is "doing"; a direct chat task becomes a task of the user's.
  setStatus(projectId, id, status, { by = "automata", runId = null, round = null, evidence = null, note = null } = {}) {
    return this.apply(projectId, { update: [{ id, status, evidence, note }] }, { by, runId, round });
  }
  addUserTask(projectId, { title, detail = "", criterion = "", status = "todo", evidence = "", note = "", by = "user", runId = null, round = null, criteria = [] }) {
    const result = this.apply(projectId, { add: [{ title, detail, criterion, dependsOn: [] }] }, { by, runId, round, criteria });
    const id = result.added[0];
    if (status !== "todo") this.apply(projectId, { update: [{ id, status, evidence, note }] }, { by, runId, round });
    return this.list(projectId).find((t) => t.id === id);
  }
  reorder(projectId, ids) {
    return this.memory.transaction(projectId, (db) => {
      const at = now();
      ids.map(Number).forEach((id, index) => db.prepare("UPDATE tasks SET position = ?, updated_at = ? WHERE id = ?").run(index + 1, at, id));
      return true;
    });
  }
  // Is the plan ready for the director's decision? Returns the problem, or null.
  problemFor(projectId, decision, options = {}) {
    return planProblem(this.list(projectId), decision, options);
  }
  taskIdOf(ref) {
    const m = REF.exec(String(ref ?? "").trim().toUpperCase());
    return m && m[1] === "T" ? Number(m[2]) : null;
  }
  // The compact block for the prompts, within PLAN_BUDGET_TOKENS: the current task in full, then the rest by title.
  brief(projectId, { current = null, budgetTokens = PLAN_BUDGET_TOKENS, forCoder = false } = {}) {
    const tasks = this.list(projectId);
    if (!tasks.length) return { text: "", tokens: 0, tasks: 0 };
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const depText = (t) => t.dependsOn.length ? ` · depende de ${t.dependsOn.map((id) => `T${id}${byId.get(id)?.status === "done" ? " ✓" : ` (${LABELS[byId.get(id)?.status] ?? "?"})`}`).join(", ")}` : "";
    const line = (t) => `- T${t.id} «${clip(t.title, 90)}»${t.criterion ? ` · criterio: ${clip(t.criterion, 60)}` : ""}${depText(t)}${t.status === "blocked" || t.status === "dropped" ? ` · ${t.note ? clip(t.note, 90) : ""}` : ""}`;
    const full = (t) => `T${t.id} «${t.title}»${t.criterion ? `\n  Criterio: ${t.criterion}` : ""}${t.detail ? `\n  Detalle: ${t.detail}` : ""}${depText(t) ? `\n  Depende de${depText(t).replace(" · depende de", "")}` : ""}${t.evidence ? `\n  Evidencia previa: ${clip(t.evidence, 200)}` : ""}`;
    const done = tasks.filter((t) => t.status === "done"), doing = tasks.filter((t) => t.status === "doing"), review = tasks.filter((t) => t.status === "review"), todo = tasks.filter((t) => t.status === "todo"), blocked = tasks.filter((t) => t.status === "blocked"), user = tasks.filter((t) => t.source === "user" && ["todo", "review"].includes(t.status));
    const currentTask = current ? byId.get(Number(current)) : null;
    const head = `PLAN DEL PROYECTO (${done.length} de ${tasks.filter((t) => t.status !== "dropped").length} tareas hechas${forCoder ? "; lo mantiene el director" : "; lo mantienes tú con plan.add, plan.update y task"}):`;
    const section = (title, list, max, render = line) => list.length ? `${title}\n${list.slice(0, max).map(render).join("\n")}${list.length > max ? `\n  … y ${list.length - max} más` : ""}` : "";
    const sections = [
      { id: "head", minTokens: 10, content: head },
      { id: "current", minTokens: 40, content: currentTask ? `${forCoder ? "TU TAREA AHORA" : "TAREA ASIGNADA"}: ${full(currentTask)}` : "" },
      { id: "doing", minTokens: 20, content: section("EN CURSO:", doing.filter((t) => t !== currentTask), 4) },
      { id: "review", minTokens: 20, content: section(forCoder ? "POR CONFIRMAR POR EL DIRECTOR:" : "POR CONFIRMAR (tareas directas del usuario; confírmalas como hechas con evidencia o devuélvelas a todo):", review, 4) },
      { id: "user", minTokens: 20, content: section(forCoder ? "PEDIDAS POR EL USUARIO:" : "PEDIDAS POR EL USUARIO (asígnalas o descártalas con motivo):", user.filter((t) => t.status === "todo"), 4) },
      { id: "blocked", minTokens: 20, content: section("BLOQUEADAS:", blocked, 4) },
      { id: "todo", minTokens: 20, content: section(forCoder ? "OTRAS TAREAS DEL PLAN (no las hagas ahora):" : "SIGUIENTES:", todo.filter((t) => t.source !== "user" && t !== currentTask), forCoder ? 5 : 8) },
      { id: "done", minTokens: 10, content: done.length ? `HECHAS: ${done.map((t) => `T${t.id}`).join(", ")}` : "" }
    ];
    const text = allocateBudget(sections, budgetTokens).filter((s) => s.content).map((s) => s.content).join("\n");
    return { text, tokens: estimateTokens(text), tasks: tasks.length };
  }
}
export const taskLabel = (status) => LABELS[status] ?? status;

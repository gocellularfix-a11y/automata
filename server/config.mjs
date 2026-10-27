import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { directoryProblem } from "./safety.mjs";
import { defaultBudget } from "./resources.mjs";
export const MODES = {
  small: { label: "Pequeño", description: "Un cambio concreto por ronda. Audita antes de avanzar.", turns: 20 },
  medium: { label: "Mediano", description: "Una funcionalidad acotada por ronda, con sus verificaciones.", turns: 45 },
  large: { label: "Largo", description: "Una fase coherente por ronda, con hitos y reporte de evidencia.", turns: 80 }
};
export const MODELS = {
  coder: [
    { id: "haiku", label: "Haiku", detail: "Ágil y ligero" },
    { id: "sonnet", label: "Sonnet", detail: "Trabajo cotidiano" },
    { id: "opus", label: "Opus", detail: "Problemas complejos" },
    { id: "fable", label: "Fable", detail: "Trabajo de largo alcance" }
  ],
  auditor: [
    { id: "gpt-6-sol", label: "Sol", detail: "Dirección y revisión" },
    { id: "gpt-6-luna", label: "Luna", detail: "Revisiones ágiles" },
    { id: "gpt-6-astra", label: "Astra", detail: "Análisis profundo" }
  ]
};
// Agent 1 of each role lives in coderModel/coderEffort and auditorModel/auditorEffort; extra agents follow it.
export const TEAM_LIMITS = { coder: 3, auditor: 2 };
const TEAM_KEYS = { coder: "extraCoders", auditor: "extraAuditors" };
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]{0,99}$/;
// autoResume: interrupted or waiting runs continue on their own when Automata opens again.
// maxRetries: passing failures retried per stage before asking the user. autoStart: open with Windows (desktop only).
// coderRefreshRounds / auditorRefreshRounds: a resumed CLI session is replaced by a fresh one (with the full
// prompt, plan and memory) after this many rounds, separately for Claude and for Codex; 0 keeps that agent's
// sessions for the whole run. Codex re-reads more of the project each round, so it renews sooner.
export const DEFAULT_SETTINGS = { language: "es", mode: "small", accessMode: "full", coderModel: "sonnet", auditorModel: "gpt-6-sol", coderEffort: "default", auditorEffort: "high", maxRounds: 6, timeoutMinutes: 30, extraCoders: [], extraAuditors: [], gitMode: "ask-push", projectsRoot: "", reuseSessions: true, fastFix: true, planOnly: true, autoResume: true, maxRetries: 4, autoStart: false, coderRefreshRounds: 8, auditorRefreshRounds: 3, ramBudgetMB: defaultBudget() };
// ramBudgetMB: the most RAM Automata's own processes (itself, Claude, Codex, checks, the app) may use together; 30 GiB
// unless AUTOMATA_RAM_BUDGET_MB says otherwise before the first save. 0 turns the budget and its measurement off.
// It is supervision (resources.mjs): nothing running is closed because of it.
// Settings saved before the renewal was set per agent had one number for both: a value the user chose
// (anything but the old default of 8) still applies to both.
const LEGACY_REFRESH_DEFAULT = 8;
// Identifiers that earlier versions offered but Codex does not accept, and what they meant.
export const RENAMED_MODELS = { "gpt-6.1-sol": "gpt-6-sol" };
// planOnly: Claude and Codex use the user's subscription login, as in the terminal. API keys found in
// Windows are left out, because with a key the CLIs bill per use instead of using the plan.
export const API_KEY_VARIABLES = { coder: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], auditor: ["OPENAI_API_KEY", "CODEX_API_KEY"] };
// Node's spawn leaves out variables whose value is undefined, so this removes them for that agent only.
export const agentEnv = (settings, role) => settings?.planOnly === false ? {} : Object.fromEntries((API_KEY_VARIABLES[role] ?? []).map((name) => [name, undefined]));
// ask-push: commits run on their own, push and merge wait for the user. ask-all: everything waits. auto: nothing waits. off: the director does not decide Git.
export const GIT_MODES = ["ask-push", "ask-all", "auto", "off"];
export const defaultProjectsRoot = () => path.join(os.homedir(), "Automata Projects");
export const projectsRootOf = (settings) => settings?.projectsRoot || defaultProjectsRoot();
export const teamOf = (settings, role) => [{ model: settings[role + "Model"], effort: settings[role + "Effort"] }, ...settings[TEAM_KEYS[role]] ?? []];
export const modelLabel = (role, id) => MODELS[role].find((m) => m.id === id)?.label ?? id;
export function agentLabel(role, team, index) {
  const agent = team[index] ?? team[0];
  return `${role === "coder" ? "Claude" : "Codex"} ${index + 1} · ${modelLabel(role, agent.model)}`;
}
export function effortsFor(model, role) {
  if (role === "coder") return ["default", "low", "medium", "high", "xhigh", "max"];
  return ["default", "low", "medium", "high", "xhigh", "max", .../luna/.test(model) ? [] : ["ultra"]];
}
export function validateSettings(value = {}) {
  const s = { ...DEFAULT_SETTINGS, ...value };
  if (value.sessionRefreshRounds != null && Number(value.sessionRefreshRounds) !== LEGACY_REFRESH_DEFAULT) for (const k of ["coderRefreshRounds", "auditorRefreshRounds"]) if (value[k] == null) s[k] = value.sessionRefreshRounds;
  s.auditorModel = RENAMED_MODELS[s.auditorModel] ?? s.auditorModel;
  if (Array.isArray(s.extraAuditors)) s.extraAuditors = s.extraAuditors.map((agent) => agent && RENAMED_MODELS[agent.model] ? { ...agent, model: RENAMED_MODELS[agent.model] } : agent);
  if (!["es", "en"].includes(s.language)) throw new Error("Elige English o Español.");
  if (!MODES[s.mode]) throw new Error("Elige un tamaño de trabajo válido.");
  if (!["full", "limited"].includes(s.accessMode)) throw new Error("Elige acceso completo o limitado.");
  for (const role of ["coder", "auditor"]) {
    if (typeof s[`${role}Model`] !== "string" || !MODEL_ID.test(s[`${role}Model`])) throw new Error("Identificador de modelo no válido.");
    if (!effortsFor(s[`${role}Model`], role).includes(s[`${role}Effort`])) throw new Error("Ese nivel de razonamiento no es compatible.");
    const extras = s[TEAM_KEYS[role]] ?? [];
    if (!Array.isArray(extras) || extras.length > TEAM_LIMITS[role] - 1) throw new Error(role === "coder" ? "Usa de 1 a 3 codificadores." : "Usa de 1 a 2 revisores.");
    s[TEAM_KEYS[role]] = extras.map((agent) => {
      const model = agent?.model, effort = agent?.effort ?? "default";
      if (typeof model !== "string" || !MODEL_ID.test(model)) throw new Error("Identificador de modelo no válido.");
      if (!effortsFor(model, role).includes(effort)) throw new Error("Ese nivel de razonamiento no es compatible.");
      return { model, effort };
    });
  }
  if (!GIT_MODES.includes(s.gitMode)) throw new Error("Elige cuánto decide el director sobre Git.");  if (typeof s.projectsRoot !== "string" || s.projectsRoot.length > 1000) throw new Error("La carpeta de proyectos debe ser una ruta absoluta que no sea la raíz del disco.");
  if (s.projectsRoot.trim()) {
    const root = path.resolve(s.projectsRoot.trim());
    if (!path.isAbsolute(s.projectsRoot.trim()) || root === path.parse(root).root) throw new Error("La carpeta de proyectos debe ser una ruta absoluta que no sea la raíz del disco.");
    s.projectsRoot = root;
  } else s.projectsRoot = "";
  for (const k of ["reuseSessions", "fastFix", "planOnly", "autoResume", "autoStart"]) if (typeof s[k] !== "boolean") throw new Error(`${k}: usa verdadero o falso.`);
  for (const [k, min, max] of [["maxRounds", 1, 50], ["timeoutMinutes", 1, 120], ["maxRetries", 0, 10], ["coderRefreshRounds", 0, 50], ["auditorRefreshRounds", 0, 50], ["ramBudgetMB", 0, 1048576]]) {
    s[k] = Number(s[k]);
    if (!Number.isInteger(s[k]) || s[k] < min || s[k] > max) throw new Error(`${k}: usa un número entre ${min} y ${max}.`);
    if (k === "ramBudgetMB" && s[k] > 0 && s[k] < 2048) throw new Error("ramBudgetMB: usa 0 (sin presupuesto) o un número entre 2048 y 1048576.");
  }
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, s[k]]));
}
export function githubRepository(value) {
  const text = String(value ?? "").trim();
  const shorthand = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})$/.exec(text);
  let url;
  try { url = new URL(shorthand ? `https://github.com/${text}` : text); } catch { throw new Error("Usa un repositorio GitHub como usuario/repo o https://github.com/usuario/repo."); }
  const parts = /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash || !parts) throw new Error("Usa una URL HTTPS de GitHub sin credenciales, parámetros ni rutas adicionales.");
  const repository = parts[2].replace(/\.git$/, "");
  if (!repository || /^\.+$/.test(repository)) throw new Error("Nombre de repositorio no válido.");
  return `https://github.com/${parts[1]}/${repository}`;
}
// safety: { automataRoot, dataDir, projectsRoot } (safety.mjs). Without it only the disk root is refused.
export function validateProject(input, { checkDirectory = true, safety = null } = {}) {
  const text = (k, max) => {
    const t = String(input[k] ?? "").trim();
    if (!t || t.length > max) throw new Error(`Completa ${k} (máximo ${max} caracteres).`);
    return t;
  };
  const name = text("name", 80), objective = text("objective", 12e3);
  const directory = path.resolve(text("directory", 1e3));
  if (directory === path.parse(directory).root) throw new Error("Selecciona la carpeta de un proyecto, no la raíz del disco.");
  if (checkDirectory && !fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) throw new Error("La carpeta del proyecto no existe.");
  if (safety) {
    const problem = directoryProblem(directory, safety);
    if (problem) throw Object.assign(new Error(problem), { code: "unsafe-directory" });
  }
  const lines = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/\r?\n/)).map((x) => String(x).trim()).filter(Boolean);
  const criteria = lines(input.criteria), checks = lines(input.checks);
  if (!criteria.length || criteria.length > 30 || criteria.some((c) => c.length > 2e3)) throw new Error("Define entre 1 y 30 criterios de aceptación.");
  if (checks.length > 12 || checks.some((c) => c.length > 2e3)) throw new Error("Usa hasta 12 comandos de verificación.");
  const source = input.source ?? "local";
  if (!["local", "github"].includes(source)) throw new Error("Elige Local o GitHub para el proyecto.");
  return { name, directory: checkDirectory ? fs.realpathSync(directory) : directory, objective, criteria, checks, constraints: String(input.constraints ?? "").trim().slice(0, 12e3), source, repository: source === "github" ? githubRepository(input.repository) : null };
}
export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "summary", "nextPrompt", "task", "files", "findings", "criteria", "git", "run", "memory", "plan"],
  properties: {
    decision: { type: "string", enum: ["continue", "complete", "blocked"] },
    summary: { type: "string" },
    nextPrompt: { type: "string" },
    // The plan task nextPrompt works on: "T12" (existing) or "N1" (first task added in this review). Empty when not continuing.
    task: { type: "string" },
    // Files (relative to the project) the executor should start from for this task, so it does not reread everything.
    files: { type: "array", items: { type: "string" } },
    findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["severity", "file", "description", "evidence"], properties: { severity: { type: "string", enum: ["critical", "major", "minor", "info"] }, file: { type: "string" }, description: { type: "string" }, evidence: { type: "string" } } } },
    criteria: { type: "array", items: { type: "object", additionalProperties: false, required: ["criterion", "met", "evidence"], properties: { criterion: { type: "string" }, met: { type: "boolean" }, evidence: { type: "string" } } } },
    // What the director decides about Git. The executor (not the director) carries it out; empty values mean "do nothing".
    git: { type: "object", additionalProperties: false, required: ["commit", "message", "push", "branch", "merge_into"], properties: { commit: { type: "boolean" }, message: { type: "string" }, push: { type: "boolean" }, branch: { type: "string" }, merge_into: { type: "string" } } },
    // Whether the app can already be opened, and how. Automata asks the user before running anything.
    run: { type: "object", additionalProperties: false, required: ["ready", "command", "url", "note"], properties: { ready: { type: "boolean" }, command: { type: "string" }, url: { type: "string" }, note: { type: "string" } } },
    // What the project memory should keep (durable, verified facts) and which shown facts (#id) are wrong or stale.
    memory: { type: "object", additionalProperties: false, required: ["add", "retire"], properties: {
      add: { type: "array", items: { type: "object", additionalProperties: false, required: ["kind", "text"], properties: { kind: { type: "string", enum: ["decision", "env", "pending", "gotcha", "note"] }, text: { type: "string" } } } },
      retire: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "reason"], properties: { id: { type: "integer" }, reason: { type: "string" } } } }
    } },
    // The project plan the director keeps (plan.mjs): tasks to add, with dependencies on existing ("T12") or
    // new ("N1") tasks, and status changes with evidence (done) or a note (blocked, dropped).
    plan: { type: "object", additionalProperties: false, required: ["add", "update"], properties: {
      add: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "detail", "criterion", "dependsOn"], properties: { title: { type: "string" }, detail: { type: "string" }, criterion: { type: "string" }, dependsOn: { type: "array", items: { type: "string" } } } } },
      update: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "status", "evidence", "note"], properties: { id: { type: "integer" }, status: { type: "string", enum: ["todo", "doing", "review", "done", "blocked", "dropped", ""] }, evidence: { type: "string" }, note: { type: "string" } } } }
    } }
  }
};
// Relative paths inside the project, a dozen at most; anything else (absolute, "..", odd characters) is dropped.
export function normalizeFiles(files) {
  return [...new Set((Array.isArray(files) ? files : []).map((f) => String(f ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "")).filter((f) => f && f.length <= 200 && !path.isAbsolute(f) && !/^[a-z]:/i.test(f) && !f.split("/").includes("..") && !/[<>"|?*\0]/.test(f)))].slice(0, 12);
}
// ---- Proposals: an idea in plain words becomes a project definition the user approves once ----
export const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "summary", "objective", "features", "criteria", "checks", "platform", "plan", "risks", "questions"],
  properties: {
    name: { type: "string" },
    summary: { type: "string" },
    objective: { type: "string" },
    features: { type: "array", items: { type: "string" } },
    criteria: { type: "array", items: { type: "string" } },
    checks: { type: "array", items: { type: "string" } },
    platform: { type: "string" },
    plan: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "detail", "criterion", "dependsOn"], properties: { title: { type: "string" }, detail: { type: "string" }, criterion: { type: "string" }, dependsOn: { type: "array", items: { type: "string" } } } } },
    risks: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } }
  }
};
const lines = (value, max, maxLength) => (Array.isArray(value) ? value : []).map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, max).map((item) => item.slice(0, maxLength));
const criterionKey = (text) => String(text).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clip = (text, max) => { const value = String(text ?? "").replace(/\s+/g, " ").trim(); return value.length > max ? value.slice(0, max - 1) + "…" : value; };
// Which criteria does a task mean when it quotes one? Returns { kind, indexes } or null (nothing fits).
//   exact · reformatted (same words, other case, accents or punctuation) · shortened (cut off; it opens exactly one criterion)
//   · merged / extended (whole criteria found inside the quote, in list order) · fragment (a piece from the middle of one)
//   · ambiguous (it fits several: never guessed).
export function resolveQuote(quote, criteria) {
  if (criteria.includes(quote)) return { kind: "exact", indexes: [criteria.indexOf(quote)] };
  const q = criterionKey(quote), keys = criteria.map(criterionKey);
  if (!q) return null;
  const where = (test) => keys.flatMap((k, i) => test(k) ? [i] : []);
  const same = where((k) => k === q);
  if (same.length === 1) return { kind: "reformatted", indexes: same };
  const cut = q.replace(/\s*\S*$/, "");
  if (cut.length >= 20) {
    const opens = where((k) => k.startsWith(cut));
    if (opens.length === 1) return { kind: "shortened", indexes: opens };
    if (opens.length > 1) return { kind: "ambiguous", indexes: opens };
  }
  const inside = where((k) => k.length >= 15 && q.includes(k));
  if (inside.length) return { kind: inside.length > 1 ? "merged" : "extended", indexes: inside };
  if (q.length >= 25) {
    const within = where((k) => k.includes(q));
    if (within.length) return { kind: within.length === 1 ? "fragment" : "ambiguous", indexes: within };
  }
  return null;
}
export function validateProposal(p) {
  if (!p || typeof p !== "object") throw Object.assign(new Error("El director no entregó una propuesta válida."), { kind: "malformed", role: "auditor" });
  const proposal = {
    name: String(p.name ?? "").trim().slice(0, 60), summary: String(p.summary ?? "").trim().slice(0, 600), objective: String(p.objective ?? "").trim().slice(0, 4000),
    features: lines(p.features, 12, 200), criteria: lines(p.criteria, 25, 2000), checks: lines(p.checks, 6, 2000), platform: String(p.platform ?? "").trim().slice(0, 120),
    plan: (Array.isArray(p.plan) ? p.plan : []).slice(0, 40).map((t) => ({ title: String(t?.title ?? "").trim().slice(0, 140), detail: String(t?.detail ?? "").trim().slice(0, 600), criterion: String(t?.criterion ?? "").trim().slice(0, 2000), dependsOn: lines(t?.dependsOn, 12, 10) })),
    risks: lines(p.risks, 12, 300), questions: lines(p.questions, 6, 300)
  };
  const invalid = (message) => Object.assign(new Error(message), { kind: "malformed", role: "auditor" });
  if (proposal.name.length < 3) throw invalid("La propuesta necesita un nombre de proyecto.");
  if (proposal.objective.length < 20) throw invalid("La propuesta necesita un objetivo claro.");
  if (proposal.criteria.length < 3) throw invalid("La propuesta necesita al menos 3 criterios de aceptación comprobables.");
  if (!proposal.checks.length) throw invalid("La propuesta necesita al menos un comando de verificación (por ejemplo node --test).");
  if (proposal.plan.length < 3) throw invalid("La propuesta necesita un plan inicial de al menos 3 tareas.");
  // How the tasks quote the acceptance criteria: unambiguous slips are resolved here (see resolveQuote), so they do
  // not cost the director another attempt; a criterion nobody mentions, or a quote that fits none or several, still does.
  const adjusted = [];
  proposal.plan.forEach((task, index) => {
    if (!task.criterion) return;
    const found = resolveQuote(task.criterion, proposal.criteria);
    if (!found || found.kind === "ambiguous") return;
    if (found.kind !== "exact") adjusted.push({ task: task.title, kind: found.kind, criterion: proposal.criteria[found.indexes[0]], also: found.indexes.slice(1).map((i) => proposal.criteria[i]) });
    task.criterion = proposal.criteria[found.indexes[0]];
    task.alsoCovers = found.indexes.slice(1).map((i) => proposal.criteria[i]);
    task.position = index;
  });
  const quoted = new Set(proposal.plan.map((task) => task.criterion).filter(Boolean));
  // A task that served several criteria quoted together keeps the first; each of the others, if no task of its
  // own mentions it, gets a verification task after the rest, so that the director closes it with its own evidence.
  const derived = [];
  for (const task of proposal.plan) for (const criterion of task.alsoCovers ?? []) if (!quoted.has(criterion) && !derived.some((d) => d.criterion === criterion)) derived.push({ title: `Comprobar: ${criterion}`.slice(0, 140), detail: `Confirmar con evidencia que se cumple este criterio. Lo construye la tarea «${task.title}».`.slice(0, 600), criterion, dependsOn: [`N${task.position + 1}`] });
  for (const task of proposal.plan) { delete task.alsoCovers; delete task.position; }
  proposal.plan.push(...derived);
  const covered = new Set(proposal.plan.map((task) => task.criterion).filter(Boolean));
  const uncovered = proposal.criteria.filter((criterion) => !covered.has(criterion));
  if (uncovered.length) throw invalid(`Cada criterio necesita al menos una tarea del plan que cite su texto completo y exacto en criterion (una tarea, un criterio). Sin tarea: ${uncovered.map((c) => `«${clip(c, 200)}»`).join("; ")}.`);
  for (const task of proposal.plan) {
    if (!task.criterion || proposal.criteria.includes(task.criterion)) continue;
    const found = resolveQuote(task.criterion, proposal.criteria);
    throw invalid(found?.kind === "ambiguous"
      ? `La tarea «${task.title}» cita «${clip(task.criterion, 100)}», que puede ser cualquiera de ${found.indexes.length} criterios. Copia el texto completo de uno solo.`
      : `La tarea «${task.title}» cita «${clip(task.criterion, 100)}», que no coincide con ningún criterio de la lista: cita un criterio exacto o deja criterion vacío.`);
  }
  proposal.adjusted = adjusted;
  for (const [index, task] of proposal.plan.entries()) {
    if (!task.title) throw invalid(`La tarea ${index + 1} del plan no tiene título.`);
    for (const ref of task.dependsOn) {
      const m = /^N(\d+)$/i.exec(ref);
      if (!m || Number(m[1]) < 1 || Number(m[1]) > proposal.plan.length || Number(m[1]) === index + 1) throw invalid(`La tarea «${task.title}» depende de «${ref}», que no es una tarea de este plan (usa N1, N2…).`);
    }
  }
  return proposal;
}
// Keeps only well-formed memory items, a few per review. Reviews without the field are valid.
export function normalizeMemory(memory) {
  const add = (Array.isArray(memory?.add) ? memory.add : []).filter((item) => ["decision", "env", "pending", "gotcha", "note"].includes(item?.kind) && typeof item.text === "string" && item.text.trim()).slice(0, 6).map((item) => ({ kind: item.kind, text: item.text.trim().slice(0, 400) }));
  const retire = (Array.isArray(memory?.retire) ? memory.retire : []).filter((item) => Number.isInteger(item?.id) && item.id > 0).slice(0, 10).map((item) => ({ id: item.id, reason: String(item.reason ?? "").trim().slice(0, 200) }));
  return { add, retire };
}
const LOCAL_URL = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#][^\s]*)?$/i;
// Keeps only what Automata may offer: a one-line command and, optionally, a local address.
export function normalizeRun(run) {
  const command = String(run?.command ?? "").split(/\r?\n/)[0].trim().slice(0, 500);
  const url = String(run?.url ?? "").trim().replace(/^(https?:\/\/)0\.0\.0\.0/i, "$1localhost");
  const ready = run?.ready === true && !!command;
  return { ready, command: ready ? command : "", url: ready && LOCAL_URL.test(url) ? url.slice(0, 300) : "", note: ready ? String(run?.note ?? "").trim().slice(0, 300) : "" };
}
export const isLocalUrl = (url) => LOCAL_URL.test(String(url ?? ""));
// Reviewers run in order and only the last one may be something other than "complete".
// Approval needs every reviewer; anything else is decided by the reviewer that did not approve.
export function combineReviews(reviews, labels) {
  const last = reviews.length - 1, tag = (review, i) => `${labels[i]}: ${review.summary}`;
  if (reviews[last].decision !== "complete") return { ...reviews[last], summary: tag(reviews[last], last) };
  // Approval: the primary director (first) decides Git, because the others only confirm.
  return {
    decision: "complete",
    summary: reviews.map(tag).join("\n"),
    nextPrompt: "",
    git: reviews[0].git,
    run: reviews[0].run,
    memory: normalizeMemory({ add: reviews.flatMap((review) => review.memory?.add ?? []), retire: reviews.flatMap((review) => review.memory?.retire ?? []) }),
    task: "",
    plan: reviews[0].plan,
    findings: reviews.flatMap((review, i) => review.findings.map((f) => ({ ...f, description: `[${labels[i]}] ${f.description}` }))),
    criteria: reviews[0].criteria.map((c) => ({
      criterion: c.criterion,
      met: reviews.every((review) => review.criteria.some((x) => x.criterion === c.criterion && x.met)),
      evidence: reviews.map((review, i) => {
        const x = review.criteria.find((y) => y.criterion === c.criterion);
        return x?.evidence?.trim() ? `${labels[i]}: ${x.evidence}` : "";
      }).filter(Boolean).join("\n")
    }))
  };
}
// A review the director must redo: the coordinator asks again, with the reason, a bounded number of times.
export const invalidReview = (message) => Object.assign(new Error(message), { kind: "malformed", role: "auditor" });
export function validateReview(r, project, phase = "review") {
  if (!r || !["continue", "complete", "blocked"].includes(r.decision) || typeof r.summary !== "string" || typeof r.nextPrompt !== "string" || !Array.isArray(r.findings) || !Array.isArray(r.criteria)) throw invalidReview("El auditor no entregó una decisión válida.");
  if (r.findings.some((f) => !["critical", "major", "minor", "info"].includes(f.severity) || ["file", "description", "evidence"].some((k) => typeof f[k] !== "string"))) throw invalidReview("Los hallazgos del auditor no son válidos.");
  if (r.criteria.some((c) => typeof c.criterion !== "string" || typeof c.met !== "boolean" || typeof c.evidence !== "string")) throw invalidReview("La evidencia de aceptación no es válida.");
  if (r.decision === "continue" && !r.nextPrompt.trim()) throw invalidReview("El auditor no indicó la siguiente tarea.");
  if (r.decision === "complete") {
    if (phase === "plan") throw invalidReview("El proyecto necesita ejecución y auditoría antes de marcarse terminado.");
    if (project.criteria.some((c) => !r.criteria.some((x) => x.criterion === c && x.met && x.evidence.trim()))) throw invalidReview("Falta evidencia para uno o más criterios de aceptación.");
    if (r.findings.some((f) => ["critical", "major"].includes(f.severity))) throw invalidReview("Hay hallazgos importantes pendientes.");
  }
  r.run = normalizeRun(r.run);
  r.memory = normalizeMemory(r.memory);
  r.task = String(r.task ?? "").trim().toUpperCase();
  r.files = normalizeFiles(r.files);
  // Reviews without a plan field (simulated agents, older reviews) leave the plan untouched.
  r.plan = r.plan && typeof r.plan === "object" ? { add: Array.isArray(r.plan.add) ? r.plan.add : [], update: (Array.isArray(r.plan.update) ? r.plan.update : []).map((item) => ({ ...item, status: item?.status || null, evidence: item?.evidence ? item.evidence : null, note: item?.note ? item.note : null })) } : null;
  return r;
}

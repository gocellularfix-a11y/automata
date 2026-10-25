import fs from "node:fs";
import path from "node:path";
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
    { id: "gpt-6.1-sol", label: "Sol", detail: "Dirección y revisión" },
    { id: "gpt-6-luna", label: "Luna", detail: "Revisiones ágiles" },
    { id: "gpt-6-astra", label: "Astra", detail: "Análisis profundo" }
  ]
};
export const DEFAULT_SETTINGS = { mode: "small", coderModel: "sonnet", auditorModel: "gpt-6.1-sol", coderEffort: "default", auditorEffort: "high", maxRounds: 6, timeoutMinutes: 30 };
export function effortsFor(model, role) {
  if (role === "coder") return ["default", "low", "medium", "high", "xhigh", "max"];
  return ["default", "low", "medium", "high", "xhigh", "max", .../luna/.test(model) ? [] : ["ultra"]];
}
export function validateSettings(value = {}) {
  const s = { ...DEFAULT_SETTINGS, ...value };
  if (!MODES[s.mode]) throw new Error("Elige un tamaño de trabajo válido.");
  for (const role of ["coder", "auditor"]) {
    if (typeof s[`${role}Model`] !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]{0,99}$/.test(s[`${role}Model`])) throw new Error("Identificador de modelo no válido.");
    if (!effortsFor(s[`${role}Model`], role).includes(s[`${role}Effort`])) throw new Error("Ese nivel de razonamiento no es compatible.");
  }
  for (const [k, min, max] of [["maxRounds", 1, 50], ["timeoutMinutes", 1, 120]]) {
    s[k] = Number(s[k]);
    if (!Number.isInteger(s[k]) || s[k] < min || s[k] > max) throw new Error(`${k}: usa un número entre ${min} y ${max}.`);
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
export function validateProject(input, { checkDirectory = true } = {}) {
  const text = (k, max) => {
    const t = String(input[k] ?? "").trim();
    if (!t || t.length > max) throw new Error(`Completa ${k} (máximo ${max} caracteres).`);
    return t;
  };
  const name = text("name", 80), objective = text("objective", 12e3);
  const directory = path.resolve(text("directory", 1e3));
  if (directory === path.parse(directory).root) throw new Error("Selecciona la carpeta de un proyecto, no la raíz del disco.");
  if (checkDirectory && !fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) throw new Error("La carpeta del proyecto no existe.");
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
  required: ["decision", "summary", "nextPrompt", "findings", "criteria"],
  properties: {
    decision: { type: "string", enum: ["continue", "complete", "blocked"] },
    summary: { type: "string" },
    nextPrompt: { type: "string" },
    findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["severity", "file", "description", "evidence"], properties: { severity: { type: "string", enum: ["critical", "major", "minor", "info"] }, file: { type: "string" }, description: { type: "string" }, evidence: { type: "string" } } } },
    criteria: { type: "array", items: { type: "object", additionalProperties: false, required: ["criterion", "met", "evidence"], properties: { criterion: { type: "string" }, met: { type: "boolean" }, evidence: { type: "string" } } } }
  }
};
export function validateReview(r, project, phase = "review") {
  if (!r || !["continue", "complete", "blocked"].includes(r.decision) || typeof r.summary !== "string" || typeof r.nextPrompt !== "string" || !Array.isArray(r.findings) || !Array.isArray(r.criteria)) throw new Error("El auditor no entregó una decisión válida.");
  if (r.findings.some((f) => !["critical", "major", "minor", "info"].includes(f.severity) || ["file", "description", "evidence"].some((k) => typeof f[k] !== "string"))) throw new Error("Los hallazgos del auditor no son válidos.");
  if (r.criteria.some((c) => typeof c.criterion !== "string" || typeof c.met !== "boolean" || typeof c.evidence !== "string")) throw new Error("La evidencia de aceptación no es válida.");
  if (r.decision === "continue" && !r.nextPrompt.trim()) throw new Error("El auditor no indicó la siguiente tarea.");
  if (r.decision === "complete") {
    if (phase === "plan") throw new Error("El proyecto necesita ejecución y auditoría antes de marcarse terminado.");
    if (project.criteria.some((c) => !r.criteria.some((x) => x.criterion === c && x.met && x.evidence.trim()))) throw new Error("Falta evidencia para uno o más criterios de aceptación.");
    if (r.findings.some((f) => ["critical", "major"].includes(f.severity))) throw new Error("Hay hallazgos importantes pendientes.");
  }
  return r;
}

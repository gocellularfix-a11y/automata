// Project memory: what Claude and Codex should remember about a project between sessions.
// One SQLite file per project (node:sqlite, FTS5), opened only for each operation, so there is no
// resident process and nothing stays locked. It keeps summaries only; the complete history of every
// round stays in runs/<id>/round-NN, and each summary records the run and round it came from.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactSecrets, isSensitiveFile, sanitizeFtsQuery, allocateBudget, estimateTokens } from "./redact.mjs";

// recovery: interruptions, retries and waits, written by Automata itself (never by the agents).
export const MEMORY_KINDS = ["decision", "env", "progress", "pending", "gotcha", "note", "recovery"];
export const MEMORY_BUDGET_TOKENS = 1500;
const LABELS = { decision: "Decisión", env: "Entorno", progress: "Avance", pending: "Pendiente", gotcha: "Trampa conocida", note: "Nota", recovery: "Recuperación" };
const TAGS = { entorno: "env", env: "env", "decisión": "decision", decision: "decision", pendiente: "pending", pending: "pending", trampa: "gotcha", gotcha: "gotcha", nota: "note", note: "note", avance: "progress", progress: "progress" };
const SCHEMA_VERSION = 1;
const PROJECT_ID = /^[a-zA-Z0-9-]{1,64}$/;
const MAX_TEXT = 400;
// Facts that pile up: only the most recent ones stay active.
const KEEP_ACTIVE = { progress: 20, note: 60, recovery: 30 };
const now = () => new Date().toISOString();
const clip = (text, max) => text.length > max ? text.slice(0, max - 1) + "…" : text;
const clean = (text, max = MAX_TEXT) => clip(redactSecrets(String(text ?? "")).replace(/\s+/g, " ").trim(), max);
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', run_id TEXT, round INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, retired_at TEXT, retired_reason TEXT);
CREATE INDEX IF NOT EXISTS facts_status ON facts(status, kind);
CREATE TABLE IF NOT EXISTS fact_revisions (
  id INTEGER PRIMARY KEY, fact_id INTEGER NOT NULL, action TEXT NOT NULL, before TEXT, after TEXT, by TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY, signature TEXT NOT NULL UNIQUE, origin TEXT NOT NULL, command TEXT NOT NULL, excerpt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL, first_run TEXT, first_round INTEGER,
  last_seen_at TEXT NOT NULL, last_run TEXT, last_round INTEGER, resolved_at TEXT);
CREATE TABLE IF NOT EXISTS solutions (
  id INTEGER PRIMARY KEY, error_id INTEGER NOT NULL REFERENCES errors(id), run_id TEXT, round INTEGER,
  files TEXT NOT NULL, summary TEXT NOT NULL, verified_by TEXT NOT NULL, at TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(text, content='facts', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN INSERT INTO facts_fts(rowid, text) VALUES (new.id, new.text); END;
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN INSERT INTO facts_fts(facts_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE OF text ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO facts_fts(rowid, text) VALUES (new.id, new.text); END;
CREATE VIRTUAL TABLE IF NOT EXISTS errors_fts USING fts5(command, excerpt, content='errors', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS errors_ai AFTER INSERT ON errors BEGIN INSERT INTO errors_fts(rowid, command, excerpt) VALUES (new.id, new.command, new.excerpt); END;
CREATE TRIGGER IF NOT EXISTS errors_au AFTER UPDATE OF excerpt ON errors BEGIN
  INSERT INTO errors_fts(errors_fts, rowid, command, excerpt) VALUES ('delete', old.id, old.command, old.excerpt);
  INSERT INTO errors_fts(rowid, command, excerpt) VALUES (new.id, new.command, new.excerpt); END;`;

// ---- Error signatures ---------------------------------------------------------------------------
const ERROR_LINE = /(\berror\b|\bfail(?:ed|ure|s)?\b|✖|\bnot ok\b|exception|assert|cannot find|not found|no se (?:pudo|encontr)|fall[óo]|is not (?:recognized|defined|a function)|undefined|\bENOENT\b|\bEACCES\b|denied|refused|BUILD FAILED)/i;
const SUMMARY_LINE = /^(ℹ|#)\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration)/i;
// The first line that says what went wrong, without timings, absolute paths or numbers that change every run.
export function errorKey(output) {
  const lines = String(output ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const line = lines.find((l) => ERROR_LINE.test(l) && !SUMMARY_LINE.test(l)) ?? lines.at(-1) ?? "";
  return normalize(line).slice(0, 160);
}
const normalize = (text) => String(text ?? "").toLowerCase()
  .replace(/\(\d+(?:\.\d+)?\s*m?s\)/g, "")
  .replace(/[a-z]:[\\/][^\s'"`)]+/gi, (p) => path.win32.basename(p))
  .replace(/(?:\/[^\s/'"`)]+){2,}/g, (p) => path.posix.basename(p))
  .replace(/\b[0-9a-f]{8,}\b/g, "#").replace(/\d+/g, "#")
  .replace(/\s+/g, " ").trim();
const normalizeCommand = (command) => normalize(command).slice(0, 200);
export const signatureOf = (origin, command, output) => `${origin}|${normalizeCommand(command)}|${errorKey(output)}`;
function excerptOf(output) {
  const lines = String(output ?? "").split(/\r?\n/).map((line) => line.trimEnd()).filter((l) => l.trim());
  const at = Math.max(0, lines.findIndex((l) => ERROR_LINE.test(l) && !SUMMARY_LINE.test(l.trim())));
  return clean(lines.slice(at, at + 6).join(" ⏎ "), 600);
}
// Build and test commands are worth remembering when they fail; exploratory commands are not.
const BUILD_OR_TEST = /\b(test|tests|build|compile|gradle|gradlew|mvn|make|cmake|tsc|jest|vitest|mocha|pytest|cargo|go (?:test|build)|dotnet|npm (?:run|test|ci|install)|pnpm|yarn|npx|node --test|eslint|lint|cap (?:sync|run)|electron-builder|adb install|flutter|xcodebuild)\b/i;
export const isBuildOrTest = (command) => BUILD_OR_TEST.test(String(command ?? ""));

// ---- "PARA RECORDAR" sections in agent reports -------------------------------------------------
// Agents end a report with lines like "- [entorno] Android solo compila con el JDK 21".
export function parseRemember(text, max = 6) {
  const match = /(?:^|\n)\s*(?:#+\s*|\*\*)?PARA RECORDAR:?(?:\*\*)?:?\s*\n([\s\S]*)$/i.exec(String(text ?? ""));
  if (!match) return [];
  const items = [];
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { if (items.length) break; continue; }
    const item = /^[-*•]\s*(?:\[([^\]]+)\]\s*)?(.+)$/.exec(line);
    if (!item) break;
    const tag = item[1]?.trim().toLowerCase();
    items.push({ kind: TAGS[tag] ?? "note", text: item[2] });
    if (items.length >= max) break;
  }
  return items;
}
// Files the coder wrote or edited, from the watch log (watch.mjs), relative to the project.
export function changedFiles(log, directory) {
  const files = new Set();
  for (const item of log ?? []) if ((item.t === "edit" || item.t === "write") && item.path && item.ok !== false) {
    const rel = directory ? path.relative(directory, item.path) : item.path;
    files.add((rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : item.path).replaceAll("\\", "/"));
  }
  return [...files];
}
// Files a fact mentions that no longer exist in the project: a hint that the fact may be stale.
// Relative paths with a folder are checked where they point; bare names only at the project root,
// and only flagged when a file by that name is nowhere in the first two levels (cheap and conservative).
// Nothing is retired automatically: the panel shows the warning and the prompts carry it.
const FILE_MENTION = /(?<![\w@:/\\.-])((?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])+[\w.-]+\.[a-z0-9]{1,8}|[\w-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|py|java|kt|kts|rs|go|cs|html|css|scss|yml|yaml|toml|ps1|sh|sql|gradle|xml|txt|csv|ini|cfg|env|lock))(?![\w/\\-])/gi;
const NOT_FILES = /^(?:e\.g|i\.e|etc|vs|npm|node|git|http|https|www)\./i;
export function staleMentions(text, directory, { exists = (file) => fs.existsSync(file), shallow = null } = {}) {
  if (!directory || !text) return [];
  const missing = [];
  for (const match of String(text).matchAll(FILE_MENTION)) {
    const token = match[1].replace(/[.,;:]+$/, "");
    if (NOT_FILES.test(token) || /^\d/.test(token) || missing.includes(token)) continue;
    if (path.isAbsolute(token)) {
      if (!exists(token)) missing.push(token);
      continue;
    }
    const target = path.resolve(directory, token);
    if (!target.toLowerCase().startsWith(path.resolve(directory).toLowerCase())) continue;
    if (exists(target)) continue;
    if (/[\\/]/.test(token)) missing.push(token);
    else if (!(shallow ?? shallowNames(directory)).has(token.toLowerCase())) missing.push(token);
  }
  return missing;
}
// File names in the project root and its first level of folders, lower-cased.
export function shallowNames(directory) {
  const names = new Set();
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      names.add(entry.name.toLowerCase());
      if (entry.isDirectory() && !/^(?:node_modules|\.git|dist|build|\.automata)$/.test(entry.name)) {
        try { for (const child of fs.readdirSync(path.join(directory, entry.name))) names.add(child.toLowerCase()); } catch {}
      }
    }
  } catch {}
  return names;
}
// Plain words from free text, for an OR query over the FTS index.
function relevanceQuery(text) {
  const words = [...new Set((sanitizeFtsQuery(String(text ?? "").slice(0, 4000), 4000) ?? "").toLowerCase().split(" ").filter((w) => w.length >= 4 && /\p{L}/u.test(w)))].slice(0, 16);
  return words.length ? words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ") : null;
}

export class MemoryStore {
  constructor(directory) {
    this.directory = directory;
  }
  file(projectId) {
    if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) throw new Error("Proyecto no válido para la memoria.");
    return path.join(this.directory, `${projectId}.db`);
  }
  // Opens the project's own file for one operation. Reading a project without memory creates nothing.
  #use(projectId, write, fn) {
    const file = this.file(projectId);
    if (!write && !fs.existsSync(file)) return fn(null);
    fs.mkdirSync(this.directory, { recursive: true });
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA busy_timeout = 3000; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
      const version = db.prepare("PRAGMA user_version").get().user_version;
      if (version < SCHEMA_VERSION) {
        db.exec("BEGIN");
        try {
          db.exec(SCHEMA);
          db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('project', ?)").run(projectId);
          db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      // A file copied or renamed from another project is refused rather than read.
      const owner = db.prepare("SELECT value FROM meta WHERE key = 'project'").get()?.value;
      if (owner !== projectId) throw new Error("Este archivo de memoria pertenece a otro proyecto.");
      return fn(db);
    } finally {
      db.close();
    }
  }
  #tx(projectId, fn) {
    return this.#use(projectId, true, (db) => {
      db.exec("BEGIN");
      try {
        const result = fn(db);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  // ---- Facts ----
  addFact(projectId, { kind = "note", text, source = "user", runId = null, round = null }) {
    if (!MEMORY_KINDS.includes(kind)) throw new Error("Tipo de recuerdo no válido.");
    const value = clean(text);
    if (value.length < 3) throw new Error("Escribe el recuerdo (al menos 3 caracteres).");
    return this.#tx(projectId, (db) => {
      const same = db.prepare("SELECT * FROM facts WHERE status = 'active' AND kind = ? AND lower(text) = lower(?)").get(kind, value);
      if (same) {
        db.prepare("UPDATE facts SET updated_at = ? WHERE id = ?").run(now(), same.id);
        return { ...same, duplicate: true };
      }
      const at = now();
      const { lastInsertRowid } = db.prepare("INSERT INTO facts (kind, text, source, run_id, round, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(kind, value, String(source).slice(0, 40), runId, round, at, at);
      db.prepare("INSERT INTO fact_revisions (fact_id, action, after, by, at) VALUES (?, 'add', ?, ?, ?)").run(lastInsertRowid, value, String(source).slice(0, 40), at);
      const keep = KEEP_ACTIVE[kind];
      if (keep) {
        for (const old of db.prepare("SELECT id FROM facts WHERE status = 'active' AND kind = ? ORDER BY id DESC LIMIT -1 OFFSET ?").all(kind, keep)) {
          db.prepare("UPDATE facts SET status = 'retired', retired_at = ?, retired_reason = 'Reemplazado por recuerdos más recientes' WHERE id = ?").run(at, old.id);
        }
      }
      return db.prepare("SELECT * FROM facts WHERE id = ?").get(lastInsertRowid);
    });
  }
  updateFact(projectId, id, { text, kind, by = "user" }) {
    return this.#tx(projectId, (db) => {
      const fact = db.prepare("SELECT * FROM facts WHERE id = ?").get(Number(id));
      if (!fact) throw new Error("No se encontró ese recuerdo.");
      const value = text === undefined ? fact.text : clean(text);
      if (value.length < 3) throw new Error("Escribe el recuerdo (al menos 3 caracteres).");
      const nextKind = kind ?? fact.kind;
      if (!MEMORY_KINDS.includes(nextKind)) throw new Error("Tipo de recuerdo no válido.");
      db.prepare("UPDATE facts SET text = ?, kind = ?, updated_at = ? WHERE id = ?").run(value, nextKind, now(), fact.id);
      db.prepare("INSERT INTO fact_revisions (fact_id, action, before, after, by, at) VALUES (?, 'update', ?, ?, ?, ?)").run(fact.id, fact.text, value, by, now());
      return db.prepare("SELECT * FROM facts WHERE id = ?").get(fact.id);
    });
  }
  setFactStatus(projectId, id, status, { reason = "", by = "user" } = {}) {
    if (!["active", "retired"].includes(status)) throw new Error("Estado no válido.");
    return this.#tx(projectId, (db) => {
      const fact = db.prepare("SELECT * FROM facts WHERE id = ?").get(Number(id));
      if (!fact) throw new Error("No se encontró ese recuerdo.");
      const at = now(), why = clean(reason, 200);
      db.prepare("UPDATE facts SET status = ?, retired_at = ?, retired_reason = ?, updated_at = ? WHERE id = ?").run(status, status === "retired" ? at : null, status === "retired" ? why : null, at, fact.id);
      db.prepare("INSERT INTO fact_revisions (fact_id, action, before, after, by, at) VALUES (?, ?, ?, ?, ?, ?)").run(fact.id, status === "retired" ? "retire" : "restore", fact.status, why || null, by, at);
      return db.prepare("SELECT * FROM facts WHERE id = ?").get(fact.id);
    });
  }
  listFacts(projectId, { status = "active", kind, q, limit = 200 } = {}) {
    return this.#use(projectId, false, (db) => {
      if (!db) return [];
      const where = [], params = [];
      if (status !== "all") { where.push("f.status = ?"); params.push(status); }
      if (kind) { where.push("f.kind = ?"); params.push(kind); }
      const query = sanitizeFtsQuery(q ?? "");
      const sql = query
        ? `SELECT f.* FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid WHERE facts_fts MATCH ? ${where.length ? "AND " + where.join(" AND ") : ""} ORDER BY bm25(facts_fts) LIMIT ?`
        : `SELECT f.* FROM facts f ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY f.updated_at DESC, f.id DESC LIMIT ?`;
      return db.prepare(sql).all(...(query ? [query.split(" ").map((w) => `"${w}"`).join(" ")] : []), ...params, Math.min(Number(limit) || 200, 500));
    });
  }
  history(projectId, id) {
    return this.#use(projectId, false, (db) => db ? db.prepare("SELECT * FROM fact_revisions WHERE fact_id = ? ORDER BY id").all(Number(id)) : []);
  }

  // ---- Errors and their verified solutions ----
  // checks: Automata's check results. A failing check opens (or reopens) an error; when the same check
  // passes again, its open errors are resolved with what changed, verified by that check.
  recordChecks(projectId, { runId = null, round = null, checks = [], files = [], report = "" }) {
    const result = { opened: [], recurred: [], resolved: [] };
    if (!checks.length) return result;
    return this.#tx(projectId, (db) => {
      for (const check of checks) {
        const command = String(check.command ?? "");
        if (!check.passed) this.#seen(db, result, { origin: "check", command, output: `${check.output ?? ""}\n${check.stderr ?? ""}`, runId, round });
        else {
          for (const error of db.prepare("SELECT * FROM errors WHERE status = 'open' AND origin = 'check' AND command = ?").all(clean(command, 300))) {
            this.#resolve(db, error, { runId, round, files, summary: report, verifiedBy: `Verificación aprobada: ${command}` });
            result.resolved.push(error.id);
          }
        }
      }
      return result;
    });
  }
  // log: the watch records of one coder invocation, in order. A failing build or test command opens an
  // error; the same command succeeding later in the log resolves it with the files edited in between.
  recordCommands(projectId, { runId = null, round = null, log = [], directory = "" }) {
    const result = { opened: [], recurred: [], resolved: [] };
    const commands = (log ?? []).filter((item) => item.t === "cmd" && item.ok !== undefined && isBuildOrTest(item.command));
    if (!commands.length) return result;
    return this.#tx(projectId, (db) => {
      log.forEach((item, index) => {
        if (item.t !== "cmd" || item.ok === undefined || !isBuildOrTest(item.command)) return;
        if (item.ok === false) {
          const id = this.#seen(db, result, { origin: "command", command: item.command, output: item.output, runId, round });
          (item.memoryError ??= id);
          return;
        }
        for (const error of db.prepare("SELECT * FROM errors WHERE status = 'open' AND origin = 'command' AND command = ?").all(clean(item.command, 300))) {
          const failedAt = log.findIndex((x) => x.memoryError === error.id);
          const between = log.slice(failedAt >= 0 ? failedAt + 1 : 0, index);
          const notes = between.filter((x) => x.t === "note").map((x) => x.text).join(" ");
          this.#resolve(db, error, { runId, round, files: changedFiles(between, directory), summary: notes, verifiedBy: `El comando volvió a funcionar: ${item.command}` });
          result.resolved.push(error.id);
        }
      });
      for (const item of log) delete item.memoryError;
      return result;
    });
  }
  #seen(db, result, { origin, command, output, runId, round }) {
    const signature = signatureOf(origin, command, output), at = now();
    const known = db.prepare("SELECT * FROM errors WHERE signature = ?").get(signature);
    if (!known) {
      const { lastInsertRowid } = db.prepare("INSERT INTO errors (signature, origin, command, excerpt, first_seen_at, first_run, first_round, last_seen_at, last_run, last_round) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(signature, origin, clean(command, 300), excerptOf(output) || clean(errorKey(output), 300), at, runId, round, at, runId, round);
      result.opened.push(Number(lastInsertRowid));
      return Number(lastInsertRowid);
    }
    const sameRound = known.last_run === runId && known.last_round === round;
    db.prepare("UPDATE errors SET status = 'open', occurrences = occurrences + ?, last_seen_at = ?, last_run = ?, last_round = ?, resolved_at = CASE WHEN status = 'open' THEN resolved_at ELSE NULL END WHERE id = ?").run(sameRound ? 0 : 1, at, runId, round, known.id);
    if (known.status === "resolved") result.recurred.push(known.id);
    return known.id;
  }
  #resolve(db, error, { runId, round, files, summary, verifiedBy }) {
    const at = now();
    const safeFiles = (files ?? []).filter((file) => !isSensitiveFile(file)).slice(0, 20).map((file) => clean(file, 200));
    db.prepare("UPDATE errors SET status = 'resolved', resolved_at = ? WHERE id = ?").run(at, error.id);
    db.prepare("INSERT INTO solutions (error_id, run_id, round, files, summary, verified_by, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(error.id, runId, round, JSON.stringify(safeFiles), clean(summary, 500), clean(verifiedBy, 300), at);
  }
  setErrorStatus(projectId, id, status) {
    if (!["open", "resolved", "retired"].includes(status)) throw new Error("Estado no válido.");
    return this.#tx(projectId, (db) => {
      const error = db.prepare("SELECT * FROM errors WHERE id = ?").get(Number(id));
      if (!error) throw new Error("No se encontró ese error.");
      db.prepare("UPDATE errors SET status = ? WHERE id = ?").run(status, error.id);
      return db.prepare("SELECT * FROM errors WHERE id = ?").get(error.id);
    });
  }
  listErrors(projectId, { status = "all", q, limit = 100 } = {}) {
    return this.#use(projectId, false, (db) => {
      if (!db) return [];
      const query = sanitizeFtsQuery(q ?? "");
      const filter = status === "all" ? "" : "e.status = ?";
      const rows = query
        ? db.prepare(`SELECT e.* FROM errors_fts JOIN errors e ON e.id = errors_fts.rowid WHERE errors_fts MATCH ? ${filter ? "AND " + filter : ""} ORDER BY bm25(errors_fts) LIMIT ?`).all(query.split(" ").map((w) => `"${w}"`).join(" "), ...(filter ? [status] : []), Math.min(Number(limit) || 100, 300))
        : db.prepare(`SELECT e.* FROM errors e ${filter ? "WHERE " + filter : ""} ORDER BY e.last_seen_at DESC LIMIT ?`).all(...(filter ? [status] : []), Math.min(Number(limit) || 100, 300));
      return rows.map((error) => ({ ...error, solutions: this.#solutions(db, error.id) }));
    });
  }
  #solutions(db, errorId) {
    return db.prepare("SELECT * FROM solutions WHERE error_id = ? ORDER BY id DESC LIMIT 3").all(errorId).map((s) => ({ ...s, files: JSON.parse(s.files) }));
  }
  // Solutions recorded for these failures: the same signature first, then similar errors.
  knownSolutions(projectId, failing = []) {
    return this.#use(projectId, false, (db) => {
      if (!db || !failing.length) return [];
      const found = new Map();
      for (const check of failing) {
        const output = `${check.output ?? ""}\n${check.stderr ?? ""}`;
        const exact = db.prepare("SELECT * FROM errors WHERE signature = ? AND status != 'retired'").get(signatureOf("check", check.command, output));
        const candidates = exact ? [exact] : [];
        const query = relevanceQuery(errorKey(output));
        if (query) candidates.push(...db.prepare("SELECT e.* FROM errors_fts JOIN errors e ON e.id = errors_fts.rowid WHERE errors_fts MATCH ? AND e.status != 'retired' ORDER BY bm25(errors_fts) LIMIT 3").all(query));
        for (const error of candidates) {
          const solutions = this.#solutions(db, error.id);
          if (solutions.length && !found.has(error.id)) found.set(error.id, { ...error, solutions, exact: error.id === exact?.id });
        }
      }
      return [...found.values()].slice(0, 4);
    });
  }

  // ---- What the director decided, and where the project stands ----
  // memory: { add: [{ kind, text }], retire: [{ id, reason }] } from the director's review.
  applyAgentMemory(projectId, memory, { source, runId = null, round = null }) {
    const added = [], retired = [];
    for (const item of memory?.add ?? []) {
      try {
        const fact = this.addFact(projectId, { kind: item.kind, text: item.text, source, runId, round });
        if (!fact.duplicate) added.push(fact.id);
      } catch {}
    }
    for (const item of memory?.retire ?? []) {
      try {
        const fact = this.listFacts(projectId, { status: "active", limit: 500 }).find((f) => f.id === Number(item.id));
        if (fact) {
          this.setFactStatus(projectId, fact.id, "retired", { reason: item.reason || `Retirado por ${source}`, by: source });
          retired.push(fact.id);
        }
      } catch {}
    }
    return { added, retired };
  }
  // Progress from each review, and the criteria still open as automatic pending items.
  recordReview(projectId, { review, runId, round, criteria = [] }) {
    if (review.summary?.trim()) this.addFact(projectId, { kind: "progress", text: `Ronda ${round}: ${review.summary}`, source: "director", runId, round });
    const open = review.decision === "complete" ? [] : (review.criteria ?? []).filter((c) => !c.met).map((c) => c.criterion).filter((c) => criteria.includes(c));
    this.#tx(projectId, (db) => {
      for (const fact of db.prepare("SELECT * FROM facts WHERE status = 'active' AND kind = 'pending' AND source = 'automata'").all()) {
        if (!open.some((criterion) => fact.text === clean(`Criterio pendiente: ${criterion}`))) db.prepare("UPDATE facts SET status = 'retired', retired_at = ?, retired_reason = 'El director lo dio por cumplido' WHERE id = ?").run(now(), fact.id);
      }
    });
    for (const criterion of open) this.addFact(projectId, { kind: "pending", text: `Criterio pendiente: ${criterion}`, source: "automata", runId, round });
  }

  // ---- What goes into a prompt ----
  // Only what is relevant to `query` and to the failing checks, within budgetTokens.
  brief(projectId, { query = "", failing = [], budgetTokens = MEMORY_BUDGET_TOKENS, directory = "" } = {}) {
    if (!fs.existsSync(this.file(projectId))) return { text: "", tokens: 0, facts: [], errors: [] };
    const solutions = this.knownSolutions(projectId, failing);
    const shallow = directory ? shallowNames(directory) : null;
    return this.#use(projectId, false, (db) => {
      const terms = relevanceQuery(query);
      const relevant = new Set(terms ? db.prepare("SELECT rowid FROM facts_fts WHERE facts_fts MATCH ? ORDER BY bm25(facts_fts) LIMIT 40").all(terms).map((row) => row.rowid) : []);
      const active = db.prepare("SELECT * FROM facts WHERE status = 'active' ORDER BY updated_at DESC, id DESC LIMIT 400").all();
      const byKind = (kind, limit) => active.filter((f) => f.kind === kind).sort((a, b) => Number(relevant.has(b.id)) - Number(relevant.has(a.id))).slice(0, limit);
      const usedFacts = [], usedErrors = [];
      const factLine = (fact) => {
        usedFacts.push(fact.id);
        const stale = directory ? staleMentions(fact.text, directory, { shallow }) : [];
        return `- [#${fact.id}] ${fact.text}${stale.length ? ` (⚠ ya no existe: ${stale.join(", ")})` : ""}`;
      };
      const files = (solution) => solution.files.length ? solution.files.join(", ") : "sin archivos registrados";
      const solutionLine = (error) => {
        usedErrors.push(error.id);
        const s = error.solutions[0];
        return `- [E${error.id}]${error.exact ? " (el mismo error)" : " (parecido)"} Falló \`${error.command}\`: ${clip(error.excerpt, 220)}\n  Se resolvió en la ronda ${s.round ?? "?"} cambiando ${files(s)}. ${clip(s.summary, 220)} (${s.verified_by})`;
      };
      const resolvedQuery = terms ? db.prepare("SELECT e.* FROM errors_fts JOIN errors e ON e.id = errors_fts.rowid WHERE errors_fts MATCH ? AND e.status = 'resolved' ORDER BY bm25(errors_fts) LIMIT 4").all(terms) : [];
      const recentResolved = db.prepare("SELECT * FROM errors WHERE status = 'resolved' ORDER BY resolved_at DESC LIMIT 4").all();
      const resolved = [...new Map([...resolvedQuery, ...recentResolved].map((e) => [e.id, e])).values()].filter((e) => !solutions.some((s) => s.id === e.id)).slice(0, 4).map((e) => ({ ...e, solutions: this.#solutions(db, e.id) })).filter((e) => e.solutions.length);
      const section = (title, lines) => lines.length ? `${title}\n${lines.join("\n")}` : "";
      const sections = [
        { id: "solutions", minTokens: 60, content: section("SOLUCIONES CONOCIDAS PARA LO QUE FALLA AHORA:", solutions.map(solutionLine)) },
        { id: "env", minTokens: 30, content: section("ENTORNO:", byKind("env", 12).map(factLine)) },
        { id: "decision", minTokens: 30, content: section("DECISIONES:", byKind("decision", 15).map(factLine)) },
        { id: "pending", minTokens: 30, content: section("PENDIENTES:", byKind("pending", 12).map(factLine)) },
        { id: "gotcha", minTokens: 30, content: section("TRAMPAS CONOCIDAS (ya comprobadas; no las vuelvas a investigar):", byKind("gotcha", 10).map(factLine)) },
        { id: "resolved", minTokens: 40, content: section("ERRORES QUE YA SE RESOLVIERON ANTES:", resolved.map((e) => solutionLine({ ...e, exact: false }).replace(" (parecido)", ""))) },
        { id: "progress", minTokens: 30, content: section("AVANCES RECIENTES:", byKind("progress", 4).map(factLine)) },
        { id: "note", minTokens: 20, content: section("NOTAS:", byKind("note", 8).map(factLine)) },
        { id: "recovery", minTokens: 20, content: section("INTERRUPCIONES RECIENTES (ya resueltas por Automata; no requieren acción):", byKind("recovery", 3).map(factLine)) }
      ];
      const kept = allocateBudget(sections, budgetTokens).filter((s) => s.content);
      const text = kept.map((s) => s.content).join("\n");
      // Only ids that made it into the text count as shown.
      return { text, tokens: estimateTokens(text), facts: usedFacts.filter((id) => text.includes(`[#${id}]`)), errors: usedErrors.filter((id) => text.includes(`[E${id}]`)) };
    });
  }
  stats(projectId) {
    return this.#use(projectId, false, (db) => {
      if (!db) return { facts: 0, retired: 0, open: 0, resolved: 0 };
      const count = (sql) => db.prepare(sql).get().n;
      return { facts: count("SELECT count(*) n FROM facts WHERE status = 'active'"), retired: count("SELECT count(*) n FROM facts WHERE status = 'retired'"), open: count("SELECT count(*) n FROM errors WHERE status = 'open'"), resolved: count("SELECT count(*) n FROM errors WHERE status = 'resolved'") };
    });
  }
}
export const kindLabel = (kind) => LABELS[kind] ?? kind;

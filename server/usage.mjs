// What a call really cost. Both CLIs report totals that are easy to misread as "context":
//  - Claude's result.usage adds up every request of the call (the cache is read again by each one);
//  - Codex's turn.completed.usage is the running total of the whole thread (it never goes down until a
//    new session starts).
// The context window only cares about the biggest single request, so that is measured apart:
// Claude's per-request usage comes with its assistant events, Codex's with the token_count events of
// its own session file (read only; nothing there is ever written).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const n = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

// One assistant message of Claude: its own request, unless a sub-agent wrote it (that has its own context).
export function claudeRequest(raw) {
  let e;
  try {
    e = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  const u = e?.type === "assistant" && !e.parent_tool_use_id ? e.message?.usage : null;
  if (!u) return null;
  return { id: e.message.id ?? null, context: n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens), output: n(u.output_tokens) };
}

// Largest, last and number of requests among the ones a call made. The same message id is written once
// per content block: it counts once.
export function summarizeRequests(requests, window = null) {
  const byId = new Map();
  for (const [i, r] of requests.entries()) byId.set(r.id ?? `#${i}`, r);
  const list = [...byId.values()];
  if (!list.length) return null;
  return { requests: list.length, contextPeak: Math.max(...list.map((r) => r.context)), contextLast: list.at(-1).context, contextWindow: window };
}

export const codexHome = (env = process.env) => env.CODEX_HOME || path.join(os.homedir(), ".codex");

// The session file of a thread: sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl, in the folder of
// the day the thread started (a resumed thread keeps it), so newest days are searched first.
export function findRollout(threadId, { home = codexHome(), maxDays = 30 } = {}) {
  if (!/^[0-9a-f-]{8,64}$/i.test(String(threadId ?? ""))) return null;
  const sessions = path.join(home, "sessions");
  const list = (dir) => { try { return fs.readdirSync(dir).sort().reverse(); } catch { return []; } };
  let days = 0;
  for (const year of list(sessions)) for (const month of list(path.join(sessions, year))) for (const day of list(path.join(sessions, year, month))) {
    if (days++ >= maxDays) return null;
    const folder = path.join(sessions, year, month, day);
    const name = list(folder).find((file) => file.endsWith(`-${threadId}.jsonl`));
    if (name) return path.join(folder, name);
  }
  return null;
}

// The requests a Codex call made, from the token_count events written after `sinceMs`.
export function readCodexRequests(file, sinceMs = 0, { tailBytes = 6 * 1024 * 1024 } = {}) {
  let text;
  try {
    const size = fs.statSync(file).size;
    if (size <= tailBytes) text = fs.readFileSync(file, "utf8");
    else {
      const fd = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(tailBytes);
        fs.readSync(fd, buffer, 0, tailBytes, size - tailBytes);
        text = buffer.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    return null;
  }
  const requests = [];
  let window = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"token_count"')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const info = e?.payload?.type === "token_count" ? e.payload.info : null;
    if (!info?.last_token_usage || Date.parse(e.timestamp) < sinceMs) continue;
    requests.push({ id: `o${e.ordinal ?? requests.length}`, context: n(info.last_token_usage.input_tokens), output: n(info.last_token_usage.output_tokens) });
    window = n(info.model_context_window) || window;
  }
  return summarizeRequests(requests, window);
}

export function codexRequests(threadId, sinceMs, options = {}) {
  const file = findRollout(threadId, options);
  return file ? readCodexRequests(file, sinceMs, options) : null;
}

// What this call consumed. A running total (Codex) is turned into the difference with the previous
// total of the same session; a fresh session starts from zero.
export function consumed(usage, { cumulative = false, previous = null } = {}) {
  const u = usage ?? {};
  const now = { input: n(u.input_tokens), cached: n(u.cached_input_tokens ?? u.cache_read_input_tokens), created: n(u.cache_creation_input_tokens ?? u.cache_write_input_tokens), output: n(u.output_tokens), reasoning: n(u.reasoning_output_tokens) };
  if (!cumulative || !previous || now.input < previous.input) return { call: now, total: now };
  return { call: { input: now.input - previous.input, cached: Math.max(0, now.cached - previous.cached), created: Math.max(0, now.created - previous.created), output: Math.max(0, now.output - previous.output), reasoning: Math.max(0, now.reasoning - previous.reasoning) }, total: now };
}

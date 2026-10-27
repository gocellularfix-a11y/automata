// Recovery: how Automata tells a usage limit from a passing failure, a malformed answer, a turn
// limit or a real error, and how long it waits before trying again. Nothing here runs agents or
// touches files: the coordinator decides what to do with the verdict.
//
// The message shapes come from the installed CLIs (strings found in Claude Code 2.1 and Codex 0.158
// binaries, plus the documented stream-json and exec --json events). None of the limit messages
// could be reproduced on demand, so every pattern has a generic fallback: an unknown wait time means
// a progressive wait, never an endless retry.
export const RECOVERY_KINDS = ["limit", "transient", "context", "malformed", "turns", "fatal", "aborted"];
// The director may be asked to correct an invalid review this many times before the run stops.
export const MAX_REVIEW_FIXES = 3;
// Usage-limit waits per stage without a reliable reset time: 5+15+30+60×5 minutes, about 6 hours.
export const MAX_LIMIT_WAITS = 8;
// Waits per run, whatever the reason. Beyond this the run stops and asks the user.
export const MAX_WAITS_PER_RUN = 40;
// A reset time further away than this is not trusted (clock problems, parsing errors).
export const MAX_WAIT_MS = 24 * 36e5;
export const DEFAULT_BACKOFF = {
  transient: [3e4, 12e4, 3e5, 6e5],
  limit: [5, 15, 30, 60, 60, 60, 60, 60].map((minutes) => minutes * 6e4),
  // Added after a reset time the CLI gave, so the first request lands after the window really opened.
  margin: 6e4
};
const AUTH = /no está instalado|not logged in|not authenticated|please (?:log|sign) in|login required|run `?\/?login|authentication_error|authentication failed|\bunauthorized\b|\b401\b|invalid api key|invalid_api_key|api key .*(?:invalid|expired|revoked)|permission_error|\bforbidden\b|\b403\b|model .{0,40}(?:not found|does not exist|not available|not supported|unknown)|unknown model|not a valid model|invalid model|no se puede leer|no se pudo iniciar/i;
const LIMIT = /usage limit|usage_limit|hit your limit|limit reached|limit has been reached|limit was reached|rate.?limit|too many requests|\b429\b|quota (?:exceeded|reached|limit)|insufficient_quota|out of credits|credits? (?:depleted|exhausted)|spend limit|resets? (?:at|in) |resets_at|try again (?:at|in|later)|usage_limited|usage limited|límite de uso|cuota/i;
const CONTEXT = /context window|context_window_exceeded|prompt is too long|too many tokens|exceeds? the (?:maximum )?context|maximum context length|input (?:is )?too long|conversation (?:is )?too long/i;
const TURNS = /error_max_turns|max(?:imum)? (?:number of )?turns|reached the maximum number of turns|límite de turnos/i;
const TIMEOUT = /límite de tiempo|timed? ?out|ETIMEDOUT/i;
const TRANSIENT = /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed|network|connection (?:error|failed|reset|closed|refused|lost)|stream (?:disconnected|ended|error)|disconnected|reconnect|overloaded|server_overloaded|\b50[0-4]\b|\b52[0-9]\b|internal server error|bad gateway|service unavailable|gateway timeout|temporarily unavailable|api_error|retryable|server error|unavailable|try again/i;
const MALFORMED = /no entregó el json|json de auditoría|sin respuesta|sin reporte final|unexpected token|not valid json|invalid json|did not match (?:the )?schema|schema/i;
const clip = (text, max) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
};
// ---- Reset times -------------------------------------------------------------------------------
// Wall-clock offset of a named zone at `at`, in ms. Unknown zones fall back to the local zone.
function zoneOffset(timeZone, at) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    return wall - Math.floor(at / 1e3) * 1e3;
  } catch {
    return null;
  }
}
// The next moment the clock in `timeZone` (or the local one) reads hour:minute.
function nextClock(hour, minute, timeZone, now) {
  const offset = timeZone ? zoneOffset(timeZone, now) : null;
  if (offset == null) {
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    if (target.getTime() <= now) target.setDate(target.getDate() + 1);
    return target.getTime();
  }
  const wallNow = new Date(now + offset);
  let target = Date.UTC(wallNow.getUTCFullYear(), wallNow.getUTCMonth(), wallNow.getUTCDate(), hour, minute) - offset;
  if (target <= now) target += 864e5;
  return target;
}
const future = (at, now) => Number.isFinite(at) && at > now && at - now <= MAX_WAIT_MS ? at : null;
// Reads a reset time out of free text: epoch seconds, ISO dates, "in 3 hours 12 minutes",
// "resets 3pm (America/Los_Angeles)", "Try again at 15:40". Returns ms since the epoch, or null.
export function parseResetTime(text, now = Date.now()) {
  const s = String(text ?? "");
  let m = /(?:\||resets?_at\W{0,3}|reset(?:s)?\s+at\s+|cooldown_until\W{0,3}|retry_at\W{0,3})(1[6-9]\d{8}|2\d{9})(\d{3})?\b/i.exec(s);
  if (m) return future(Number(m[1]) * 1e3, now);
  m = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|UTC|[+-]\d{2}:?\d{2})?/.exec(s);
  if (m) {
    const zone = m[2] === "UTC" ? "Z" : m[2] ?? "";
    const parsed = Date.parse(m[1].replace(" ", "T") + zone);
    if (Number.isFinite(parsed)) return future(parsed, now);
  }
  m = /retry[_ -]?(?:in|after)[_ ]?(?:ms|milliseconds)?\W{0,3}(\d+)\s*(ms|milliseconds|s|sec|seconds?)?\b/i.exec(s);
  if (m && /ms|milliseconds/i.test(m[0])) return future(now + Number(m[1]), now);
  if (m) return future(now + Number(m[1]) * 1e3, now);
  m = /\b(?:in|en|within)\s+(?:(\d+)\s*(?:h|hr|hrs|hours?|horas?)\b)?\s*(?:(?:and|y)\s+)?(?:(\d+)\s*(?:m|min|mins|minutes?|minutos?)\b)?\s*(?:(?:and|y)\s+)?(?:(\d+)\s*(?:s|sec|secs|seconds?|segundos?)\b)?/i.exec(s);
  if (m && (m[1] || m[2] || m[3])) return future(now + (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1e3, now);
  m = /(?:resets?|again|until|disponible|at|a las?)\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:\(([A-Za-z_]+(?:\/[A-Za-z_+-]+){1,2})\))?/i.exec(s);
  if (m && (m[2] || m[3])) {
    let hour = Number(m[1]);
    const minute = Number(m[2] ?? 0), meridiem = m[3]?.toLowerCase().replace(/\./g, "");
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59) return future(nextClock(hour, minute, m[4], now), now);
  }
  return null;
}
// Structured rate-limit data (Claude's rate_limit_event, Codex's usage limit error payloads).
export function resetFromInfo(info, now = Date.now()) {
  if (!info || typeof info !== "object") return null;
  for (const key of ["resets_at", "reset_at", "resetsAt", "cooldown_until", "retry_at"]) {
    const value = info[key];
    if (typeof value === "number") return future(value < 1e12 ? value * 1e3 : value, now);
    if (typeof value === "string") {
      const epoch = /^\d{10,13}$/.test(value) ? Number(value) * (value.length <= 10 ? 1e3 : 1) : Date.parse(value);
      if (Number.isFinite(epoch)) return future(epoch, now);
    }
  }
  if (typeof info.retry_in_ms === "number") return future(now + info.retry_in_ms, now);
  if (typeof info.retry_after === "number") return future(now + info.retry_after * 1e3, now);
  if (typeof info.resets_in_seconds === "number") return future(now + info.resets_in_seconds * 1e3, now);
  for (const nested of [info.rate_limit_info, info.rate_limits, info.error]) if (nested && typeof nested === "object") {
    const found = resetFromInfo(nested, now);
    if (found) return found;
  }
  return null;
}
// ---- Classification ------------------------------------------------------------------------------
// error: what the agent adapter or the coordinator threw. The adapter adds hints: role, agent (the
// process ran), exitCode, subtype (Claude's result subtype), lastMessage, detail (stderr), rateLimit
// (structured info) and progressed (the agent did work before failing).
export function classifyError(error, { now = Date.now() } = {}) {
  const message = String(error?.message ?? error ?? "");
  const text = [message, error?.lastMessage, error?.detail].filter(Boolean).join("\n");
  const base = { message: clip(message, 300), progressed: !!error?.progressed };
  if (error?.name === "AbortError") return { ...base, kind: "aborted" };
  if (error?.kind && RECOVERY_KINDS.includes(error.kind) && error.kind !== "fatal") return { ...base, kind: error.kind, resumeAt: error.kind === "limit" ? parseResetTime(text, now) : null };
  if (error?.subtype === "error_max_turns" || TURNS.test(text)) return { ...base, kind: "turns" };
  const info = error?.rateLimit;
  const rejected = info && (info.status === undefined || /reject|exceed|limited/i.test(String(info.status)));
  if (rejected) return { ...base, kind: "limit", resumeAt: resetFromInfo(info, now) ?? parseResetTime(text, now), source: "event" };
  if (AUTH.test(text) && !LIMIT.test(text)) return { ...base, kind: "fatal", reason: "auth" };
  if (LIMIT.test(text) || error?.subtype === "error_rate_limit" || error?.exitCode === 429) return { ...base, kind: "limit", resumeAt: parseResetTime(text, now), source: "text" };
  if (CONTEXT.test(text)) return { ...base, kind: "context" };
  if (error?.kind === "fatal") return { ...base, kind: "fatal" };
  if (MALFORMED.test(message)) return { ...base, kind: "malformed" };
  if (TIMEOUT.test(message)) return { ...base, kind: "transient", reason: "timeout" };
  if (TRANSIENT.test(text)) return { ...base, kind: "transient" };
  // The process ran and failed without saying why: worth one more try, never endless.
  if (error?.agent) return { ...base, kind: "transient", reason: "unknown-exit" };
  return { ...base, kind: "fatal" };
}
// ---- Waiting policy ------------------------------------------------------------------------------
// attempt: how many times this kind has failed in the current stage, counting this one.
// Returns { resumeAt, reliable } or null when the run should stop and ask the user.
export function planWait(verdict, { attempt = 1, maxRetries = 4, backoff = DEFAULT_BACKOFF, now = Date.now(), totalWaits = 0 } = {}) {
  if (totalWaits >= MAX_WAITS_PER_RUN) return null;
  const step = (list) => list[Math.min(Math.max(attempt, 1), list.length) - 1];
  if (verdict.kind === "limit") {
    if (attempt > MAX_LIMIT_WAITS) return null;
    if (verdict.resumeAt) return { resumeAt: verdict.resumeAt + (backoff.margin ?? 6e4), reliable: true };
    return { resumeAt: now + step(backoff.limit), reliable: false };
  }
  if (verdict.kind === "context") return attempt > maxRetries ? null : { resumeAt: now, reliable: true };
  if (verdict.kind === "transient") return attempt > maxRetries ? null : { resumeAt: now + step(backoff.transient), reliable: false };
  return null;
}
const AGENT = { coder: "Claude", auditor: "Codex" };
export const agentName = (role) => AGENT[role] ?? "el agente";
// One line for the UI, the events and the memory: why Automata waits and what it will do.
export function describeWait(waiting, language = "es") {
  const who = agentName(waiting.role), en = language === "en";
  const when = waiting.resumeAt ? new Date(waiting.resumeAt) : null;
  const sameDay = when && when.toDateString() === new Date().toDateString();
  const clock = when ? when.toLocaleTimeString(en ? "en-US" : "es-MX", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) + (sameDay ? "" : " " + when.toLocaleDateString(en ? "en-US" : "es-MX", { day: "numeric", month: "short" })) : "";
  const attempt = waiting.maxAttempts ? (en ? ` (attempt ${waiting.attempt} of ${waiting.maxAttempts})` : ` (intento ${waiting.attempt} de ${waiting.maxAttempts})`) : "";
  const reason = waiting.memory ? (en ? "Low free memory on this PC" : "Poca memoria libre en la PC") : {
    limit: en ? `${who} usage limit${waiting.reliable ? "" : ", reset time unknown"}` : `Límite de uso de ${who}${waiting.reliable ? "" : ", sin hora confiable de restablecimiento"}`,
    transient: en ? `${who} failed for a passing reason` : `Fallo pasajero de ${who}`,
    context: en ? `${who} session grew too large; a new one starts` : `La sesión de ${who} creció demasiado; se abre una nueva`
  }[waiting.kind] ?? (en ? `${who} needs another try` : `${who} necesita otro intento`);
  return en ? `${reason} · resumes at ${clock}${attempt}` : `${reason} · sigue a las ${clock}${attempt}`;
}

// Secret redaction, FTS query sanitising and token budgeting for the project memory.
//
// Adapted from local-mem (https://github.com/Teddorf/local-mem): scripts/redact.mjs,
// sanitizeFtsQuery in scripts/db.mjs and allocateBudget in scripts/session-start.mjs.
//
// MIT License
//
// Copyright (c) 2026 local-mem contributors
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// Changes from the original: a Spanish placeholder; GitHub OAuth/user/refresh tokens and AWS
// session keys; assignments with quoted JSON keys and more key names; whole PEM private-key
// blocks; connection strings only when they carry a password; a high-entropy check; and a
// budget allocator that never exceeds its total.
import path from "node:path";

const HIDDEN = "[credencial omitida]";

// Token shapes. None of these can match a quote, so they are also safe on raw JSON lines.
export const TOKEN_PATTERNS = [
  /\bsk-[a-zA-Z0-9_-]{20,}/g, // OpenAI / Anthropic API keys
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key IDs
  /(?:AccountKey|SharedAccessKey)=[a-zA-Z0-9+/=]{20,}/gi, // Azure connection strings
  /\bAIzaSy[a-zA-Z0-9_-]{33}\b/g, // Google Cloud API keys
  /\bya29\.[a-zA-Z0-9_-]{50,}/g, // Google OAuth access tokens
  /\bgh[pousr]_[a-zA-Z0-9]{30,}/g, // GitHub tokens
  /\bgithub_pat_[a-zA-Z0-9_]{22,}/g, // GitHub fine-grained tokens
  /\bglpat-[a-zA-Z0-9_-]{20,}/g, // GitLab tokens
  /\b[rs]k_(?:live|test)_[a-zA-Z0-9]{20,}/g, // Stripe secret and restricted keys
  /\bpk_live_[a-zA-Z0-9]{20,}/g, // Stripe publishable keys
  /\bSG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{22,}/g, // SendGrid
  /\bxox[bpoasr]-[a-zA-Z0-9-]{10,}/g, // Slack
  /\bnpm_[a-zA-Z0-9]{36,}/g, // npm
  /\bsbp_[a-zA-Z0-9]{40,}/g, // Supabase
  /\bvercel_[a-zA-Z0-9_-]{24,}/g, // Vercel
  /\bBearer\s+[a-zA-Z0-9._~+/=-]{20,}/gi, // Bearer tokens
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}(?:\.[a-zA-Z0-9_-]+)?/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g // PEM header (the body is removed by redactSecrets)
];
const KEY_NAMES = "password|passwd|pwd|passphrase|secret|client_secret|token|access_token|refresh_token|id_token|auth_token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|credential|credentials|authorization";
// key = value, key: value, "key": "value", KEY='value'. The key and its quotes stay; the value goes.
const ASSIGNMENT = new RegExp(`(["']?)\\b((?:[A-Za-z0-9]+[_-])*(?:${KEY_NAMES}))\\1(\\s*[:=]\\s*)(["']?)[^\\s"',;}]{4,}\\4`, "gi");
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
// scheme://user:password@host — only when a password is present.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@'"]+:[^\s@/'"]+@/gi;
const LONG_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
function entropy(text) {
  const counts = new Map();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}
// Random keys look like noise: mixed letters and digits with high entropy. Hex hashes (≤ 4 bits) are kept,
// and so are the CLI's own identifiers (message, tool-call and request ids), which are not secrets and
// keep tool calls and their results linked in the raw logs.
const KNOWN_ID = /^(?:toolu|srvtoolu|msg|req|msgbatch|call|item|thread|resp|rs|fc|ws|chatcmpl)_/;
const looksRandom = (run) => !KNOWN_ID.test(run) && /[0-9]/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run) && entropy(run) > 4.3;

// Safe on raw CLI JSON lines: replaces token shapes only.
export function redactTokens(text) {
  let out = String(text ?? "");
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, HIDDEN);
  return out;
}
// For text that goes into the project memory: tokens, assignments, key blocks, URL passwords and random keys.
export function redactSecrets(text) {
  let out = String(text ?? "").replace(PEM_BLOCK, HIDDEN);
  out = redactTokens(out);
  out = out.replace(ASSIGNMENT, (_m, quote, key, sep) => `${quote}${key}${quote}${sep}${HIDDEN}`);
  out = out.replace(URL_PASSWORD, `$1${HIDDEN}@`);
  out = out.replace(LONG_RUN, (run) => looksRandom(run) ? HIDDEN : run);
  return out;
}
// Every string inside a parsed value, so a JSON line keeps its structure while losing its secrets.
export function redactDeep(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)]));
  return value;
}
// Raw CLI log lines: JSON is parsed, cleaned and written back; anything else is cleaned as text.
export function redactJsonLine(line) {
  try {
    return JSON.stringify(redactDeep(JSON.parse(line)));
  } catch {
    return redactSecrets(line);
  }
}
const SENSITIVE_FILES = new Set([".env", "credentials.json", "credentials.yml", "credentials.yaml", "secrets.json", "secrets.yml", "secrets.yaml", ".npmrc", ".netrc", ".pypirc", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "kubeconfig", "token.json", "auth.json"]);
export function isSensitiveFile(file) {
  const name = path.basename(String(file ?? "")).toLowerCase();
  return SENSITIVE_FILES.has(name) || name.startsWith(".env.") && !/\.(example|sample|template)$/.test(name) || /\.(pem|key|p12|pfx|keystore|jks)$/.test(name);
}

// FTS5 treats quotes, parentheses and operators as syntax; user and agent text must be plain terms.
export function sanitizeFtsQuery(query, max = 300) {
  if (!query || typeof query !== "string") return null;
  const terms = query.replace(/['"(){}[\]^~*:]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter((term) => term && term !== "-" && !/^(AND|OR|NOT|NEAR)$/i.test(term));
  const sanitized = terms.join(" ").slice(0, max).trim();
  return sanitized || null;
}

export const CHARS_PER_TOKEN = 4;
export const estimateTokens = (text) => Math.ceil(String(text ?? "").length / CHARS_PER_TOKEN);
// sections: [{ id, content, minTokens }], in priority order. Content that does not fit is cut at a line end;
// a section that cannot get its minimum is left out. The total never exceeds totalBudget.
export function allocateBudget(sections, totalBudget) {
  let remaining = totalBudget;
  return sections.map((section) => {
    if (!section.content || remaining <= 0) return { id: section.id, content: null, allocated: 0 };
    const tokens = estimateTokens(section.content);
    if (tokens <= remaining) {
      remaining -= tokens;
      return { id: section.id, content: section.content, allocated: tokens };
    }
    if (remaining < (section.minTokens ?? 0)) return { id: section.id, content: null, allocated: 0 };
    const cut = section.content.slice(0, remaining * CHARS_PER_TOKEN);
    const lastLine = cut.lastIndexOf("\n");
    const content = lastLine > 0 ? cut.slice(0, lastLine) : cut;
    const allocated = estimateTokens(content);
    remaining -= allocated;
    return { id: section.id, content, allocated };
  });
}

// Audits Automata's stored records (run logs, prompts, reports, events, messages and the memory
// files) for secrets that earlier versions may have written before redaction existed.
//
//   node scripts/audit-secrets.mjs [dataDir] [--quarantine]
//
// Default: report only. Nothing is modified. The report goes to artifacts/secret-audit-<time>.json
// and the console, with the secret itself never printed (only its position and pattern).
//
// --quarantine: for each text file with findings, the original is moved, byte for byte, into
// <dataDir>/quarantine/<time>/<same relative path> (owner-only permissions) and a redacted copy
// takes its place. Each replacement is verified before it is committed: JSON files must parse
// again, JSONL lines that parsed before must still parse, and the SHA-256 of both versions is
// written to the manifest, so the change can be checked and reversed. Memory databases are
// reported but never rewritten here (the memory module redacts on write; use the Memory panel).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { redactSecrets, TOKEN_PATTERNS } from "../server/redact.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const quarantine = args.includes("--quarantine");
const dataDir = path.resolve(args.find((a) => !a.startsWith("--")) ?? path.join(process.env.APPDATA ?? "", "Automata", "workspace"));
if (!fs.existsSync(dataDir)) {
  console.error(`No existe la carpeta de datos: ${dataDir}`);
  process.exit(2);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const TEXT = /\.(?:jsonl|json|txt|md|ps1|sh|log)$/i;
const SKIP = /(?:^|[\\/])(?:quarantine|coordinator\.lock|access-token)(?:[\\/]|$)/;
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const PATTERN_NAMES = ["OpenAI/Anthropic key", "AWS key id", "Azure connection string", "Google API key", "Google OAuth token", "GitHub token", "GitHub fine-grained token", "GitLab token", "Stripe secret key", "Stripe publishable key", "SendGrid", "Slack", "npm", "Supabase", "Vercel", "Bearer token", "JWT", "PEM private key"];
function patternsIn(line) {
  const names = TOKEN_PATTERNS.map((pattern, i) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(line) ? PATTERN_NAMES[i] : null).filter(Boolean);
  return names.length ? names : ["assignment, URL password or high-entropy string"];
}
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (SKIP.test(file)) continue;
    if (entry.isDirectory()) yield* walk(file);
    else yield file;
  }
}
const report = { at: new Date().toISOString(), dataDir, mode: quarantine ? "quarantine" : "report", files: 0, findings: [], databases: [], replaced: [] };
for (const file of walk(dataDir)) {
  if (!TEXT.test(file)) continue;
  report.files++;
  const original = fs.readFileSync(file);
  const text = original.toString("utf8");
  const lines = text.split("\n");
  const hits = [];
  const redacted = lines.map((line, i) => {
    const clean = redactSecrets(line);
    if (clean !== line) hits.push({ line: i + 1, patterns: patternsIn(line), redactedPreview: clean.slice(0, 160) });
    return clean;
  });
  if (!hits.length) continue;
  const relative = path.relative(dataDir, file);
  report.findings.push({ file: relative, bytes: original.length, hits: hits.length, lines: hits.slice(0, 20) });
  if (!quarantine) continue;
  // Verification before anything is replaced.
  const output = redacted.join("\n");
  let valid = true, reason = "";
  if (/\.json$/i.test(file)) {
    try { JSON.parse(output); } catch (e) { valid = false; reason = "el JSON ya no se puede leer: " + e.message; }
  } else if (/\.jsonl$/i.test(file)) {
    for (let i = 0; i < lines.length && valid; i++) {
      let before = true;
      try { JSON.parse(lines[i]); } catch { before = false; }
      if (!before) continue;
      try { JSON.parse(redacted[i]); } catch { valid = false; reason = `la línea ${i + 1} dejó de ser JSON válido`; }
    }
  }
  if (!valid) {
    report.replaced.push({ file: relative, replaced: false, reason });
    continue;
  }
  const keep = path.join(dataDir, "quarantine", stamp, relative);
  fs.mkdirSync(path.dirname(keep), { recursive: true });
  fs.copyFileSync(file, keep);
  fs.chmodSync(keep, 0o600);
  if (!fs.readFileSync(keep).equals(original)) {
    report.replaced.push({ file: relative, replaced: false, reason: "la copia en cuarentena no coincide con el original" });
    continue;
  }
  const temporary = file + ".redacted.tmp";
  fs.writeFileSync(temporary, output, { mode: 0o600 });
  fs.renameSync(temporary, file);
  report.replaced.push({ file: relative, replaced: true, quarantined: path.relative(dataDir, keep), sha256Before: sha(original), sha256After: sha(Buffer.from(output)) });
}
// Memory databases: read-only scan of the stored text.
const memoryDir = path.join(dataDir, "memory");
if (fs.existsSync(memoryDir)) for (const name of fs.readdirSync(memoryDir).filter((n) => n.endsWith(".db"))) {
  const db = new DatabaseSync(path.join(memoryDir, name), { readOnly: true });
  try {
    const rows = [...db.prepare("SELECT 'fact' AS kind, id, text FROM facts").all(), ...db.prepare("SELECT 'error' AS kind, id, excerpt AS text FROM errors").all(), ...db.prepare("SELECT 'solution' AS kind, id, summary AS text FROM solutions").all()];
    const hits = rows.filter((row) => redactSecrets(row.text) !== row.text).map((row) => ({ kind: row.kind, id: row.id, patterns: patternsIn(row.text) }));
    report.databases.push({ file: path.join("memory", name), rows: rows.length, hits });
  } finally {
    db.close();
  }
}
if (quarantine) {
  const manifest = path.join(dataDir, "quarantine", stamp, "manifest.json");
  if (report.replaced.length) fs.writeFileSync(manifest, JSON.stringify(report, null, 2), { mode: 0o600 });
}
fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
const out = path.join(root, "artifacts", `secret-audit-${stamp}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 2));
const dbHits = report.databases.reduce((n, d) => n + d.hits.length, 0);
console.log(`Auditoría de secretos · ${dataDir}`);
console.log(`Archivos de texto revisados: ${report.files} · con posibles secretos: ${report.findings.length} (${report.findings.reduce((n, f) => n + f.hits, 0)} líneas)`);
console.log(`Bases de memoria revisadas: ${report.databases.length} · registros con posibles secretos: ${dbHits}`);
for (const finding of report.findings) console.log(`  ${finding.file}: ${finding.hits} línea(s) · ${[...new Set(finding.lines.flatMap((l) => l.patterns))].join(", ")}`);
if (quarantine) for (const item of report.replaced) console.log(`  ${item.replaced ? "reemplazado" : "NO reemplazado"}: ${item.file}${item.reason ? " · " + item.reason : ""}`);
else if (report.findings.length) console.log("Nada se modificó. Para reemplazar con copia en cuarentena verificable: --quarantine");
console.log(`Reporte: ${out}`);

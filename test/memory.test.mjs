import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore, parseRemember, signatureOf, errorKey, changedFiles, isBuildOrTest } from "../server/memory.mjs";
import { redactSecrets, redactTokens, allocateBudget, estimateTokens, sanitizeFtsQuery, isSensitiveFile } from "../server/redact.mjs";

const temporary = [];
after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-memory-"));
  temporary.push(dir);
  return new MemoryStore(path.join(dir, "memory"));
}
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const failing = (output) => ({ command: "npm test", passed: false, code: 1, output, stderr: "" });
const passing = { command: "npm test", passed: true, code: 0, output: "ℹ pass 3\nℹ fail 0", stderr: "" };
// Fake secrets assembled at runtime so no real-looking key sits in the source as one literal.
const SECRETS = [
  "sk-ant-api03-" + "Zx9".repeat(12), "AKIA" + "ABCDEFGHIJKLMNOP", "ghp_" + "a1B2c3".repeat(7), "github_pat_" + "11ABCDEFG0".repeat(4),
  "xoxb-" + "1234567890-abcdefghij", "eyJhbGciOiJIUzI1NiJ9." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig" + "nature123",
  "Kq7Rz2Lw9Xc4Vb8Nm1Pd6Ft3Gh5Jy0Ae7Sx2Ud4Wi9", "s3cretP4ssw0rd!"
];

test("cada proyecto tiene su propio archivo y no ve los recuerdos de otro", () => {
  const m = store();
  m.addFact(A, { kind: "decision", text: "Usar SQLite local para el inventario", source: "director" });
  m.addFact(B, { kind: "env", text: "Android compila con el JDK 21", source: "coder" });
  assert.deepEqual(m.listFacts(A).map((f) => f.text), ["Usar SQLite local para el inventario"]);
  assert.deepEqual(m.listFacts(B).map((f) => f.text), ["Android compila con el JDK 21"]);
  assert.equal(m.listFacts(A, { q: "JDK" }).length, 0);
  assert.equal(m.brief(B, { query: "inventario SQLite" }).text.includes("inventario"), false);
  assert.notEqual(m.file(A), m.file(B));
  for (const bad of ["../otro", "..\\otro", "a/b", "", "x".repeat(65), null]) assert.throws(() => m.file(bad), /no válido/);
  // A file copied over from another project is refused instead of read.
  fs.copyFileSync(m.file(A), m.file(B));
  assert.throws(() => m.listFacts(B), /otro proyecto/);
});

test("leer un proyecto sin memoria no crea archivos, y la memoria sobrevive a un reinicio", () => {
  const m = store();
  assert.deepEqual(m.listFacts(A), []);
  assert.equal(m.brief(A).text, "");
  assert.equal(fs.existsSync(m.file(A)), false);
  m.addFact(A, { kind: "decision", text: "La API usa Express sin ORM", source: "director", runId: "run-1", round: 2 });
  const again = new MemoryStore(m.directory);
  const [fact] = again.listFacts(A);
  assert.equal(fact.text, "La API usa Express sin ORM");
  assert.equal(fact.run_id, "run-1");
  assert.equal(fact.round, 2);
  assert.match(again.brief(A).text, /DECISIONES:\n- \[#\d+\] La API usa Express sin ORM/);
});

test("un error de verificación queda ligado a la solución que lo hizo pasar, y vuelve con ella si reaparece", () => {
  const m = store();
  const out = "▶ calcularCuenta\n✖ la CLI imprime el resultado en JSON (39.7ms)\n  Error: Cannot find module 'C:\\Users\\x\\proyecto\\src\\cli.mjs'\nℹ fail 1";
  let r = m.recordChecks(A, { runId: "run-1", round: 1, checks: [failing(out)] });
  assert.equal(r.opened.length, 1);
  // The same failure in the next round is the same error, not a new one.
  r = m.recordChecks(A, { runId: "run-1", round: 2, checks: [failing(out.replace("39.7ms", "41.2ms"))] });
  assert.equal(r.opened.length, 0);
  r = m.recordChecks(A, { runId: "run-1", round: 3, checks: [passing], files: ["src/cli.mjs", "README.md", ".env"], report: "Creé src/cli.mjs con el parser de argumentos y el README." });
  assert.equal(r.resolved.length, 1);
  const [error] = m.listErrors(A);
  assert.equal(error.status, "resolved");
  assert.equal(error.occurrences, 2);
  assert.deepEqual(error.solutions[0].files, ["src/cli.mjs", "README.md"], "los archivos sensibles no se guardan");
  assert.equal(error.solutions[0].round, 3);
  assert.match(error.solutions[0].verified_by, /Verificación aprobada: npm test/);
  // In a later run the problem comes back: it reopens, and the brief brings the earlier solution.
  r = m.recordChecks(A, { runId: "run-2", round: 1, checks: [failing(out.replace("39.7ms", "12ms"))] });
  assert.deepEqual(r.recurred, [error.id]);
  const brief = m.brief(A, { failing: [failing(out)] });
  assert.match(brief.text, /SOLUCIONES CONOCIDAS PARA LO QUE FALLA AHORA:/);
  assert.match(brief.text, /el mismo error/);
  assert.match(brief.text, /src\/cli\.mjs, README\.md/);
  assert.deepEqual(brief.errors, [error.id]);
});

test("los comandos de compilación que fallan y luego funcionan quedan resueltos con lo que cambió en medio", () => {
  const m = store(), dir = "C:\\proyectos\\app";
  const log = [
    { t: "cmd", id: "1", command: "npm run build:android", ok: false, output: "ERROR: JAVA_HOME is set to an invalid directory: C:\\Program Files\\Java\\jdk-25" },
    { t: "cmd", id: "2", command: "ls android", ok: false, output: "no such file" },
    { t: "note", text: "Uso el JDK 21 de Temurin, que sí está instalado." },
    { t: "edit", id: "3", path: "C:\\proyectos\\app\\package.json", diff: "+ JAVA_HOME", ok: true },
    { t: "cmd", id: "4", command: "npm run build:android", ok: true, output: "BUILD SUCCESSFUL" }
  ];
  const r = m.recordCommands(A, { runId: "run-1", round: 1, log, directory: dir });
  assert.equal(r.opened.length, 1, "los comandos de exploración no se registran");
  assert.equal(r.resolved.length, 1);
  const [error] = m.listErrors(A);
  assert.equal(error.origin, "command");
  assert.deepEqual(error.solutions[0].files, ["package.json"]);
  assert.match(error.solutions[0].summary, /JDK 21/);
  assert.equal(log.some((item) => "memoryError" in item), false);
  assert.equal(isBuildOrTest("git status"), false);
  assert.equal(isBuildOrTest("node --test acceptance"), true);
});

test("los recuerdos se corrigen, se retiran y se restauran, con historial", () => {
  const m = store();
  const wrong = m.addFact(A, { kind: "gotcha", text: "Los archivos tienen mojibake en UTF-8", source: "director" });
  m.addFact(A, { kind: "decision", text: "Interfaz en www/ compartida por Electron y Capacitor", source: "director" });
  m.updateFact(A, wrong.id, { text: "La codificación UTF-8 está bien; PowerShell 5.1 la muestra mal", by: "user" });
  assert.match(m.brief(A).text, /PowerShell 5\.1 la muestra mal/);
  m.setFactStatus(A, wrong.id, "retired", { reason: "Ya no aplica" });
  assert.doesNotMatch(m.brief(A).text, /PowerShell/);
  assert.equal(m.listFacts(A).length, 1);
  assert.equal(m.listFacts(A, { status: "retired" })[0].retired_reason, "Ya no aplica");
  m.setFactStatus(A, wrong.id, "active");
  assert.match(m.brief(A).text, /PowerShell/);
  assert.deepEqual(m.history(A, wrong.id).map((h) => h.action), ["add", "update", "retire", "restore"]);
  // The same fact twice is one fact.
  assert.equal(m.addFact(A, { kind: "decision", text: "interfaz en www/ compartida por electron y capacitor" }).duplicate, true);
  assert.throws(() => m.addFact(A, { kind: "otro", text: "x y z" }), /Tipo/);
  assert.throws(() => m.updateFact(A, 999, { text: "nuevo" }), /No se encontró/);
});

test("el director agrega y retira recuerdos, y los criterios abiertos son pendientes automáticos", () => {
  const m = store();
  const old = m.addFact(A, { kind: "gotcha", text: "El build requiere Python", source: "director" });
  const r = m.applyAgentMemory(A, { add: [{ kind: "decision", text: "Persistencia en SQLite" }, { kind: "nada", text: "inválido" }], retire: [{ id: old.id, reason: "Falso: no usa Python" }, { id: 9999, reason: "no existe" }] }, { source: "director", runId: "r", round: 1 });
  assert.equal(r.added.length, 1);
  assert.deepEqual(r.retired, [old.id]);
  const criteria = ["La CLI funciona", "Hay README"];
  m.recordReview(A, { review: { decision: "continue", summary: "Falta el README.", criteria: [{ criterion: "La CLI funciona", met: true }, { criterion: "Hay README", met: false }, { criterion: "inventado", met: false }] }, runId: "r", round: 1, criteria });
  assert.deepEqual(m.listFacts(A, { kind: "pending" }).map((f) => f.text), ["Criterio pendiente: Hay README"]);
  m.recordReview(A, { review: { decision: "complete", summary: "Todo cumplido.", criteria: [] }, runId: "r", round: 2, criteria });
  assert.equal(m.listFacts(A, { kind: "pending" }).length, 0);
  assert.equal(m.listFacts(A, { kind: "progress" }).length, 2);
});

test("lo recuperado respeta el presupuesto y prioriza lo relevante", () => {
  const m = store();
  for (let i = 0; i < 120; i++) m.addFact(A, { kind: i % 2 ? "decision" : "note", text: `Recuerdo número ${i} con bastante texto para ocupar espacio en el contexto del modelo ${"x".repeat(150)}`, source: "director" });
  m.addFact(A, { kind: "decision", text: "El inventario descuenta existencias al cerrar cada venta", source: "director" });
  m.addFact(A, { kind: "env", text: "Node 24 y Git en Windows 11", source: "coder" });
  const brief = m.brief(A, { query: "corrige el descuento de existencias del inventario", budgetTokens: 1500 });
  assert.ok(brief.tokens <= 1500, `tokens=${brief.tokens}`);
  assert.ok(brief.text.length <= 1500 * 4);
  assert.match(brief.text, /^ENTORNO:/);
  const decisions = brief.text.split("DECISIONES:\n")[1];
  assert.match(decisions.split("\n")[0], /inventario descuenta existencias/, "lo relevante va primero");
  assert.ok(m.brief(A, { budgetTokens: 200 }).tokens <= 200);
  assert.deepEqual(allocateBudget([{ id: "a", content: "x".repeat(400), minTokens: 10 }, { id: "b", content: "y".repeat(400), minTokens: 200 }], 150).map((s) => s.allocated), [100, 0]);
  assert.ok(allocateBudget([{ id: "a", content: "x".repeat(40), minTokens: 50 }], 5)[0].allocated <= 5, "una sección menor que su mínimo tampoco se pasa del total");
});

test("ningún secreto llega a la memoria, ni en hechos, ni en errores, ni en soluciones", () => {
  const m = store();
  const blob = [
    ...SECRETS.slice(0, 7),
    `password=${SECRETS[7]}`, `"api_key": "${SECRETS[6]}"`, `DB_PASSWORD='${SECRETS[7]}'`,
    `postgres://admin:${SECRETS[7]}@db.local:5432/app`, "Authorization: Bearer " + SECRETS[6],
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----"
  ].join("\n");
  m.addFact(A, { kind: "env", text: blob, source: "coder" });
  m.recordChecks(A, { runId: "r", round: 1, checks: [{ command: `deploy --token=${SECRETS[2]}`, passed: false, code: 1, output: `error: auth failed for ${SECRETS[0]}\n${blob}`, stderr: "" }] });
  m.recordChecks(A, { runId: "r", round: 2, checks: [{ command: `deploy --token=${SECRETS[2]}`, passed: true, output: "" }], report: `Arreglé el token ${SECRETS[1]} y la clave ${SECRETS[6]}`, files: ["src/app.js"] });
  const raw = fs.readFileSync(m.file(A)).toString("latin1");
  for (const secret of SECRETS) {
    assert.equal(raw.includes(secret), false, `se guardó ${secret.slice(0, 12)}…`);
    assert.equal(m.brief(A).text.includes(secret), false);
  }
  assert.equal(raw.includes("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ"), false);
  // Ordinary text survives: hashes, paths and words are not secrets.
  const sha = "acef35f49e8f1d15a9b6cb0b093cae1f894b3ef6145e9aedaa1c889d3c80fb3f";
  assert.equal(redactSecrets(`huella ${sha} en src/cuenta.mjs, token: 5`), `huella ${sha} en src/cuenta.mjs, token: 5`);
  // The raw-log variant only touches token shapes, so JSON lines stay valid.
  const line = JSON.stringify({ text: `clave ${SECRETS[0]} y "password": "x1y2z3w4"` });
  assert.doesNotThrow(() => JSON.parse(redactTokens(line)));
  assert.equal(redactTokens(line).includes(SECRETS[0]), false);
  assert.equal(isSensitiveFile("C:/app/.env.production"), true);
  assert.equal(isSensitiveFile(".env.example"), false);
});

test("firmas de error, secciones PARA RECORDAR y consultas de búsqueda", () => {
  assert.equal(errorKey("ok\n✖ suma (1.2ms)\nℹ fail 1"), "✖ suma");
  assert.equal(signatureOf("check", "npm  test", "Error at C:\\a\\b\\c.js:12:5"), signatureOf("check", "npm test", "Error at D:\\x\\c.js:99:1"));
  assert.notEqual(signatureOf("check", "npm test", "TypeError: x"), signatureOf("check", "npm run build", "TypeError: x"));
  const report = "Listo.\n\n**PARA RECORDAR:**\n- [entorno] Android compila con JDK 21\n- [decisión] Motor de cálculo sin eval\n- [trampa] PowerShell 5.1 muestra mal el UTF-8\n- sin etiqueta\n\nFin del reporte.";
  assert.deepEqual(parseRemember(report), [{ kind: "env", text: "Android compila con JDK 21" }, { kind: "decision", text: "Motor de cálculo sin eval" }, { kind: "gotcha", text: "PowerShell 5.1 muestra mal el UTF-8" }, { kind: "note", text: "sin etiqueta" }]);
  assert.deepEqual(parseRemember("Sin sección"), []);
  assert.equal(sanitizeFtsQuery('NOT "x" OR (y)'), "x y");
  assert.deepEqual(changedFiles([{ t: "edit", path: "C:\\p\\src\\a.js" }, { t: "write", path: "C:\\p\\b.md" }, { t: "edit", path: "C:\\p\\c.js", ok: false }], "C:\\p"), ["src/a.js", "b.md"]);
  assert.equal(estimateTokens("abcd"), 1);
});

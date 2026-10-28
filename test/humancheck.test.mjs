// P4 stabilization: the three real blocks of 28 Oct (a read-only director asking a person to open the page) and what
// Automata does with each, against a block that really needs a person.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyBlock, reaskMessage, overrideReview, overridePrompt, coveredText, MAX_BLOCK_OVERRIDES } from "../server/humancheck.mjs";
import { buildAutomataEvidence, summarizePage, summarizeScenarios } from "../server/evidence.mjs";

const REAL = JSON.parse(fs.readFileSync(new URL("./fixtures/real-blocks.json", import.meta.url), "utf8"));
const page = { ok: true, title: "Gastos", controls: 6, browser: "chrome.exe", resources: { total: 3, loaded: 3, failed: [], files: ["index.html"] }, problems: [] };
const evidence = ({ browser = true, ui = null } = {}) => buildAutomataEvidence({ round: 8, checks: [{ command: "node --test tests/app.test.js", passed: true, code: 0, output: "ℹ tests 10\nℹ pass 10\nℹ fail 0" }], page: browser ? summarizePage(page) : summarizePage({ ok: null, skipped: "No hay navegador." }), ui: ui ?? summarizeScenarios({ found: false }), webManaged: true });

test("los tres bloqueos reales piden a una persona hacer algo que Automata puede hacer", () => {
  assert.equal(REAL.length, 3);
  for (const block of REAL) {
    const result = classifyBlock(block, { evidence: evidence(), web: true });
    assert.equal(result.humanCheck, true, `${block.label}: ${block.summary.slice(0, 60)}`);
    assert.equal(result.sensitive, false, block.label);
    assert.equal(result.actionable, true, `${block.label}: hay navegador y es una página web`);
  }
});

test("sin navegador, o en un proyecto que no es una página, el bloqueo no se convierte en tarea", () => {
  for (const block of REAL) {
    assert.equal(classifyBlock(block, { evidence: evidence({ browser: false }), web: true }).actionable, false, "sin navegador solo una persona puede mirarla");
    assert.equal(classifyBlock(block, { evidence: evidence(), web: false }).actionable, false, "una consola no se abre en el navegador");
    assert.equal(classifyBlock(block, { evidence: null, web: true }).actionable, false, "sin ninguna evidencia de Automata todavía");
  }
});

test("lo que de verdad es de una persona nunca se toca: decisiones, datos, secretos, pagos y publicaciones", () => {
  const legit = [
    "Falta saber en qué moneda debe mostrar los importes.",
    "Se necesita la credencial de la API; alguien debe abrir la cuenta y pasarla.",
    "Hace falta que la persona decida si se publica en GitHub antes de seguir.",
    "Para continuar hay que borrar los datos de prueba reales y alguien debe confirmarlo."
  ];
  for (const text of legit) {
    const result = classifyBlock({ summary: text, nextPrompt: text }, { evidence: evidence(), web: true });
    assert.equal(result.actionable, false, text);
  }
});

test("una tarea marcada blocked cuya nota pide la prueba manual también se reconoce", () => {
  const result = classifyBlock({ summary: "No se pudo verificar T2.", nextPrompt: "", plan: { update: [{ id: 2, status: "blocked", note: "Falta una prueba manual en navegador que confirme el caso." }] } }, { evidence: evidence(), web: true });
  assert.equal(result.humanCheck, true);
});

test("el reenvío al director nombra lo que Automata ya comprobó y, si falta la interfaz, cómo producirla", () => {
  const block = classifyBlock(REAL[2], { evidence: evidence(), web: true });
  const message = reaskMessage(block, evidence());
  assert.match(message, /AUTOMATA ejecuta esas comprobaciones por su cuenta/);
  assert.match(message, /Lo que Automata YA comprobó y no debe repetir una persona: las pruebas del proyecto \(10 de 10\); el arranque y la carga de la página en un navegador real\./);
  assert.match(message, /ui-check\.json[\s\S]*decision=continue/);
  const withUi = evidence({ ui: summarizeScenarios({ found: true, scenarios: [{ name: "a", steps: [] }], problems: [] }, [{ name: "a", ok: true, steps: 3, failed: null }], true) });
  const covered = reaskMessage(classifyBlock(REAL[2], { evidence: withUi, web: true }), withUi);
  assert.match(covered, /1 escenario\(s\) de interfaz en un navegador real/);
  assert.doesNotMatch(covered, /Si lo que falta es ver la interfaz/);
});

test("si el director insiste, la revisión sigue como tarea para Claude: nunca se aprueba y la tarea no queda bloqueada", () => {
  const review = structuredClone({ decision: "blocked", summary: REAL[1].summary, nextPrompt: REAL[1].nextPrompt, task: "T11", plan: REAL[1].plan, criteria: [{ criterion: "c", met: false, evidence: "" }] });
  const block = classifyBlock(review, { evidence: evidence(), web: true });
  overrideReview(review, block, evidence());
  assert.equal(review.decision, "continue", "jamás complete");
  assert.deepEqual(review.plan.update.filter((u) => u.status === "blocked"), []);
  assert.match(review.nextPrompt, /Automata ya hace esas comprobaciones por su cuenta/);
  assert.match(review.nextPrompt, /ui-check\.json/);
  assert.match(review.nextPrompt, /No intentes ejecutar la aplicación tú/);
  assert.equal(review.criteria[0].met, false, "los criterios sin evidencia siguen sin cumplir");
  assert.match(review.summary, /Automata: esa comprobación no requiere a una persona/);
  assert.equal(MAX_BLOCK_OVERRIDES, 2);
});

test("con la interfaz ya comprobada, la tarea pide relacionar cada criterio con su prueba, no repetir la prueba manual", () => {
  const withUi = evidence({ ui: summarizeScenarios({ found: true, scenarios: [{ name: "a", steps: [] }], problems: [] }, [{ name: "a", ok: true, steps: 3, failed: null }], true) });
  const block = classifyBlock(REAL[0], { evidence: withUi, web: true });
  const prompt = overridePrompt(block, withUi, REAL[0]);
  assert.match(prompt, /Revisa que cada criterio de la tarea quede demostrado/);
  assert.doesNotMatch(prompt, /Falta evidencia de la interfaz/);
  assert.match(coveredText(block, withUi), /lanzador|escenario/);
});

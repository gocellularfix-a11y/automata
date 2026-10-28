// P4 stabilization: what the director is shown as Automata's own evidence, and what counts as covered.
import test from "node:test";
import assert from "node:assert/strict";
import { parseTestSummary, summarizeChecks, summarizePage, summarizeScenarios, buildAutomataEvidence, renderAutomataEvidence, coveredAreas } from "../server/evidence.mjs";

const NODE_OUTPUT = "✔ uno (0.5ms)\n✔ dos (0.1ms)\nℹ tests 14\nℹ suites 0\nℹ pass 14\nℹ fail 0\nℹ cancelled 0\n";
const checks = (passed = true, output = NODE_OUTPUT) => [{ command: "node --test tests/app.test.js", passed, code: passed ? 0 : 1, output }];
const goodPage = { ok: true, title: "Gastos del mes", controls: 6, browser: "chrome.exe", resources: { total: 3, loaded: 3, failed: [], files: ["index.html", "styles.css", "app.js"] }, problems: [], storageKeys: [], target: "index.html" };

test("el resumen de pruebas entiende node --test, TAP y jest, y no inventa números cuando no los hay", () => {
  assert.deepEqual(parseTestSummary(NODE_OUTPUT), { tests: 14, pass: 14, fail: 0 });
  assert.deepEqual(parseTestSummary("# tests 3\n# pass 2\n# fail 1"), { tests: 3, pass: 2, fail: 1 });
  assert.deepEqual(parseTestSummary("Tests:       1 failed, 4 passed, 5 total"), { tests: 5, pass: 4, fail: 1 });
  assert.equal(parseTestSummary("todo bien"), null);
  assert.deepEqual(summarizeChecks(checks(true, "ok")).commands[0].tests, undefined);
  assert.equal(summarizeChecks([]).status, "none");
  assert.equal(summarizeChecks(checks(false)).status, "failed");
});

test("la evidencia dice qué comprobó Automata, con números, y no da por buena una área que no se ejecutó", () => {
  const ev = buildAutomataEvidence({ round: 4, checks: checks(), page: summarizePage(goodPage), ui: summarizeScenarios({ found: false }), webManaged: true });
  const text = renderAutomataEvidence(ev);
  assert.match(text, /COMPROBACIONES DE AUTOMATA \(ronda 4; las ejecutó Automata por su cuenta, no Claude/);
  assert.match(text, /PRUEBAS: correcto · node --test tests\/app\.test\.js → 14 de 14 pruebas pasan/);
  assert.match(text, /ARRANQUE: correcto · la página se abrió en chrome\.exe sin ventana: «Gastos del mes», 6 controles/);
  assert.match(text, /RECURSOS: correcto · 3 de 3 archivos cargaron \(index\.html, styles\.css, app\.js\)/);
  assert.match(text, /ERRORES DEL NAVEGADOR: ninguno/);
  assert.match(text, /INTERFAZ: SIN ESCENARIOS · no hay ui-check\.json[\s\S]*pide a Claude \(decision=continue\)/);
  assert.match(text, /REGLAS: lo marcado «correcto» ya lo comprobó Automata/);
  assert.deepEqual(coveredAreas(ev), ["tests", "start"], "sin escenarios, la interfaz no figura como comprobada");
});

test("los escenarios que pasaron o fallaron aparecen con su paso y el texto que se vio", () => {
  const sc = { found: true, scenarios: [{ name: "Guardar", steps: [] }, { name: "Inválido", steps: [] }], problems: [] };
  const ui = summarizeScenarios(sc, [{ name: "Guardar", ok: true, steps: 8, failed: null }, { name: "Inválido", ok: false, steps: 5, failed: { index: 3, step: "expectText x", message: "expectText x: ese texto no apareció. La página decía: «Sin gastos»" } }], true);
  assert.equal(ui.status, "failed");
  const text = renderAutomataEvidence(buildAutomataEvidence({ round: 2, checks: checks(), page: summarizePage(goodPage), ui, webManaged: true }));
  assert.match(text, /INTERFAZ: FALLA · 2 escenario\(s\) hechos en un navegador real: «Guardar» \(8 pasos, bien\); «Inválido» \(falló el paso 4: expectText x: ese texto no apareció/);
  const okUi = summarizeScenarios(sc, [{ name: "Guardar", ok: true, steps: 8, failed: null }, { name: "Inválido", ok: true, steps: 5, failed: null }], true);
  assert.ok(coveredAreas(buildAutomataEvidence({ round: 2, checks: checks(), page: summarizePage(goodPage), ui: okUi })).includes("ui"));
});

test("sin navegador la comprobación NO se da por hecha: lo dice y es lo único que sí necesita mirar una persona", () => {
  const ev = buildAutomataEvidence({ round: 1, checks: checks(), page: summarizePage({ ok: null, skipped: "No hay un navegador compatible para abrir la aplicación." }), ui: summarizeScenarios({ found: true, scenarios: [{ name: "a", steps: [] }], problems: [] }, null, false), webManaged: true });
  const text = renderAutomataEvidence(ev);
  assert.match(text, /ARRANQUE: NO SE PUDO COMPROBAR · No hay un navegador compatible/);
  assert.match(text, /INTERFAZ: NO SE EJECUTÓ/);
  assert.doesNotMatch(text, /RECURSOS:/);
  assert.deepEqual(coveredAreas(ev), ["tests"]);
});

test("un error del navegador o un recurso que no carga aparece como falla, no como correcto", () => {
  const broken = summarizePage({ ...goodPage, ok: false, problems: ["Un error de programa al abrir la página: ReferenceError: x is not defined", "Un archivo no cargó: app.js"], resources: { total: 3, loaded: 2, failed: ["app.js"], files: ["index.html", "styles.css", "app.js"] } });
  const text = renderAutomataEvidence(buildAutomataEvidence({ round: 3, checks: checks(), page: broken }));
  assert.match(text, /ARRANQUE: FALLA · Un error de programa/);
  assert.match(text, /RECURSOS: FALLA · 2 de 3 archivos cargaron[\s\S]*no cargaron: app\.js/);
  assert.match(text, /ERRORES DEL NAVEGADOR: HAY: Un error de programa[\s\S]*Un archivo no cargó: app\.js/);
  assert.deepEqual(coveredAreas(buildAutomataEvidence({ round: 3, checks: checks(), page: broken })), ["tests"]);
});

test("la codificación: un error real se lista; si todo está bien se avisa de cómo leer sin falsas alarmas", () => {
  const good = renderAutomataEvidence(buildAutomataEvidence({ round: 1, checks: checks(), encoding: { status: "ok", files: 7, withAccents: 2, problems: [] } }));
  assert.match(good, /CODIFICACIÓN: correcto · 7 archivos de texto leídos byte a byte: UTF-8 válido[\s\S]*\(2 con acentos\)/);
  assert.doesNotMatch(good, /PowerShell 5\.1/, "la advertencia de lectura va en las reglas del director, no se repite cada ronda");
  const bad = renderAutomataEvidence(buildAutomataEvidence({ round: 1, checks: checks(), encoding: { status: "problems", files: 7, withAccents: 2, problems: [{ file: "app.js", kind: "invalid", detail: "no es UTF-8 válido" }] } }));
  assert.match(bad, /CODIFICACIÓN: ERROR REAL · app\.js no es UTF-8 válido/);
});

test("en inglés la evidencia está completa en inglés", () => {
  const ev = buildAutomataEvidence({ round: 2, checks: checks(), page: summarizePage(goodPage), ui: summarizeScenarios({ found: false }), encoding: { status: "ok", files: 3, withAccents: 1, problems: [] }, webManaged: true });
  const text = renderAutomataEvidence(ev, "en");
  assert.match(text, /AUTOMATA CHECKS \(round 2; Automata ran them itself/);
  assert.match(text, /TESTS: ok · node --test tests\/app\.test\.js → 14 of 14 tests pass/);
  assert.match(text, /START: ok · the page opened in chrome\.exe without a window/);
  assert.match(text, /INTERFACE: NO SCENARIOS/);
  assert.match(text, /ENCODING: ok/);
  assert.doesNotMatch(text, /ARRANQUE|PRUEBAS|correcto/);
});

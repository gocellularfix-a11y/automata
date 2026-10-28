// What Automata itself checked in a round, in a form the director can rely on: each area says what was done, whether
// it passed, or that it was NOT run and why. The director is read-only and Claude's access is limited, so these
// results are produced by Automata (the project's checks, a real browser, a byte-level text check) and shown as
// evidence. An area that was not run is never reported as correct, and a missing area is something Claude can produce,
// not a reason to ask a person to repeat it by hand.
import { SCENARIO_FILE } from "./scenarios.mjs";

const clip = (text, max) => { const value = String(text ?? "").replace(/\s+/g, " ").trim(); return value.length > max ? value.slice(0, max - 1) + "…" : value; };

// node --test prints «ℹ tests 14 / ℹ pass 14 / ℹ fail 0» (or the same with «#» in TAP); other runners say «Tests: 5 passed, 5 total».
export function parseTestSummary(output) {
  const text = String(output ?? "");
  const count = (name) => { const m = new RegExp(`(?:ℹ|#)\\s*${name}\\s+(\\d+)`, "i").exec(text); return m ? Number(m[1]) : null; };
  let tests = count("tests"), pass = count("pass"), fail = count("fail");
  if (tests == null) {
    const jest = /Tests:\s+(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+passed,\s*)?(\d+)\s+total/i.exec(text);
    if (jest) { fail = Number(jest[1] ?? 0); pass = Number(jest[2] ?? 0); tests = Number(jest[3]); }
  }
  return tests == null ? null : { tests, pass: pass ?? null, fail: fail ?? 0 };
}

export function summarizeChecks(checks = []) {
  if (!checks.length) return { status: "none", commands: [] };
  const commands = checks.map((c) => ({ command: clip(c.command, 120), passed: !!c.passed, code: c.code ?? null, ...parseTestSummary(c.output) ?? {} }));
  return { status: commands.every((c) => c.passed) ? "ok" : "failed", commands };
}

// page: the browser's report (browsercheck.mjs) or { skipped }; null when the project is not a web page.
export function summarizePage(report) {
  if (!report) return null;
  if (report.skipped) return { status: "not-run", reason: report.skipped };
  return {
    status: report.ok ? "ok" : "failed", target: report.target ?? null, title: report.title ?? "", controls: report.controls ?? 0, browser: report.browser ?? "",
    resources: { total: report.resources?.total ?? 0, loaded: report.resources?.loaded ?? 0, failed: report.resources?.failed ?? [], files: report.resources?.files ?? [] },
    errors: (report.problems ?? []).slice(0, 6), storageKeys: report.storageKeys ?? []
  };
}
export function summarizeScenarios({ found, scenarios = [], problems = [] } = {}, results = null, browserRan = false) {
  if (!found) return { status: "none", file: SCENARIO_FILE };
  if (problems.length && !scenarios.length) return { status: "invalid", file: SCENARIO_FILE, problems };
  if (!results) return { status: "not-run", file: SCENARIO_FILE, problems, reason: browserRan ? "" : "browser" };
  return { status: results.every((x) => x.ok) && !problems.length ? "ok" : "failed", file: SCENARIO_FILE, problems, scenarios: results.map((x) => ({ name: x.name, ok: x.ok, steps: x.steps, failed: x.failed ? { step: x.failed.index + 1, message: clip(x.failed.message, 220) } : null })) };
}

export function buildAutomataEvidence({ round, checks, page = null, ui = null, encoding = null, delivery = null, webManaged = false }) {
  return { round, at: new Date().toISOString(), webManaged, tests: summarizeChecks(checks), page, ui, encoding, delivery };
}

const T = {
  es: {
    title: (round) => `COMPROBACIONES DE AUTOMATA (ronda ${round}; las ejecutó Automata por su cuenta, no Claude: son evidencia, no un informe):`,
    tests: "PRUEBAS", start: "ARRANQUE", resources: "RECURSOS", errors: "ERRORES DEL NAVEGADOR", ui: "INTERFAZ", encoding: "CODIFICACIÓN",
    ok: "correcto", failed: "FALLA", none: "ninguna configurada", notRun: "NO SE PUDO COMPROBAR",
    testLine: (c) => `${c.passed ? "correcto" : "FALLA"} · ${c.command}${c.tests != null ? ` → ${c.pass ?? "?"} de ${c.tests} pruebas pasan${c.fail ? `, ${c.fail} fallan` : ""}` : ` → código ${c.code}`}`,
    startOk: (p) => `correcto · la página se abrió en ${p.browser || "el navegador"} sin ventana${p.title ? `: «${clip(p.title, 60)}»` : ""}, ${p.controls} controles.`,
    startFail: (p) => `FALLA · ${p.errors[0] ?? "la página no abrió bien"}`,
    startNot: (p) => `NO SE PUDO COMPROBAR · ${p.reason} Esto sí requiere mirar la página; Automata no puede.`,
    resourcesLine: (r) => `${r.failed.length ? "FALLA" : "correcto"} · ${r.loaded} de ${r.total} archivos cargaron${r.files.length ? ` (${r.files.slice(0, 8).join(", ")})` : ""}${r.failed.length ? `; no cargaron: ${r.failed.join(", ")}` : ""}.`,
    errorsNone: "ninguno (sin errores de programa, sin mensajes de error en la consola y sin recursos fallidos).",
    errorsSome: (list) => `HAY: ${list.join(" | ")}`,
    uiNone: `SIN ESCENARIOS · no hay ${SCENARIO_FILE}. Si un criterio depende de la interfaz (escribir, pulsar, recargar, ver qué aparece) y nada lo demuestra, pide a Claude (decision=continue) que deje ese escenario: Automata lo ejecuta en un navegador real.`,
    uiInvalid: (u) => `INVÁLIDO · ${u.problems.join(" ")}`,
    uiNotRun: "NO SE EJECUTÓ · se necesita el navegador y no pudo abrirse.",
    uiList: (u) => `${u.status === "ok" ? "correcto" : "FALLA"} · ${u.scenarios.length} escenario(s) hechos en un navegador real: ${u.scenarios.map((s) => `«${clip(s.name, 50)}» ${s.ok ? `(${s.steps} pasos, bien)` : `(falló el paso ${s.failed.step}: ${s.failed.message})`}`).join("; ")}. Compara lo que prueban con el texto exacto del criterio.${u.problems.length ? ` Avisos: ${u.problems.join(" ")}` : ""}`,
    encodingOk: (e) => `correcto · ${e.files} archivos de texto leídos byte a byte: UTF-8 válido, sin caracteres de reemplazo ni texto guardado dos veces${e.withAccents ? ` (${e.withAccents} con acentos)` : ""}.`,
    encodingBad: (e) => `ERROR REAL · ${e.problems.slice(0, 5).map((p) => `${p.file} ${p.detail}`).join(" | ")}`,
    rules: "REGLAS: lo marcado «correcto» ya lo comprobó Automata; no pidas que una persona lo repita ni marques blocked por eso. Si algo no figura aquí o dice SIN ESCENARIOS o NO SE PUDO COMPROBAR, no lo des por comprobado. Eres de solo lectura y Claude no puede ejecutar comandos ni abrir ventanas: que Claude diga que no pudo ejecutar algo no es falta de evidencia cuando Automata lo ejecutó.",
    cleaning: ""
  },
  en: {
    title: (round) => `AUTOMATA CHECKS (round ${round}; Automata ran them itself, not Claude: they are evidence, not a report):`,
    tests: "TESTS", start: "START", resources: "RESOURCES", errors: "BROWSER ERRORS", ui: "INTERFACE", encoding: "ENCODING",
    ok: "ok", failed: "FAILS", none: "none configured", notRun: "COULD NOT CHECK",
    testLine: (c) => `${c.passed ? "ok" : "FAILS"} · ${c.command}${c.tests != null ? ` → ${c.pass ?? "?"} of ${c.tests} tests pass${c.fail ? `, ${c.fail} fail` : ""}` : ` → code ${c.code}`}`,
    startOk: (p) => `ok · the page opened in ${p.browser || "the browser"} without a window${p.title ? `: «${clip(p.title, 60)}»` : ""}, ${p.controls} controls.`,
    startFail: (p) => `FAILS · ${p.errors[0] ?? "the page did not open properly"}`,
    startNot: (p) => `COULD NOT CHECK · ${p.reason} This does need someone to look at the page; Automata cannot.`,
    resourcesLine: (r) => `${r.failed.length ? "FAILS" : "ok"} · ${r.loaded} of ${r.total} files loaded${r.files.length ? ` (${r.files.slice(0, 8).join(", ")})` : ""}${r.failed.length ? `; did not load: ${r.failed.join(", ")}` : ""}.`,
    errorsNone: "none (no program errors, no console error messages and no failed resources).",
    errorsSome: (list) => `THERE ARE: ${list.join(" | ")}`,
    uiNone: `NO SCENARIOS · there is no ${SCENARIO_FILE}. If a criterion depends on the interface (type, press, reload, see what appears) and nothing proves it, ask Claude (decision=continue) to leave that scenario: Automata runs it in a real browser.`,
    uiInvalid: (u) => `INVALID · ${u.problems.join(" ")}`,
    uiNotRun: "NOT RUN · the browser was needed and could not open.",
    uiList: (u) => `${u.status === "ok" ? "ok" : "FAILS"} · ${u.scenarios.length} scenario(s) done in a real browser: ${u.scenarios.map((s) => `«${clip(s.name, 50)}» ${s.ok ? `(${s.steps} steps, fine)` : `(step ${s.failed.step} failed: ${s.failed.message})`}`).join("; ")}. Compare what they prove with the exact criterion text.${u.problems.length ? ` Warnings: ${u.problems.join(" ")}` : ""}`,
    encodingOk: (e) => `ok · ${e.files} text files read byte by byte: valid UTF-8, no replacement characters, nothing saved twice${e.withAccents ? ` (${e.withAccents} with accents)` : ""}.`,
    encodingBad: (e) => `REAL ERROR · ${e.problems.slice(0, 5).map((p) => `${p.file} ${p.detail}`).join(" | ")}`,
    rules: "RULES: what says «ok» was already checked by Automata; do not ask a person to repeat it or mark blocked for it. Anything not listed here, or marked NO SCENARIOS or COULD NOT CHECK, is not verified. You are read-only and Claude cannot run commands or open windows: Claude saying it could not run something is not missing evidence when Automata ran it."
  }
};

// The text the director reads. delivery: the launcher/guide verdict already phrased elsewhere (not repeated here).
export function renderAutomataEvidence(ev, language = "es") {
  if (!ev) return "";
  const t = T[language === "en" ? "en" : "es"], lines = [t.title(ev.round)];
  if (ev.tests.status === "none") lines.push(`- ${t.tests}: ${t.none}.`);
  else for (const c of ev.tests.commands) lines.push(`- ${t.tests}: ${t.testLine(c)}`);
  const p = ev.page;
  if (p) {
    if (p.status === "not-run") lines.push(`- ${t.start}: ${t.startNot(p)}`);
    else {
      lines.push(`- ${t.start}: ${p.status === "ok" || !p.errors.length ? t.startOk(p) : t.startFail(p)}`);
      lines.push(`- ${t.resources}: ${t.resourcesLine(p.resources)}`);
      lines.push(`- ${t.errors}: ${p.errors.length ? t.errorsSome(p.errors) : t.errorsNone}`);
    }
  }
  if (ev.webManaged || p) {
    const u = ev.ui;
    lines.push(`- ${t.ui}: ${!u || u.status === "none" ? t.uiNone : u.status === "invalid" ? t.uiInvalid(u) : u.status === "not-run" ? t.uiNotRun : t.uiList(u)}`);
  }
  if (ev.encoding) lines.push(`- ${t.encoding}: ${ev.encoding.status === "ok" ? t.encodingOk(ev.encoding) : t.encodingBad(ev.encoding)}`);
  lines.push(t.rules);
  return lines.join("\n");
}

// What Automata has already done well in this round (used to tell a legitimate block from a repeated check).
export function coveredAreas(ev) {
  const covered = [];
  if (!ev) return covered;
  if (ev.tests.status === "ok") covered.push("tests");
  if (ev.page?.status === "ok") covered.push("start");
  if (ev.ui?.status === "ok") covered.push("ui");
  if (ev.delivery?.launcher) covered.push("launcher");
  return covered;
}

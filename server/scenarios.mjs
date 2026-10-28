// The interface scenarios a project leaves in ui-check.json. The director cannot open a page and Claude's access is
// limited, so the way to prove "I type this, press that, and this appears" is a small declarative file that Automata
// runs in a real browser (browsercheck.mjs) and reports. Nothing here executes the project's code: steps are data,
// validated against a short list of actions, and they only run inside a throwaway browser profile.
import fs from "node:fs";
import path from "node:path";
import { STEP_KEYS } from "./browsercheck.mjs";

export const SCENARIO_FILE = "ui-check.json";
const LIMITS = { scenarios: 12, steps: 40, text: 200 };
const textOf = (value) => typeof value === "string" && value.length <= LIMITS.text;

// What Claude is told about the format (also shown to the director so it can compare it with the criterion).
export const SCENARIO_FORMAT = `{ "scenarios": [ { "name": "Guardar un gasto", "steps": [
  { "fill": "#importe", "value": "12.50" }, { "select": "#categoria", "value": "Comida" }, { "click": "button[type=submit]" },
  { "expectText": "Almuerzo" }, { "reload": true }, { "expectText": "Almuerzo" } ] } ] }`;

// Returns { found, scenarios, problems }. problems are plain sentences for Claude; an absent file is not a problem.
export function loadScenarios(directory, language = "es") {
  const en = language === "en", problems = [];
  const name = (() => { try { return fs.readdirSync(directory).find((f) => f.toLowerCase() === SCENARIO_FILE) ?? null; } catch { return null; } })();
  if (!name) return { found: false, scenarios: [], problems };
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8").replace(/^﻿/, "")); } catch (error) {
    return { found: true, scenarios: [], problems: [en ? `${SCENARIO_FILE} is not valid JSON (${String(error.message).slice(0, 80)}).` : `${SCENARIO_FILE} no es un JSON válido (${String(error.message).slice(0, 80)}).`] };
  }
  const list = Array.isArray(data?.scenarios) ? data.scenarios : [];
  if (!list.length) return { found: true, scenarios: [], problems: [en ? `${SCENARIO_FILE} has no scenarios. Format: ${SCENARIO_FORMAT}` : `${SCENARIO_FILE} no tiene escenarios. Formato: ${SCENARIO_FORMAT}`] };
  const scenarios = [];
  for (const [i, scenario] of list.slice(0, LIMITS.scenarios).entries()) {
    const label = textOf(scenario?.name) && scenario.name.trim() ? scenario.name.trim() : `#${i + 1}`;
    if (!Array.isArray(scenario?.steps) || !scenario.steps.length || scenario.steps.length > LIMITS.steps) { problems.push(en ? `Scenario «${label}» needs between 1 and ${LIMITS.steps} steps.` : `El escenario «${label}» necesita entre 1 y ${LIMITS.steps} pasos.`); continue; }
    const steps = [];
    let bad = null;
    for (const [n, step] of scenario.steps.entries()) {
      const key = step && typeof step === "object" ? STEP_KEYS.find((k) => k in step) : null;
      const needsValue = ["fill", "select", "expectValue"].includes(key);
      const valid = key && (key === "reload" ? step.reload === true : key === "wait" ? Number.isFinite(Number(step.wait)) : key === "expectCount" ? textOf(step.expectCount) && Number.isInteger(step.count) && step.count >= 0 : textOf(step[key]) && (!needsValue || textOf(step.value)));
      if (!valid) { bad = n + 1; break; }
      steps.push(key === "expectCount" ? { expectCount: step.expectCount, count: step.count } : needsValue ? { [key]: step[key], value: step.value } : { [key]: step[key] });
    }
    if (bad) { problems.push(en ? `Scenario «${label}», step ${bad}: not a known action. Use ${STEP_KEYS.join(", ")}.` : `Escenario «${label}», paso ${bad}: no es una acción conocida. Usa ${STEP_KEYS.join(", ")}.`); continue; }
    if (!steps.some((s) => Object.keys(s).some((k) => k.startsWith("expect")))) { problems.push(en ? `Scenario «${label}» checks nothing: add at least one expect… step.` : `El escenario «${label}» no comprueba nada: agrega al menos un paso expect….`); continue; }
    scenarios.push({ name: label, steps });
  }
  return { found: true, scenarios, problems };
}

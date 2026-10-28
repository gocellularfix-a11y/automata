// P4 stabilization: the interface scenarios a project can leave, validated and run in a real browser.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadScenarios, SCENARIO_FILE } from "../server/scenarios.mjs";
import { checkInBrowser } from "../server/browsercheck.mjs";

function project(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-scenarios-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  return dir;
}
const scenario = (steps, name = "Guardar") => ({ name, steps });

test("sin ui-check.json no hay problema; con uno válido se leen los escenarios", (t) => {
  assert.deepEqual(loadScenarios(project(t)), { found: false, scenarios: [], problems: [] });
  const dir = project(t, { [SCENARIO_FILE]: { scenarios: [scenario([{ fill: "#a", value: "x" }, { click: "button" }, { expectText: "x" }])] } });
  const result = loadScenarios(dir);
  assert.equal(result.found, true);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.scenarios[0].steps, [{ fill: "#a", value: "x" }, { click: "button" }, { expectText: "x" }]);
});

test("un archivo roto, sin escenarios, con una acción desconocida o que no comprueba nada se explica, en el idioma configurado", (t) => {
  assert.match(loadScenarios(project(t, { [SCENARIO_FILE]: "{ no es json" })).problems[0], /no es un JSON válido/);
  assert.match(loadScenarios(project(t, { [SCENARIO_FILE]: "{ no es json" }), "en").problems[0], /is not valid JSON/);
  assert.match(loadScenarios(project(t, { [SCENARIO_FILE]: { scenarios: [] } })).problems[0], /no tiene escenarios\. Formato:/);
  const unknown = loadScenarios(project(t, { [SCENARIO_FILE]: { scenarios: [scenario([{ teleport: "#a" }, { expectText: "x" }])] } }));
  assert.deepEqual(unknown.scenarios, []);
  assert.match(unknown.problems[0], /paso 1: no es una acción conocida/);
  const nothing = loadScenarios(project(t, { [SCENARIO_FILE]: { scenarios: [scenario([{ click: "button" }])] } }));
  assert.match(nothing.problems[0], /no comprueba nada/);
  const valueless = loadScenarios(project(t, { [SCENARIO_FILE]: { scenarios: [scenario([{ fill: "#a" }, { expectText: "x" }])] } }));
  assert.match(valueless.problems[0], /paso 1/);
  const tooMany = loadScenarios(project(t, { [SCENARIO_FILE]: { scenarios: [scenario(Array.from({ length: 41 }, () => ({ expectText: "x" })))] } }));
  assert.match(tooMany.problems[0], /entre 1 y 40 pasos/);
});

test("un archivo guardado con BOM (como lo deja PowerShell) también se lee", (t) => {
  const dir = project(t, { [SCENARIO_FILE]: "\uFEFF" + JSON.stringify({ scenarios: [scenario([{ expectText: "Hola" }])] }) });
  assert.equal(loadScenarios(dir).scenarios.length, 1);
});

const PAGE = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Gastos</title></head><body>
<form id="f"><input id="desc" type="text"><input id="monto" type="text"><select id="cat"><option>Comida</option><option>Hogar</option></select><button type="submit">Guardar</button></form>
<p id="msg"></p><ul id="lista"></ul><script src="app.js"></script></body></html>`;
const APP = `const lista = document.getElementById("lista"), msg = document.getElementById("msg");
const saved = () => JSON.parse(localStorage.getItem("gastos") || "[]");
const draw = () => { lista.innerHTML = ""; for (const g of saved()) { const li = document.createElement("li"); li.textContent = g.desc + " " + g.monto + " " + g.cat; lista.appendChild(li); } };
document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); const monto = Number(document.getElementById("monto").value.replace(",", "."));
  if (!(monto > 0)) { msg.textContent = "El importe debe ser mayor que cero."; return; } msg.textContent = "";
  localStorage.setItem("gastos", JSON.stringify([...saved(), { desc: document.getElementById("desc").value, monto, cat: document.getElementById("cat").value }])); draw(); });
draw();`;
const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));
const open = (dir, scenarios, language = "es") => checkInBrowser(new URL(`file:///${path.join(dir, "index.html").replace(/\\/g, "/")}`).href, { executable: chrome, scenarios, language });

test("con un navegador real: escribir, pulsar, recargar y comprobar lo que aparece; cada escenario empieza sin los datos del anterior", { skip: !chrome && "no hay Chrome ni Edge" }, async (t) => {
  const dir = project(t, { "index.html": PAGE, "app.js": APP });
  const seen = await open(dir, [
    scenario([{ fill: "#desc", value: "Almuerzo" }, { fill: "#monto", value: "12.50" }, { select: "#cat", value: "Hogar" }, { click: "button[type=submit]" }, { expectText: "Almuerzo 12.5 Hogar" }, { reload: true }, { expectText: "Almuerzo 12.5 Hogar" }, { expectCount: "#lista li", count: 1 }], "Guardar y conservar al recargar"),
    scenario([{ expectNoText: "Almuerzo" }, { fill: "#desc", value: "Cosa" }, { fill: "#monto", value: "abc" }, { click: "button[type=submit]" }, { expectText: "El importe debe ser mayor que cero." }, { expectCount: "#lista li", count: 0 }, { expectVisible: "#msg" }], "Importe inválido")
  ]);
  assert.equal(seen.ok, true, JSON.stringify(seen.problems));
  assert.deepEqual(seen.scenarios.map((x) => x.ok), [true, true]);
  assert.deepEqual(seen.scenarioProblems, []);
  assert.equal(seen.resources.total, 2);
  assert.deepEqual(seen.resources.files, ["index.html", "app.js"]);
});

test("un escenario que falla dice el paso y lo que la página mostraba; no marca la página como rota", { skip: !chrome && "no hay Chrome ni Edge" }, async (t) => {
  const dir = project(t, { "index.html": PAGE, "app.js": APP });
  const seen = await open(dir, [scenario([{ fill: "#desc", value: "Cena" }, { fill: "#monto", value: "0" }, { click: "button[type=submit]" }, { expectText: "Guardado" }], "Mensaje de guardado"), scenario([{ click: "#no-existe" }, { expectText: "x" }], "Botón que no existe")]);
  assert.equal(seen.ok, true, "la página abrió bien");
  assert.deepEqual(seen.scenarios.map((x) => x.ok), [false, false]);
  assert.match(seen.scenarioProblems[0], /En el escenario «Mensaje de guardado», paso 4: expectText Guardado: ese texto no apareció\. La página decía: «.*El importe debe ser mayor que cero\./);
  assert.match(seen.scenarioProblems[1], /click #no-existe: el elemento no existe en la página\./);
  const en = await open(dir, [scenario([{ click: "#no-existe" }, { expectText: "x" }], "Missing")], "en");
  assert.match(en.scenarioProblems[0], /In the scenario «Missing», step 1: click #no-existe: the element does not exist on the page\./);
});

test("un alert() no cuelga la comprobación y un recurso que falta se informa por su nombre", { skip: !chrome && "no hay Chrome ni Edge" }, async (t) => {
  const dir = project(t, { "index.html": '<!doctype html><meta charset="utf-8"><title>x</title><body><button id="b">Ok</button><script src="falta.js"></script><script>document.getElementById("b").onclick = () => alert("Guardado");</script></body>' });
  const seen = await open(dir, [scenario([{ click: "#b" }, { expectVisible: "#b" }])]);
  assert.deepEqual(seen.scenarios.map((x) => x.ok), [true]);
  assert.deepEqual(seen.dialogs, ["Guardado"]);
  assert.deepEqual(seen.resources.failed, ["falta.js"]);
  assert.equal(seen.ok, false);
  assert.ok(seen.problems.some((p) => /falta\.js/.test(p)));
});

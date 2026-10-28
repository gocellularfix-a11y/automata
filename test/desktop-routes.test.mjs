// The desktop window reaches the server through a short list of routes (desktop/main.cjs). In P4 the buttons
// «Abrir aplicación», «Abrir carpeta» and «Guía y detalles» were tested in Chrome only and failed in the real desktop
// window with «Ruta no permitida». This keeps the list and the interface in step.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const main = read("../desktop/main.cjs"), ui = read("../public/app.js"), server = read("../server/index.mjs");
const allowed = JSON.parse(/\[("state"[^\]]*)\]\.includes\(route\)/.exec(main)[1].replace(/^/, "[") + "]");

test("cada ruta que usa la interfaz está permitida en el puente de la ventana de escritorio", () => {
  const used = [...new Set([...ui.matchAll(/\bapi\(\s*["'`]([a-z-]+)/g)].map((m) => m[1]))];
  assert.ok(used.length >= 10, "la interfaz usa varias rutas: " + used.join(", "));
  const missing = used.filter((route) => !allowed.includes(route));
  assert.deepEqual(missing, [], `la ventana de escritorio rechazaría estas rutas con «Ruta no permitida»: ${missing.join(", ")}`);
  assert.ok(allowed.includes("delivery") && allowed.includes("app"));
});

test("cada ruta permitida existe en el servidor (no queda una puerta a ninguna parte)", () => {
  for (const route of allowed) assert.match(server, new RegExp(`/api/${route}"`), `/api/${route}`);
});

test("la entrega no se abre por una puerta nueva: el puente solo conoce rutas con nombre y exige la ventana de Automata", () => {
  assert.match(main, /validateSender\(event\);\s*if \(typeof route !== "string"/);
  assert.match(main, /throw new Error\("Ruta no permitida\."\)/);
  assert.ok(!allowed.includes("environment"), "el puente no se ensancha con rutas que la interfaz no usa");
});

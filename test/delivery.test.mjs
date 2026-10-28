import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseLauncher, parseGuide, checkGuide, pageReferences, verifyDelivery, addDeliveryCriteria, deliveryCriteria, deliveryPlan, deliveryFixPrompt, GUIDE_SECTIONS, LAUNCHER, GUIDE } from "../server/delivery.mjs";
import { validateProposal } from "../server/config.mjs";
import { detectEnvironment } from "../server/environment.mjs";
import { checkInBrowser } from "../server/browsercheck.mjs";

const GOOD_GUIDE = `# Calculadora de propinas

## Instalar
No hay nada que instalar: solo necesitas un navegador como Chrome o Edge, que ya tiene tu computadora.

## Abrir
Haz doble clic en el archivo Abrir.cmd de esta carpeta. Se abre la calculadora en tu navegador.

## Usar
Escribe el total de la cuenta y cuántas personas son; la calculadora te dice cuánto paga cada una.

## Respaldar tus datos
La calculadora no guarda datos: no hay nada que respaldar. Si cambias la carpeta de lugar, cópiala completa.

## Qué funciona
Calcula la propina y el total por persona; avisa si el dato no es válido.

## Qué queda pendiente
No guarda un historial y no tiene versión para teléfono.
`;
function project(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-delivery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}
const staticFiles = (extra = {}) => ({ "index.html": '<!doctype html><title>Propinas</title><link rel="stylesheet" href="style.css"><body><input id="total"><script src="app.js"></script></body>', "style.css": "body{}", "app.js": "console.log(1)", [LAUNCHER]: '@echo off\r\nstart "" "%~dp0index.html"\r\n', [GUIDE]: GOOD_GUIDE, ...extra });
const seeing = (result = { ok: true, title: "Propinas", controls: 2, browser: "chrome.exe" }) => async () => result;
const withBrowser = { tools: { browser: { found: true, name: "Chrome", path: "C:/chrome.exe" } } };
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test("el lanzador se reconoce por lo que abre y se rechaza lo que cambia la PC o descarga cosas", () => {
  const page = parseLauncher('@echo off\r\nstart "" "%~dp0index.html"\r\n');
  assert.deepEqual([page.ok, page.mode, page.target], [true, "static", "index.html"]);
  assert.equal(parseLauncher('@echo off\nstart "" "%~dp0web\\inicio.htm"').target, "web/inicio.htm");
  const server = parseLauncher('@echo off\r\nstart /min "" node "%~dp0server.js"\r\ntimeout /t 2 >nul\r\nstart "" http://localhost:4173\r\n');
  assert.deepEqual([server.ok, server.mode, server.port, server.url], [true, "server", 4173, "http://localhost:4173"]);
  assert.match(server.command, /node "?%~dp0server\.js|node/);
  assert.equal(parseLauncher(null).problems[0], `Falta ${LAUNCHER} en la carpeta del proyecto.`);
  assert.match(parseLauncher("  \n").problems[0], /está vacío/);
  assert.match(parseLauncher("@echo off\r\necho hola").problems[0], /no abre nada reconocible/);
  for (const [text, what] of [["npm install", "instala paquetes"], ["winget install x", "instala programas"], ["curl http://x/y.exe -o y.exe", "descarga archivos"], ["reg add HKCU\\x", "cambia la configuración"], ["rmdir /s /q C:\\x", "borra archivos"]]) {
    const r = parseLauncher(`@echo off\r\n${text}\r\nstart "" "%~dp0index.html"`);
    assert.equal(r.ok, false, text);
    assert.ok(r.problems.some((p) => p.includes(what)), `${text}: ${r.problems}`);
  }
  const absolute = parseLauncher('start "" "C:\\Users\\yo\\app\\index.html"');
  assert.match(absolute.problems.join(" "), /ruta absoluta de esta PC/);
});

test("la guía necesita sus seis secciones con contenido, y «Abrir» no puede pedir comandos", () => {
  assert.equal(checkGuide(GOOD_GUIDE).ok, true);
  assert.equal(parseGuide(GOOD_GUIDE).length, 7, "título y seis secciones");
  const missing = checkGuide(GOOD_GUIDE.replace(/## Respaldar tus datos[\s\S]*?## Qué funciona/, "## Qué funciona"));
  assert.deepEqual(missing.problems, [`En ${GUIDE} falta la sección «Respaldar tus datos».`]);
  assert.match(checkGuide(GOOD_GUIDE.replace(/(## Usar\n)[^\n]+/, "$1Ok.")).problems[0], /«Usar» está vacía o es demasiado corta/);
  assert.match(checkGuide(GOOD_GUIDE.replace("Haz doble clic en el archivo Abrir.cmd de esta carpeta", "Abre PowerShell y escribe npm start")).problems.join(" "), /debe decir que se abre con doble clic en Abrir\.cmd.*pide escribir comandos/);
  assert.match(checkGuide(null).problems[0], /Falta COMO_USAR\.md/);
  const english = GOOD_GUIDE.replace("Instalar", "Install").replace("Abrir\n", "Open\n").replace("## Usar", "## Use").replace("Respaldar tus datos", "Back up your data").replace("Qué funciona", "What works").replace("Qué queda pendiente", "What is still pending");
  assert.equal(checkGuide(english, "en").ok, true, "los encabezados en inglés también valen");
  assert.equal(GUIDE_SECTIONS.length, 6);
});

test("separa los archivos que la página necesita de los recursos de Internet", () => {
  const refs = pageReferences('<link rel="stylesheet" href="style.css?v=2"><link rel="stylesheet" href="https://cdn.x/y.css"><script src="https://cdn.x/lib.js"></script><script src="/abs.js"></script><script type="module" src="m.js"></script><img src="data:image/png;base64,AA"><a href="#top">x</a><link rel="icon" href="https://x/icon.png"><img src="img/a.png">');
  assert.deepEqual(refs.local.map((r) => r.ref), ["style.css", "/abs.js", "m.js", "img/a.png"]);
  assert.equal(refs.local.find((r) => r.ref === "m.js").module, true);
  assert.deepEqual(refs.remote, ["https://cdn.x/y.css", "https://cdn.x/lib.js"], "el ícono remoto no cuenta, los scripts y estilos sí");
});

test("una página estática completa pasa: lanzador, guía, archivos enlazados y apertura en el navegador", async (t) => {
  const dir = project(t, staticFiles());
  const seen = [];
  const result = await verifyDelivery({ directory: dir, env: withBrowser, browser: async (url, o) => { seen.push([url, o.executable]); return { ok: true, title: "Propinas", controls: 2, browser: "chrome.exe" }; } });
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "static");
  assert.deepEqual(result.open, { type: "file", target: "index.html", path: path.join(dir, "index.html") });
  assert.deepEqual(result.steps.map((s) => [s.name, s.ok]), [["launcher", true], ["guide", true], ["page", true], ["files", true], ["browser", true]]);
  assert.equal(seen.length, 1);
  assert.match(seen[0][0], /^file:\/\/\/.*index\.html$/, "se abre como lo hará la persona: con file://");
  assert.equal(seen[0][1], "C:/chrome.exe");
  assert.deepEqual(result.browser, { ran: true, name: "chrome.exe", title: "Propinas", controls: 2 });
  assert.equal(result.guideSections.length, 6);
});

test("lo que falta se dice una vez por problema, en palabras para Claude, y no se declara lista", async (t) => {
  const dir = project(t, staticFiles({ "index.html": '<title>x</title><script src="falta.js"></script><link rel="stylesheet" href="/style.css">' }));
  fs.rmSync(path.join(dir, GUIDE));
  const result = await verifyDelivery({ directory: dir, env: withBrowser, browser: seeing() });
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes(`Falta ${GUIDE} en la carpeta del proyecto.`));
  assert.ok(result.problems.some((p) => /carga «falta\.js», pero ese archivo no existe/.test(p)));
  assert.ok(result.problems.some((p) => /carga «\/style\.css» con una ruta que empieza con «\/».*«style\.css»/.test(p)));
  const empty = await verifyDelivery({ directory: project(t, {}), env: null, browser: seeing() });
  assert.deepEqual(empty.problems, [`Falta ${LAUNCHER} en la carpeta del proyecto.`, `Falta ${GUIDE} en la carpeta del proyecto.`]);
  const outside = await verifyDelivery({ directory: project(t, staticFiles({ [LAUNCHER]: 'start "" "%~dp0..\\x.html"' })), env: null, browser: seeing() });
  assert.ok(outside.problems.some((p) => /fuera de la carpeta del proyecto/.test(p)));
  const noPage = await verifyDelivery({ directory: project(t, staticFiles({ [LAUNCHER]: 'start "" "%~dp0otra.html"' })), env: null, browser: seeing() });
  assert.ok(noPage.problems.some((p) => /abre otra\.html, pero ese archivo no existe/.test(p)));
});

test("si la página falla al abrirse en el navegador, la entrega no pasa; si no hay navegador, pasa avisando que no se vio", async (t) => {
  const dir = project(t, staticFiles());
  const broken = await verifyDelivery({ directory: dir, env: withBrowser, browser: seeing({ ok: false, problems: ["Un error de programa al abrir la página: Error: boom"], browser: "chrome.exe" }) });
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.problems, ["Al abrir la aplicación en el navegador: Un error de programa al abrir la página: Error: boom"]);
  const none = await verifyDelivery({ directory: dir, env: { tools: { browser: { found: false } } }, browser: seeing({ ok: null, skipped: "No hay un navegador compatible para abrir la aplicación." }) });
  assert.equal(none.ok, true);
  assert.deepEqual(none.browser, { ran: false, note: "No hay un navegador compatible para abrir la aplicación." });
  assert.match(none.notes.join(" "), /no se vio abierta en pantalla/);
  const remote = await verifyDelivery({ directory: project(t, staticFiles({ "index.html": '<title>x</title><script src="https://cdn.x/lib.js"></script>' })), env: withBrowser, browser: seeing() });
  assert.equal(remote.ok, true, "depender de Internet es una limitación, no un fallo");
  assert.match(remote.notes.join(" "), /recursos de Internet \(https:\/\/cdn\.x\/lib\.js\)/);
});

test("una página con acentos necesita declarar su codificación o se vería rota al abrirla con doble clic", async (t) => {
  const bad = await verifyDelivery({ directory: project(t, staticFiles({ "app.js": 'document.title = "Ñandú";' })), env: null });
  assert.match(bad.problems.join(" "), /index.html tiene acentos o caracteres especiales pero no declara la codificación.*<meta charset="utf-8">/);
  const page = '<!doctype html><html><head><meta charset="utf-8"><title>Propinas</title></head><body><p>¿Cuánto es?</p></body></html>';
  assert.deepEqual((await verifyDelivery({ directory: project(t, staticFiles({ "index.html": page })), env: null })).problems, []);
  const noAccents = await verifyDelivery({ directory: project(t, staticFiles()), env: null });
  assert.deepEqual(noAccents.problems, [], "sin caracteres especiales no hace falta declararla");
});

test("una app con servidor se arranca de verdad, se pide su página y se detiene", async (t) => {
  const port = await freePort();
  const server = `import http from "node:http"; http.createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end("<title>Hola</title><body><p>Hola</p></body>"); }).listen(${port}, "127.0.0.1", () => console.log("http://localhost:${port}"));`;
  const dir = project(t, { "server.mjs": server, "package.json": '{"scripts":{"start":"node server.mjs"}}', [LAUNCHER]: `@echo off\r\nstart /min "" node "%~dp0server.mjs"\r\ntimeout /t 2 >nul\r\nstart "" http://localhost:${port}\r\n`, [GUIDE]: GOOD_GUIDE });
  const opened = [];
  const result = await verifyDelivery({ directory: dir, runCommand: "node server.mjs", env: withBrowser, browser: async (url) => { opened.push(url); return { ok: true, title: "Hola", controls: 0, browser: "chrome.exe" }; }, bootTimeoutMs: 15000 });
  assert.deepEqual(result.problems, []);
  assert.equal(result.mode, "server");
  assert.deepEqual(result.open, { type: "url", target: `http://localhost:${port}`, command: "node server.mjs" });
  assert.deepEqual(opened, [`http://localhost:${port}`]);
  assert.equal(result.steps.find((s) => s.name === "start").ok, true);
  const after = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1500) }).then(() => "sigue", () => "detenido");
  assert.equal(after, "detenido", "el servidor de la prueba no queda corriendo");
});

test("un servidor que se cierra al arrancar, que no responde o que escucha en otro puerto devuelve el problema al ciclo", async (t) => {
  const port = await freePort(), other = await freePort();
  const launcher = (p) => `@echo off\r\nstart "" node "%~dp0server.mjs"\r\nstart "" http://localhost:${p}\r\n`;
  const crash = project(t, { "server.mjs": 'console.error("Cannot find module express"); process.exit(1);', [LAUNCHER]: launcher(port), [GUIDE]: GOOD_GUIDE });
  const a = await verifyDelivery({ directory: crash, runCommand: "node server.mjs", env: null, bootTimeoutMs: 8000 });
  assert.equal(a.ok, false);
  assert.match(a.problems.join(" "), /El servidor de la aplicación se cerró al arrancar \(node server\.mjs\).*Cannot find module express/);
  const silent = project(t, { "server.mjs": "setTimeout(() => {}, 30000);", [LAUNCHER]: launcher(port), [GUIDE]: GOOD_GUIDE });
  const b = await verifyDelivery({ directory: silent, runCommand: "node server.mjs", env: null, bootTimeoutMs: 1500 });
  assert.match(b.problems.join(" "), /no respondió en http:\/\/localhost:\d+ tras 2 segundos/);
  const mismatch = project(t, { "server.mjs": `import http from "node:http"; http.createServer((q, r) => r.end("<p>x</p>")).listen(${other}, "127.0.0.1", () => console.log("http://localhost:${other}"));`, [LAUNCHER]: launcher(port), [GUIDE]: GOOD_GUIDE });
  const c = await verifyDelivery({ directory: mismatch, runCommand: "node server.mjs", env: null, bootTimeoutMs: 6000 });
  assert.match(c.problems.join(" "), new RegExp(`abre http://localhost:${port}, pero la aplicación está escuchando en http://localhost:${other}`));
  const noStart = project(t, { [LAUNCHER]: `@echo off\r\nstart "" http://localhost:${port}\r\n`, [GUIDE]: GOOD_GUIDE });
  const d = await verifyDelivery({ directory: noStart, env: null });
  assert.match(d.problems.join(" "), /No encuentro cómo se arranca el servidor/);
});

test("si el puerto ya está ocupado no se da por comprobado a fondo, pero tampoco se acusa a la app", async (t) => {
  const busy = net.createServer();
  await new Promise((resolve) => busy.listen(0, "127.0.0.1", resolve));
  t.after(() => busy.close());
  const port = busy.address().port;
  const http = await import("node:http");
  const web = http.createServer((q, r) => r.end("<p>otra cosa</p>"));
  busy.close();
  await new Promise((resolve) => web.listen(port, "127.0.0.1", resolve));
  t.after(() => web.close());
  const dir = project(t, { [LAUNCHER]: `@echo off\r\nstart "" node "%~dp0server.mjs"\r\nstart "" http://localhost:${port}\r\n`, [GUIDE]: GOOD_GUIDE });
  const result = await verifyDelivery({ directory: dir, runCommand: "node server.mjs", env: null });
  assert.equal(result.ok, true);
  assert.match(result.notes.join(" "), new RegExp(`puerto ${port} ya estaba en uso`));
});

test("a una propuesta web se le añaden el lanzador y la guía, cada uno con su tarea; a las demás plataformas no", () => {
  const base = (platform) => validateProposal({ name: "Propinas", summary: "s", objective: "Una calculadora de propinas sencilla para repartir la cuenta.", features: ["a"], criteria: ["Calcula la propina", "Avisa si el dato no es válido", "Divide entre personas"], checks: ["node --test"], platform, plan: [{ title: "Preparar", detail: "", criterion: "Calcula la propina", dependsOn: [] }, { title: "Validar", detail: "", criterion: "Avisa si el dato no es válido", dependsOn: ["N1"] }, { title: "Dividir", detail: "", criterion: "Divide entre personas", dependsOn: ["N1"] }], risks: [], questions: [] });
  const draft = addDeliveryCriteria(base("página web local en el navegador"));
  const { launcher, guide } = deliveryCriteria();
  assert.deepEqual(draft.criteria.slice(3), [launcher, guide]);
  assert.equal(draft.plan.length, 5);
  assert.deepEqual(draft.plan.slice(3).map((t) => [t.criterion, t.dependsOn]), [[launcher, ["N3"]], [guide, ["N4"]]]);
  assert.match(draft.plan[3].detail, /start "" "%~dp0index\.html"/);
  assert.match(draft.plan[3].detail, /nunca instala ni descarga nada/);
  assert.match(draft.plan[4].detail, /'Instalar', 'Abrir', 'Usar', 'Respaldar tus datos', 'Qué funciona', 'Qué queda pendiente'/);
  for (const c of draft.criteria) assert.ok(draft.plan.some((t) => t.criterion === c), `sin tarea: ${c}`);
  assert.equal(addDeliveryCriteria(draft).criteria.length, 5, "no se añade dos veces");
  assert.equal(addDeliveryCriteria(base("app para Android")).criteria.length, 3);
  assert.equal(addDeliveryCriteria(base("instalador para Windows")).criteria.length, 3);
  const english = addDeliveryCriteria(base("local web page"), "en");
  assert.match(english.criteria[3], /double-clicking it opens the app/);
});

test("el aviso previo es honesto sobre lo que Automata entrega hoy, aunque existan las herramientas", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automata-plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = await detectEnvironment({ env: { PATH: "" }, platform: "win32", home: root, probe: false, release: "10.0.26200" });
  const web = deliveryPlan("página web local", env);
  assert.deepEqual([web.kind, web.verified, web.toolsReady], ["web", true, true]);
  assert.match(web.note, /botón para abrirla.*doble clic.*guía sencilla/);
  const android = deliveryPlan("App para Android", env);
  assert.deepEqual([android.kind, android.verified, android.toolsReady], ["android", false, false]);
  assert.deepEqual(android.missing, ["Java (JDK 17 o 21).", "El Android SDK (Android Studio lo instala)."]);
  assert.match(android.note, /todavía no genera ni comprueba un APK instalable/);
  const windows = deliveryPlan("instalador .exe", env);
  assert.equal(windows.verified, false);
  assert.match(windows.note, /todavía no genera ni comprueba un instalador de Windows/);
  assert.match(deliveryPlan("consola de Windows", env).note, /no comprueba su entrega/);
  assert.match(deliveryPlan("Android", env, "en").note, /does not build or check an installable APK yet/);
});

test("lo que recibe Claude para corregir es concreto, no cambia los criterios y nombra los archivos del producto", () => {
  const text = deliveryFixPrompt([`Falta ${GUIDE} en la carpeta del proyecto.`]);
  assert.match(text, /todavía no está lista para entregarse a una persona/);
  assert.match(text, /- Falta COMO_USAR\.md/);
  assert.match(text, /no cambies los criterios de aceptación/);
  assert.equal(deliveryFixPrompt(Array.from({ length: 20 }, (_, i) => "p" + i)).split("\n- ").length - 1, 10, "como mucho diez problemas");
});

// With a real Chrome or Edge (when this PC has one): what a person would really hit when double-clicking.
const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));
test("con un navegador real: una página buena abre, y un módulo por file://, un script roto o una página en blanco se detectan", { skip: !chrome && "no hay Chrome ni Edge" }, async (t) => {
  const run = (files) => verifyDelivery({ directory: project(t, files), env: { tools: { browser: { found: true, path: chrome } } } });
  const good = await run(staticFiles());
  assert.deepEqual(good.problems, []);
  assert.equal(good.browser.ran, true);
  assert.equal(good.browser.title, "Propinas");
  const thrown = await run(staticFiles({ "app.js": 'throw new Error("se rompio al abrir");' }));
  assert.equal(thrown.ok, false);
  assert.match(thrown.problems.join(" "), /Al abrir la aplicación en el navegador: Un error de programa al abrir la página: (?:Uncaught )?Error: se rompio al abrir/);
  const module = await run(staticFiles({ "index.html": '<title>M</title><body><p>x</p><script type="module" src="app.js"></script></body>', "app.js": 'import "./otro.js";', "otro.js": "export const a = 1;" }));
  assert.equal(module.ok, false, "un módulo abierto con doble clic lo bloquea el navegador: la persona vería la app muerta");
  const blank = await run(staticFiles({ "index.html": "<title>vacía</title>" }));
  assert.match(blank.problems.join(" "), /se abre en blanco/);
});

test("el navegador no queda abierto ni deja perfiles temporales", { skip: !chrome && "no hay Chrome ni Edge" }, async (t) => {
  const dir = project(t, staticFiles());
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("automata-browser-")).length;
  const seen = await checkInBrowser(new URL(`file:///${path.join(dir, "index.html").replace(/\\/g, "/")}`).href, { executable: chrome });
  assert.equal(seen.ok, true);
  assert.equal(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("automata-browser-")).length, before);
  assert.equal((await checkInBrowser("file:///x", { executable: "C:/no/existe.exe" })).skipped, "No hay un navegador compatible para abrir la aplicación.");
});

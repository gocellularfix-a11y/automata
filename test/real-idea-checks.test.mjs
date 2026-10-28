import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { listProcesses } from "../server/procs.mjs";
import { chromeProcesses, findLeftovers, classifyPushOrMerge, checkStaticPage } from "../scripts/real-idea-checks.mjs";

const T0 = 1_000_000;
const proc = (pid, ppid, name, created = T0 + 10_000) => ({ pid, ppid, name, created });

test("los restos de Automata se detectan, pero no el muestreador del propio script", () => {
  const SCRIPT = 100, SERVER = 200;
  const baseline = new Set([1, 2, 3]);
  const options = { baseline, scriptPid: SCRIPT, serverPid: SERVER, startedAt: T0 };
  // The sampler reads the process table with powershell.exe (+ conhost.exe) started by the script itself.
  const sampler = [proc(100, 50, "node.exe"), proc(110, 100, "powershell.exe"), proc(111, 110, "conhost.exe")];
  assert.deepEqual(findLeftovers(sampler, options), [], "ni el PowerShell del muestreo ni su conhost cuentan");
  // The server is dead but Claude and a node it started were left behind (orphans: their parent no longer exists).
  const orphans = [...sampler, proc(300, 200, "claude.exe"), proc(301, 300, "node.exe"), proc(302, 300, "git.exe")];
  assert.deepEqual(findLeftovers(orphans, options).map((p) => p.name).sort(), ["claude.exe", "git.exe", "node.exe"]);
  // The server itself survived (it hangs from the script): its whole tree is still reported, not hidden as the script's own.
  const alive = [...sampler, proc(200, 100, "node.exe"), proc(300, 200, "claude.exe"), proc(301, 300, "conhost.exe")];
  assert.deepEqual(findLeftovers(alive, options).map((p) => p.pid).sort(), [200, 300, 301]);
  // What was already running before the drill, anything older than its start, and Chrome are not Automata's leftovers.
  const others = [proc(1, 0, "node.exe", T0 + 20_000), proc(400, 0, "node.exe", T0 - 60_000), proc(401, 0, "chrome.exe"), proc(402, 0, "explorer.exe")];
  assert.deepEqual(findLeftovers(others, options), []);
});

test("la detección de restos funciona con la tabla de procesos real", async (t) => {
  const before = await listProcesses();
  const startedAt = Date.now();
  // A process of the test itself plays the sampler; another one, detached from it, plays an orphan left by the server.
  const sampler = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  t.after(() => { for (const child of [sampler, orphan]) { try { process.kill(child.pid); } catch {} } });
  await new Promise((r) => setTimeout(r, 600));
  const after = await listProcesses();
  const baseline = new Set(before.map((p) => p.pid));
  // The orphan's parent is reported as a pid that no longer exists, as happens after the server tree is killed.
  const view = after.map((p) => p.pid === orphan.pid ? { ...p, ppid: 2_000_000_000 } : p);
  const found = findLeftovers(view, { baseline, scriptPid: process.pid, serverPid: 2_000_000_001, startedAt });
  assert.ok(found.some((p) => p.pid === orphan.pid), "el huérfano se detecta");
  assert.ok(!found.some((p) => p.pid === sampler.pid), "el hijo directo del script no se cuenta");
});

test("Chrome del ensayo se reconoce sin depender de browser.process(), que Playwright no tiene", () => {
  const baseline = new Set([10]);
  const table = [proc(10, 1, "chrome.exe"), proc(11, 1, "chrome.exe"), proc(12, 11, "chrome.exe"), proc(13, 1, "node.exe")];
  assert.deepEqual(chromeProcesses(table, baseline).map((p) => p.pid), [11, 12]);
  const source = fs.readFileSync(new URL("../scripts/real-idea.mjs", import.meta.url), "utf8");
  assert.ok(!/browser\??\.process\(\)/.test(source), "el muestreo ya no usa browser.process()");
});

test("un merge o push solicitado y pendiente no es un merge ejecutado", () => {
  const pending = classifyPushOrMerge([{ kind: "commit", status: "done" }, { kind: "merge", into: "main", status: "pending" }, { kind: "push", status: "pending" }], ["commit: feat"]);
  assert.equal(pending.pending, 2);
  assert.deepEqual(pending.executed, [], "nada se ejecutó");
  const done = classifyPushOrMerge([{ kind: "merge", into: "main", status: "done" }, { kind: "push", status: "failed" }], []);
  assert.equal(done.executed.length, 2, "un merge hecho o un push intentado sí cuentan");
  const reflog = classifyPushOrMerge([], ["commit: feat", "merge feature/x: Merge made", "checkout: moving"]);
  assert.deepEqual(reflog.executed, ["merge feature/x: Merge made"], "aunque no esté en la cola, el reflog delata un merge real");
  assert.deepEqual(classifyPushOrMerge(undefined, undefined), { pending: 0, executed: [] });
});

test("una página estática se comprueba por el archivo que abre el comando entregado", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-page-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Calculadora</title><input><input type=number><INPUT>");
  assert.deepEqual(checkStaticPage("Start-Process .\\index.html", dir), { answered: "file", title: "Calculadora", inputs: 3 });
  assert.equal(checkStaticPage("start .\\index.html", dir)?.answered, "file");
  assert.equal(checkStaticPage("start .\\falta.html", dir), null, "un archivo que no existe no se da por bueno");
  assert.equal(checkStaticPage("node server.js", dir), null);
  assert.equal(checkStaticPage(undefined, dir), null);
  // P4: the command the director offers is the double-click launcher; the page it opens is what is checked.
  fs.writeFileSync(path.join(dir, "Abrir.cmd"), '@echo off\r\nstart "" "%~dp0index.html"\r\n');
  assert.deepEqual(checkStaticPage("Abrir.cmd", dir), { answered: "file", title: "Calculadora", inputs: 3 });
  fs.writeFileSync(path.join(dir, "Roto.cmd"), '@echo off\r\nstart "" "%~dp0falta.html"\r\n');
  assert.equal(checkStaticPage("Roto.cmd", dir), null, "un lanzador que abre un archivo inexistente no se da por bueno");
  fs.writeFileSync(path.join(dir, "Nada.cmd"), "@echo off\r\necho hola\r\n");
  assert.equal(checkStaticPage("Nada.cmd", dir), null);
});

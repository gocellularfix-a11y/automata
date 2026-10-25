import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AuthManager, authUrl, interpretStatus } from "../server/auth.mjs";
import { createServer } from "../server/index.mjs";

function harness(t, options = {}) {
  const loggedIn = { coder: false, auditor: false, github: false }, calls = [], children = [];
  const manager = new AuthManager({
    find: role => ({ command: role + ".exe", args: ["base"] }),
    run: async (command, args) => {
      calls.push({ command, args });
      if (command === "github.exe") return { code: loggedIn.github ? 0 : 1, stdout: "", stderr: loggedIn.github ? "github.com\nLogged in to github.com account test-user\nActive account: true" : "You are not logged into any GitHub hosts. Run gh auth login." };
      return command === "coder.exe" ? { code: loggedIn.coder ? 0 : 1, stdout: JSON.stringify({ loggedIn: loggedIn.coder, authMethod: loggedIn.coder ? "claude.ai" : "none", accessToken: "never-return-this" }), stderr: "" } : { code: loggedIn.auditor ? 0 : 1, stdout: "", stderr: loggedIn.auditor ? "Logged in using ChatGPT" : "Not logged in" };
    },
    spawnLogin: (command, args, spawnOptions) => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), command, args, spawnOptions });
      children.push(child);
      return child;
    },
    stop: async child => { child.stopped = true; child.emit("close", -1); },
    ...options
  });
  t.after(() => manager.close());
  return { manager, loggedIn, calls, children };
}

test("los estados se interpretan desde las CLI, sin exponer credenciales ni confundir errores con conexión", () => {
  assert.equal(interpretStatus("coder", { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: "" }).connected, true);
  assert.equal(interpretStatus("coder", { code: 1, stdout: '{"loggedIn":true}', stderr: "error" }).connected, false);
  assert.equal(interpretStatus("coder", { code: 0, stdout: "wrong version", stderr: "" }).status, "error");
  assert.equal(interpretStatus("auditor", { code: 0, stdout: "", stderr: "Logged in using ChatGPT" }).method, "chatgpt");
  assert.equal(interpretStatus("auditor", { code: 0, stdout: "Logged in using an API key: sk-private-secret", stderr: "" }).method, "api_key");
  assert.equal(interpretStatus("auditor", { code: 1, stdout: "Not logged in", stderr: "" }).status, "disconnected");
  assert.equal(interpretStatus("auditor", { code: 1, stdout: "", stderr: "Access denied" }).status, "error");
});

test("solo se aceptan URLs HTTPS de los proveedores oficiales", () => {
  assert.ok(authUrl("coder", "https://claude.ai/oauth/authorize?state=abc"));
  assert.ok(authUrl("auditor", "https://auth.openai.com/oauth/authorize?state=abc"));
  for (const url of ["javascript:alert(1)", "http://auth.openai.com/", "https://auth.openai.com.evil.test/", "https://evil.test/?next=https://auth.openai.com", "https://user:password@auth.openai.com/", "https://auth.openai.com:8443/", "https://claude.ai/"]) assert.equal(authUrl("auditor", url), null);
});

test("se detectan sesiones existentes y se comprueba cada cuenta requerida antes de ejecutar", async t => {
  const { manager, calls, loggedIn } = harness(t);
  loggedIn.coder = true;
  let status = await manager.status({ local: true });
  assert.equal(status.providers.coder.connected, true);
  assert.equal(status.providers.auditor.connected, false);
  assert.equal(JSON.stringify(status).includes("never-return-this"), false);
  await manager.requireConnected(["coder"]);
  await assert.rejects(manager.requireConnected(), /Conecta ChatGPT \/ Codex/);
  loggedIn.auditor = true;
  await manager.requireConnected();
  status = manager.snapshot({ local: false });
  assert.equal(status.canLogin, false);
  assert.equal(status.providers.auditor.connected, true);
  assert.ok(calls.some(call => call.args.join(" ") === "base login status"));
});

test("login es único por proveedor, publica el enlace solo en la PC y confirma la conexión al terminar", async t => {
  const { manager, children, loggedIn } = harness(t);
  await Promise.all([manager.start("coder"), manager.start("coder")]);
  assert.equal(children.length, 1);
  const child = children[0];
  assert.deepEqual(child.args, ["base", "auth", "login", "--claudeai"]);
  assert.equal(child.spawnOptions.shell, false);
  child.stdout.write("https://evil.test/steal\nhttps://claude.ai/oauth/authorize?state=private-state\nPaste code here if prompted: ");
  assert.equal(manager.snapshot({ local: true }).providers.coder.flow.acceptsCode, true);
  assert.match(manager.snapshot({ local: true }).providers.coder.flow.url, /^https:\/\/claude.ai\//);
  assert.equal(manager.snapshot({ local: false }).providers.coder.flow, undefined);
  await assert.rejects(manager.requireConnected(["coder"]), /Conecta/);
  assert.throws(() => manager.submitCode("coder", "abc\nWrite-Host hello"), /solamente/);
  let input = "";
  child.stdin.on("data", value => input += value);
  manager.submitCode("coder", "official-code#state");
  assert.equal(input, "official-code#state\n");
  loggedIn.coder = true;
  child.emit("close", 0);
  await new Promise(resolve => setImmediate(resolve));
  const result = manager.snapshot({ local: true });
  assert.equal(result.providers.coder.connected, true);
  assert.equal(result.providers.coder.flow, undefined);
  assert.equal(JSON.stringify(result).includes("private-state"), false);
});

test("el código de dispositivo y la cancelación no alteran sesiones ajenas", async t => {
  const { manager, children } = harness(t);
  await assert.rejects(manager.start("coder", "device"), /no válido/);
  await assert.rejects(manager.start("arbitrary"), /no válido/);
  await manager.start("auditor", "device");
  children[0].stderr.write("Visit https://auth.openai.com/codex/device\nABCD-EFGHI\n");
  assert.equal(manager.snapshot({ local: true }).providers.auditor.flow.deviceCode, "ABCD-EFGHI");
  assert.ok(children[0].args.includes("--device-auth"));
  await manager.cancel("auditor");
  assert.equal(children[0].stopped, true);
  assert.equal(manager.snapshot({ local: true }).providers.auditor.flow, undefined);
  assert.equal(manager.snapshot({ local: true }).providers.auditor.status, "disconnected");
});

test("faltas de instalación y demostración no producen conexiones ficticias ni abren un login", async t => {
  const { manager } = harness(t, { find: () => null });
  assert.equal((await manager.status()).providers.coder.status, "missing");
  await assert.rejects(manager.start("coder"), /Instala/);
  const demo = new AuthManager({ demo: true, find: () => { throw new Error("must not run"); } });
  t.after(() => demo.close());
  assert.equal((await demo.status({ local: true })).providers.auditor.status, "demo");
  assert.equal(demo.snapshot({ local: true }).canLogin, false);
  await demo.requireConnected();
  await assert.rejects(demo.start("coder"), /sin --demo/);
});

test("el login vence y limpia sus datos; cerrar la app detiene sus procesos de acceso", async t => {
  const { manager, children } = harness(t, { timeoutMs: 30 });
  await manager.start("coder");
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(children[0].stopped, true);
  assert.match(manager.snapshot().providers.coder.message, /venció/);
  await manager.start("auditor");
  await manager.close();
  assert.equal(children[1].stopped, true);
});

test("HTTP protege login y códigos, impide mutaciones desde Android y bloquea trabajos sin cuentas", async t => {
  const { manager, children } = harness(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "automata-auth-"));
  const app = await createServer({ port: 0, dataDir: directory, auth: manager });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const headers = { Authorization: "Bearer " + app.token, "Content-Type": "application/json" };
  const post = (route, data, extra = {}) => fetch(app.origin + "/api/" + route, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(data) });
  assert.equal((await fetch(app.origin + "/api/auth")).status, 401);
  assert.equal((await post("auth", { action: "login", role: "coder" }, { Origin: "https://evil.test" })).status, 403);
  assert.equal((await post("auth", { action: "login", role: "coder" }, { Origin: "https://automata.local" })).status, 403);
  assert.equal((await post("auth", { action: "login", role: "coder" })).status, 202);
  children[0].stdout.write("https://claude.ai/oauth/authorize?state=local-only\n");
  const remote = await (await fetch(app.origin + "/api/auth", { headers: { ...headers, Origin: "https://automata.local" } })).json();
  assert.equal(remote.canLogin, false);
  assert.equal(JSON.stringify(remote).includes("local-only"), false);
  const rejected = await post("start", { projectId: "not-started" });
  assert.equal(rejected.status, 422);
  assert.match((await rejected.json()).error, /Conecta/);
  const chat = await post("chat", { projectId: "not-started", target: "auditor", text: "Consulta con el tipo predeterminado." });
  assert.equal(chat.status, 422);
  assert.match((await chat.json()).error, /Conecta/);
  assert.equal(app.coordinator.runs.length, 0);
  assert.equal(fs.readdirSync(directory).some(file => /auth|login/.test(file)), false);
});

test("un subprocess real mantiene stdin abierto para el retorno y vuelve a comprobar la sesión", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "automata-login-"));
  const stub = path.join(directory, "official-cli-stub.mjs"), session = path.join(directory, "session.json");
  fs.writeFileSync(stub, `import fs from 'node:fs';const [file,...args]=process.argv.slice(2);if(args[1]==='status'){const loggedIn=fs.existsSync(file);console.log(JSON.stringify({loggedIn,authMethod:loggedIn?'claude.ai':'none'}));process.exit(loggedIn?0:1);}console.log('https://claude.ai/oauth/authorize?state=test-only');console.log('Paste code here if prompted:');for await(const data of process.stdin){if(data.toString().trim()==='test-only-code#state'){fs.writeFileSync(file,'{"loggedIn":true}');process.exit(0);}process.exit(1);}`);
  const manager = new AuthManager({ find: () => ({ command: process.execPath, args: [stub, session] }) });
  t.after(async () => { await manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await manager.start("coder");
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(predicate(), true);
  };
  await until(() => manager.snapshot({ local: true }).providers.coder.flow?.acceptsCode === true);
  manager.submitCode("coder", "test-only-code#state");
  await until(() => manager.snapshot().providers.coder.connected);
  assert.equal(fs.readFileSync(session, "utf8"), '{"loggedIn":true}');
  assert.deepEqual(fs.readdirSync(directory).sort(), ["official-cli-stub.mjs", "session.json"]);
});

test("GitHub es opcional para las AI y su login solo publica código y URL en la PC", async t => {
  const { manager, loggedIn, children } = harness(t);
  loggedIn.coder = loggedIn.auditor = true;
  await manager.requireConnected();
  assert.equal(manager.snapshot().providers.github.connected, false);
  await assert.rejects(manager.requireConnected(["github"]), /Conecta GitHub/);
  await manager.start("github");
  assert.deepEqual(children[0].args.slice(0, 7), ["base", "auth", "login", "--hostname", "github.com", "--git-protocol", "https"]);
  children[0].stderr.write("First copy your one-time code: ABCD-GHJK\nhttps://github.com/login/device\n");
  assert.equal(manager.snapshot({ local: true }).providers.github.flow.deviceCode, "ABCD-GHJK");
  assert.equal(manager.snapshot({ local: false }).providers.github.flow, undefined);
  loggedIn.github = true;
  children[0].emit("close", 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.snapshot().providers.github.connected, true);
});

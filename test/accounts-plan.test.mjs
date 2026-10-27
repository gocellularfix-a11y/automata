import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { agentEnv, validateSettings, DEFAULT_SETTINGS } from "../server/config.mjs";
import { AuthManager, interpretStatus } from "../server/auth.mjs";
import { CliAgents } from "../server/agents.mjs";
const temporaryDirectories = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-test-"));
  temporaryDirectories.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaryDirectories) if (path.resolve(dir).startsWith(path.join(os.tmpdir(), "automata-test-"))) fs.rmSync(dir, { recursive: true, force: true });
});

test("por defecto se usa solo el plan: las claves de API quedan fuera de Claude y de Codex", () => {
  assert.equal(DEFAULT_SETTINGS.planOnly, true);
  assert.equal(validateSettings({}).planOnly, true);
  assert.throws(() => validateSettings({ planOnly: "si" }), /planOnly/);
  assert.deepEqual(Object.keys(agentEnv({ planOnly: true }, "coder")), ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
  assert.deepEqual(Object.keys(agentEnv({ planOnly: true }, "auditor")), ["OPENAI_API_KEY", "CODEX_API_KEY"]);
  assert.ok(Object.values(agentEnv({}, "coder")).every((value) => value === undefined), "un trabajo antiguo sin el campo también usa el plan");
  assert.deepEqual(agentEnv({ planOnly: false }, "coder"), {});
});

test("Claude corre sin la clave de API de Windows cuando se usa el plan", async (t) => {
  const dir = fixture(), stub = path.join(dir, "claude-stub.mjs");
  // A stand-in for Claude Code that reports whether it can see an API key.
  fs.writeFileSync(stub, `console.log(JSON.stringify({ type: "result", result: "clave=" + (process.env.ANTHROPIC_API_KEY ? "si" : "no"), session_id: "s" }));\n`);
  const previous = { claude: process.env.AUTOMATA_CLAUDE, key: process.env.ANTHROPIC_API_KEY };
  process.env.AUTOMATA_CLAUDE = stub;
  process.env.ANTHROPIC_API_KEY = "sk-ant-prueba-que-no-debe-llegar";
  t.after(() => {
    for (const [name, value] of [["AUTOMATA_CLAUDE", previous.claude], ["ANTHROPIC_API_KEY", previous.key]]) value === undefined ? delete process.env[name] : process.env[name] = value;
  });
  const run = (planOnly) => new CliAgents().run({ role: "coder", prompt: "x", phase: "code", directory: dir, project: { directory: dir }, settings: { ...DEFAULT_SETTINGS, planOnly }, agent: { model: "sonnet", effort: "default" }, emit: () => {} });
  assert.equal((await run(true)).text, "clave=no");
  assert.equal((await run(false)).text, "clave=si");
});

test("Cuentas muestra el plan y la cuenta, y cierra sesión con el comando de cada herramienta", async () => {
  const claude = interpretStatus("coder", { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "yo@ejemplo.com", accessToken: "nunca" }), stderr: "" });
  assert.equal(claude.plan, "max");
  assert.equal(claude.account, "yo@ejemplo.com");
  assert.equal(JSON.stringify(claude).includes("nunca"), false);
  const key = interpretStatus("coder", { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "api_key", apiKeySource: "ANTHROPIC_API_KEY" }), stderr: "" });
  assert.equal(key.keySource, "ANTHROPIC_API_KEY");
  assert.match(key.message, /se cobra por uso/);
  assert.equal(interpretStatus("github", { code: 0, stdout: "", stderr: "github.com\n  ✓ Logged in to github.com account mi-usuario (keyring)" }).account, "mi-usuario");

  const calls = [];
  let loggedIn = true;
  const manager = new AuthManager({
    env: { ANTHROPIC_API_KEY: "x" },
    agentEnv: (role) => agentEnv({ planOnly: true }, role),
    find: (role) => ({ command: role + ".exe", args: [] }),
    run: async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      if (args.includes("logout")) { loggedIn = false; return { code: 0, stdout: "", stderr: "" }; }
      if (command === "github.exe") return loggedIn ? { code: 0, stdout: "", stderr: "Logged in to github.com account mi-usuario" } : { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts." };
      if (command === "coder.exe") return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" };
      return { code: 0, stdout: "", stderr: "Logged in using ChatGPT" };
    }
  });
  const status = await manager.status({ local: true });
  assert.deepEqual(status.apiKeys, { coder: ["ANTHROPIC_API_KEY"], auditor: [] });
  assert.ok("ANTHROPIC_API_KEY" in calls.find((c) => c.command === "coder.exe").env, "la comprobación de Claude tampoco ve la clave");
  assert.equal("ANTHROPIC_API_KEY" in calls.find((c) => c.command === "github.exe").env, false);
  const after = await manager.logout("github");
  assert.deepEqual(calls.find((c) => c.args.includes("logout")).args, ["auth", "logout", "--hostname", "github.com", "--user", "mi-usuario"]);
  assert.equal(after.providers.github.connected, false);
});

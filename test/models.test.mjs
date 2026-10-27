import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSettings, DEFAULT_SETTINGS, MODELS } from "../server/config.mjs";
import { CodexModels, parseCodexCatalog } from "../server/models.mjs";
// Trimmed output of `codex debug models` for a ChatGPT account.
const catalog = JSON.stringify([
  { slug: "gpt-6-astra", display_name: "GPT-6-Astra", description: "Frontier intelligence.", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }] },
  { slug: "gpt-6-sol", display_name: "GPT-6-Sol", description: "Everyday.", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }] },
  { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide", supported_reasoning_levels: [] },
  { slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] }
]);

test("el modelo Sol usa el identificador que Codex acepta y los ajustes viejos se corrigen solos", () => {
  assert.equal(DEFAULT_SETTINGS.auditorModel, "gpt-6-sol");
  assert.ok(!MODELS.auditor.some((m) => m.id === "gpt-6.1-sol"));
  const migrated = validateSettings({ auditorModel: "gpt-6.1-sol", extraAuditors: [{ model: "gpt-6.1-sol", effort: "low" }] });
  assert.equal(migrated.auditorModel, "gpt-6-sol");
  assert.equal(migrated.extraAuditors[0].model, "gpt-6-sol");
});

test("la lista del director sale del catálogo de Codex, sin los modelos ocultos", () => {
  const models = parseCodexCatalog(catalog);
  assert.deepEqual(models.map((m) => m.id), ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]);
  assert.deepEqual(models[1], { id: "gpt-6-sol", label: "6-Sol", detail: "Everyday.", efforts: ["default", "low", "medium"] });
  assert.equal(parseCodexCatalog("no es json"), null);
  assert.equal(parseCodexCatalog("[]"), null);
});

test("si Codex no responde se usa la lista incluida, y la respuesta se guarda un rato", async () => {
  let calls = 0, answer = { code: 0, stdout: catalog, stderr: "" };
  const env = [];
  const models = new CodexModels({ find: () => ({ command: "codex.exe", args: [], env: { X: "1" } }), run: async (command, args, options) => { calls++; env.push(options.env); return answer; }, env: () => ({ OPENAI_API_KEY: undefined }) });
  const first = await models.list();
  assert.equal(first.source, "codex");
  assert.equal(first.models.length, 3);
  assert.ok("OPENAI_API_KEY" in env[0], "consulta el catálogo con la cuenta del plan");
  await models.list();
  assert.equal(calls, 1);
  answer = { code: 1, stdout: "", stderr: "error" };
  const fallback = await models.list({ force: true });
  assert.equal(fallback.source, "builtin");
  assert.deepEqual(fallback.models, MODELS.auditor);
  const missing = await new CodexModels({ find: () => null }).list();
  assert.equal(missing.source, "builtin");
});

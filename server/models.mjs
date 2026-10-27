import { findAgent, runProcess } from "./agents.mjs";
import { MODELS } from "./config.mjs";
// The director's models come from Codex itself (`codex debug models`), so the list only shows
// what the signed-in account accepts. The built-in list is the fallback when Codex cannot answer.
const CACHE_MS = 10 * 60 * 1000;
export function parseCodexCatalog(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.models) ? data.models : null;
  if (!list) return null;
  const models = list.filter((m) => typeof m?.slug === "string" && m.visibility === "list").map((m) => ({
    id: m.slug,
    label: String(m.display_name || m.slug).replace(/^GPT-/i, ""),
    detail: typeof m.description === "string" ? m.description.slice(0, 120) : "",
    efforts: ["default", ...(Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []).map((level) => level?.effort ?? level).filter((effort) => typeof effort === "string")]
  }));
  return models.length ? models : null;
}
export class CodexModels {
  constructor({ find = () => findAgent("auditor"), run = runProcess, env = () => ({}) } = {}) {
    Object.assign(this, { find, run, env });
    this.cached = null;
    this.at = 0;
    this.pending = null;
  }
  async list({ force = false } = {}) {
    if (!force && this.cached && Date.now() - this.at < CACHE_MS) return this.cached;
    this.pending ??= (async () => {
      let models = null;
      const cli = this.find();
      if (cli) {
        try {
          const result = await this.run(cli.command, [...cli.args, "debug", "models"], { timeoutMs: 20000, env: { ...cli.env, ...this.env() } });
          if (result.code === 0) models = parseCodexCatalog(result.stdout);
        } catch {}
      }
      this.cached = models ? { source: "codex", models } : { source: "builtin", models: MODELS.auditor };
      this.at = Date.now();
      return this.cached;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
}

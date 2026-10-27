import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeRequest, summarizeRequests, findRollout, readCodexRequests, consumed } from "../server/usage.mjs";
import { CliAgents } from "../server/agents.mjs";
import { validateSettings } from "../server/config.mjs";
import { Coordinator } from "../server/coordinator.mjs";
import { Store } from "../server/store.mjs";

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-usage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const assistant = (id, usage, extra = {}) => JSON.stringify({ type: "assistant", message: { id, content: [], usage }, ...extra });

test("el contexto de Claude es su solicitud más grande, sin sumar bloques repetidos ni sub-agentes", () => {
  assert.equal(claudeRequest("no es json"), null);
  assert.equal(claudeRequest(JSON.stringify({ type: "user" })), null);
  assert.equal(claudeRequest(assistant("m1", { input_tokens: 4, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 7 })).context, 1204);
  assert.equal(claudeRequest(assistant("m2", { input_tokens: 9, cache_read_input_tokens: 99999 }, { parent_tool_use_id: "t1" })), null, "un sub-agente tiene su propio contexto");
  const summary = summarizeRequests([
    claudeRequest(assistant("m1", { input_tokens: 4, cache_read_input_tokens: 1000, output_tokens: 7 })),
    claudeRequest(assistant("m1", { input_tokens: 4, cache_read_input_tokens: 1000, output_tokens: 7 })),
    claudeRequest(assistant("m2", { input_tokens: 4, cache_read_input_tokens: 2500, output_tokens: 30 })),
    claudeRequest(assistant("m3", { input_tokens: 4, cache_read_input_tokens: 1800, output_tokens: 9 }))
  ]);
  assert.deepEqual(summary, { requests: 3, contextPeak: 2504, contextLast: 1804, contextWindow: null });
  assert.equal(summarizeRequests([]), null);
});

test("el consumo de Codex es la diferencia entre acumulados del mismo hilo, y una sesión nueva parte de cero", () => {
  const first = consumed({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 }, { cumulative: true, previous: null });
  assert.deepEqual([first.call.input, first.call.cached, first.call.output], [1000, 800, 50]);
  const second = consumed({ input_tokens: 2600, cached_input_tokens: 2300, output_tokens: 130 }, { cumulative: true, previous: first.total });
  assert.deepEqual([second.call.input, second.call.cached, second.call.output], [1600, 1500, 80]);
  assert.equal(second.total.input, 2600);
  // The thread was replaced: the total went down, so nothing is subtracted.
  assert.equal(consumed({ input_tokens: 700, output_tokens: 10 }, { cumulative: true, previous: second.total }).call.input, 700);
  // Claude's usage is already per call.
  assert.equal(consumed({ input_tokens: 4, cache_read_input_tokens: 500, output_tokens: 9 }, { cumulative: false, previous: first.total }).call.cached, 500);
});

test("el contexto de Codex sale de los token_count de su archivo de sesión, solo desde que empezó la llamada", (t) => {
  const home = tmp(t), day = path.join(home, "sessions", "2026", "10", "27");
  fs.mkdirSync(day, { recursive: true });
  const thread = "01a17f56-98f5-78a2-845d-d6cdae8a7889", file = path.join(day, `rollout-2026-10-27T14-49-04-${thread}.jsonl`);
  const line = (ordinal, at, last, window = 258400) => JSON.stringify({ timestamp: at, ordinal, type: "event_msg", payload: { type: "token_count", info: last ? { total_token_usage: { input_tokens: 999999 }, last_token_usage: { input_tokens: last, output_tokens: 10 }, model_context_window: window } : null } });
  fs.writeFileSync(file, [
    JSON.stringify({ timestamp: "2026-10-27T21:49:04.000Z", ordinal: 0, type: "session_meta", payload: {} }),
    line(1, "2026-10-27T21:49:05.000Z", 21153),
    line(2, "2026-10-27T21:49:06.000Z", null),
    line(3, "2026-10-27T21:55:00.000Z", 26942),
    line(4, "2026-10-27T21:55:09.000Z", 31000),
    line(5, "2026-10-27T21:55:20.000Z", 28000)
  ].join("\n") + "\n");
  assert.equal(findRollout(thread, { home }), file);
  assert.equal(findRollout("00000000-0000-0000-0000-000000000000", { home }), null);
  assert.equal(findRollout("../../etc", { home }), null);
  assert.equal(findRollout(thread, { home: path.join(home, "no-existe") }), null);
  const all = readCodexRequests(file, 0);
  assert.deepEqual([all.requests, all.contextPeak, all.contextLast, all.contextWindow], [4, 31000, 28000, 258400]);
  const call = readCodexRequests(file, Date.parse("2026-10-27T21:54:00.000Z"));
  assert.deepEqual([call.requests, call.contextPeak], [3, 31000], "el acumulado del hilo no cuenta como contexto");
  assert.equal(readCodexRequests(file, Date.parse("2026-10-28T00:00:00.000Z")), null);
  assert.equal(readCodexRequests(path.join(home, "falta.jsonl"), 0), null);
});

test("los adaptadores devuelven el contexto real de cada CLI y marcan el acumulado de Codex", async (t) => {
  const dir = tmp(t), stub = path.join(dir, "cli.mjs"), home = path.join(dir, "codex-home");
  const reviewJson = { decision: "continue", summary: "Sigue.", nextPrompt: "Haz algo", task: "", files: [], findings: [], criteria: [], git: { commit: false, message: "", push: false, branch: "", merge_into: "" }, run: { ready: false, command: "", url: "", note: "" }, memory: { add: [], retire: [] }, plan: { add: [], update: [] } };
  fs.writeFileSync(stub, `import fs from 'node:fs';import path from 'node:path';let prompt='';for await(const c of process.stdin)prompt+=c;const args=process.argv.slice(2);
const usage=(id,ctx)=>JSON.stringify({type:'assistant',message:{id,content:[],usage:{input_tokens:3,cache_read_input_tokens:ctx,cache_creation_input_tokens:0,output_tokens:5}}});
if(args[0]==='exec'){
  const day=path.join(process.env.CODEX_HOME,'sessions','2026','10','27');fs.mkdirSync(day,{recursive:true});
  const file=path.join(day,'rollout-2026-10-27T14-49-04-0123abcd-0000-0000-0000-000000000001.jsonl');
  for(const ctx of [20000,34000,30000])fs.appendFileSync(file,JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:ctx,output_tokens:9},total_token_usage:{input_tokens:84000},model_context_window:258400}}})+'\\n');
  fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(${JSON.stringify(reviewJson)}));
  console.log(JSON.stringify({type:'thread.started',thread_id:'0123abcd-0000-0000-0000-000000000001'}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:84000,cached_input_tokens:60000,output_tokens:27}}));
}else{
  console.log(usage('a',40000));console.log(usage('a',40000));console.log(usage('b',52000));console.log(usage('c',47000));
  console.log(JSON.stringify({type:'assistant',parent_tool_use_id:'x',message:{id:'z',content:[],usage:{input_tokens:1,cache_read_input_tokens:900000,output_tokens:1}}}));
  console.log(JSON.stringify({type:'result',result:'Listo',is_error:false,session_id:'s1',usage:{input_tokens:12,cache_read_input_tokens:139000,cache_creation_input_tokens:0,output_tokens:15}}));
}`);
  const saved = { claude: process.env.AUTOMATA_CLAUDE, codex: process.env.AUTOMATA_CODEX, home: process.env.CODEX_HOME };
  Object.assign(process.env, { AUTOMATA_CLAUDE: stub, AUTOMATA_CODEX: stub, CODEX_HOME: home });
  t.after(() => { for (const [key, value] of [["AUTOMATA_CLAUDE", saved.claude], ["AUTOMATA_CODEX", saved.codex], ["CODEX_HOME", saved.home]]) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const project = { name: "P", directory: dir, objective: "x", criteria: ["c"], checks: [] }, settings = validateSettings({ accessMode: "limited" });
  const agents = new CliAgents();
  const coder = await agents.run({ role: "coder", phase: "code", prompt: "Tarea", project, settings, directory: dir, emit() {} });
  assert.equal(coder.usage.cache_read_input_tokens, 139000, "el total de la llamada suma todas las solicitudes");
  assert.deepEqual([coder.requests, coder.contextPeak, coder.contextLast], [3, 52003, 47003], "el contexto es la solicitud más grande, sin el sub-agente");
  assert.notEqual(coder.usageCumulative, true);
  const director = await agents.run({ role: "auditor", phase: "review", prompt: "Revisa", project, settings, directory: dir, emit() {} });
  assert.equal(director.usageCumulative, true);
  assert.equal(director.usage.input_tokens, 84000);
  assert.deepEqual([director.requests, director.contextPeak, director.contextLast, director.contextWindow], [3, 34000, 30000, 258400]);
});

test("el coordinador cuenta lo consumido por llamada y el contexto máximo real por agente, y la renovación de cada uno es independiente", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-usage-")), project = path.join(dir, "p");
  fs.mkdirSync(project);
  const review = (decision, extra = {}) => ({ decision, summary: "ok", nextPrompt: decision === "continue" ? "Haz el paso" : "", task: "", files: [], findings: [], criteria: decision === "complete" ? [{ criterion: "Funciona", met: true, evidence: "visto" }] : [], git: { commit: false, message: "", push: false, branch: "", merge_into: "" }, run: { ready: false, command: "", url: "", note: "" }, memory: { add: [], retire: [] }, plan: null, ...extra });
  const seen = [];
  let reviews = 0, coderCalls = 0, directorTotal = 0;
  const agents = { async run(a) {
    seen.push({ role: a.role, resume: !!a.agent.resume, round: undefined });
    if (a.role === "coder") {
      coderCalls++;
      return { text: "Hecho", sessionId: "c" + (a.agent.resume ? "x" : coderCalls), resumed: !!a.agent.resume, usage: { input_tokens: 5, cache_read_input_tokens: 5000 * coderCalls, output_tokens: 50 }, contextPeak: 20000 + coderCalls * 1000, contextLast: 19000, requests: 4, contextWindow: 200000 };
    }
    reviews++;
    directorTotal += 40000;
    // Codex reports the running total of its thread; the thread changes when the session is renewed.
    const total = a.agent.resume ? directorTotal : (directorTotal = 40000);
    return { review: review(reviews >= 6 ? "complete" : "continue"), sessionId: "d" + (a.agent.resume ? "x" : reviews), resumed: !!a.agent.resume, usage: { input_tokens: total, cached_input_tokens: total - 3000, output_tokens: 100 }, usageCumulative: true, contextPeak: 30000, contextLast: 28000, requests: 3, contextWindow: 258400 };
  } };
  const c = new Coordinator(new Store(path.join(dir, "data")), { agents, evidence: async () => "", checks: async () => [] });
  t.after(async () => { await c.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  c.updateSettings({ ...c.settings, coderRefreshRounds: 0, auditorRefreshRounds: 2 });
  const p = c.addProject({ name: "P", directory: project, objective: "Hacer algo útil", criteria: ["Funciona"], checks: [] });
  c.start(p.id);
  for (let i = 0; i < 400 && (c.busy || c.active.status === "running"); i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(c.active.status, "complete", c.active.error);
  // Only Codex renews (every 2 rounds); Claude's setting 0 keeps its session for the whole run.
  assert.ok(c.active.sessionLog.length >= 2 && c.active.sessionLog.every((x) => x.role === "auditor"), JSON.stringify(c.active.sessionLog));
  assert.equal(seen.filter((x) => x.role === "coder" && !x.resume).length, 1, "Claude abrió una sola sesión");
  const usage = c.snapshot().runs[0].usage;
  assert.equal(usage.auditor.maxContext, 30000, "el contexto no es el acumulado del hilo");
  assert.equal(usage.coder.maxContext, 20000 + coderCalls * 1000);
  assert.equal(usage.auditor.window, 258400);
  assert.equal(usage.auditor.measured, usage.auditor.calls);
  // Each Codex call is charged what it added to the thread: 40 000 for a fresh one, 40 000 more per resumed call.
  assert.ok(c.active.usageLog.filter((u) => u.role === "auditor").every((u) => u.input === 40000), JSON.stringify(c.active.usageLog.filter((u) => u.role === "auditor").map((u) => u.input)));
  assert.equal(usage.auditor.input, 40000 * usage.auditor.calls);
  assert.equal(c.active.tokens, usage.coder.tokens + usage.auditor.tokens);
});

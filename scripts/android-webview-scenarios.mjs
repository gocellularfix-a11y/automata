// Runs a project's ui-check.json scenarios INSIDE the WebView of its TEST variant on an authorized phone, through the
// WebView's own debugging socket (adb forward = a port on this PC only; nothing extra is installed on the phone).
//   node scripts/android-webview-scenarios.mjs --project <folder> --package <x.test> --serial <adb serial> [--out <folder>]
// The package must be a test variant (ends in .test): the delivered app has WebView debugging off on purpose.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { resolveToolchain, runTool, APP_HOST } from "../server/androidbuild.mjs";
import { openWebView } from "./adb-webview.mjs";
import { loadScenarios } from "../server/scenarios.mjs";
import { stepExpression } from "../server/browsercheck.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const at = args.indexOf("--" + name); return at >= 0 ? args[at + 1] : undefined; };
const project = path.resolve(flag("project") ?? ""), pkg = flag("package"), serial = flag("serial");
const out = path.resolve(flag("out") ?? path.join("artifacts", "webview-" + Date.now()));
if (!pkg?.endsWith(".test") || pkg.startsWith("app.automata.") || !serial) { console.error("Uso: --project <carpeta> --package <paquete .test> --serial <serie>. Solo variantes de prueba."); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const tc = await resolveToolchain();
const adb = (...a) => runTool(tc.adb, ["-s", serial, ...a], { timeoutMs: 60000 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { scenarios, problems } = loadScenarios(project);
if (!scenarios.length) { console.error("No hay escenarios válidos: " + problems.join(" ")); process.exit(2); }

const results = [];
let view;
const finish = async (code) => {
  await view?.close();
  fs.writeFileSync(path.join(out, "webview-scenarios.json"), JSON.stringify({ package: pkg, at: new Date().toISOString(), results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `Escenarios: ${failed.length} de ${results.length} fallaron.` : `Escenarios: ${results.length}/${results.length} correctos dentro del WebView.`);
  process.exit(code ?? (failed.length ? 1 : 0));
};
try {
  view = await openWebView({ adb: tc.adb, serial, pkg });
  const { send, evaluate } = view;
  const consoleErrors = [];
  view.onEvent((m) => { if (m.method === "Runtime.exceptionThrown") consoleErrors.push(String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).split("\n")[0].slice(0, 160)); });
  const origin = `https://${APP_HOST}/index.html`;
  const settled = async () => { for (let i = 0; i < 100 && await evaluate("document.readyState").catch(() => "") !== "complete"; i++) await wait(100); await wait(250); };
  const info = view.info;
  console.log(`WebView: ${info.ua.match(/Chrome\/[\d.]+/)?.[0] ?? info.ua} · ${info.width}x${info.height} @${info.dpr} · ${info.href}`);
  fs.writeFileSync(path.join(out, "webview-info.json"), JSON.stringify(info, null, 2));
  for (const scenario of scenarios) {
    await evaluate("try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} 0");
    await send("Page.navigate", { url: origin });
    await wait(400);
    await settled();
    const outcome = { name: scenario.name, ok: true, failed: null };
    for (const [index, step] of scenario.steps.entries()) {
      if ("wait" in step) { await wait(Math.min(Math.max(Number(step.wait) || 0, 0), 1000)); continue; }
      if ("reload" in step) { await send("Page.reload"); await wait(400); await settled(); continue; }
      const expecting = Object.keys(step).some((k) => k.startsWith("expect"));
      const until = Date.now() + (expecting ? 2000 : 0);
      let result;
      for (;;) {
        result = await evaluate(stepExpression(step)).catch((e) => ({ ok: false, message: e.message }));
        if (result?.ok || Date.now() >= until) break;
        await wait(150);
      }
      if (!result?.ok) { outcome.ok = false; outcome.failed = { step: index + 1, what: JSON.stringify(step).slice(0, 120), saw: result?.seen ?? result?.message ?? "sin respuesta" }; break; }
    }
    results.push(outcome);
    console.log(`${outcome.ok ? "ok   " : "FALLA"} ${scenario.name}${outcome.failed ? ` — paso ${outcome.failed.step} ${outcome.failed.what}: ${outcome.failed.saw}` : ""}`);
  }
  if (consoleErrors.length) { results.push({ name: "errores de JavaScript durante las pruebas", ok: false, failed: { saw: consoleErrors.slice(0, 3).join(" | ") } }); console.log("FALLA errores de JavaScript: " + consoleErrors.slice(0, 3).join(" | ")); }
  const shot = await new Promise((resolve) => execFile(tc.adb, ["-s", serial, "exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 20 * 1024 * 1024 }, (e, so) => resolve(e ? null : so)));
  if (shot?.length > 1000) fs.writeFileSync(path.join(out, "scenarios-final.png"), shot);
  await finish();
} catch (error) {
  console.error("Error: " + error.message);
  await finish(2);
}

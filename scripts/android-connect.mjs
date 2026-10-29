// Connects the installed Automata CLIENT on an authorized phone to a coordinator, without typing: it writes the address and
// the access code into the client's own saved connection over USB (the WebView's debugging channel) and reloads it. The code is
// read from a file on this PC and never printed or logged.
//   node scripts/android-connect.mjs --serial <adb serial> --url https://<pc>.<tailnet>.ts.net:8444 --token-file <access-token>
import fs from "node:fs";
import path from "node:path";
import { resolveToolchain } from "../server/androidbuild.mjs";
import { openWebView } from "./adb-webview.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const at = args.indexOf("--" + name); return at >= 0 ? args[at + 1] : undefined; };
const serial = flag("serial"), tokenFile = flag("token-file");
const PKG = "app.automata.workspace";
if (!serial || !flag("url") || !tokenFile) { console.error("Uso: node scripts/android-connect.mjs --serial <serie> --url <https://…> --token-file <archivo>"); process.exit(2); }
const origin = new URL(flag("url")).origin;
const token = fs.readFileSync(path.resolve(tokenFile), "utf8").trim();
if (!/^[0-9a-f]{64}$/.test(token)) { console.error("El archivo no contiene un código de acceso de Automata."); process.exit(2); }
const tc = await resolveToolchain();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (...a) => import("../server/androidbuild.mjs").then(({ runTool }) => runTool(tc.adb, ["-s", serial, ...a], { timeoutMs: 30000 }));

await run("shell", "am", "start", "-W", "-n", `${PKG}/.MainActivity`);
await wait(2000);
const view = await openWebView({ adb: tc.adb, serial, pkg: PKG, pickHost: "automata.local" });
try {
  await view.evaluate(`localStorage.setItem("automata.connection", ${JSON.stringify(JSON.stringify({ origin, token }))}); document.querySelectorAll("dialog[open]").forEach((d) => d.close()); 0`);
  await view.send("Page.reload");
  let state = null;
  for (let i = 0; i < 40 && !state?.ok; i++) {
    await wait(500);
    state = await view.evaluate(`(() => { const c = document.querySelector("#connection"); return { ok: !!c && !c.classList.contains("offline") && /Conectado/.test(c.lastElementChild.textContent), text: c?.lastElementChild.textContent.trim(), project: document.querySelector("#projectName")?.textContent.trim() }; })()`).catch(() => null);
  }
  console.log(state?.ok ? `Conectado: ${state.text} · proyecto: ${state.project}` : `No conectó (${JSON.stringify(state)}). ¿Tailscale está activo en el teléfono?`);
  process.exitCode = state?.ok ? 0 : 1;
} finally {
  await view.close();
}

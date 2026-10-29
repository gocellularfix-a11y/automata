// Opens the Chrome DevTools channel of a debuggable app's WebView on an authorized phone, through `adb forward` (a port on
// this PC only). Nothing is installed on the phone. Returns { info, send, evaluate, onEvent, close }.
import { runTool, APP_HOST } from "../server/androidbuild.mjs";

export async function openWebView({ adb, serial, pkg, pickHost = APP_HOST }) {
  const run = (...a) => runTool(adb, ["-s", serial, ...a], { timeoutMs: 60000 });
  // The socket appears a moment after the app starts, once its WebView exists.
  let pid = "", socket = null;
  for (let i = 0; i < 40 && !socket; i++) {
    pid = (await run("shell", `pidof ${pkg}`)).stdout.trim().split(/\s+/)[0];
    if (/^\d+$/.test(pid)) socket = new RegExp(`webview_devtools_remote_${pid}\\b`).exec((await run("shell", "cat /proc/net/unix")).stdout)?.[0] ?? null;
    if (!socket) await new Promise((r) => setTimeout(r, 500));
  }
  if (!/^\d+$/.test(pid)) throw new Error("La app no está en ejecución; ábrela primero.");
  if (!socket) throw new Error("El WebView no expone su socket de depuración (¿app depurable?).");
  const port = 9300 + Math.floor(Math.random() * 400);
  const forwarded = await run("forward", `tcp:${port}`, `localabstract:${socket}`);
  if (forwarded.code !== 0) throw new Error(forwarded.stderr);
  let ws, nextId = 1;
  const pending = new Map(), listeners = [];
  const close = async () => { try { ws?.close(); } catch { /* closed */ } await run("forward", "--remove", `tcp:${port}`); };
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const pages = targets.filter((t) => t.type === "page");
    const target = pages.find((t) => { try { return new URL(t.url).host === pickHost; } catch { return false; } }) ?? pages[0];
    if (!target) throw new Error("El WebView no tiene ninguna página abierta.");
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("No se pudo abrir el canal de depuración.")); });
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); } else listeners.forEach((l) => l(message));
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => (await send("Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression })).result?.value;
    await send("Runtime.enable");
    await send("Page.enable");
    const info = JSON.parse(await evaluate("JSON.stringify({ href: location.href, ua: navigator.userAgent, width: innerWidth, height: innerHeight, dpr: devicePixelRatio })"));
    return { info, send, evaluate, onEvent: (fn) => listeners.push(fn), close };
  } catch (error) {
    await close();
    throw error;
  }
}

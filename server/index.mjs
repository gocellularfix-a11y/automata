import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Store } from "./store.mjs";
import { Coordinator } from "./coordinator.mjs";
import { MODELS, MODES, effortsFor } from "./config.mjs";
import { findAgent } from "./agents.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json" };
const loopback = (address) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
export async function createServer({ port = 4780, lan = false, demo = false, dataDir = path.join(ROOT, ".automata", demo ? "demo" : "live"), ...injections } = {}) {
  const store = new Store(dataDir), release = store.acquire();
  let coordinator;
  try {
    coordinator = new Coordinator(store, { demo, ...injections });
    coordinator.seedDemo();
  } catch (e) {
    release();
    throw e;
  }
  const tokenFile = store.location("access-token");
  let token;
  try {
    token = fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    token = randomBytes(32).toString("hex");
    fs.writeFileSync(tokenFile, token, { mode: 384 });
  }
  const clients = /* @__PURE__ */ new Set();
  let origin;
  const notify = (type, payload) => {
    const data = `event: ${type}
data: ${JSON.stringify(payload)}

`;
    for (const client of clients) {
      if (client.writableLength > 1024 * 1024) client.destroy();
      else client.write(data);
    }
  };
  coordinator.on("event", (e) => notify("activity", e));
  coordinator.on("state", (s) => notify("state", s));
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      const host = req.headers.host?.split(":")[0];
      if (!host || !lan && !["127.0.0.1", "localhost", "["].includes(host)) {
        send(403, { error: "Host no permitido." });
        return;
      }
      const requestOrigin = req.headers.origin;
      const originAllowed = !requestOrigin || requestOrigin === origin || requestOrigin === "https://automata.local" || lan && (() => {
        try {
          const u = new URL(requestOrigin);
          return u.port === String(server.address().port) && ["http:", "https:"].includes(u.protocol) && ["localhost", "127.0.0.1", ...Object.values(os.networkInterfaces()).flat().filter(Boolean).map((i) => i.address)].includes(u.hostname);
        } catch {
          return false;
        }
      })();
      if (!originAllowed) {
        send(403, { error: "Origen no permitido." });
        return;
      }
      if (requestOrigin) {
        res.setHeader("Access-Control-Allow-Origin", requestOrigin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
      }
      if (req.headers["access-control-request-private-network"] === "true") res.setHeader("Access-Control-Allow-Private-Network", "true");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      if (url.pathname.startsWith("/api/")) {
        const supplied = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
        if (supplied.length !== Buffer.byteLength(token) || !timingSafeEqual(supplied, Buffer.from(token))) {
          send(401, { error: "Conecta con el código de acceso de tu PC." });
          return;
        }
        if (url.pathname === "/api/events" && req.method === "GET") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive" });
          res.write(`event: state
data: ${JSON.stringify(coordinator.snapshot())}

`);
          clients.add(res);
          req.on("close", () => clients.delete(res));
          return;
        }
        const body = async () => {
          let text = "";
          for await (const c of req) {
            text += c;
            if (text.length > 15e4) throw new Error("La solicitud es demasiado grande.");
          }
          return text ? JSON.parse(text) : {};
        };
        if (url.pathname === "/api/state" && req.method === "GET") return send(200, coordinator.snapshot());
        if (url.pathname === "/api/capabilities" && req.method === "GET") return send(200, { demo, version: "0.1.0", models: MODELS, modes: MODES, efforts: { coder: effortsFor("sonnet", "coder"), auditor: effortsFor("gpt-6.1-sol", "auditor") }, agents: { coder: !!findAgent("coder"), auditor: !!findAgent("auditor") }, lan, addresses: lan ? Object.values(os.networkInterfaces()).flat().filter((i) => i?.family === "IPv4" && !i.internal).map((i) => `http://${i.address}:${server.address().port}`) : [] });
        if (url.pathname === "/api/pairing" && req.method === "GET") {
          if (!loopback(req.socket.remoteAddress)) return send(403, { error: "Abre la conexión de Android desde la PC." });
          return send(200, { token, lan, addresses: Object.values(os.networkInterfaces()).flat().filter((i) => i?.family === "IPv4" && !i.internal).map((i) => `http://${i.address}:${server.address().port}`) });
        }
        if (url.pathname === "/api/projects" && req.method === "POST") return send(201, coordinator.addProject(await body()));
        if (url.pathname === "/api/settings" && req.method === "PUT") return send(200, coordinator.updateSettings(await body()));
        if (url.pathname === "/api/start" && req.method === "POST") return send(202, coordinator.start((await body()).projectId));
        if (url.pathname === "/api/control" && req.method === "POST") return send(200, coordinator.control((await body()).action));
        if (url.pathname === "/api/chat" && req.method === "POST") return send(202, await coordinator.sendChat(await body()));
        return send(404, { error: "Ruta no encontrada." });
      }
      if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: "Método no permitido." });
      const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(ROOT, "public", relative), base = path.join(ROOT, "public") + path.sep;
      if (!file.startsWith(base) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return send(404, { error: "Archivo no encontrado." });
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' http: https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      res.writeHead(200, { "content-type": mime[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(file).pipe(res);
    } catch (e) {
      if (!res.headersSent) send(e instanceof SyntaxError ? 400 : 422, { error: e.message });
      else res.end();
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, lan ? "0.0.0.0" : "127.0.0.1", resolve);
    });
  } catch (e) {
    release();
    throw e;
  }
  origin = `http://127.0.0.1:${server.address().port}`;
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(": heartbeat\n\n");
  }, 15e3);
  heartbeat.unref();
  return { server, coordinator, origin, token, store, async close() {
    clearInterval(heartbeat);
    await coordinator.close();
    for (const c of clients) c.end();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    release();
  } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = args.indexOf("--port");
  const app = await createServer({ port: at >= 0 ? Number(args[at + 1]) : 4780, lan: args.includes("--lan"), demo: args.includes("--demo") });
  console.log(`Automata · ${app.origin}
Abre la aplicación de Windows o conecta desde Android.
Código de conexión local: ${app.token}`);
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => void app.close().then(() => process.exit(0)));
}

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server/index.mjs";
import { removeFolder } from "./rmretry.mjs";

const REMOTE = "cellhub.example.ts.net";
// What `tailscale serve` adds when it forwards a request from another device.
const PROXY = { "x-forwarded-for": "100.82.143.118", "x-forwarded-proto": "https", "tailscale-user-login": "jorge@example.com", "tailscale-user-name": "Jorge" };

async function start(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-remote-"));
  const app = await createServer({ port: 0, demo: true, dataDir: path.join(dir, "data"), ...options });
  t.after(async () => { await app.close(); removeFolder(dir); });
  const port = new URL(app.origin).port;
  // fetch cannot set Host; this does, so it can pose as the proxy forwarding a remote request.
  const call = (route, { host = `127.0.0.1:${port}`, headers = {}, token = app.token, method = "GET", body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, method, headers: { Host: host, ...token ? { Authorization: "Bearer " + token } : {}, ...body ? { "Content-Type": "application/json" } : {}, ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: (() => { try { return JSON.parse(text); } catch { return text; } })() }));
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  const remote = (route, extra = {}) => call(route, { host: REMOTE + ":8444", headers: { ...PROXY, ...extra.headers }, ...extra, ...{ headers: { ...PROXY, ...extra.headers } } });
  return { app, call, remote, port };
}

test("sin acceso remoto configurado, el nombre del proxy no se acepta", async (t) => {
  const { remote } = await start(t);
  assert.equal((await remote("/api/state")).status, 403);
});

test("con acceso remoto: el nombre del proxy entra con el código, y solo ese nombre", async (t) => {
  const { app, call, remote } = await start(t, { remoteHost: REMOTE });
  assert.equal((await remote("/api/state")).status, 200);
  assert.equal((await remote("/api/state", { token: "" })).status, 401, "sin código no entra");
  assert.equal((await remote("/api/state", { token: "f".repeat(64) })).status, 401);
  assert.equal((await call("/api/state", { host: "otra.example.com" })).status, 403, "otro nombre de host");
  assert.equal((await call("/api/state", { host: "100.107.206.48:8444", headers: PROXY })).status, 403, "ni la IP del proxy sin LAN");
  const caps = await remote("/api/capabilities");
  assert.deepEqual(caps.body.remote, { host: REMOTE, restricted: false });
  assert.deepEqual(app.remote, { host: REMOTE, restricted: false });
});

test("el nombre remoto sin las cabeceras del proxy no vale (nadie se hace pasar por él desde la PC)", async (t) => {
  const { call } = await start(t, { remoteHost: REMOTE });
  assert.equal((await call("/api/state", { host: REMOTE })).status, 403);
});

test("el origen web debe ser https del mismo nombre; otros orígenes se rechazan", async (t) => {
  const { remote } = await start(t, { remoteHost: REMOTE });
  const good = await remote("/api/state", { headers: { Origin: `https://${REMOTE}:8444` } });
  assert.equal(good.status, 200);
  assert.equal(good.headers["access-control-allow-origin"], `https://${REMOTE}:8444`);
  assert.equal((await remote("/api/state", { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await remote("/api/state", { headers: { Origin: `http://${REMOTE}:8444` } })).status, 403, "http no");
  assert.equal((await remote("/api/state", { headers: { Origin: `https://${REMOTE}.evil.example` } })).status, 403);
  assert.equal((await remote("/api/state", { headers: { Origin: "https://automata.local" } })).status, 200, "el cliente Android sigue valiendo");
});

test("lo reservado a quien está en la PC se niega a lo que llega por el proxy, aunque venga de 127.0.0.1", async (t) => {
  const { app, call, remote } = await start(t, { remoteHost: REMOTE });
  // The same requests from the PC itself still work…
  assert.equal((await call("/api/pairing")).status, 200);
  assert.equal((await call("/api/pairing")).body.token, app.token);
  // …and through the proxy none of them does.
  const pairing = await remote("/api/pairing");
  assert.equal(pairing.status, 403);
  assert.ok(!JSON.stringify(pairing.body).includes(app.token), "el código no viaja en la respuesta");
  assert.equal((await remote("/api/auth", { method: "POST", body: { action: "login", role: "coder", method: "subscription" } })).status, 403, "conectar cuentas solo desde la PC");
  assert.equal((await remote("/api/agent-checks", { method: "POST", token: "x", body: {} })).status, 403, "la herramienta de comprobación de Claude solo desde la PC");
  const status = await remote("/api/auth");
  assert.equal(status.status, 200);
});

test("cualquier proxy local cuenta como remoto, también sin acceso remoto configurado", async (t) => {
  const { call } = await start(t);
  for (const header of [{ "x-forwarded-for": "1.2.3.4" }, { forwarded: "for=1.2.3.4" }, { "x-real-ip": "1.2.3.4" }, { via: "1.1 proxy" }, { "tailscale-user-login": "a@b.c" }]) {
    assert.equal((await call("/api/pairing", { headers: header })).status, 403, JSON.stringify(header));
  }
  assert.equal((await call("/api/pairing")).status, 200);
});

test("se puede limitar el acceso remoto a las cuentas de Tailscale indicadas", async (t) => {
  const { app, remote } = await start(t, { remoteHost: REMOTE, remoteLogins: ["Jorge@Example.com"] });
  assert.deepEqual(app.remote, { host: REMOTE, restricted: true });
  assert.equal((await remote("/api/state")).status, 200, "la cuenta indicada (sin distinguir mayúsculas)");
  assert.equal((await remote("/api/state", { headers: { "tailscale-user-login": "otro@example.com" } })).status, 403);
  const anonymous = await remote("/api/state", { headers: { "tailscale-user-login": "" } });
  assert.equal(anonymous.status, 403, "un dispositivo sin cuenta no entra");
  assert.match(anonymous.body.error, /no tiene permiso/);
});

test("el servidor sigue escuchando solo en 127.0.0.1 con acceso remoto", async (t) => {
  const { app } = await start(t, { remoteHost: REMOTE });
  assert.equal(app.server.address().address, "127.0.0.1");
});

test("con una dirección remota, el emparejamiento (solo desde la PC) la ofrece junto al código", async (t) => {
  const { app, call, remote } = await start(t, { remoteUrl: `https://${REMOTE}:8444`, remoteLogins: ["jorge@example.com"] });
  assert.deepEqual(app.remote, { host: REMOTE, restricted: true });
  const pairing = (await call("/api/pairing")).body;
  assert.deepEqual(pairing.remote, { host: REMOTE, url: `https://${REMOTE}:8444`, restricted: true });
  assert.equal(pairing.token, app.token);
  assert.equal((await remote("/api/pairing")).status, 403, "por el túnel no se entrega");
  assert.equal((await remote("/api/state")).status, 200, "el nombre sale de la dirección");
});

test("una dirección remota que no es https se ignora", async (t) => {
  const { app, remote } = await start(t, { remoteUrl: `http://${REMOTE}:8444` });
  assert.equal(app.remote, null);
  assert.equal((await remote("/api/state")).status, 403);
});

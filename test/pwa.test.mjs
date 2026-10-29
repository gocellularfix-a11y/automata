import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server/index.mjs";
import { removeFolder } from "./rmretry.mjs";

const pub = (name) => path.join(import.meta.dirname, "..", "public", name);
const pngSize = (file) => { const b = fs.readFileSync(file); assert.equal(b.toString("latin1", 1, 4), "PNG", file); return [b.readUInt32BE(16), b.readUInt32BE(20), b[25]]; };

test("el manifiesto permite instalar Automata como app en Windows, Android y iOS", () => {
  const manifest = JSON.parse(fs.readFileSync(pub("manifest.webmanifest"), "utf8"));
  assert.equal(manifest.name, "Automata");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
  const png = manifest.icons.filter((i) => i.type === "image/png");
  assert.ok(png.some((i) => i.sizes === "192x192") && png.some((i) => i.sizes === "512x512" && i.purpose === "any"), "192 y 512 normales");
  assert.ok(png.some((i) => i.purpose === "maskable"), "un icono maskable para Android");
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(pub(icon.src)), `falta ${icon.src}`);
    if (icon.type === "image/png") { const [w, h] = pngSize(pub(icon.src)); assert.equal(`${w}x${h}`, icon.sizes, icon.src); }
  }
});

test("iOS: icono de pantalla de inicio opaco de 180×180 y metadatos de app web en la página", () => {
  const [w, h, colorType] = pngSize(pub("apple-touch-icon.png"));
  assert.deepEqual([w, h], [180, 180]);
  assert.equal(colorType, 2, "sin canal alfa: iOS pone negras las esquinas transparentes");
  assert.equal(pngSize(pub("icon-maskable-512.png"))[2], 2, "el maskable llena todo el cuadrado");
  const html = fs.readFileSync(pub("index.html"), "utf8");
  for (const needle of ['rel="manifest" href="manifest.webmanifest"', 'rel="apple-touch-icon" href="apple-touch-icon.png"', 'name="apple-mobile-web-app-capable"', 'name="mobile-web-app-capable"', 'name="apple-mobile-web-app-title"', 'name="theme-color"', "viewport-fit=cover"]) assert.ok(html.includes(needle), needle);
});

test("el coordinador sirve el manifiesto y los iconos sin código de acceso, con el tipo correcto", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-pwa-"));
  const app = await createServer({ port: 0, demo: true, dataDir: path.join(dir, "data") });
  t.after(async () => { await app.close(); removeFolder(dir); });
  const manifest = await fetch(app.origin + "/manifest.webmanifest");
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get("content-type"), /^application\/manifest\+json/);
  assert.equal((await manifest.json()).name, "Automata");
  for (const file of ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]) {
    const response = await fetch(`${app.origin}/${file}`);
    assert.equal(response.status, 200, file);
    assert.equal(response.headers.get("content-type"), "image/png", file);
  }
  assert.equal((await fetch(app.origin + "/api/state")).status, 401, "la API sigue pidiendo el código");
});

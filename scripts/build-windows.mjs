import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = require("electron"), source = path.dirname(executable), target = path.join(root, "dist", "Automata-Windows");
const exists = fs.existsSync(target);
if (exists && !process.argv.includes("--refresh")) throw new Error("dist/Automata-Windows ya existe. Usa --refresh para actualizar la aplicación generada.");
if (exists && !fs.realpathSync(target).startsWith(fs.realpathSync(path.join(root, "dist")) + path.sep)) throw new Error("El destino debe permanecer dentro de dist.");
if (!exists) {
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}
const app = path.join(target, "resources", "app");
fs.mkdirSync(app, { recursive: true });
for (const name of ["desktop", "public", "server"]) fs.cpSync(path.join(root, name), path.join(app, name), { recursive: true });
fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
fs.copyFileSync(path.join(root, "scripts/browser.mjs"), path.join(app, "scripts/browser.mjs"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
delete pkg.devDependencies;
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify(pkg, null, 2));
fs.copyFileSync(path.join(root, "README.md"), path.join(target, "LEEME.md"));
fs.copyFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(target, "AVISOS_DE_TERCEROS.md"));
if (!exists) fs.renameSync(path.join(target, "electron.exe"), path.join(target, "Automata.exe"));
const legacyBrowserLauncher = path.join(target, "Automata-Chrome.cmd");
if (fs.existsSync(legacyBrowserLauncher)) fs.unlinkSync(legacyBrowserLauncher);
console.log("Aplicación portable: " + path.join(target, "Automata.exe"));

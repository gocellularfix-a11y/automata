// A3: installs ONE app created by Automata on ONE authorized phone, starts it, watches it, and removes it again.
// It touches no other package: the package comes from the APK's build-info.json, it may never be Automata's own client
// (app.automata.*), and the client's fingerprint is read before and after to prove it did not change.
//   node scripts/android-device-check.mjs --apk <file.apk> --serial <adb serial> [--keep] [--out <folder>]
import fs from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { runTool, resolveToolchain, packageNameProblem } from "../server/androidbuild.mjs";
import { verifyApk } from "../server/androidverify.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const at = args.indexOf("--" + name); return at >= 0 ? args[at + 1] : undefined; };
const apk = path.resolve(flag("apk") ?? ""), serial = flag("serial"), keep = args.includes("--keep");
const out = path.resolve(flag("out") ?? path.join("artifacts", "device-" + Date.now()));
const CLIENT = "app.automata.workspace";
if (!fs.existsSync(apk) || !serial) { console.error("Uso: node scripts/android-device-check.mjs --apk <archivo> --serial <serie> [--keep] [--out <carpeta>]"); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

const tc = await resolveToolchain();
if (!tc.ok || !tc.adb) { console.error("Faltan herramientas (adb incluido): " + [...tc.missing ?? [], tc.adb ? "" : "adb"].join(" ")); process.exit(2); }
const info = JSON.parse(fs.readFileSync(path.join(path.dirname(apk), "build-info.json"), "utf8"));
const pkg = info.app.packageName;
if (packageNameProblem(pkg) || pkg === CLIENT || pkg.startsWith("app.automata.")) { console.error(`Paquete no permitido para esta prueba: ${pkg}`); process.exit(2); }

const adb = async (...a) => runTool(tc.adb, ["-s", serial, ...a], { timeoutMs: 120000 });
const shell = async (cmd) => (await adb("shell", cmd)).stdout.trim();
const report = { at: new Date().toISOString(), package: pkg, apk: { path: apk, sha256: info.apk.sha256 }, checks: [] };
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) }); console.log(`${ok ? "ok   " : "FALLA"} ${name}${detail ? ": " + String(detail).slice(0, 200) : ""}`); return !!ok; };
const fingerprint = async () => (await shell(`pm path ${CLIENT}; dumpsys package ${CLIENT} | grep -E "versionCode|lastUpdateTime|signatures="`)).replace(/\r/g, "");
let installed = false;
const finish = async (code) => {
  if (installed && !keep) {
    const gone = await adb("uninstall", pkg);
    check("paquete de prueba desinstalado (solo ese)", /Success/.test(gone.stdout), gone.stdout.trim());
  }
  const after = await fingerprint();
  check("el cliente de Automata no cambió", after === report.clientBefore, after === report.clientBefore ? "misma ruta, versión, fecha y firma" : "DIFERENTE:\n" + after);
  report.ok = report.checks.every((c) => c.ok);
  fs.writeFileSync(path.join(out, "device-report.json"), JSON.stringify(report, null, 2));
  console.log(report.ok ? "A3: correcto (ver capturas)." : "A3: hay fallos.");
  process.exit(code ?? (report.ok ? 0 : 1));
};

report.clientBefore = await fingerprint();
// 1. Nothing goes to the phone unless the package is exactly what was verified.
const verified = await verifyApk({ apkPath: apk, toolchain: tc, expected: { permissions: info.permissions } });
if (!check("el APK pasa la verificación estática antes de instalarlo", verified.ok, verified.errors.join(" | "))) await finish(1);
if (!check("el paquete no está ya instalado (no se pisa nada)", !/package:/.test(await shell(`pm path ${pkg}`)))) await finish(1);

// 2. Install, start, watch
const install = await adb("install", apk);
installed = /Success/.test(install.stdout);
if (!check("instalación", installed, install.stdout.trim() + install.stderr.trim())) await finish(1);
const dump = await shell(`dumpsys package ${pkg}`);
check("versionCode y firma instalados", new RegExp(`versionCode=${info.app.versionCode}\\b`).test(dump) && !/DEBUGGABLE/.test(dump), (/versionCode=\d+/.exec(dump) ?? [""])[0] + (/DEBUGGABLE/.test(dump) ? " DEBUGGABLE" : " no depurable"));
check("sin permisos peligrosos concedidos", !/granted=true/.test(dump.split("requested permissions:")[1]?.split("User 0")[0] ?? ""), "");
await adb("logcat", "-c");
const start = await adb("shell", "am", "start", "-W", "-n", `${pkg}/${pkg}.MainActivity`);
check("la actividad inicial arranca (am start -W)", /Status: ok/.test(start.stdout) && /LaunchState: (COLD|WARM|HOT)/.test(start.stdout), start.stdout.replace(/\r?\n/g, " | "));
await new Promise((r) => setTimeout(r, 5000));
const pid = (await shell(`pidof ${pkg}`)).split(/\s+/)[0];
check("el proceso sigue vivo a los 5 s", /^\d+$/.test(pid), pid);
const crash = (await adb("logcat", "-b", "crash", "-d")).stdout;
check("sin FATAL EXCEPTION en logcat", !/FATAL EXCEPTION|AndroidRuntime/.test(crash), crash.split(/\r?\n/).slice(0, 4).join(" | "));
const web = (await adb("logcat", "-d", "-s", "AutomataWeb:*")).stdout;
report.console = web.split(/\r?\n/).filter((l) => /AutomataWeb/.test(l)).slice(0, 30);
check("la consola de la página no reporta errores", !/ERROR/.test(web), report.console.filter((l) => /ERROR/.test(l)).join(" | "));
const png = path.join(out, "01-app-creada.png");
const screencap = await new Promise((resolve) => execFile(tc.adb, ["-s", serial, "exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 20 * 1024 * 1024 }, (e, so) => resolve(e ? null : so)));
if (screencap?.length > 1000) fs.writeFileSync(png, screencap);
check("captura de pantalla", fs.existsSync(png), png);
const top = await shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'");
check("la app creada tiene el foco", top.includes(pkg), top.split(/\r?\n/)[0]);
await finish();

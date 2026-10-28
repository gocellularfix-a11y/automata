// What this PC has to build and deliver an app: a read-only look, never an installation.
// It finds tools the way a person would expect (PATH, JAVA_HOME, ANDROID_HOME, the usual folders), runs at most a
// version query per tool, and says per target (web, Windows, Android) whether it is ready and, if not, what is
// missing in plain words. Automata installs nothing global: a missing tool is reported, never fetched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultRun = (file, args, options = {}) => execFileAsync(file, args, { windowsHide: true, timeout: 8000, ...options });
// How the platform text of a proposal («página web local», «app para Android»…) maps to a delivery target.
export function platformKind(text) {
  const t = String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (/android|apk|telefono|celular|movil|tablet/.test(t)) return "android";
  if (/instalador|ejecutable|\.exe|escritorio|desktop|electron|programa para windows|aplicacion de windows|app de windows|app para windows|aplicacion para windows/.test(t)) return "windows";
  if (/web|navegador|pagina|html|sitio|browser|localhost/.test(t)) return "web";
  if (/consola|terminal|linea de comandos|cli|powershell/.test(t)) return "console";
  return "web";
}

const versionOf = (text) => /(\d+(?:\.\d+){1,3})/.exec(String(text ?? ""))?.[1] ?? null;
// Java 8 reports itself as 1.8.
const majorOf = (version) => { const [a, b] = String(version ?? "").split("."); return Number(a) === 1 ? Number(b) || 1 : Number(a) || 0; };

// A tool on the PATH (or on a given list of folders), without running anything.
export function findOnPath(name, { env = process.env, platform = process.platform, exists = fs.existsSync, extra = [] } = {}) {
  const win = platform === "win32";
  const dirs = [...String(env.PATH ?? env.Path ?? "").split(win ? ";" : ":").filter(Boolean), ...extra];
  const exts = win ? ["", ...String(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean).map((e) => e.toLowerCase())] : [""];
  for (const dir of dirs) for (const ext of exts) {
    const candidate = path.join(dir.replace(/^"|"$/g, ""), name + ext);
    try { if (exists(candidate)) return candidate; } catch { /* unreadable folder */ }
  }
  return null;
}

// JDK folders worth looking at when Java is not on the PATH: where installers and Android Studio leave it.
function javaHomes({ env, platform, exists, readdir }) {
  const list = [];
  if (env.JAVA_HOME) list.push({ home: env.JAVA_HOME, source: "JAVA_HOME" });
  if (platform === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs")].filter(Boolean);
    for (const root of roots) {
      for (const vendor of ["Eclipse Adoptium", "Java", "Microsoft", "Zulu", "Amazon Corretto", "BellSoft", "Semeru"]) {
        const base = path.join(root, vendor);
        try { for (const entry of readdir(base)) list.push({ home: path.join(base, entry), source: vendor }); } catch { /* not installed */ }
      }
      list.push({ home: path.join(root, "Android", "Android Studio", "jbr"), source: "Android Studio" });
    }
  }
  return list.filter((c) => { try { return exists(path.join(c.home, "bin", platform === "win32" ? "java.exe" : "java")); } catch { return false; } });
}

// The Android SDK folder and what it holds, the way scripts/build-android.ps1 uses it (no Gradle needed).
function androidSdk({ env, platform, exists, readdir, home }) {
  const candidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, platform === "win32" && env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Android", "Sdk"), path.join(home, "Android", "Sdk")].filter(Boolean);
  for (const sdk of candidates) {
    let platforms = [], buildTools = [];
    try { platforms = readdir(path.join(sdk, "platforms")).filter((n) => /^android-\d+$/.test(n)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8))); } catch { /* none */ }
    try { buildTools = readdir(path.join(sdk, "build-tools")).filter((n) => /^\d+(\.\d+)*$/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); } catch { /* none */ }
    if (!platforms.length && !buildTools.length && !exists(sdk)) continue;
    const tools = buildTools.length ? path.join(sdk, "build-tools", buildTools.at(-1)) : null;
    const exe = (n) => platform === "win32" ? n + ".exe" : n;
    const has = tools ? { aapt2: exists(path.join(tools, exe("aapt2"))), zipalign: exists(path.join(tools, exe("zipalign"))), apksigner: exists(path.join(tools, "lib", "apksigner.jar")), d8: exists(path.join(tools, "lib", "d8.jar")) } : { aapt2: false, zipalign: false, apksigner: false, d8: false };
    const adb = path.join(sdk, "platform-tools", exe("adb"));
    return { found: true, path: sdk, platform: platforms.at(-1) ?? null, buildTools: buildTools.at(-1) ?? null, has, adb: exists(adb) ? adb : null };
  }
  return { found: false, path: null, platform: null, buildTools: null, has: { aapt2: false, zipalign: false, apksigner: false, d8: false }, adb: null };
}

const BROWSERS = [["Chrome", "Google", "Chrome", "Application", "chrome.exe"], ["Edge", "Microsoft", "Edge", "Application", "msedge.exe"]];
const PACKAGERS = ["electron", "electron-builder", "@electron/packager", "electron-packager", "pkg", "nexe"];

// options (all injectable for tests): env, platform, home, exists, readdir, run, probe (false: never run a program).
export async function detectEnvironment({ env = process.env, platform = process.platform, home = os.homedir(), exists = fs.existsSync, readdir = fs.readdirSync, run = defaultRun, probe = env.AUTOMATA_ENV_PROBE !== "0", release = os.release(), arch = os.arch() } = {}) {
  const ctx = { env, platform, exists, readdir, home };
  const win = platform === "win32";
  const tool = (found, extra = {}) => ({ found: !!found, path: found || null, ...extra });
  const query = async (file, args) => {
    if (!probe) return "";
    try { const { stdout, stderr } = await run(file, args); return `${stdout}\n${stderr}`; } catch (error) { return `${error.stdout ?? ""}\n${error.stderr ?? ""}`; }
  };
  const system = { platform, arch, release, name: platform !== "win32" ? platform : Number(release.split(".")[2]) >= 22000 ? "Windows 11" : "Windows 10" };

  // Node is the process running Automata itself, so it is always there; npm and Git are looked up.
  const npm = findOnPath("npm", ctx);
  const git = findOnPath("git", ctx);
  const powershell = win ? findOnPath("powershell", ctx) : findOnPath("pwsh", ctx) ?? findOnPath("sh", ctx);
  const tools = {
    node: tool(process.execPath, { version: process.versions.node }),
    npm: tool(npm),
    git: tool(git, { version: git ? versionOf(await query(git, ["--version"])) : null }),
    powershell: tool(powershell)
  };
  let browser = { found: false, name: null, path: null };
  if (win) {
    for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA)].filter(Boolean)) {
      for (const [name, ...parts] of BROWSERS) {
        const candidate = path.join(root, ...parts);
        if (!browser.found && exists(candidate)) browser = { found: true, name, path: candidate };
      }
    }
  } else {
    const found = findOnPath("google-chrome", ctx) ?? findOnPath("chromium", ctx) ?? findOnPath("firefox", ctx);
    if (found) browser = { found: true, name: path.basename(found), path: found };
  }
  tools.browser = browser;

  // Java: the PATH first, then the usual JDK folders. A JDK (javac, jar, keytool) is what building an APK needs.
  const javaExe = win ? "java.exe" : "java";
  const homes = [];
  const onPath = findOnPath("java", ctx);
  if (onPath) homes.push({ home: path.dirname(path.dirname(onPath)), source: "PATH", exe: onPath });
  for (const c of javaHomes({ ...ctx, platform })) homes.push({ ...c, exe: path.join(c.home, "bin", javaExe) });
  let java = { found: false, path: null, home: null, version: null, jdk: false, source: null };
  const seen = new Set();
  for (const c of homes) {
    const key = c.home.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const version = versionOf(await query(c.exe, ["-version"])) ?? null;
    const jdk = ["javac", "jar", "keytool"].every((n) => exists(path.join(c.home, "bin", win ? n + ".exe" : n)));
    // Prefer a full JDK, then the newest version.
    if (!java.found || (jdk && !java.jdk) || (jdk === java.jdk && majorOf(version) > majorOf(java.version))) java = { found: true, path: c.exe, home: c.home, version, jdk, source: c.source };
  }
  tools.java = java;
  const gradle = findOnPath("gradle", ctx);
  tools.gradle = tool(gradle);
  const sdk = androidSdk(ctx);
  tools.androidSdk = sdk;
  tools.adb = tool(sdk.adb ?? findOnPath("adb", ctx));

  // Packaging a Windows app from a Node project: a packager installed globally. A project may carry its own
  // (devDependencies); that is judged per project, never installed from here.
  const globalModules = [npm && path.join(path.dirname(npm), "node_modules"), env.APPDATA && path.join(env.APPDATA, "npm", "node_modules")].filter(Boolean);
  const packagers = [];
  for (const dir of globalModules) for (const name of PACKAGERS) if (exists(path.join(dir, name))) packagers.push(name);
  tools.packager = { found: packagers.length > 0, names: [...new Set(packagers)] };

  // ---- Per target: ready, or what is missing ----
  const web = { ready: true, missing: [], notes: [] };
  if (!browser.found) web.notes.push("No encontré Chrome ni Edge; la app se abrirá con el navegador que tenga Windows como predeterminado.");
  const windows = { ready: false, missing: [] };
  if (!win) windows.missing.push("Solo se prepara en Windows.");
  if (!tools.npm.found) windows.missing.push("npm (viene con Node.js).");
  if (!tools.packager.found) windows.missing.push("Una herramienta para crear el instalador (por ejemplo electron-builder). Automata no la instala sola.");
  windows.ready = windows.missing.length === 0;
  const android = { ready: false, missing: [] };
  if (!java.found) android.missing.push("Java (JDK 17 o 21).");
  else if (!java.jdk) android.missing.push("Java está instalado pero sin las herramientas de desarrollo (JDK).");
  if (!sdk.found) android.missing.push("El Android SDK (Android Studio lo instala).");
  else {
    if (!sdk.platform) android.missing.push("Una plataforma de Android en el SDK (Android SDK Platform).");
    if (!sdk.buildTools) android.missing.push("Android SDK Build-Tools.");
    else {
      if (!sdk.has.aapt2 || !sdk.has.zipalign || !sdk.has.d8) android.missing.push("Faltan herramientas de compilación dentro de las Build-Tools.");
      if (!sdk.has.apksigner) android.missing.push("La herramienta para firmar el APK (apksigner).");
    }
  }
  if (!tools.adb.found) android.notes = ["Sin adb no se puede instalar en un teléfono conectado; el APK se genera igual."];
  android.ready = android.missing.length === 0;
  web.verified = VERIFIED_TARGETS.includes("web");
  windows.verified = VERIFIED_TARGETS.includes("windows");
  android.verified = VERIFIED_TARGETS.includes("android");
  return { at: new Date().toISOString(), system, tools, targets: { web, windows, android } };
}

// Targets whose delivery Automata builds and checks by itself. Having the tools for another one is not the same
// as having it verified: Windows installers and Android APKs are prepared (detected) but not yet delivered.
export const VERIFIED_TARGETS = ["web"];

// Short text for the director: what is available, in one paragraph, so it does not propose what cannot be delivered.
export function describeEnvironment(info, { language = "es" } = {}) {
  const en = language === "en";
  const t = info.tools, x = info.targets;
  const parts = [`${info.system.name}`, `Node.js ${t.node.version}`];
  if (t.npm.found) parts.push("npm");
  if (t.git.found) parts.push("Git");
  if (t.powershell.found) parts.push("PowerShell");
  if (t.browser.found) parts.push(t.browser.name);
  const name = { windows: en ? "Windows installer" : "instalador de Windows", android: "APK de Android" };
  const others = ["windows", "android"].map((k) => `${name[k]} (${x[k].ready ? (en ? "tools found" : "herramientas encontradas") : (en ? "tools missing" : "faltan herramientas")})`).join(", ");
  return `${parts.join(", ")}. ` + (en
    ? `Automata builds and verifies the delivery of: local web page (a launcher, a plain-words guide and a start check). Not delivered automatically yet, even when the tools exist: ${others}; if the idea needs one of them, propose the simplest local web page that meets the goal instead and say so in risks. Automata installs nothing by itself.`
    : `Automata construye y verifica la entrega de: página web local (lanzador, guía en palabras sencillas y prueba de arranque). Todavía NO entrega automáticamente, aunque existan las herramientas: ${others}; si la idea necesita uno de ellos, propón la página web local más simple que cumpla el objetivo y dilo en risks. Automata no instala nada por su cuenta.`)
    + (en ? " No cloud accounts, no publishing to the Internet." : " Sin cuentas de servicios y sin publicar en Internet.");
}

// Cached reading shared by the server and the coordinator: it changes only when the person installs something.
export function createDetector({ detect = detectEnvironment, ttlMs = 5 * 60000 } = {}) {
  let last = null, pending = null;
  return async function read({ force = false } = {}) {
    if (!force && last && Date.now() - last.at < ttlMs) return last.info;
    pending ??= detect().then((info) => { last = { at: Date.now(), info }; return info; }).finally(() => { pending = null; });
    return pending;
  };
}
export const sharedDetector = createDetector();

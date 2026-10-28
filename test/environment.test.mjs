import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectEnvironment, describeEnvironment, findOnPath, platformKind, createDetector, VERIFIED_TARGETS } from "../server/environment.mjs";

// A PC built in a temporary folder: the tests never depend on what is installed on the machine that runs them.
function pc(t, files = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automata-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of files) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "");
  }
  const at = (...parts) => path.join(root, ...parts);
  const env = { PATH: at("bin"), PATHEXT: ".EXE;.CMD", ProgramFiles: at("Program Files"), "ProgramFiles(x86)": at("Program Files (x86)"), LOCALAPPDATA: at("Local"), APPDATA: at("Roaming") };
  return { root, at, env, options: { env, platform: "win32", home: at("home"), release: "10.0.26200", arch: "x64", probe: false } };
}
const sdkFiles = (base, { signer = true } = {}) => [`${base}/platforms/android-35/android.jar`, `${base}/build-tools/35.0.0/aapt2.exe`, `${base}/build-tools/35.0.0/zipalign.exe`, `${base}/build-tools/35.0.0/lib/d8.jar`, ...signer ? [`${base}/build-tools/35.0.0/lib/apksigner.jar`] : [], `${base}/platform-tools/adb.exe`];
const jdkFiles = (base) => ["java.exe", "javac.exe", "jar.exe", "keytool.exe"].map((n) => `${base}/bin/${n}`);

test("el texto de plataforma de una propuesta se reconoce sin ser quisquilloso", () => {
  assert.equal(platformKind("página web local en el navegador"), "web");
  assert.equal(platformKind("Aplicación web (HTML)"), "web");
  assert.equal(platformKind("App para Android"), "android");
  assert.equal(platformKind("un APK para mi celular"), "android");
  assert.equal(platformKind("aplicación de escritorio para Windows"), "windows");
  assert.equal(platformKind("instalador .exe"), "windows");
  assert.equal(platformKind("consola de Windows"), "console");
  assert.equal(platformKind(""), "web", "sin dato, lo más simple");
  assert.equal(platformKind("Android y web"), "android", "si pide Android, no se disfraza de web");
});

test("busca en el PATH sin ejecutar nada y respeta las extensiones de Windows", (t) => {
  const { at, env } = pc(t, ["bin/git.exe", "bin/npm.cmd", "other/gradle.bat"]);
  assert.equal(findOnPath("git", { env, platform: "win32" }), at("bin", "git.exe"));
  assert.equal(findOnPath("npm", { env, platform: "win32" }), at("bin", "npm.cmd"));
  assert.equal(findOnPath("gradle", { env, platform: "win32" }), null);
  assert.equal(findOnPath("gradle", { env, platform: "win32", extra: [at("other")] }), null, ".bat no está en este PATHEXT");
  assert.equal(findOnPath("java", { env, platform: "win32" }), null);
});

test("sin nada instalado: la web está lista y lo demás dice en palabras sencillas qué falta", async (t) => {
  const { options } = pc(t);
  const info = await detectEnvironment(options);
  assert.equal(info.system.name, "Windows 11");
  assert.equal(info.targets.web.ready, true, "una página local no necesita herramientas");
  assert.equal(info.targets.android.ready, false);
  assert.deepEqual(info.targets.android.missing, ["Java (JDK 17 o 21).", "El Android SDK (Android Studio lo instala)."]);
  assert.equal(info.targets.windows.ready, false);
  assert.match(info.targets.windows.missing.join(" "), /electron-builder.*no la instala sola/);
  assert.equal(info.tools.java.found, false);
  assert.equal(info.tools.androidSdk.found, false);
  assert.match(info.targets.web.notes.join(" "), /No encontré Chrome ni Edge/);
});

test("Android queda listo con un JDK, el SDK con plataforma y build-tools, y la herramienta de firma", async (t) => {
  const { at, options } = pc(t, [...jdkFiles("Program Files/Android/Android Studio/jbr"), ...sdkFiles("Local/Android/Sdk"), "Program Files/Google/Chrome/Application/chrome.exe"]);
  const info = await detectEnvironment(options);
  assert.equal(info.tools.java.found, true);
  assert.equal(info.tools.java.jdk, true);
  assert.equal(info.tools.java.source, "Android Studio");
  assert.equal(info.tools.androidSdk.path, at("Local", "Android", "Sdk"));
  assert.equal(info.tools.androidSdk.platform, "android-35");
  assert.equal(info.tools.androidSdk.buildTools, "35.0.0");
  assert.equal(info.tools.adb.found, true);
  assert.equal(info.tools.browser.name, "Chrome");
  assert.deepEqual(info.targets.android, { ready: true, missing: [], verified: false });
  assert.equal(info.targets.web.notes.length, 0);
});

test("detecta lo que falta: sin firma, un JRE sin compilador, o un SDK sin build-tools", async (t) => {
  const noSigner = pc(t, [...jdkFiles("Program Files/Java/jdk-21"), ...sdkFiles("home/Android/Sdk", { signer: false })]);
  assert.match((await detectEnvironment(noSigner.options)).targets.android.missing.join(" "), /firmar el APK \(apksigner\)/);
  const jre = pc(t, ["Program Files/Java/jre-8/bin/java.exe", ...sdkFiles("home/Android/Sdk")]);
  const jreInfo = await detectEnvironment(jre.options);
  assert.equal(jreInfo.tools.java.found, true);
  assert.equal(jreInfo.tools.java.jdk, false);
  assert.match(jreInfo.targets.android.missing.join(" "), /sin las herramientas de desarrollo \(JDK\)/);
  const bare = pc(t, [...jdkFiles("Program Files/Java/jdk-21"), "home/Android/Sdk/platforms/android-35/android.jar"]);
  assert.match((await detectEnvironment(bare.options)).targets.android.missing.join(" "), /Build-Tools/);
});

test("JAVA_HOME y ANDROID_HOME mandan sobre las carpetas habituales, y se prefiere el JDK más nuevo", async (t) => {
  const { at, env, options } = pc(t, [...jdkFiles("jdks/jdk-17"), ...jdkFiles("jdks/jdk-21"), ...jdkFiles("Program Files/Java/jdk-11"), ...sdkFiles("sdk-propio")]);
  env.JAVA_HOME = at("jdks", "jdk-17");
  env.ANDROID_HOME = at("sdk-propio");
  const versions = { [at("jdks", "jdk-17", "bin", "java.exe")]: '"17.0.9"', [at("Program Files", "Java", "jdk-11", "bin", "java.exe")]: '"11.0.2"' };
  const run = async (file, args) => { assert.deepEqual(args, ["-version"]); return { stdout: "", stderr: `openjdk version ${versions[file]}` }; };
  const info = await detectEnvironment({ ...options, probe: true, run });
  assert.equal(info.tools.androidSdk.path, at("sdk-propio"));
  assert.equal(info.tools.java.version, "17.0.9", "entre los JDK completos gana la versión más nueva que se pudo leer");
  assert.equal(info.tools.java.source, "JAVA_HOME");
});

test("solo lee: las únicas consultas son versiones y nunca instala ni descarga nada", async (t) => {
  const { options } = pc(t, [...jdkFiles("Program Files/Java/jdk-21"), "bin/git.exe"]);
  const calls = [];
  const run = async (file, args) => { calls.push([path.basename(file), ...args].join(" ")); return { stdout: "git version 2.50.0", stderr: 'openjdk version "21.0.5"' }; };
  await detectEnvironment({ ...options, probe: true, run });
  assert.deepEqual(calls.sort(), ["git.exe --version", "java.exe -version"]);
  const silent = [];
  await detectEnvironment({ ...options, probe: false, run: async (...a) => { silent.push(a); return { stdout: "", stderr: "" }; } });
  assert.deepEqual(silent, [], "con probe apagado no se ejecuta ningún programa");
});

test("la descripción para el director no promete entregar lo que todavía no se verifica", async (t) => {
  assert.deepEqual(VERIFIED_TARGETS, ["web"], "hoy solo la página web local se entrega y se verifica");
  const full = pc(t, [...jdkFiles("Program Files/Java/jdk-21"), ...sdkFiles("home/Android/Sdk"), "bin/npm.cmd"]);
  const text = describeEnvironment(await detectEnvironment(full.options));
  assert.match(text, /construye y verifica la entrega de: página web local/);
  assert.match(text, /Todavía NO entrega automáticamente, aunque existan las herramientas: instalador de Windows \(faltan herramientas\), APK de Android \(herramientas encontradas\)/);
  assert.match(text, /propón la página web local más simple/);
  assert.match(text, /no instala nada por su cuenta/);
  const english = describeEnvironment(await detectEnvironment(full.options), { language: "en" });
  assert.match(english, /Not delivered automatically yet, even when the tools exist/);
});

test("la lectura se guarda un rato y se puede forzar; dos preguntas a la vez leen una sola vez", async () => {
  let reads = 0;
  const read = createDetector({ detect: async () => ({ n: ++reads }), ttlMs: 60000 });
  const [a, b] = await Promise.all([read(), read()]);
  assert.equal(a.n, 1);
  assert.equal(b.n, 1);
  assert.equal((await read()).n, 1);
  assert.equal((await read({ force: true })).n, 2);
});

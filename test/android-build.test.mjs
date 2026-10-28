import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packageNameProblem, defaultPackageName, appLabel, permissionProblems, manifestSource, manifestProblems, activitySource, collectWebAssets, resolveToolchain, keyIdOf, keyFolder, runTool, APPROVABLE_PERMISSIONS, WEB_LIMITS } from "../server/androidbuild.mjs";
import { openZip, readEntry } from "../server/apkzip.mjs";
import { AUTOMATA_ROOT } from "../server/safety.mjs";
import { SKIP, toolchain, makeWorkspace, build, webProject } from "./androidfixture.mjs";

const workspace = (t) => { const w = makeWorkspace(); t.after(() => w.cleanup()); return w; };
const within = (child, parent) => path.resolve(child).toLowerCase().startsWith(path.resolve(parent).toLowerCase() + path.sep);

test("los identificadores de paquete válidos pasan y los de Automata, del sistema o mal formados no", () => {
  for (const good of ["apps.local.calc.p1a2b3c4d", "mi.empresa.app_uno"]) assert.equal(packageNameProblem(good), null, good);
  for (const bad of ["", "app", "a.b", "App.Local.Calc", "apps.local.1calc", "apps.local.new.x1", "apps..calc", "apps.local.calc-x", "com.android.calc.x", "android.app.x", "com.google.mi.app", "app.automata.workspace", "app.automata.miapp", "x".repeat(130)]) assert.ok(packageNameProblem(bad), `debía rechazar «${bad}»`);
});

test("el nombre de paquete por defecto es válido, estable y distinto por proyecto", () => {
  const a = defaultPackageName("Mi Calculadora ñandú", "aaaaaaaaaaaaaaaa"), b = defaultPackageName("Mi Calculadora ñandú", "bbbbbbbbbbbbbbbb");
  assert.equal(packageNameProblem(a), null, a);
  assert.match(a, /^apps\.local\.mi_calculadora_nandu.paaaaaaaa$/);
  assert.notEqual(a, b);
  for (const odd of ["", "123", "new", "¿¿??", "Ñ"]) assert.equal(packageNameProblem(defaultPackageName(odd, "0123456789abcdef")), null, odd);
});

test("el nombre visible se limpia y un nombre vacío se rechaza", () => {
  assert.equal(appLabel("  Mi <app> & \"cuentas\"  "), "Mi app cuentas");
  assert.equal(appLabel("Calculadora de propinas"), "Calculadora de propinas");
  assert.equal(appLabel("x".repeat(80)).length, 30);
  for (const bad of ["", "   ", "<>&", "@@", "-oculto"]) assert.throws(() => appLabel(bad), (e) => e.code === "bad-name", bad);
});

test("solo se aprueban permisos de una lista corta y sin repetir", () => {
  assert.deepEqual(permissionProblems([]), []);
  assert.deepEqual(permissionProblems(["android.permission.INTERNET"]), []);
  assert.equal(permissionProblems(["android.permission.CAMERA"]).length, 1);
  for (const p of ["android.permission.READ_CONTACTS", "android.permission.ACCESS_FINE_LOCATION", "android.permission.RECORD_AUDIO", "android.permission.READ_EXTERNAL_STORAGE", "android.permission.MANAGE_EXTERNAL_STORAGE", "android.permission.SYSTEM_ALERT_WINDOW"]) assert.ok(!APPROVABLE_PERMISSIONS.includes(p), p);
  assert.equal(permissionProblems(["android.permission.INTERNET", "android.permission.INTERNET"]).length, 1);
  assert.equal(permissionProblems("INTERNET").length, 1);
});

test("el manifiesto generado desactiva depuración y HTTP, no pide permisos de más y no admite componentes ajenos", () => {
  const spec = { packageName: "apps.local.calc.p1a2b3c4d", versionCode: 3, versionName: "1.2", minSdk: 26, targetSdk: 36, permissions: [] };
  const xml = manifestSource(spec);
  assert.deepEqual(manifestProblems(xml, spec), []);
  assert.match(xml, /android:debuggable="false"/);
  assert.match(xml, /android:usesCleartextTraffic="false"/);
  assert.match(xml, /android:allowBackup="false"/);
  assert.doesNotMatch(xml, /uses-permission/);
  assert.equal((xml.match(/<activity /g) ?? []).length, 1);
  const withPermission = { ...spec, permissions: ["android.permission.INTERNET"] };
  assert.deepEqual(manifestProblems(manifestSource(withPermission), withPermission), []);
  assert.ok(manifestProblems(manifestSource(withPermission), spec).length, "un permiso no aprobado se detecta");
  assert.ok(manifestProblems(xml.replace("</application>", '<service android:name=".S"/></application>'), spec).some((p) => /<service>/.test(p)));
  assert.ok(manifestProblems(xml.replace('debuggable="false"', 'debuggable="true"'), spec).length);
  assert.ok(manifestProblems(xml.replace('usesCleartextTraffic="false"', 'usesCleartextTraffic="true"'), spec).length);
  assert.match(manifestSource({ ...spec, versionName: '1"><x' }), /1&quot;&gt;&lt;x/, "los valores se escapan");
});

test("la Activity generada solo sirve su propio origen y no abre puentes ni archivos locales", () => {
  const code = activitySource("apps.local.calc.p1a2b3c4d");
  assert.match(code, /^package apps\.local\.calc\.p1a2b3c4d;/);
  assert.doesNotMatch(code, /addJavascriptInterface|setWebContentsDebuggingEnabled|MIXED_CONTENT_ALWAYS_ALLOW|setAllowFileAccess\(true\)|AllowUniversalAccessFromFileURLs\(true\)|file:\/\//);
  for (const needle of ["setAllowFileAccess(false)", "setAllowContentAccess(false)", "setAllowUniversalAccessFromFileURLs(false)", "MIXED_CONTENT_NEVER_ALLOW", "setSupportMultipleWindows(false)", "Content-Security-Policy", 'path.matches("/[A-Za-z0-9._/-]+")', "return !isAppUrl(request.getUrl())"]) assert.ok(code.includes(needle), needle);
  assert.equal(code, activitySource("apps.local.calc.p1a2b3c4d"), "determinista");
});

test("de la carpeta del proyecto solo entra la web: sin secretos, ocultos, pruebas ni node_modules", (t) => {
  const w = workspace(t);
  const dir = w.project();
  const found = collectWebAssets(dir);
  assert.deepEqual(found.problems, []);
  assert.deepEqual(found.files.map((f) => f.path), ["app.js", "img/logo.svg", "index.html", "style.css"]);
  const reasons = Object.fromEntries(found.skipped.map((s) => [s.path, s.reason]));
  for (const left of [".env", "node_modules/", "test/", "README.md", "COMO_USAR.md", "Abrir.cmd", "package.json", "ui-check.json"]) assert.ok(reasons[left], `«${left}» debía quedar fuera y explicarse`);
  assert.ok(found.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.bytes > 0));
});

test("una web con nombres inseguros, credenciales, archivos enormes o sin index.html no se empaqueta", (t) => {
  const w = workspace(t);
  const dir = w.project();
  fs.writeFileSync(path.join(dir, "mi imagen.png"), "x");
  fs.writeFileSync(path.join(dir, "CON.js"), "x");
  fs.writeFileSync(path.join(dir, "_privado.css"), "x");
  fs.writeFileSync(path.join(dir, "config.js"), 'const k = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";');
  fs.writeFileSync(path.join(dir, "clave.js"), "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
  fs.writeFileSync(path.join(dir, "enorme.png"), Buffer.alloc(WEB_LIMITS.maxFileBytes + 1));
  const problems = collectWebAssets(dir).problems.join("\n");
  for (const expected of ["mi imagen.png", "CON.js", "_privado.css", "config.js", "clave.js", "enorme.png"]) assert.match(problems, new RegExp(expected.replace(".", "\\.")), expected);
  fs.rmSync(path.join(dir, "index.html"));
  assert.match(collectWebAssets(dir).problems.join("\n"), /Falta index\.html/);
});

test("los enlaces simbólicos y las uniones no se siguen ni se empaquetan", (t) => {
  const w = workspace(t);
  const dir = w.project();
  const outside = path.join(w.base, "fuera");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secreto.js"), "x");
  try {
    fs.symlinkSync(outside, path.join(dir, "enlace"), "junction");
  } catch (error) {
    t.skip(`no se pueden crear enlaces aquí (${error.code})`);
    return;
  }
  const found = collectWebAssets(dir);
  assert.ok(found.problems.some((p) => /enlace/.test(p) && /simbólico/.test(p)), found.problems.join("|"));
  assert.ok(!found.files.some((f) => /secreto/.test(f.path)));
});

test("las entradas inválidas se rechazan antes de tocar ninguna herramienta, con la razón en palabras sencillas", async (t) => {
  const w = workspace(t);
  const dir = w.project();
  const fail = async (options, code) => {
    const result = await build({ projectDir: dir, dataDir: w.data, name: "App", toolchain: { ok: true }, ...options });
    assert.equal(result.ok, false, JSON.stringify(options));
    assert.equal(result.stage, "validar", `${JSON.stringify(options)} → ${result.stage}/${result.code}: ${result.error}`);
    assert.equal(result.code, code, result.error);
    assert.ok(result.error.length > 10);
    return result;
  };
  await fail({ packageName: "app.automata.workspace" }, "bad-package");
  await fail({ packageName: "com.android.algo.app" }, "bad-package");
  await fail({ packageName: "Mal.Nombre.App" }, "bad-package");
  await fail({ permissions: ["android.permission.CAMERA"] }, "bad-permissions");
  await fail({ permissions: ["android.permission.INTERNET", "android.permission.INTERNET"] }, "bad-permissions");
  await fail({ name: "<>" }, "bad-name");
  await fail({ versionCode: 0 }, "bad-version");
  await fail({ versionCode: 1.5 }, "bad-version");
  await fail({ versionName: "1.0; rm -rf" }, "bad-version");
  await fail({ minSdk: 21 }, "bad-sdk");
  await fail({ minSdk: 40 }, "bad-sdk");
  await fail({ webRoot: ".." }, "web-outside");
  await fail({ webRoot: "no-existe" }, "no-web");
  await fail({ outDir: ".." }, "out-outside");
  await fail({ outDir: "." }, "out-outside");
  await fail({ outDir: path.join(w.base, "otro-lado") }, "out-outside");
  await fail({ projectDir: path.join(w.base, "no-existe") }, "no-project");
  await fail({ projectDir: AUTOMATA_ROOT }, "project-folder");
  await fail({ projectDir: os.homedir() }, "project-folder");
  await fail({ dataDir: path.join(dir, "datos") }, "data-in-project");
  // A secret in the web files and a missing index.html stop the build too.
  fs.writeFileSync(path.join(dir, "k.js"), 'x="ghp_abcdefghijklmnopqrstuvwxyz0123456789"');
  const secret = await fail({}, "bad-web");
  assert.match(secret.error, /k\.js/);
  assert.doesNotMatch(secret.error, /ghp_/, "el mensaje no repite la credencial");
});

test("otro proyecto no puede reutilizar el identificador de una app ya registrada", async (t) => {
  const w = workspace(t);
  const first = w.project("uno"), second = w.project("dos");
  const folder = keyFolder(w.data, keyIdOf(first));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "key.json"), JSON.stringify({ packageName: "apps.local.compartido.app1" }));
  const result = await build({ projectDir: second, dataDir: w.data, name: "Dos", packageName: "apps.local.compartido.app1", toolchain: { ok: true } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "package-taken");
});

test("sin JDK ni SDK se explica qué falta y no se construye nada", async (t) => {
  const w = workspace(t);
  const dir = w.project();
  const empty = path.join(w.base, "vacio");
  fs.mkdirSync(empty);
  const found = await resolveToolchain({ env: { PATH: "", Path: "" }, home: empty, javaHome: path.join(empty, "jdk"), sdkRoot: path.join(empty, "sdk") });
  assert.equal(found.ok, false);
  assert.ok(found.missing.some((m) => /JDK/.test(m)) && found.missing.some((m) => /SDK/.test(m)), found.missing.join("|"));
  const result = await build({ projectDir: dir, dataDir: w.data, name: "App", toolchain: found });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "herramientas");
  assert.equal(result.code, "toolchain-missing");
  assert.match(result.error, /JDK/);
  assert.ok(!fs.existsSync(path.join(dir, "dist")), "no dejó nada en el proyecto");
});

test("JDK 21 va antes que 25 y las versiones no admitidas se ignoran", { skip: SKIP }, async (t) => {
  const w = workspace(t);
  const fake = (name, version) => {
    const home = path.join(w.base, name);
    for (const exe of ["java", "javac", "keytool"]) { fs.mkdirSync(path.join(home, "bin"), { recursive: true }); fs.writeFileSync(path.join(home, "bin", process.platform === "win32" ? exe + ".exe" : exe), ""); }
    fs.writeFileSync(path.join(home, "release"), `JAVA_VERSION="${version}"\nIMPLEMENTOR="Prueba"\n`);
    return home;
  };
  const home = path.join(w.base, "home");
  fs.mkdirSync(path.join(home, ".gradle", "jdks"), { recursive: true });
  const jdks = path.join(home, ".gradle", "jdks");
  fs.cpSync(fake("j25", "25.0.2"), path.join(jdks, "jdk-25"), { recursive: true });
  fs.cpSync(fake("j17", "17.0.9"), path.join(jdks, "jdk-17"), { recursive: true });
  fs.cpSync(fake("j21", "21.0.3"), path.join(jdks, "jdk-21"), { recursive: true });
  const found = await resolveToolchain({ env: {}, home, sdkRoot: toolchain.sdk.root });
  assert.equal(found.ok, true, found.missing?.join("|"));
  assert.equal(found.java.major, 21);
  assert.equal(path.basename(found.java.home), "jdk-21");
  fs.rmSync(path.join(jdks, "jdk-21"), { recursive: true });
  assert.equal((await resolveToolchain({ env: {}, home, sdkRoot: toolchain.sdk.root })).java.major, 25, "sin 21, el 25");
  fs.rmSync(path.join(jdks, "jdk-25"), { recursive: true });
  assert.notEqual((await resolveToolchain({ env: {}, home, sdkRoot: toolchain.sdk.root })).java?.major, 17, "el 17 no se usa");
});

test("un fallo de una herramienta detiene la construcción, dice en qué etapa y deja el registro", { skip: SKIP }, async (t) => {
  const w = workspace(t);
  const dir = w.project();
  // «javac» is replaced by Node, which refuses javac's options: a real tool failure with its own stderr.
  const broken = { ...toolchain, java: { ...toolchain.java, bin: { ...toolchain.java.bin, javac: process.execPath } } };
  const result = await build({ projectDir: dir, dataDir: w.data, name: "Rota", toolchain: broken });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "java");
  assert.equal(result.code, "tool-failed");
  assert.match(result.error, /«java»/);
  assert.match(result.detail, /bad option|-encoding/i, "la salida de la herramienta se conserva");
  assert.ok(fs.existsSync(result.logPath));
  const log = fs.readFileSync(result.logPath, "utf8");
  assert.match(log, /recursos: aapt2 compile/);
  assert.match(log, /FALLO en «java»/);
  assert.ok(!fs.existsSync(path.join(dir, "dist", "android", "build-info.json")), "un fallo no deja un build-info");
  assert.ok(!within(result.logPath, dir), "los intermedios y el registro no ensucian el proyecto");
});

test("una herramienta que se cuelga se corta por tiempo y no queda ningún proceso", async () => {
  const started = Date.now();
  const result = await runTool(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 400 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5000);
  assert.notEqual(result.code, 0);
});

test("se construye un APK real: firmado con la llave del proyecto, con build-info.json y sin secretos", { skip: SKIP }, async (t) => {
  const w = workspace(t);
  const dir = w.project();
  const first = await build({ projectDir: dir, dataDir: w.data, name: "Calculadora de prueba", versionCode: 7, versionName: "2.1" });
  assert.equal(first.ok, true, first.error + "\n" + first.detail);
  assert.equal(path.dirname(first.apk), path.join(fs.realpathSync(dir), "dist", "android"));
  const info = JSON.parse(fs.readFileSync(first.buildInfoPath, "utf8"));
  assert.equal(info.apk.sha256, (await import("../server/androidbuild.mjs")).sha256File(first.apk));
  assert.equal(info.apk.bytes, fs.statSync(first.apk).size);
  assert.deepEqual(info.app, { name: "Calculadora de prueba", packageName: info.app.packageName, versionCode: 7, versionName: "2.1" });
  assert.equal(packageNameProblem(info.app.packageName), null);
  assert.ok(info.app.packageName.startsWith("apps.local.calculadora_de_prueba.p"));
  assert.deepEqual(info.permissions, []);
  assert.equal(info.sdk.minSdk, 26);
  assert.ok(info.sdk.targetSdk >= 26);
  assert.match(info.tools.jdk.version, /^(21|25)\./);
  assert.match(info.tools.jdk.javac, /^javac (21|25)./);
  for (const field of ["aapt2", "d8", "apksigner"]) assert.ok(info.tools[field], `versión de ${field}`);
  assert.equal(info.tools.gradle, null, "sin Gradle");
  assert.deepEqual(info.assets.map((a) => a.path), ["web/app.js", "web/img/logo.svg", "web/index.html", "web/style.css"]);
  assert.match(info.signing.certSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(info).toLowerCase().includes(os.homedir().toLowerCase().replace(/\\/g, "\\\\")), false, "build-info.json no lleva rutas del usuario");
  assert.equal(JSON.stringify(info).toLowerCase().includes(w.base.toLowerCase().replace(/\\/g, "\\\\")), false, "ni rutas temporales");

  // What is inside the package is the manifest, resources, one DEX and the web files — and nothing else.
  const bytes = fs.readFileSync(first.apk);
  const zip = openZip(bytes);
  const names = zip.entries.map((e) => e.name);
  for (const required of ["AndroidManifest.xml", "classes.dex", "resources.arsc", "assets/web/index.html", "assets/web/img/logo.svg"]) assert.ok(names.includes(required), required);
  assert.ok(names.every((n) => !n.includes("\\")), "ningún nombre con barra invertida");
  assert.ok(names.every((n) => /^(?:AndroidManifest\.xml|resources\.arsc|classes\.dex|res\/.+|assets\/web\/.+|META-INF\/[\w.-]+)$/.test(n)), names.join(" "));
  for (const left of [".env", "README", "Abrir.cmd", "node_modules", "package.json", "ui-check", "test/", ".keystore", ".pass"]) assert.ok(!names.some((n) => n.includes(left)), left);
  assert.equal(zip.byName.get("resources.arsc").method, 0, "resources.arsc sin comprimir");
  assert.equal(readEntry(bytes, zip.byName.get("assets/web/app.js")).toString("utf8"), fs.readFileSync(path.join(dir, "app.js"), "utf8"));

  // The signing key lives in Automata's data folder, never in the project, and its password is not in the APK.
  assert.ok(within(first.keyDir, w.data) && !within(first.keyDir, dir));
  const secret = fs.readFileSync(path.join(first.keyDir, "store.pass"), "utf8").trim();
  assert.ok(secret.length >= 24);
  assert.ok(!bytes.includes(secret));
  const stray = [];
  (function scan(folder) { for (const e of fs.readdirSync(folder, { withFileTypes: true })) { const full = path.join(folder, e.name); if (e.isDirectory()) { if (e.name !== "node_modules") scan(full); } else if (/\.(keystore|jks|pass)$/.test(e.name) || fs.readFileSync(full).includes(secret)) stray.push(full); } })(dir);
  assert.deepEqual(stray, [], "nada de llaves ni la contraseña dentro del proyecto");
  assert.ok(!fs.readFileSync(first.logPath, "utf8").includes(secret), "ni en el registro");

  // The project folder only gained dist/android; its own files are untouched.
  assert.deepEqual(fs.readdirSync(path.join(dir, "dist")), ["android"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "dist", "android")).sort(), ["build-info.json", "calculadora-de-prueba.apk"]);

  // Same project, same inputs → the same identity, the same key and the very same bytes.
  const second = await build({ projectDir: dir, dataDir: w.data, name: "Calculadora de prueba", versionCode: 7, versionName: "2.1" });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.buildInfo.app.packageName, info.app.packageName);
  assert.equal(second.buildInfo.signing.certSha256, info.signing.certSha256);
  assert.equal(second.buildInfo.apk.sha256, info.apk.sha256, "construcción reproducible");

  // Another project gets its own package and its own key: apps and data stay apart.
  const other = w.project("otro");
  const third = await build({ projectDir: other, dataDir: w.data, name: "Calculadora de prueba" });
  assert.equal(third.ok, true, third.error);
  assert.notEqual(third.buildInfo.app.packageName, info.app.packageName);
  assert.notEqual(third.buildInfo.signing.certSha256, info.signing.certSha256);
  assert.notEqual(third.keyDir, first.keyDir);
});

test("un permiso aprobado llega al manifiesto y uno no aprobado nunca", { skip: SKIP }, async (t) => {
  const w = workspace(t);
  const dir = w.project();
  const result = await build({ projectDir: dir, dataDir: w.data, name: "Con red", permissions: ["android.permission.INTERNET"] });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.buildInfo.permissions, ["android.permission.INTERNET"]);
  const denied = await build({ projectDir: dir, dataDir: w.data, name: "Con cámara", permissions: ["android.permission.CAMERA"] });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "bad-permissions");
});

test("webProject (ayuda de las pruebas) no depende del orden de creación", (t) => {
  const w = workspace(t);
  const a = w.project("a"), b = path.join(w.base, "b");
  fs.mkdirSync(b);
  webProject(b);
  assert.deepEqual(collectWebAssets(a).files.map((f) => f.sha256), collectWebAssets(b).files.map((f) => f.sha256));
});

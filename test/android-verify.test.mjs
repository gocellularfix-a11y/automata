import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { verifyApk, parseBadging, parseXmlTree, parseSigner, hardeningProblems, PENDING_NOTE } from "../server/androidverify.mjs";
import { openZip, readEntry, ZipError, unsafeEntryName, addToZip, crc32 } from "../server/apkzip.mjs";
import { SKIP, toolchain, makeWorkspace, build } from "./androidfixture.mjs";
import { makeZip } from "./zipmaker.mjs";

const BADGING = `package: name='apps.local.calc.p1a2b3c4d' versionCode='3' versionName='1.2' platformBuildVersionName='16' compileSdkVersion='36'
minSdkVersion:'26'
targetSdkVersion:'36'
uses-permission: name='android.permission.INTERNET'
application-label:'Calc'
launchable-activity: name='apps.local.calc.p1a2b3c4d.MainActivity'  label='' icon=''
`;
const treeText = (appAttrs, extra = "") => `N: android=http://schemas.android.com/apk/res/android (line=2)
  E: manifest (line=2)
    A: package="apps.local.calc.p1a2b3c4d" (Raw: "apps.local.calc.p1a2b3c4d")
      E: uses-sdk (line=3)
        A: http://schemas.android.com/apk/res/android:minSdkVersion(0x0101020c)=26
      E: application (line=4)
${appAttrs}
          E: activity (line=5)
            A: http://schemas.android.com/apk/res/android:name(0x01010003)=".MainActivity" (Raw: ".MainActivity")
            A: http://schemas.android.com/apk/res/android:exported(0x01010010)=true
${extra}`;
const HARD = ["debuggable", "allowBackup", "usesCleartextTraffic"].map((n) => `        A: http://schemas.android.com/apk/res/android:${n}(0x0101000f)=false`).join("\n");

test("se interpretan la salida de aapt2 y de apksigner", () => {
  const badge = parseBadging(BADGING.replace(/\n/g, "\r\n"));
  assert.deepEqual(badge, { package: "apps.local.calc.p1a2b3c4d", versionCode: 3, versionName: "1.2", minSdk: 26, targetSdk: 36, launchables: ["apps.local.calc.p1a2b3c4d.MainActivity"], permissions: ["android.permission.INTERNET"], debuggable: false });
  assert.equal(parseBadging(BADGING + "application-debuggable\n").debuggable, true);
  const tree = parseXmlTree(treeText(HARD));
  assert.deepEqual(tree.map((e) => e.name), ["manifest", "uses-sdk", "application", "activity"]);
  assert.equal(tree[2].attrs["android:debuggable"], "false");
  assert.equal(tree[3].attrs["android:name"], ".MainActivity");
  assert.equal(tree[1].attrs["android:minSdkVersion"], "26");
  const signer = parseSigner("Verifies\nVerified using v1 scheme (JAR signing): false\nVerified using v2 scheme (APK Signature Scheme v2): true\nVerified using v3 scheme (APK Signature Scheme v3): true\nNumber of signers: 1\nSigner #1 certificate SHA-256 digest: " + "ab".repeat(32) + "\nWARNING: algo raro\n");
  assert.deepEqual({ ...signer, certSha256: signer.certSha256.length }, { verifies: true, v1: false, v2: true, v3: true, signers: 1, certSha256: 64, warnings: ["algo raro"] });
  assert.equal(parseSigner("DOES NOT VERIFY\nERROR: JAR_SIG_NO_MANIFEST").verifies, false);
});

test("el endurecimiento del manifiesto detecta depuración, HTTP, copias, componentes de más y elementos ajenos", () => {
  const badge = parseBadging(BADGING);
  assert.deepEqual(hardeningProblems(parseXmlTree(treeText(HARD)), badge), []);
  const problems = (appAttrs, extra, b = badge) => hardeningProblems(parseXmlTree(treeText(appAttrs, extra)), b).join("|");
  assert.match(problems(HARD.replace(/debuggable.*=false/, "debuggable(0x0101000f)=true")), /depurable/);
  assert.match(problems(HARD, "", { ...badge, debuggable: true }), /depurable/);
  assert.match(problems(HARD.replace(/=false\n(?=.*allowBackup)/, "=false\n").split("\n").filter((l) => !/usesCleartext/.test(l)).join("\n")), /HTTP/);
  assert.match(problems(HARD.split("\n").filter((l) => !/allowBackup/.test(l)).join("\n")), /copias/);
  assert.match(problems(HARD, "          E: service (line=9)\n"), /service/);
  assert.match(problems(HARD, "          E: provider (line=9)\n            A: http://schemas.android.com/apk/res/android:exported(0x01010010)=true\n"), /provider.*|2 componentes exportados/);
  assert.match(problems(HARD, "", { ...badge, launchables: [] }), /actividad inicial/);
  assert.match(problems(`${HARD}\n        A: http://schemas.android.com/apk/res/android:networkSecurityConfig(0x01010527)=@0x7f010000`), /configuración de red/);
});

test("el lector de ZIP acepta lo correcto y rechaza lo dañado o peligroso", () => {
  const good = makeZip([{ name: "a.txt", data: "hola" }, { name: "dir/b.txt", data: "x".repeat(500), method: 8 }]);
  const zip = openZip(good);
  assert.deepEqual(zip.entries.map((e) => e.name), ["a.txt", "dir/b.txt"]);
  assert.equal(readEntry(good, zip.byName.get("dir/b.txt")).length, 500);
  const code = (buffer) => { try { openZip(buffer); return "ok"; } catch (error) { assert.ok(error instanceof ZipError, error.message); return error.code; } };
  assert.equal(code(Buffer.from("esto no es un zip, solo texto largo suficiente")), "not-zip");
  assert.equal(code(Buffer.alloc(5)), "too-small");
  assert.equal(code(good.subarray(0, good.length - 7)), "no-eocd", "truncado");
  assert.equal(code(Buffer.concat([good, Buffer.from("basura")])), "no-eocd", "datos añadidos al final");
  assert.equal(code(makeZip([{ name: "../fuera.txt", data: "x" }])), "unsafe-path");
  assert.equal(code(makeZip([{ name: "a/../../fuera.txt", data: "x" }])), "unsafe-path");
  assert.equal(code(makeZip([{ name: "/absoluta.txt", data: "x" }])), "unsafe-path");
  assert.equal(code(makeZip([{ name: "C:/windows.txt", data: "x" }])), "unsafe-path");
  assert.equal(code(makeZip([{ name: "assets\\web\\a.js", data: "x" }])), "unsafe-path");
  assert.equal(code(makeZip([{ name: "a\u0000b", data: "x" }])), "unsafe-path");
  assert.equal(code(makeZip([{ name: "a.txt", data: "1" }, { name: "a.txt", data: "2" }])), "duplicate");
  assert.equal(code(makeZip([{ name: "A.txt", data: "1" }, { name: "a.txt", data: "2" }])), "duplicate");
  assert.equal(code(makeZip([{ name: "a.txt", data: "1", flags: 1 }])), "encrypted");
  assert.equal(code(makeZip([{ name: "a.txt", data: "1", localName: "b.txt" }])), "bad-local");
  const wrongCrc = makeZip([{ name: "a.txt", data: "hola", crc: 123 }]);
  assert.throws(() => readEntry(wrongCrc, openZip(wrongCrc).byName.get("a.txt")), (e) => e.code === "corrupt");
  assert.equal(unsafeEntryName("assets/web/index.html"), null);
  assert.ok(unsafeEntryName("a//b"));
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("addToZip pone las entradas nuevas con «/», fechas fijas y sin tocar las que ya estaban", () => {
  const base = makeZip([{ name: "resources.arsc", data: "ARSC" }]);
  const out = addToZip(base, [{ name: "assets/web/a.js", data: "x".repeat(300) }, { name: "classes.dex", data: "dex" }]);
  assert.deepEqual(openZip(out).entries.map((e) => e.name), ["resources.arsc", "assets/web/a.js", "classes.dex"]);
  assert.equal(openZip(out).byName.get("resources.arsc").method, 0, "lo que ya estaba conserva su método");
  assert.deepEqual(out, addToZip(base, [{ name: "assets/web/a.js", data: "x".repeat(300) }, { name: "classes.dex", data: "dex" }]), "mismos datos, mismos bytes");
  assert.throws(() => addToZip(base, [{ name: "assets\\web\\a.js", data: "x" }]), (e) => e.code === "unsafe-path");
  assert.throws(() => addToZip(base, [{ name: "../x", data: "x" }]), (e) => e.code === "unsafe-path");
  assert.throws(() => addToZip(base, [{ name: "resources.arsc", data: "otra" }]), (e) => e.code === "duplicate");
});

// ---- Real APKs (need a JDK 21/25 and the Android SDK; they are only read and unzipped, never installed) ----

let shared = null;
async function fixture() {
  shared ??= (async () => {
    const w = makeWorkspace("automata-verify-");
    const project = w.project("proyecto");
    const built = await build({ projectDir: project, dataDir: w.data, name: "Verificada" });
    assert.equal(built.ok, true, built.error + built.detail);
    const withNet = await build({ projectDir: w.project("conred"), dataDir: w.data, name: "Con red", permissions: ["android.permission.INTERNET"] });
    assert.equal(withNet.ok, true, withNet.error);
    return { w, project, built, withNet };
  })();
  return shared;
}
test.after(async () => { if (shared) (await shared).w.cleanup(); });

const failed = (report) => report.checks.filter((c) => !c.ok && c.level === "error").map((c) => c.id).sort();
// One verification at a time: each starts a JVM, and the suite already runs many files in parallel.
let queue = Promise.resolve();
const serial = (work) => { const next = queue.then(work, work); queue = next.catch(() => {}); return next; };
const verifyOne = (options) => serial(() => verifyApk(options));
async function verify(f, overrides = {}) {
  const { expected = {}, ...rest } = overrides;
  return verifyOne({ apkPath: f.built.apk, dataDir: f.w.data, projectDir: f.project, toolchain, expected: { permissions: [], webRoot: f.project, ...expected }, ...rest });
}
// A copy of the APK with changes, next to a copy of its build-info.json (the claim stays the original).
function variant(f, name, change, { source = f.built } = {}) {
  const folder = path.join(f.w.base, "variantes", name);
  fs.mkdirSync(folder, { recursive: true });
  fs.copyFileSync(source.buildInfoPath, path.join(folder, "build-info.json"));
  const original = fs.readFileSync(source.apk);
  const zip = openZip(original);
  const entries = zip.entries.map((e) => ({ name: e.name, data: readEntry(original, e), method: e.method }));
  const file = path.join(folder, "app.apk");
  fs.writeFileSync(file, change(entries, original, zip) ?? makeZip(entries));
  return file;
}

test("un APK bueno pasa todas las comprobaciones, pero no se declara funcional", { skip: SKIP }, async () => {
  const f = await fixture();
  const reportPath = path.join(f.w.base, "informe", "verification.json");
  const report = await verify(f, { reportPath });
  assert.equal(report.ok, true, report.errors.join("\n"));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.functional, false);
  assert.equal(report.pending, PENDING_NOTE);
  assert.match(report.pending, /A3/);
  const ids = report.checks.map((c) => c.id);
  for (const id of ["file", "zip", "integrity", "entries", "required", "dex", "arsc", "secrets", "web", "signature", "cert", "key", "package", "sdk", "version", "launcher", "hardening", "permissions", "bridge"]) assert.ok(ids.includes(id), id);
  assert.equal(report.facts.package, f.built.buildInfo.app.packageName);
  assert.equal(report.facts.minSdk, 26);
  assert.deepEqual(report.facts.launcher, [`${f.built.buildInfo.app.packageName}.MainActivity`]);
  assert.equal(report.facts.signature.certSha256, f.built.buildInfo.signing.certSha256);
  assert.equal(report.apk.sha256, f.built.buildInfo.apk.sha256);
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, "utf8")).checks.length, report.checks.length, "el informe queda escrito");
});

test("un paquete dañado, truncado o que no es un APK se rechaza con su razón", { skip: SKIP }, async () => {
  const f = await fixture();
  const flipped = variant(f, "byte-cambiado", (entries, original, zip) => { const copy = Buffer.from(original); const dex = zip.byName.get("classes.dex"); copy[dex.dataOffset + 12] ^= 0xff; return copy; });
  const truncated = variant(f, "truncado", (entries, original) => original.subarray(0, original.length - 40));
  const text = variant(f, "texto", () => Buffer.from("Esto es un texto cualquiera con extensión .apk, lo bastante largo para parecer un archivo."));
  const empty = variant(f, "vacio", () => Buffer.alloc(0));
  const [a, b, c, d, e] = await Promise.all([
    verify(f, { apkPath: flipped }), verify(f, { apkPath: truncated }), verify(f, { apkPath: text }), verify(f, { apkPath: empty }), verify(f, { apkPath: path.join(f.w.base, "no-existe.apk") })
  ]);
  for (const report of [a, b, c, d, e]) { assert.equal(report.ok, false); assert.equal(report.functional, false); }
  assert.ok(failed(a).includes("zip") && failed(a).includes("integrity"), failed(a).join());
  assert.match(a.errors.join("\n"), /CRC|dañado|descomprimir/);
  assert.ok(failed(b).includes("zip") && failed(b).includes("integrity"), failed(b).join());
  assert.match(b.errors.join("\n"), /truncado|datos añadidos|final/);
  assert.ok(failed(c).includes("zip"));
  assert.match(c.errors.join("\n"), /no-zip|PK|not-zip/);
  assert.deepEqual(failed(d), ["file"]);
  assert.match(d.errors.join("\n"), /vacío/);
  assert.deepEqual(failed(e), ["file"]);
  assert.match(e.errors.join("\n"), /no existe/);
});

test("rutas inseguras dentro del paquete: no se acepta y se dice cuál", { skip: SKIP }, async () => {
  const f = await fixture();
  const names = { "sale-de-la-carpeta": "assets/web/../../evil.txt", "absoluta": "/data/evil.txt", "barra-invertida": "assets\\web\\evil.js", "unidad": "C:/evil.txt" };
  const files = Object.entries(names).map(([key, name]) => [key, variant(f, `ruta-${key}`, (entries) => makeZip([...entries, { name, data: "x" }]))]);
  const reports = await Promise.all(files.map(([, apkPath]) => verify(f, { apkPath })));
  reports.forEach((report, i) => {
    assert.equal(report.ok, false, files[i][0]);
    assert.ok(failed(report).includes("zip"), files[i][0]);
    assert.match(report.errors.join("\n"), /unsafe-path|Ruta insegura/, files[i][0]);
  });
});

test("un recurso web cambiado, una entrada de más, una llave o una credencial dentro del APK se detectan", { skip: SKIP }, async () => {
  const f = await fixture();
  const password = fs.readFileSync(path.join(f.built.keyDir, "store.pass"), "utf8").trim();
  const edited = variant(f, "web-cambiada", (entries) => makeZip(entries.map((e) => e.name === "assets/web/app.js" ? { ...e, data: Buffer.from("alert('otro');") } : e)));
  const stray = variant(f, "entradas-de-mas", (entries) => makeZip([...entries, { name: "lib/arm64-v8a/libx.so", data: "ELF" }, { name: "release.keystore", data: "KEYSTORE" }]));
  const leakedKey = variant(f, "clave-filtrada", (entries) => makeZip([...entries, { name: "assets/web/nota.txt", data: `la clave es ${password}` }]));
  const token = variant(f, "credencial", (entries) => makeZip([...entries, { name: "assets/web/config.js", data: 'var k = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";' }]));
  const missing = variant(f, "sin-index", (entries) => makeZip(entries.filter((e) => e.name !== "assets/web/index.html")));
  const [r1, r2, r3, r4, r5] = await Promise.all([edited, stray, leakedKey, token, missing].map((apkPath) => verify(f, { apkPath })));
  assert.deepEqual(["integrity", "signature", "web"].filter((id) => !failed(r1).includes(id)), [], "web cambiada: " + failed(r1).join());
  assert.match(r1.errors.join("\n"), /app\.js es distinto/);
  assert.ok(failed(r2).includes("entries") && failed(r2).includes("secrets"), failed(r2).join());
  assert.match(r2.errors.join("\n"), /libx\.so/);
  assert.match(r2.errors.join("\n"), /release\.keystore/);
  assert.ok(failed(r3).includes("secrets"), failed(r3).join());
  assert.match(r3.errors.join("\n"), /contraseña de la llave/);
  assert.ok(!r3.errors.join("\n").includes(password), "el informe no repite la contraseña");
  assert.ok(failed(r4).includes("secrets") && failed(r4).includes("web"), failed(r4).join());
  assert.doesNotMatch(r4.errors.join("\n"), /sk-ant/);
  assert.ok(failed(r5).includes("required") && failed(r5).includes("web"), failed(r5).join());
});

test("una web que cambió después de construir marca el APK como desactualizado, aunque la firma siga válida", { skip: SKIP }, async () => {
  const f = await fixture();
  const file = path.join(f.project, "style.css");
  const before = fs.readFileSync(file);
  try {
    fs.appendFileSync(file, "p { color: red; }\n");
    const report = await verify(f);
    assert.deepEqual(failed(report), ["web"]);
    assert.match(report.errors.join("\n"), /style\.css es distinto/);
    const added = path.join(f.project, "nuevo.js");
    fs.writeFileSync(added, "1;");
    assert.match((await verify(f)).errors.join("\n"), /sobra|falta/);
    fs.rmSync(added);
  } finally {
    fs.writeFileSync(file, before);
  }
  assert.equal((await verify(f)).ok, true);
});

test("identidad, niveles de SDK, permisos aprobados y referencias se comparan con lo esperado", { skip: SKIP }, async () => {
  const f = await fixture();
  const info = f.built.buildInfo;
  const [wrongPackage, wrongMin, wrongTarget, taken, noPermission, open] = await Promise.all([
    verify(f, { expected: { packageName: "apps.local.otra.p00000000" } }),
    verify(f, { expected: { minSdk: 28 } }),
    verify(f, { expected: { targetSdk: 33 } }),
    verify(f, { expected: { knownPackages: ["apps.local.x.p1", info.app.packageName] } }),
    verifyOne({ apkPath: f.withNet.apk, toolchain, expected: { permissions: [] } }),
    verifyOne({ apkPath: f.withNet.apk, toolchain, expected: { permissions: ["android.permission.INTERNET"] } })
  ]);
  assert.deepEqual(failed(wrongPackage), ["package"]);
  assert.deepEqual(failed(wrongMin), ["sdk"]);
  assert.deepEqual(failed(wrongTarget), ["sdk"]);
  assert.deepEqual(failed(taken), ["package"]);
  assert.match(taken.errors.join("\n"), /ya lo usa otra app/);
  assert.deepEqual(failed(noPermission), ["permissions", "web"].filter((id) => failed(noPermission).includes(id)).length ? failed(noPermission) : ["permissions"]);
  assert.ok(failed(noPermission).includes("permissions"));
  assert.match(noPermission.errors.join("\n"), /Permisos sin aprobar: android\.permission\.INTERNET/);
  assert.equal(open.ok, true, open.errors.join("\n"));
  assert.deepEqual(open.facts.permissions, ["android.permission.INTERNET"]);
  const notGranted = await verifyOne({ apkPath: f.withNet.apk, toolchain, expected: { permissions: ["android.permission.INTERNET", "android.permission.CAMERA"] } });
  assert.ok(failed(notGranted).includes("permissions"));
  assert.match(notGranted.errors.join("\n"), /CAMERA/);
});

test("las referencias falsas o ausentes (hash, certificado, otro APK) se detectan", { skip: SKIP }, async () => {
  const f = await fixture();
  const claim = (name, change) => {
    const folder = path.join(f.w.base, "variantes", name);
    fs.mkdirSync(folder, { recursive: true });
    const copy = path.join(folder, "app.apk");
    fs.copyFileSync(f.built.apk, copy);
    const info = JSON.parse(fs.readFileSync(f.built.buildInfoPath, "utf8"));
    change(info);
    fs.writeFileSync(path.join(folder, "build-info.json"), JSON.stringify(info));
    return copy;
  };
  const badHash = claim("hash", (i) => { i.apk.sha256 = "0".repeat(64); });
  const badCert = claim("cert", (i) => { i.signing.certSha256 = "f".repeat(64); });
  const noInfo = path.join(f.w.base, "variantes", "sin-info");
  fs.mkdirSync(noInfo, { recursive: true });
  fs.copyFileSync(f.built.apk, path.join(noInfo, "app.apk"));
  // Another project's APK presented with this project's build-info.json.
  const swapped = variant(f, "otro-apk", (entries, original) => original, { source: f.withNet });
  fs.copyFileSync(f.built.buildInfoPath, path.join(path.dirname(swapped), "build-info.json"));
  const [h, c, n, s, given] = await Promise.all([
    verify(f, { apkPath: badHash }), verify(f, { apkPath: badCert }), verify(f, { apkPath: path.join(noInfo, "app.apk"), expected: { webRoot: f.project } }), verify(f, { apkPath: swapped }),
    verify(f, { apkPath: path.join(noInfo, "app.apk"), expected: { sha256: f.built.buildInfo.apk.sha256, packageName: f.built.buildInfo.app.packageName, minSdk: 26, targetSdk: f.built.buildInfo.sdk.targetSdk } })
  ]);
  assert.deepEqual(failed(h), ["integrity"]);
  assert.match(h.errors.join("\n"), /Fue modificado|otra construcción/);
  assert.deepEqual(failed(c), ["cert"]);
  assert.ok(failed(n).includes("build-info") && failed(n).includes("integrity"), failed(n).join());
  for (const id of ["integrity", "package", "cert"]) assert.ok(failed(s).includes(id), `otro APK: ${id} en ${failed(s).join()}`);
  assert.equal(given.ok, true, given.errors.join("\n"));
});

test("sin herramientas del SDK no se puede dar nada por verificado", { skip: SKIP }, async () => {
  const f = await fixture();
  const report = await verify(f, { toolchain: { ok: false, missing: ["Android SDK Build-Tools."] } });
  assert.equal(report.ok, false);
  assert.ok(failed(report).includes("tools"));
  assert.match(report.errors.join("\n"), /Build-Tools/);
  assert.ok(!report.checks.some((c) => c.id === "signature"), "no inventa una firma");
});

test("la variante de prueba pasa como prueba y nunca como entrega; la entrega no pasa como prueba", { skip: SKIP }, async () => {
  const f = await fixture();
  const test = await build({ projectDir: f.project, dataDir: f.w.data, name: "Verificada", variant: "test" });
  assert.equal(test.ok, true, test.error);
  const asTest = await verifyOne({ apkPath: test.apk, toolchain, expected: { permissions: [], variant: "test", webRoot: f.project } });
  assert.equal(asTest.ok, true, asTest.errors.join("\n"));
  assert.equal(asTest.variant, "test");
  assert.equal(asTest.deliverable, false, "una variante de prueba nunca es entregable");
  const asRelease = await verifyOne({ apkPath: test.apk, toolchain, expected: { permissions: [], webRoot: f.project } });
  assert.equal(asRelease.ok, false);
  assert.ok(failed(asRelease).includes("hardening") && failed(asRelease).includes("bridge") && failed(asRelease).includes("package"), failed(asRelease).join());
  assert.equal((await verify(f)).deliverable, true);
  const releaseAsTest = await verify(f, { expected: { variant: "test" } });
  assert.equal(releaseAsTest.ok, false);
  assert.ok(failed(releaseAsTest).includes("hardening") && failed(releaseAsTest).includes("package"), failed(releaseAsTest).join());
});

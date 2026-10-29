// Independent check of an APK. It does not trust the builder: it reads the package with its own strict ZIP reader,
// asks the SDK's own tools (apksigner, aapt2) what they see, and compares everything with what Automata approved
// (package, SDK levels, permissions, the verified web files) and with the build-info.json the builder wrote.
//
// A green result means the PACKAGE is what was asked for, intact and signed. It does NOT mean the app works: how
// the page behaves inside a WebView is only known after running it on a device or emulator (milestone A3), and the
// result says so (`functional: false`, `pending`).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { openZip, readEntry, ZipError, adler32 } from "./apkzip.mjs";
import { resolveToolchain, runTool, packageNameProblem, collectWebAssets, sha256File, APPROVABLE_PERMISSIONS, keyIdOf, keyFolder } from "./androidbuild.mjs";
import { TOKEN_PATTERNS, isSensitiveFile } from "./redact.mjs";

export const PENDING_NOTE = "Falta A3: instalar y abrir la app en un teléfono o emulador autorizado y repetir los escenarios web dentro del WebView. Un APK que compila y está firmado no es por eso una app que funciona.";
const MAX_APK_BYTES = 128 * 1024 * 1024;
const ALLOWED_ELEMENTS = new Set(["manifest", "uses-sdk", "uses-permission", "application", "activity", "intent-filter", "action", "category"]);
const ANDROID_NS = "http://schemas.android.com/apk/res/android:";

// ---------- Parsers of the SDK tools' text output (exported for the tests) ----------

export function parseBadging(text) {
  const out = { package: null, versionCode: null, versionName: null, minSdk: null, targetSdk: null, launchables: [], permissions: [], debuggable: false };
  for (const line of String(text).split(/\r?\n/)) {
    let m;
    if ((m = /^package: name='([^']*)' versionCode='([^']*)' versionName='([^']*)'/.exec(line))) Object.assign(out, { package: m[1], versionCode: Number(m[2]), versionName: m[3] });
    else if ((m = /^minSdkVersion:'(\d+)'/.exec(line))) out.minSdk = Number(m[1]);
    else if ((m = /^targetSdkVersion:'(\d+)'/.exec(line))) out.targetSdk = Number(m[1]);
    else if ((m = /^launchable-activity: name='([^']*)'/.exec(line))) out.launchables.push(m[1]);
    else if ((m = /^uses-permission(?:-sdk-23)?: name='([^']*)'/.exec(line))) out.permissions.push(m[1]);
    else if (/^application-debuggable/.test(line)) out.debuggable = true;
  }
  return out;
}
// aapt2 dump xmltree → [{ name, depth, attrs: { "android:name": "value" } }] in document order.
export function parseXmlTree(text) {
  const elements = [];
  for (const line of String(text).split(/\r?\n/)) {
    let m;
    if ((m = /^(\s*)E: (\S+) \(line=\d+\)/.exec(line))) elements.push({ name: m[2], depth: m[1].length, attrs: {} });
    else if (elements.length && (m = /^\s*A: (\S+?)(?:\(0x[0-9a-f]+\))?=(.*)$/.exec(line))) {
      const name = m[1].startsWith(ANDROID_NS) ? "android:" + m[1].slice(ANDROID_NS.length) : m[1];
      let value = m[2].trim();
      const quoted = /^"(.*)" \(Raw: "(.*)"\)$/.exec(value);
      if (quoted) value = quoted[1];
      elements.at(-1).attrs[name] = value;
    }
  }
  return elements;
}
export function parseSigner(text) {
  const flag = (re) => { const m = re.exec(text); return m ? m[1] === "true" : null; };
  return {
    verifies: /^Verifies\s*$/m.test(text),
    v1: flag(/Verified using v1 scheme \(JAR signing\): (true|false)/),
    v2: flag(/Verified using v2 scheme \(APK Signature Scheme v2\): (true|false)/),
    v3: flag(/Verified using v3 scheme \(APK Signature Scheme v3\): (true|false)/),
    signers: Number(/Number of signers: (\d+)/.exec(text)?.[1] ?? 0),
    certSha256: /Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})/i.exec(text)?.[1]?.toLowerCase() ?? null,
    warnings: [...text.matchAll(/^WARNING: (.*)$/gm)].map((m) => m[1].trim())
  };
}

// What is wrong with a compiled manifest (parseXmlTree) and its badging, in plain words; [] when it is hardened.
export function hardeningProblems(tree, badge, { variant = "release" } = {}) {
  const app = tree.find((e) => e.name === "application")?.attrs ?? {};
  const extra = [...new Set(tree.map((e) => e.name).filter((n) => !ALLOWED_ELEMENTS.has(n)))];
  const problems = [];
  const debuggable = badge.debuggable || app["android:debuggable"] === "true";
  if (debuggable && variant !== "test") problems.push("la app es depurable");
  if (!debuggable && variant === "test") problems.push("la variante de prueba debía ser depurable y no lo es");
  if (app["android:usesCleartextTraffic"] !== "false") problems.push("el tráfico HTTP sin cifrar no está desactivado explícitamente");
  if (app["android:allowBackup"] !== "false") problems.push("las copias de seguridad no están desactivadas");
  if (app["android:networkSecurityConfig"] !== undefined) problems.push("trae una configuración de red propia");
  if (extra.length) problems.push(`elementos no permitidos: ${extra.join(", ")}`);
  const exported = tree.filter((e) => e.attrs["android:exported"] === "true").length;
  if (exported !== 1) problems.push(`${exported} componentes exportados (debe haber solo la actividad inicial)`);
  if (!badge.launchables.length) problems.push("no hay actividad inicial");
  return problems;
}

// ---------- The verification ----------

// options: apkPath; buildInfoPath? (default build-info.json next to the APK); dataDir? (Automata's data folder, to
// compare with the project's key and to look for the key's secrets inside the APK); projectDir? (with dataDir/
// projectId: which key belongs to the project); expected: { packageName?, minSdk?, targetSdk?, versionCode?,
// permissions (the APPROVED list; missing = none are approved), webRoot? (folder with the verified web files),
// sha256?, knownPackages? (packages of other projects) }; toolchain?; reportPath?
// Never throws: every problem is a failed check and a line in `errors`.
export async function verifyApk(options) {
  const checks = [];
  const facts = {};
  const check = (id, title, ok, detail, level = "error") => checks.push({ id, title, ok: !!ok, level: ok ? "info" : level, detail: String(detail ?? "") });
  const result = () => {
    const errors = checks.filter((c) => !c.ok && c.level === "error").map((c) => `${c.title}: ${c.detail}`);
    const warnings = checks.filter((c) => !c.ok && c.level === "warning").map((c) => `${c.title}: ${c.detail}`);
    const report = { ok: errors.length === 0, variant, deliverable: errors.length === 0 && variant === "release", verifiedAt: new Date().toISOString(), functional: false, pending: PENDING_NOTE, apk: facts.apk ?? null, facts, checks, errors, warnings };
    if (options.reportPath) try { fs.mkdirSync(path.dirname(options.reportPath), { recursive: true }); fs.writeFileSync(options.reportPath, JSON.stringify(report, null, 2) + "\n"); } catch { /* the report must not hide the result */ }
    return report;
  };
  const expected = options.expected ?? {};
  const approved = expected.permissions ?? [];
  const variant = expected.variant ?? "release";

  // 1. The file exists, is a plain file and is not empty
  let apkPath, buffer;
  try {
    apkPath = path.resolve(String(options.apkPath ?? ""));
    const stat = fs.lstatSync(apkPath);
    if (stat.isSymbolicLink()) throw new Error("es un enlace simbólico");
    if (!stat.isFile()) throw new Error("no es un archivo");
    if (stat.size === 0) throw new Error("está vacío");
    if (stat.size > MAX_APK_BYTES) throw new Error("es demasiado grande");
    buffer = fs.readFileSync(apkPath);
    facts.apk = { path: apkPath, bytes: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex"), modifiedAt: stat.mtime.toISOString() };
    check("file", "APK generado", true, `${path.basename(apkPath)} · ${buffer.length} bytes`);
  } catch (error) {
    check("file", "APK generado", false, `No hay un APK utilizable en ${options.apkPath}: ${error.code === "ENOENT" ? "no existe" : error.message}`);
    return result();
  }

  // build-info.json: what the builder claims. It is a claim, not proof.
  let info = null;
  const infoPath = options.buildInfoPath ?? path.join(path.dirname(apkPath), "build-info.json");
  try {
    info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
    if (info.schema !== 1 || !info.apk?.sha256) throw new Error("formato desconocido");
  } catch (error) {
    info = null;
    check("build-info", "build-info.json", false, `No se puede leer ${path.basename(infoPath)}: ${error.code === "ENOENT" ? "no existe" : error.message}`, expected.sha256 ? "warning" : "error");
  }

  // 2. ZIP structure and every entry's CRC
  let zip = null;
  const data = new Map();
  try {
    // Only a package that reads completely counts as a package; a half-read one would make the other checks invent errors.
    const opened = openZip(buffer);
    for (const entry of opened.entries) data.set(entry.name, readEntry(buffer, entry));
    zip = opened;
    check("zip", "Estructura ZIP", true, `${zip.entries.length} entradas, directorio central y CRC correctos`);
  } catch (error) {
    check("zip", "Estructura ZIP", false, error instanceof ZipError ? `${error.message} [${error.code}]` : `No se puede leer el paquete: ${error.message}`);
  }

  // 3. SHA-256 integrity against the builder's record (or one given by the caller)
  const reference = expected.sha256 ?? info?.apk?.sha256;
  if (!reference) check("integrity", "Integridad SHA-256", false, "No hay un hash de referencia con el que comparar.");
  else check("integrity", "Integridad SHA-256", reference.toLowerCase() === facts.apk.sha256, reference.toLowerCase() === facts.apk.sha256 ? facts.apk.sha256 : `El APK tiene ${facts.apk.sha256} y se esperaba ${reference}. Fue modificado, reemplazado o es de otra construcción.`);
  if (info) {
    const fresh = info.builtAt && facts.apk.modifiedAt >= info.startedAt;
    check("fresh", "APK posterior al inicio de la construcción", fresh, fresh ? facts.apk.modifiedAt : `El archivo (${facts.apk.modifiedAt}) es anterior a la construcción que dice haberlo creado (${info.startedAt}).`, "warning");
  }

  // 4. Tools
  const tc = options.toolchain ?? await resolveToolchain({ targetSdk: expected.targetSdk });
  if (!tc.ok) check("tools", "Herramientas del SDK", false, `No se puede verificar sin: ${tc.missing.join(" ")}`);

  let keyMeta = null, password = null;
  if (zip) {
    // 5. Entries: nothing but what an Automata WebView APK contains, no key material, no secrets
    const allowed = (name) => name === "AndroidManifest.xml" || name === "resources.arsc" || /^classes\d*\.dex$/.test(name) || /^res\/[A-Za-z0-9._\-/]+$/.test(name) || /^assets\/web\/[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(name) || /^META-INF\/(?:MANIFEST\.MF|[A-Za-z0-9_-]+\.(?:SF|RSA|EC|DSA))$/.test(name);
    const stray = zip.entries.filter((e) => !e.directory && !allowed(e.name)).map((e) => e.name);
    check("entries", "Contenido permitido", stray.length === 0, stray.length ? `Entradas que no deberían estar: ${stray.slice(0, 8).join(", ")}${stray.length > 8 ? "…" : ""}` : "solo manifiesto, recursos, DEX, assets/web y firma");
    const required = ["AndroidManifest.xml", "classes.dex", "resources.arsc", "assets/web/index.html"].filter((n) => !zip.byName.has(n));
    check("required", "Archivos imprescindibles", required.length === 0, required.length ? `Faltan: ${required.join(", ")}` : "AndroidManifest.xml, classes.dex, resources.arsc, assets/web/index.html");

    // 6. DEX files
    const dexProblems = [];
    for (const entry of zip.entries.filter((e) => /^classes\d*\.dex$/.test(e.name))) {
      const dex = data.get(entry.name);
      if (!dex || dex.length < 0x70 || !/^dex\n0\d\d\0$/.test(dex.toString("latin1", 0, 8))) { dexProblems.push(`${entry.name}: cabecera DEX inválida`); continue; }
      if (dex.readUInt32LE(32) !== dex.length) dexProblems.push(`${entry.name}: el tamaño de la cabecera no coincide con el archivo`);
      if (dex.readUInt32LE(36) !== 0x70 || dex.readUInt32LE(40) !== 0x12345678) dexProblems.push(`${entry.name}: cabecera o endianness inesperados`);
      if (adler32(dex, 12) !== dex.readUInt32LE(8)) dexProblems.push(`${entry.name}: suma de control Adler-32 incorrecta`);
      if (!crypto.createHash("sha1").update(dex.subarray(32)).digest().equals(dex.subarray(12, 32))) dexProblems.push(`${entry.name}: firma SHA-1 del DEX incorrecta`);
    }
    const dexCount = zip.entries.filter((e) => /^classes\d*\.dex$/.test(e.name)).length;
    check("dex", "Archivos DEX", dexProblems.length === 0 && dexCount > 0, dexProblems.length ? dexProblems.join("; ") : `${dexCount} archivo(s) DEX con cabecera, tamaño y sumas de control correctos`);
    if (dexCount > 1) check("dex-count", "Un solo DEX", false, "Hay más de un DEX; el envoltorio de Automata no lo necesita.", "warning");

    // 7. resources.arsc must be stored and aligned for apps that target Android 11 or later
    const arsc = zip.byName.get("resources.arsc");
    if (arsc) check("arsc", "resources.arsc sin comprimir y alineado", arsc.method === 0 && arsc.dataOffset % 4 === 0, arsc.method === 0 && arsc.dataOffset % 4 === 0 ? "almacenado, alineado a 4 bytes" : "Android 11 o posterior no instala un APK con resources.arsc comprimido o desalineado.");

    // 8. Secrets: key files by name, token shapes in the web files, and the project's own key password anywhere
    const secretNames = zip.entries.filter((e) => isSensitiveFile(e.name) || /(?:\.keystore|\.jks|\.pass|\.p12|\.pfx|\.pem|\.key)$/i.test(e.name)).map((e) => e.name);
    const leaked = [];
    for (const entry of zip.entries.filter((e) => /^assets\//.test(e.name) && /\.(?:html?|css|m?js|json|webmanifest|txt|svg)$/i.test(e.name))) {
      const text = data.get(entry.name)?.toString("utf8") ?? "";
      if (TOKEN_PATTERNS.some((p) => new RegExp(p.source, p.flags.replace("g", "")).test(text))) leaked.push(entry.name);
    }
    if (options.dataDir && (options.projectDir || options.projectId)) {
      try {
        const folder = keyFolder(path.resolve(options.dataDir), keyIdOf(options.projectDir ?? ".", options.projectId ?? null));
        keyMeta = JSON.parse(fs.readFileSync(path.join(folder, "key.json"), "utf8"));
        password = fs.readFileSync(path.join(folder, "store.pass"), "utf8").trim();
      } catch { /* this project has no key yet, or it cannot be read */ }
    }
    if (password && password.length >= 16) {
      if (buffer.includes(password)) secretNames.push("(la contraseña de la llave aparece en el APK)");
      for (const [name, bytes] of data) if (bytes.includes(password)) secretNames.push(`(la contraseña de la llave aparece en ${name})`);
    }
    check("secrets", "Sin secretos ni llaves", secretNames.length === 0 && leaked.length === 0, secretNames.length || leaked.length ? [...secretNames.map((n) => `archivo o dato sensible: ${n}`), ...leaked.map((n) => `${n} parece contener una credencial`)].join("; ") : "ni archivos de llave, ni credenciales en la web, ni la contraseña de la firma");

    // 9. Web resources against the files that passed the web checks
    const actual = new Map();
    for (const entry of zip.entries) if (/^assets\//.test(entry.name) && !entry.directory) actual.set(entry.name.slice(7), crypto.createHash("sha256").update(data.get(entry.name) ?? Buffer.alloc(0)).digest("hex"));
    const compare = (label, wanted) => {
      const problems = [];
      for (const [name, hash] of wanted) {
        if (!actual.has(name)) problems.push(`falta ${name}`);
        else if (actual.get(name) !== hash) problems.push(`${name} es distinto`);
      }
      for (const name of actual.keys()) if (!wanted.has(name)) problems.push(`sobra ${name}`);
      return problems.length ? `${label}: ${problems.slice(0, 8).join(", ")}${problems.length > 8 ? ` (+${problems.length - 8})` : ""}` : null;
    };
    const webProblems = [];
    if (info?.assets) webProblems.push(compare("build-info.json", new Map(info.assets.map((a) => [a.path, a.sha256]))));
    let sourceCount = null;
    if (expected.webRoot) {
      try {
        const source = collectWebAssets(expected.webRoot);
        if (source.problems.length) webProblems.push(`la carpeta web de origen no es válida: ${source.problems.slice(0, 3).join(" ")}`);
        else { sourceCount = source.files.length; webProblems.push(compare("archivos web verificados", new Map(source.files.map((f) => [`web/${f.path}`, f.sha256])))); }
      } catch (error) {
        webProblems.push(`no se puede leer la carpeta web de origen: ${error.message}`);
      }
    }
    if (!info?.assets && !expected.webRoot) webProblems.push("no hay con qué comparar los recursos web (ni build-info.json ni carpeta web verificada)");
    const webIssue = webProblems.filter(Boolean);
    check("web", "Recursos web = archivos verificados", webIssue.length === 0, webIssue.length ? webIssue.join(" | ") : `${actual.size} archivo(s) idénticos${sourceCount !== null ? " a la carpeta verificada" : ""} y a build-info.json`);
    facts.assets = actual.size;
  }

  if (tc.ok) {
    const jenv = { PATH: process.env.PATH ?? process.env.Path ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "", JAVA_HOME: tc.java.home };
    const bt = tc.sdk.buildTools;
    const [badgingRun, xmlRun, signerRun] = await Promise.all([
      zip ? runTool(bt.aapt2, ["dump", "badging", apkPath], { env: jenv, timeoutMs: 60000 }) : null,
      zip ? runTool(bt.aapt2, ["dump", "xmltree", "--file", "AndroidManifest.xml", apkPath], { env: jenv, timeoutMs: 60000 }) : null,
      runTool(tc.java.bin.java, ["-Xmx512m", "-jar", bt.apksignerJar, "verify", "--verbose", "--print-certs", ...info?.sdk?.minSdk || expected.minSdk ? ["--min-sdk-version", String(expected.minSdk ?? info.sdk.minSdk)] : [], apkPath], { env: jenv, timeoutMs: 90000 })
    ]);

    // 10. Signature
    const signer = parseSigner(`${signerRun.stdout}\n${signerRun.stderr}`);
    facts.signature = signer;
    const scheme = signer.v2 || signer.v3;
    check("signature", "Firma (apksigner)", signerRun.code === 0 && signer.verifies && scheme && signer.signers === 1, signerRun.code === 0 && signer.verifies && scheme && signer.signers === 1 ? `válida · v1:${signer.v1} v2:${signer.v2} v3:${signer.v3} · certificado ${signer.certSha256}` : `apksigner no la da por válida (código ${signerRun.code}): ${`${signerRun.stdout}\n${signerRun.stderr}`.split(/\r?\n/).filter(Boolean).slice(0, 4).join(" | ")}`);
    if (signer.warnings.length) check("signature-warnings", "Avisos de apksigner", false, signer.warnings.slice(0, 3).join(" | "), "warning");
    if (signer.certSha256 && info?.signing?.certSha256) check("cert", "Certificado = el de la construcción", signer.certSha256 === info.signing.certSha256, signer.certSha256 === info.signing.certSha256 ? "coincide con build-info.json" : `El APK está firmado con ${signer.certSha256}; build-info.json dice ${info.signing.certSha256}.`);
    if (signer.certSha256 && keyMeta?.certSha256) check("key", "Firmado con la llave del proyecto", signer.certSha256 === keyMeta.certSha256, signer.certSha256 === keyMeta.certSha256 ? "es la llave de desarrollo guardada de este proyecto" : "La firma no es la de la llave guardada de este proyecto.");

    // 11. Identity, SDK levels, launcher
    if (!badgingRun) { /* an unreadable package is already reported by the zip check */ } else if (badgingRun.code !== 0) check("manifest", "Manifiesto legible", false, `aapt2 no puede leer el paquete: ${(badgingRun.stderr || badgingRun.stdout).split(/\r?\n/).filter(Boolean).slice(0, 3).join(" | ")}`);
    else {
      const badge = parseBadging(badgingRun.stdout);
      const tree = parseXmlTree(xmlRun.stdout);
      Object.assign(facts, { package: badge.package, versionCode: badge.versionCode, versionName: badge.versionName, minSdk: badge.minSdk, targetSdk: badge.targetSdk, launcher: badge.launchables, permissions: badge.permissions });
      const wantedPackage = expected.packageName ?? info?.app?.packageName;
      const problem = badge.package ? packageNameProblem(badge.package) ?? (variant === "test" && !badge.package.endsWith(".test") ? "la variante de prueba debe terminar en .test" : variant !== "test" && badge.package.endsWith(".test") ? "un paquete .test no es una entrega" : null) : "no se pudo leer";
      const taken = (expected.knownPackages ?? []).includes(badge.package);
      check("package", "Identificador único del paquete", !problem && !taken && (!wantedPackage || badge.package === wantedPackage), problem ? `Identificador no válido (${problem})` : taken ? `${badge.package} ya lo usa otra app.` : wantedPackage && badge.package !== wantedPackage ? `El APK es ${badge.package} y se esperaba ${wantedPackage}.` : badge.package);
      const wantMin = expected.minSdk ?? info?.sdk?.minSdk, wantTarget = expected.targetSdk ?? info?.sdk?.targetSdk;
      check("sdk", "minSdk y targetSdk", (!wantMin || badge.minSdk === wantMin) && (!wantTarget || badge.targetSdk === wantTarget) && badge.minSdk >= 24 && badge.targetSdk >= badge.minSdk, `minSdk ${badge.minSdk} (se esperaba ${wantMin ?? "—"}), targetSdk ${badge.targetSdk} (se esperaba ${wantTarget ?? "—"})`);
      if (expected.versionCode !== undefined || info?.app?.versionCode !== undefined) {
        const wantCode = expected.versionCode ?? info.app.versionCode;
        check("version", "versionCode", badge.versionCode === wantCode, `APK ${badge.versionCode}, esperado ${wantCode}`);
      }
      const launcher = `${badge.package}.MainActivity`;
      const activities = tree.filter((e) => e.name === "activity");
      const dexBytes = data.get("classes.dex");
      const classLoaded = dexBytes?.includes(Buffer.from(`L${badge.package?.replace(/\./g, "/")}/MainActivity;`));
      check("launcher", "Actividad inicial", badge.launchables.length === 1 && badge.launchables[0] === launcher && activities.length === 1 && !!classLoaded, `${badge.launchables.join(", ") || "ninguna"} · ${activities.length} actividad(es) en el manifiesto · clase ${classLoaded ? "presente" : "AUSENTE"} en el DEX`);

      // 12. Hardening of the manifest
      const hard = xmlRun.code === 0 ? hardeningProblems(tree, badge, { variant }) : ["aapt2 no pudo leer el manifiesto"];
      check("hardening", "Manifiesto endurecido", hard.length === 0, hard.length ? hard.join("; ") : "sin depuración, sin HTTP sin cifrar, sin copias de seguridad, un solo componente exportado, solo elementos conocidos");

      // 13. Permissions asked vs approved
      const asked = [...new Set([...badge.permissions, ...tree.filter((e) => e.name === "uses-permission").map((e) => e.attrs["android:name"]).filter(Boolean)])];
      const notApproved = asked.filter((p) => !approved.includes(p));
      const notAllowed = approved.filter((p) => !APPROVABLE_PERMISSIONS.includes(p));
      check("permissions", "Permisos pedidos = permisos aprobados", notApproved.length === 0 && notAllowed.length === 0, notApproved.length ? `Permisos sin aprobar: ${notApproved.join(", ")}` : notAllowed.length ? `La lista aprobada incluye permisos que Automata no concede: ${notAllowed.join(", ")}` : asked.length ? `solo ${asked.join(", ")}` : "ninguno solicitado, ninguno aprobado");
      const unused = approved.filter((p) => !asked.includes(p));
      if (unused.length) check("permissions-unused", "Permisos aprobados sin pedir", false, unused.join(", "), "warning");
    }

    // 14. The wrapper must not expose Java to the page or open the WebView to remote debugging
    if (zip) {
    const dexAll = Buffer.concat([...data].filter(([n]) => /^classes\d*\.dex$/.test(n)).map(([, b]) => b));
    const banned = ["addJavascriptInterface", ...variant === "test" ? [] : ["setWebContentsDebuggingEnabled"]].filter((word) => dexAll.includes(Buffer.from(word)));
    check("bridge", "Sin puentes JavaScript ni depuración remota", banned.length === 0, banned.length ? `El código usa: ${banned.join(", ")}` : "el DEX no referencia addJavascriptInterface ni setWebContentsDebuggingEnabled");
    }
  }
  return result();
}

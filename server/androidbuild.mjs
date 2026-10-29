// Builds the Android APK of a project whose static web app already passed the web delivery checks. The APK is a
// thin WebView shell: Automata generates the manifest, the resources and the single Activity itself (a project
// never contributes Java), packs the project's web files as assets, and compiles, aligns and signs with the SDK
// tools that are already on this PC (aapt2, javac, d8, zipalign, apksigner). No Gradle, no downloads, nothing
// installed or changed outside the folders it is given: the project's `dist/android` for the result and Automata's
// own data folder for scratch files and the project's signing key.
//
// Nothing here says the app WORKS. A compiled, signed APK only proves the packaging; how the page behaves inside a
// WebView is checked on a device or emulator (milestone A3) and the package is inspected by androidverify.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { detectEnvironment } from "./environment.mjs";
import { directoryProblem } from "./safety.mjs";
import { TOKEN_PATTERNS, isSensitiveFile } from "./redact.mjs";
import { trackChild, releaseChild } from "./procs.mjs";
import { addToZip } from "./apkzip.mjs";

export const GENERATOR = { name: "automata-androidbuild", version: 1 };
// Java 8 bytecode is what Android's d8 reads best. JDK 21 and 25 still accept it (with an «obsolete» warning); the
// first build on a JDK that stops accepting it fails at the «java» stage and says so in the log.
export const JAVA_RELEASE = 8;
// JDK 21 first; 25 only because the same pipeline was checked on it (see ANDROID_A1_A2_REPORT.md).
export const SUPPORTED_JDKS = [21, 25];
export const DEFAULT_MIN_SDK = 26, LOWEST_MIN_SDK = 24, DEFAULT_TARGET_SDK = 36;
export const APP_HOST = "appassets.local";
// The only permissions a project may ask for. Nothing that reaches camera, microphone, contacts, location, files…
export const APPROVABLE_PERMISSIONS = Object.freeze(["android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE", "android.permission.VIBRATE"]);
export const WEB_TYPES = Object.freeze({
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json", webmanifest: "application/manifest+json",
  txt: "text/plain", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", mp4: "video/mp4", webm: "video/webm"
});
const TEXT_EXTENSIONS = new Set(["html", "htm", "css", "js", "mjs", "json", "webmanifest", "txt", "svg"]);
export const WEB_LIMITS = Object.freeze({ maxFiles: 500, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 40 * 1024 * 1024, maxDepth: 8 });
// Folders and files of a project that are never part of its web app.
const SKIPPED_DIRS = new Set(["node_modules", "dist", "android", "build-android", "test", "tests", "__tests__", "coverage", "runs", "artifacts"]);
const SKIPPED_FILES = new Set(["package.json", "package-lock.json", "ui-check.json", "project.local.json", "tsconfig.json", "jsconfig.json", "thumbs.db"]);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const JAVA_KEYWORDS = new Set("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null".split(" "));

// A failure the person can read: which stage, a stable code, a plain message and the tail of the tool's output.
export class AndroidBuildError extends Error {
  constructor(stage, code, message, detail = "") {
    super(message);
    this.name = "AndroidBuildError";
    this.stage = stage;
    this.code = code;
    this.detail = detail;
  }
}

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
export const sha256File = (file) => sha256(fs.readFileSync(file));
const normalized = (p) => { const r = path.resolve(p); return process.platform === "win32" ? r.toLowerCase() : r; };
const within = (child, parent) => { const c = normalized(child), p = normalized(parent); return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep); };
const realOf = (p) => fs.realpathSync.native(p);

// ---------- Validation (pure, no tools needed) ----------

// Why a package name is not acceptable, or null. Automata's own identity and the system namespaces are off limits.
export function packageNameProblem(name) {
  const value = String(name ?? "");
  if (value.length < 5 || value.length > 120) return "El identificador del paquete debe tener entre 5 y 120 caracteres.";
  const parts = value.split(".");
  if (parts.length < 3) return "El identificador del paquete necesita al menos tres partes separadas por puntos (por ejemplo apps.local.mi_app).";
  for (const part of parts) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(part)) return `La parte «${part}» del identificador no es válida: minúsculas, números y guion bajo, empezando por una letra.`;
    if (JAVA_KEYWORDS.has(part)) return `La parte «${part}» del identificador es una palabra reservada de Java.`;
  }
  if (/^(?:android|java|javax|dalvik|kotlin|com\.android|com\.google|com\.samsung)\./.test(value)) return "Ese identificador pertenece al sistema Android o a un fabricante.";
  if (value === "app.automata" || value.startsWith("app.automata.")) return "Ese identificador es el de Automata; cada app necesita el suyo.";
  return null;
}
// A readable, stable identifier for a project: apps.local.<name>.p<8 hex of the key id>.
export function defaultPackageName(name, id) {
  let slug = String(name ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24).replace(/_+$/, "");
  if (!slug || !/^[a-z]/.test(slug)) slug = "app" + slug;
  if (JAVA_KEYWORDS.has(slug)) slug += "_app";
  return `apps.local.${slug}.p${String(id).slice(0, 8)}`;
}
// The name shown under the icon: letters, digits, spaces and a few marks; anything else becomes a space.
export function appLabel(name) {
  const label = String(name ?? "").normalize("NFC").replace(/[^\p{L}\p{N} ._-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 30);
  if (!label || /^[._-]/.test(label)) throw new AndroidBuildError("validar", "bad-name", "La app necesita un nombre con letras o números.");
  return label;
}
export function permissionProblems(list) {
  if (!Array.isArray(list)) return ["Los permisos deben ser una lista."];
  const problems = [];
  for (const permission of list) {
    if (!APPROVABLE_PERMISSIONS.includes(permission)) problems.push(`El permiso «${String(permission).slice(0, 80)}» no está entre los que Automata aprueba (${APPROVABLE_PERMISSIONS.map((p) => p.split(".").pop()).join(", ")}).`);
  }
  if (new Set(list).size !== list.length) problems.push("Hay permisos repetidos.");
  return problems;
}

// The files of the web app that go into the APK, with a reason for each one left out. Only plain, regular files with
// safe names and known web types are packed; symbolic links, hidden files, secrets and oversized files never are.
export function collectWebAssets(webRoot) {
  const root = realOf(webRoot);
  const files = [], skipped = [], problems = [];
  let total = 0;
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { problems.push(`No se puede leer la carpeta ${path.relative(root, dir) || "."}: ${error.code ?? error.message}`); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      const skip = (reason) => skipped.push({ path: rel + (entry.isDirectory() ? "/" : ""), reason });
      if (entry.isSymbolicLink()) { problems.push(`${rel} es un enlace simbólico: no se incluye ni se sigue.`); continue; }
      if (entry.name.startsWith(".")) { skip("oculto"); continue; }
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name.toLowerCase())) { skip("carpeta que no es de la web"); continue; }
        if (depth >= WEB_LIMITS.maxDepth) { problems.push(`${rel} está demasiado profundo (máximo ${WEB_LIMITS.maxDepth} niveles).`); continue; }
        walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) { skip("no es un archivo normal"); continue; }
      if (isSensitiveFile(entry.name)) { skip("archivo sensible"); continue; }
      if (SKIPPED_FILES.has(entry.name.toLowerCase()) || /\.(?:test|spec)\.[a-z]+$/i.test(entry.name)) { skip("archivo de proyecto, no de la web"); continue; }
      const extension = path.extname(entry.name).slice(1).toLowerCase();
      if (!WEB_TYPES[extension]) { skip("tipo de archivo que no se incluye"); continue; }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(entry.name) || WINDOWS_RESERVED.test(entry.name) || rel.length > 200) { problems.push(`El nombre ${JSON.stringify(rel)} no es seguro para la app (letras, números, punto, guion; sin espacios ni comienzos raros).`); continue; }
      const bytes = fs.statSync(abs).size;
      if (bytes > WEB_LIMITS.maxFileBytes) { problems.push(`${rel} pesa demasiado (${bytes} bytes; máximo ${WEB_LIMITS.maxFileBytes}).`); continue; }
      const data = fs.readFileSync(abs);
      if (TEXT_EXTENSIONS.has(extension)) {
        const text = data.toString("utf8");
        if (TOKEN_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text))) { problems.push(`${rel} parece contener una credencial; no se empaqueta.`); continue; }
      }
      total += bytes;
      files.push({ path: rel, abs, bytes, sha256: sha256(data) });
    }
  };
  walk(root, 0);
  const seen = new Map();
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (seen.has(key)) problems.push(`${file.path} y ${seen.get(key)} solo se distinguen por mayúsculas.`);
    seen.set(key, file.path);
  }
  if (files.length > WEB_LIMITS.maxFiles) problems.push(`Hay demasiados archivos web (${files.length}; máximo ${WEB_LIMITS.maxFiles}).`);
  if (total > WEB_LIMITS.maxTotalBytes) problems.push(`La web pesa demasiado (${total} bytes; máximo ${WEB_LIMITS.maxTotalBytes}).`);
  if (!files.some((f) => f.path === "index.html")) problems.push("Falta index.html en la carpeta web.");
  return { root, files, skipped, problems, bytes: total };
}

// ---------- What gets generated ----------

const escapeXml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// The icon color comes from the key id so two apps of one person are told apart on the home screen.
function iconColor(id) {
  const hue = parseInt(String(id).slice(0, 4), 16) % 360;
  const [r, g, b] = [0, 8, 4].map((shift) => { const k = (shift + hue / 30) % 12; return 0.35 - 0.3 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); });
  return "#" + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}
export function manifestSource({ packageName, versionCode, versionName, minSdk, targetSdk, permissions, variant = "release" }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${packageName}" android:versionCode="${versionCode}" android:versionName="${escapeXml(versionName)}">
  <uses-sdk android:minSdkVersion="${minSdk}" android:targetSdkVersion="${targetSdk}" />
${permissions.map((p) => `  <uses-permission android:name="${p}" />\n`).join("")}  <application android:label="@string/app_name" android:icon="@drawable/app_icon" android:theme="@android:style/Theme.Material.Light.NoActionBar" android:debuggable="${variant === "test"}" android:allowBackup="false" android:usesCleartextTraffic="false" android:supportsRtl="true" android:enableOnBackInvokedCallback="false">
    <activity android:name=".MainActivity" android:exported="true" android:configChanges="orientation|screenSize|screenLayout|smallestScreenSize|keyboardHidden|density|uiMode" android:windowSoftInputMode="adjustResize">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
`;
}
const ALLOWED_ELEMENTS = new Set(["manifest", "uses-sdk", "uses-permission", "application", "activity", "intent-filter", "action", "category"]);
// The generated manifest must contain nothing but the elements Automata knows: no services, receivers, providers…
export function manifestProblems(xml, { permissions, variant = "release" }) {
  const problems = [];
  for (const [, name] of xml.matchAll(/<([a-zA-Z][\w-]*)/g)) if (!ALLOWED_ELEMENTS.has(name)) problems.push(`Elemento no permitido en el manifiesto: <${name}>.`);
  const asked = [...xml.matchAll(/<uses-permission android:name="([^"]+)"/g)].map((m) => m[1]);
  if (asked.join("|") !== permissions.join("|")) problems.push("Los permisos del manifiesto no coinciden con los aprobados.");
  if (/usesCleartextTraffic="true"/.test(xml) || variant !== "test" && /debuggable="true"/.test(xml)) problems.push("El manifiesto activa depuración o tráfico HTTP sin cifrar.");
  if (variant === "test" && !/debuggable="true"/.test(xml)) problems.push("La variante de prueba debe ser depurable.");
  return problems;
}
export function stringsSource(label) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <string name="app_name">${escapeXml(label)}</string>\n</resources>\n`;
}
export function iconSource(id) {
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="96dp" android:height="96dp" android:viewportWidth="96" android:viewportHeight="96">
  <path android:fillColor="${iconColor(id)}" android:pathData="M0,0h96v96h-96z" />
  <path android:fillColor="#FFFFFF" android:pathData="M48,48m-26,0a26,26 0 1,0 52,0a26,26 0 1,0 -52,0" />
</vector>
`;
}
// The only Java in the APK. It serves the packed web files over a private https origin, refuses every other
// address (navigation and sub-resources), exposes no Java to the page, and turns the risky WebView switches off.
export function activitySource(packageName, { variant = "release" } = {}) {
  const types = Object.entries(WEB_TYPES).map(([extension, type]) => `        if (path.endsWith(".${extension}")) return "${type}";`).join("\n");
  return `package ${packageName};

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.ConsoleMessage;
import android.webkit.JsResult;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

// Generated by Automata (${GENERATOR.name} v${GENERATOR.version}). Do not edit: the next build overwrites it.
public class MainActivity extends Activity {
    private static final String HOST = "${APP_HOST}";
    private static final String CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
    private WebView web;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
                if (Build.VERSION.SDK_INT >= 30) {
                    Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                    view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                } else {
                    view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
                }
                return insets;
            }
        });
        setContentView(root);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setGeolocationEnabled(false);
${variant === "test" ? "        WebView.setWebContentsDebuggingEnabled(true); // TEST VARIANT ONLY: never in the delivered app\n" : ""}        web.setWebViewClient(new AppClient());
        web.setWebChromeClient(new AppChrome());
        web.loadUrl("https://" + HOST + "/index.html");
    }

    @Override public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    private static boolean isAppUrl(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && HOST.equals(uri.getHost()) && uri.getPort() == -1 && uri.getUserInfo() == null;
    }

    private static String typeOf(String path) {
${types}
        return "application/octet-stream";
    }

    private static WebResourceResponse refuse(int code, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", code, reason, null, new ByteArrayInputStream(new byte[0]));
    }

    private class AppClient extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return !isAppUrl(request.getUrl());
        }

        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!isAppUrl(uri) || !"GET".equals(request.getMethod())) return refuse(403, "Forbidden");
            String path = uri.getPath();
            if (path == null || path.equals("/")) path = "/index.html";
            if (path.contains("..") || path.contains("//") || !path.matches("/[A-Za-z0-9._/-]+")) return refuse(404, "Not Found");
            try {
                InputStream data = getAssets().open("web" + path);
                Map<String, String> headers = new HashMap<String, String>();
                headers.put("Content-Security-Policy", CSP);
                headers.put("X-Content-Type-Options", "nosniff");
                String type = typeOf(path);
                return new WebResourceResponse(type, type.startsWith("text/") || type.endsWith("json") || type.endsWith("svg+xml") ? "UTF-8" : null, 200, "OK", headers, data);
            } catch (IOException missing) {
                return refuse(404, "Not Found");
            }
        }

        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            finish();
            return true;
        }
    }

    private class AppChrome extends WebChromeClient {
        @Override public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
            new AlertDialog.Builder(MainActivity.this).setMessage(message).setCancelable(false).setPositiveButton(android.R.string.ok, new DialogInterface.OnClickListener() {
                @Override public void onClick(DialogInterface dialog, int which) { result.confirm(); }
            }).show();
            return true;
        }

        @Override public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
            new AlertDialog.Builder(MainActivity.this).setMessage(message).setCancelable(false).setPositiveButton(android.R.string.ok, new DialogInterface.OnClickListener() {
                @Override public void onClick(DialogInterface dialog, int which) { result.confirm(); }
            }).setNegativeButton(android.R.string.cancel, new DialogInterface.OnClickListener() {
                @Override public void onClick(DialogInterface dialog, int which) { result.cancel(); }
            }).show();
            return true;
        }

        @Override public boolean onConsoleMessage(ConsoleMessage message) {
            Log.d("AutomataWeb", message.messageLevel() + " " + message.message() + " [" + message.sourceId() + ":" + message.lineNumber() + "]");
            return true;
        }
    }
}
`;
}

// ---------- Tools ----------

// Where the JDK and the SDK are. JDK 21 (also the ones Gradle keeps in ~/.gradle/jdks, only read) before 25.
// Everything is looked up, nothing is installed or changed. `missing` says in plain words what is not there.
export async function resolveToolchain({ env = process.env, home = os.homedir(), javaHome = env.AUTOMATA_ANDROID_JAVA_HOME, sdkRoot = env.AUTOMATA_ANDROID_SDK, targetSdk = DEFAULT_TARGET_SDK, platform = process.platform } = {}) {
  const win = platform === "win32";
  const exe = (n) => (win ? n + ".exe" : n);
  const has = (p) => { try { return fs.existsSync(p); } catch { return false; } };
  const missing = [];
  const info = await detectEnvironment({ env: sdkRoot ? { ...env, ANDROID_HOME: sdkRoot } : env, platform, home, probe: false });

  const candidates = [];
  if (javaHome) candidates.push(javaHome);
  try {
    const jdks = path.join(home, ".gradle", "jdks");
    for (const entry of fs.readdirSync(jdks)) candidates.push(path.join(jdks, entry));
  } catch { /* none */ }
  if (info.tools.java.home) candidates.push(info.tools.java.home);
  if (env.JAVA_HOME) candidates.push(env.JAVA_HOME);
  const jdks = [];
  const seen = new Set();
  for (const dir of candidates) {
    const key = normalized(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!["java", "javac", "keytool"].every((n) => has(path.join(dir, "bin", exe(n))))) continue;
    let release = "";
    try { release = fs.readFileSync(path.join(dir, "release"), "utf8"); } catch { /* no release file */ }
    const version = /JAVA_VERSION="?([\d.]+)/.exec(release)?.[1] ?? null;
    const major = version ? Number(version.split(".")[0]) : 0;
    if (SUPPORTED_JDKS.includes(major)) jdks.push({ explicit: !!javaHome && key === normalized(javaHome), home: dir, version, major, vendor: /IMPLEMENTOR="?([^"\r\n]+)/.exec(release)?.[1] ?? null });
  }
  // A JDK named on purpose (option or AUTOMATA_ANDROID_JAVA_HOME) wins; otherwise 21 before 25.
  jdks.sort((a, b) => Number(b.explicit) - Number(a.explicit) || SUPPORTED_JDKS.indexOf(a.major) - SUPPORTED_JDKS.indexOf(b.major));
  const jdk = jdks[0] ? { home: jdks[0].home, version: jdks[0].version, major: jdks[0].major, vendor: jdks[0].vendor } : null;
  if (!jdk) missing.push(`Un JDK ${SUPPORTED_JDKS.join(" o ")} (con javac y keytool).`);

  const sdk = info.tools.androidSdk;
  let platformInfo = null, buildTools = null;
  if (!sdk.found) missing.push("El Android SDK.");
  else {
    const wanted = path.join(sdk.path, "platforms", `android-${targetSdk}`, "android.jar");
    if (has(wanted)) platformInfo = { api: targetSdk, jar: wanted };
    else if (sdk.platform && has(path.join(sdk.path, "platforms", sdk.platform, "android.jar"))) platformInfo = { api: Number(sdk.platform.slice(8)), jar: path.join(sdk.path, "platforms", sdk.platform, "android.jar") };
    else missing.push("Una plataforma de Android en el SDK (Android SDK Platform).");
    if (!sdk.buildTools) missing.push("Android SDK Build-Tools.");
    else {
      const dir = path.join(sdk.path, "build-tools", sdk.buildTools);
      buildTools = { version: sdk.buildTools, dir, aapt2: path.join(dir, exe("aapt2")), zipalign: path.join(dir, exe("zipalign")), d8Jar: path.join(dir, "lib", "d8.jar"), apksignerJar: path.join(dir, "lib", "apksigner.jar") };
      for (const [name, file] of Object.entries({ aapt2: buildTools.aapt2, zipalign: buildTools.zipalign, d8: buildTools.d8Jar, apksigner: buildTools.apksignerJar })) if (!has(file)) missing.push(`${name} dentro de las Build-Tools ${sdk.buildTools}.`);
    }
  }
  if (missing.length) return { ok: false, missing, java: jdk, sdk: sdk.found ? sdk.path : null };
  const bin = { java: path.join(jdk.home, "bin", exe("java")), javac: path.join(jdk.home, "bin", exe("javac")), keytool: path.join(jdk.home, "bin", exe("keytool")) };
  return { ok: true, missing: [], java: { ...jdk, bin }, sdk: { root: sdk.path, platform: platformInfo, buildTools }, adb: sdk.adb };
}

// The environment a tool gets: the system essentials and JAVA_HOME. No tokens, no JAVA_TOOL_OPTIONS.
function toolEnv(javaHome, base = process.env) {
  const keep = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "ComSpec", "LANG"];
  const out = {};
  for (const key of keep) if (base[key] !== undefined) out[key] = base[key];
  if (javaHome) out.JAVA_HOME = javaHome;
  return out;
}
const MAX_CAPTURE = 1024 * 1024;
// Runs a program (never through a shell) and returns { code, stdout, stderr, timedOut }. Registered with the
// process registry so a crash of Automata does not leave a JVM behind.
export function runTool(file, args, { cwd, timeoutMs = 120000, env, input } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { cwd, env, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: `No se pudo iniciar ${path.basename(file)}: ${error.message}`, timedOut: false });
      return;
    }
    trackChild(child, { command: file });
    let stdout = "", stderr = "", timedOut = false, done = false;
    const add = (current, chunk) => (current.length < MAX_CAPTURE ? current + chunk : current);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout = add(stdout, c); });
    child.stderr.on("data", (c) => { stderr = add(stderr, c); });
    if (input !== undefined) child.stdin.end(input);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      releaseChild(child.pid);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on("error", (error) => { stderr += `\n${error.message}`; finish(-1); });
    child.on("close", (code) => finish(code ?? -1));
  });
}
const javaArgs = (tc, rest) => [tc.java.bin.java, ["-Xmx1g", ...rest]];

// ---------- Signing key (one per project, outside the project) ----------

const keyLocks = new Map();
async function withLock(key, work) {
  while (keyLocks.has(key)) await keyLocks.get(key).catch(() => {});
  const running = (async () => work())();
  keyLocks.set(key, running);
  try { return await running; } finally { keyLocks.delete(key); }
}
export const keyIdOf = (projectDir, projectId = null) => sha256(`automata-android-key:${projectId ?? normalized(realOf(projectDir))}`).slice(0, 16);
export const keyFolder = (dataDir, id) => path.join(dataDir, "android-keys", id);
// Another project already uses this package name: two apps must never share an identity.
function packageOwner(dataDir, packageName, id) {
  const base = path.join(dataDir, "android-keys");
  let folders = [];
  try { folders = fs.readdirSync(base); } catch { return null; }
  for (const folder of folders) {
    if (folder === id) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(base, folder, "key.json"), "utf8"));
      if (meta.packageName === packageName) return folder;
    } catch { /* not a key folder */ }
  }
  return null;
}
// Creates the project's development key the first time and reuses it afterwards (an update only installs over the
// same package when it is signed by the same key). The password is random, lives in a file next to the keystore
// and is handed to the tools as a file, never on a command line or in a log.
async function ensureSigningKey({ dataDir, id, packageName, label, tc, log }) {
  const dir = keyFolder(dataDir, id);
  const store = path.join(dir, "dev.keystore"), pass = path.join(dir, "store.pass"), metaFile = path.join(dir, "key.json");
  return withLock(dir, async () => {
    if (fs.existsSync(store) && fs.existsSync(pass) && fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      return { dir, store, pass, alias: meta.alias, meta, created: false };
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.rmSync(store, { force: true });
    fs.writeFileSync(pass, crypto.randomBytes(24).toString("base64url"), { mode: 0o600 });
    const dname = `CN=${label} (llave de desarrollo de Automata), O=Automata local development, C=XX`;
    const out = await runTool(tc.java.bin.keytool, ["-genkeypair", "-keystore", store, "-storetype", "PKCS12", "-alias", "dev", "-keyalg", "RSA", "-keysize", "2048", "-validity", "9125", "-storepass:file", pass, "-dname", dname, "-noprompt"], { env: toolEnv(tc.java.home), timeoutMs: 60000 });
    log("keytool -genkeypair (llave de desarrollo nueva; la contraseña va en un archivo, no se muestra)", out);
    if (out.code !== 0 || !fs.existsSync(store)) throw new AndroidBuildError("llave", "key-failed", "No se pudo crear la llave de firma de desarrollo de este proyecto.", out.stderr || out.stdout);
    const meta = { schema: 1, alias: "dev", packageName, createdAt: new Date().toISOString(), certSha256: null, note: "Llave SOLO para desarrollo de este proyecto. No sirve para publicar y no debe copiarse al proyecto." };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), { mode: 0o600 });
    return { dir, store, pass, alias: "dev", meta, created: true };
  });
}

// ---------- The build ----------

const slugFile = (label) => label.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";
const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.\d+Z$/, "");
const writeFileAtomic = (file, content) => { const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, content); fs.renameSync(temp, file); };

// options: projectDir (the authorized project), dataDir (Automata's data folder), name, packageName?, projectId?,
// versionCode?, versionName?, webRoot? (relative to the project, default the project folder), outDir? (inside the
// project, default dist/android), permissions? (approved list, default none), minSdk?, targetSdk?, toolchain?, env?.
// Never throws for an expected failure: { ok:false, stage, code, error, detail, logPath }.
export async function buildAndroid(options) {
  const startedAt = new Date();
  let workDir = null, logPath = null;
  const lines = [];
  const log = (title, result) => {
    const body = result ? `\n  código: ${result.code}${result.timedOut ? " (se agotó el tiempo)" : ""}\n${[result.stdout, result.stderr].filter(Boolean).join("\n").split(/\r?\n/).filter(Boolean).slice(-60).map((l) => "  | " + l).join("\n")}` : "";
    const entry = `[${new Date().toISOString()}] ${title}${body}\n`;
    lines.push(entry);
    if (logPath) try { fs.appendFileSync(logPath, entry); } catch { /* the log must not stop the build */ }
  };
  try {
    return await build(options, { startedAt, log, setWork: (dir) => { workDir = dir; logPath = path.join(dir, "build.log"); fs.writeFileSync(logPath, lines.join("")); } });
  } catch (error) {
    if (!(error instanceof AndroidBuildError)) error = new AndroidBuildError("interno", "unexpected", `Error inesperado al construir: ${error.message}`, error.stack ?? "");
    log(`FALLO en «${error.stage}» (${error.code}): ${error.message}\n${error.detail}`);
    return { ok: false, stage: error.stage, code: error.code, error: error.message, detail: String(error.detail).split(/\r?\n/).filter(Boolean).slice(-25).join("\n"), logPath, workDir };
  }
}

async function build(options, { startedAt, log, setWork }) {
  const { projectDir, dataDir, name, projectId = null, versionCode = 1, versionName = "1.0", webRoot = ".", permissions = [], keep = 5, variant = "release" } = options;
  if (variant !== "release" && variant !== "test") throw new AndroidBuildError("validar", "bad-variant", "La variante debe ser release o test.");
  const env = options.env ?? process.env;
  // --- 1. Inputs
  if (!projectDir || !dataDir) throw new AndroidBuildError("validar", "missing-input", "Faltan la carpeta del proyecto o la de datos de Automata.");
  let project, data;
  try { project = realOf(projectDir); } catch { throw new AndroidBuildError("validar", "no-project", "La carpeta del proyecto no existe."); }
  fs.mkdirSync(dataDir, { recursive: true });
  data = realOf(dataDir);
  if (!fs.statSync(project).isDirectory()) throw new AndroidBuildError("validar", "no-project", "La ruta del proyecto no es una carpeta.");
  const folderProblem = directoryProblem(project, { dataDir: data });
  if (folderProblem) throw new AndroidBuildError("validar", "project-folder", folderProblem);
  if (within(data, project)) throw new AndroidBuildError("validar", "data-in-project", "La carpeta de datos (llaves y archivos temporales) no puede estar dentro del proyecto.");
  const label = appLabel(name);
  const id = keyIdOf(project, projectId);
  const basePackage = options.packageName ?? defaultPackageName(label, id);
  const packageName = variant === "test" ? basePackage + ".test" : basePackage;
  const packageProblem = packageNameProblem(packageName);
  if (packageProblem) throw new AndroidBuildError("validar", "bad-package", packageProblem);
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) throw new AndroidBuildError("validar", "bad-version", "versionCode debe ser un entero entre 1 y 2 100 000 000.");
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,29}$/.test(String(versionName))) throw new AndroidBuildError("validar", "bad-version", "versionName solo admite letras, números, punto, guion y guion bajo (máximo 30).");
  const permissionIssues = permissionProblems(permissions);
  if (permissionIssues.length) throw new AndroidBuildError("validar", "bad-permissions", permissionIssues.join(" "));
  const target = options.targetSdk ?? DEFAULT_TARGET_SDK;
  const minSdk = options.minSdk ?? DEFAULT_MIN_SDK;
  if (!Number.isInteger(minSdk) || minSdk < LOWEST_MIN_SDK || minSdk > target) throw new AndroidBuildError("validar", "bad-sdk", `minSdk debe estar entre ${LOWEST_MIN_SDK} y ${target}.`);
  const owner = variant === "test" ? null : packageOwner(data, packageName, id);
  if (owner) throw new AndroidBuildError("validar", "package-taken", `El identificador ${packageName} ya lo usa otro proyecto de Automata.`);

  const webAbs = path.resolve(project, webRoot);
  if (!within(webAbs, project)) throw new AndroidBuildError("validar", "web-outside", "La carpeta web debe estar dentro del proyecto.");
  if (!fs.existsSync(webAbs) || !fs.statSync(webAbs).isDirectory()) throw new AndroidBuildError("validar", "no-web", "No existe la carpeta web del proyecto.");
  if (!within(realOf(webAbs), project)) throw new AndroidBuildError("validar", "web-outside", "La carpeta web apunta fuera del proyecto.");
  const outAbs = path.resolve(project, options.outDir ?? path.join("dist", "android"), variant === "test" ? "test" : ".");
  if (!within(outAbs, project) || normalized(outAbs) === normalized(project)) throw new AndroidBuildError("validar", "out-outside", "El APK debe quedar en una subcarpeta del proyecto (por ejemplo dist/android).");
  const web = collectWebAssets(webAbs);
  if (web.problems.length) throw new AndroidBuildError("validar", "bad-web", `La web del proyecto no se puede empaquetar:\n- ${web.problems.slice(0, 12).join("\n- ")}`);

  // --- 2. Tools
  const tc = options.toolchain ?? await resolveToolchain({ env, targetSdk: target });
  if (!tc.ok) throw new AndroidBuildError("herramientas", "toolchain-missing", `Faltan herramientas para crear el APK: ${tc.missing.join(" ")}`);
  const bt = tc.sdk.buildTools, jenv = toolEnv(tc.java.home, env);

  // --- 3. Scratch folder (outside the project) and the generated sources
  const work = path.join(data, "android-builds", id, stamp(startedAt) + "-" + crypto.randomBytes(2).toString("hex"));
  fs.mkdirSync(work, { recursive: true });
  setWork(work);
  log(`Construcción de «${label}» (${packageName}) con JDK ${tc.java.version}, Build-Tools ${bt.version}, plataforma android-${tc.sdk.platform.api}`);
  const dirs = Object.fromEntries(["src", "classes", "dex", "res", "assets"].map((d) => [d, path.join(work, d)]));
  const javaDir = path.join(dirs.src, ...packageName.split("."));
  fs.mkdirSync(javaDir, { recursive: true });
  fs.mkdirSync(path.join(dirs.res, "values"), { recursive: true });
  fs.mkdirSync(path.join(dirs.res, "drawable"), { recursive: true });
  fs.mkdirSync(dirs.classes, { recursive: true });
  fs.mkdirSync(dirs.dex, { recursive: true });
  const manifestXml = manifestSource({ packageName, versionCode, versionName, minSdk, targetSdk: target, permissions, variant });
  const manifestIssues = manifestProblems(manifestXml, { permissions, variant });
  if (manifestIssues.length) throw new AndroidBuildError("validar", "bad-manifest", manifestIssues.join(" "));
  const manifestFile = path.join(work, "AndroidManifest.xml");
  const activityCode = activitySource(packageName, { variant });
  fs.writeFileSync(manifestFile, manifestXml);
  fs.writeFileSync(path.join(javaDir, "MainActivity.java"), activityCode);
  fs.writeFileSync(path.join(dirs.res, "values", "strings.xml"), stringsSource(variant === "test" ? `${label.slice(0, 20)} (prueba)` : label));
  fs.writeFileSync(path.join(dirs.res, "drawable", "app_icon.xml"), iconSource(id));
  for (const file of web.files) {
    const dest = path.join(dirs.assets, "web", ...file.path.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file.abs, dest);
    if (sha256File(dest) !== file.sha256) throw new AndroidBuildError("recursos", "web-changed", `${file.path} cambió mientras se copiaba.`);
  }

  const signing = await ensureSigningKey({ dataDir: data, id, packageName, label, tc, log });
  if (variant !== "test" && signing.meta.packageName !== packageName) {
    signing.meta.packageName = packageName;
    fs.writeFileSync(path.join(signing.dir, "key.json"), JSON.stringify(signing.meta, null, 2), { mode: 0o600 });
  }

  // --- 4. The tool chain, stage by stage; every non-zero exit stops the build with the tool's own words
  const step = async (stage, title, file, args, extra = {}) => {
    const result = await runTool(file, args, { cwd: work, env: jenv, timeoutMs: 180000, ...extra });
    log(`${stage}: ${title}`, result);
    if (result.code !== 0 || result.timedOut) throw new AndroidBuildError(stage, result.timedOut ? "timeout" : "tool-failed", `La etapa «${stage}» falló${result.timedOut ? " (se agotó el tiempo)" : ` (código ${result.code})`}.`, result.stderr || result.stdout);
    return result;
  };
  const compiledRes = path.join(work, "resources.zip"), unsigned = path.join(work, "unsigned.apk"), aligned = path.join(work, "aligned.apk"), signed = path.join(work, "signed.apk");
  await step("recursos", "aapt2 compile", bt.aapt2, ["compile", "--dir", dirs.res, "-o", compiledRes]);
  await step("enlazar", "aapt2 link", bt.aapt2, ["link", "-o", unsigned, "-I", tc.sdk.platform.jar, "--manifest", manifestFile, compiledRes]);
  const javaFile = path.join(javaDir, "MainActivity.java");
  await step("java", `javac --release ${JAVA_RELEASE}`, tc.java.bin.javac, ["-encoding", "UTF-8", "--release", String(JAVA_RELEASE), "-Xlint:-options", "-classpath", tc.sdk.platform.jar, "-d", dirs.classes, javaFile]);
  const classFiles = [];
  (function collect(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? collect(path.join(dir, e.name)) : e.name.endsWith(".class") && classFiles.push(path.join(dir, e.name)); })(dirs.classes);
  if (!classFiles.length) throw new AndroidBuildError("java", "no-classes", "javac no produjo ninguna clase.");
  const [jv, jbase] = javaArgs(tc, ["-cp", bt.d8Jar, "com.android.tools.r8.D8", "--lib", tc.sdk.platform.jar, "--min-api", String(minSdk), "--output", dirs.dex, ...classFiles]);
  await step("dex", "d8", jv, jbase);
  if (!fs.existsSync(path.join(dirs.dex, "classes.dex"))) throw new AndroidBuildError("dex", "no-dex", "d8 no produjo classes.dex.");
  // The DEX and the web files are added here, not by aapt2: on Windows it writes asset names with a backslash.
  const packed = path.join(work, "packed.apk");
  const additions = [{ name: "classes.dex", data: fs.readFileSync(path.join(dirs.dex, "classes.dex")) }, ...web.files.map((f) => ({ name: `assets/web/${f.path}`, data: fs.readFileSync(path.join(dirs.assets, "web", ...f.path.split("/"))) }))];
  try {
    fs.writeFileSync(packed, addToZip(fs.readFileSync(unsigned), additions));
    log(`empaquetar: classes.dex y ${web.files.length} archivos web añadidos al APK`);
  } catch (error) {
    throw new AndroidBuildError("empaquetar", "pack-failed", `No se pudo ensamblar el APK: ${error.message}`);
  }
  await step("alinear", "zipalign", bt.zipalign, ["-p", "-f", "4", packed, aligned]);
  await step("alinear", "zipalign -c", bt.zipalign, ["-c", "-p", "4", aligned]);
  const [sv, sbase] = javaArgs(tc, ["-jar", bt.apksignerJar, "sign", "--ks", signing.store, "--ks-key-alias", signing.alias, "--ks-pass", `file:${signing.pass}`, "--min-sdk-version", String(minSdk), "--out", signed, aligned]);
  await step("firmar", "apksigner sign", sv, sbase);
  const [vv, vbase] = javaArgs(tc, ["-jar", bt.apksignerJar, "verify", "--verbose", "--print-certs", "--min-sdk-version", String(minSdk), signed]);
  const verified = await step("firmar", "apksigner verify", vv, vbase);
  const certSha256 = /certificate SHA-256 digest: ([0-9a-f]{64})/i.exec(verified.stdout)?.[1]?.toLowerCase() ?? null;
  if (!certSha256) throw new AndroidBuildError("firmar", "no-cert", "apksigner no informó el certificado de la firma.", verified.stdout);
  if (!signing.meta.certSha256) {
    signing.meta.certSha256 = certSha256;
    fs.writeFileSync(path.join(signing.dir, "key.json"), JSON.stringify(signing.meta, null, 2), { mode: 0o600 });
  } else if (signing.meta.certSha256 !== certSha256) throw new AndroidBuildError("firmar", "key-changed", "El certificado de la firma no es el de la llave guardada de este proyecto.");

  // --- 5. Result: the APK, build-info.json, and the versions of every tool that touched it
  const versionLine = (r) => `${r.stdout}\n${r.stderr}`.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
  const [aapt2v, javacv, d8v, signerv] = await Promise.all([
    runTool(bt.aapt2, ["version"], { env: jenv, timeoutMs: 20000 }),
    runTool(tc.java.bin.javac, ["-version"], { env: jenv, timeoutMs: 20000 }),
    runTool(...javaArgs(tc, ["-cp", bt.d8Jar, "com.android.tools.r8.D8", "--version"]), { env: jenv, timeoutMs: 30000 }),
    runTool(...javaArgs(tc, ["-jar", bt.apksignerJar, "--version"]), { env: jenv, timeoutMs: 30000 })
  ]);
  fs.mkdirSync(outAbs, { recursive: true });
  if (!within(realOf(outAbs), project)) throw new AndroidBuildError("publicar", "out-outside", "La carpeta de salida apunta fuera del proyecto.");
  const apkName = `${slugFile(label)}${variant === "test" ? "-test" : ""}.apk`;
  const apkOut = path.join(outAbs, apkName);
  writeFileAtomic(apkOut, fs.readFileSync(signed));
  const apkBytes = fs.statSync(apkOut).size;
  const apkHash = sha256File(apkOut);
  const dexHash = sha256File(path.join(dirs.dex, "classes.dex"));
  const info = {
    schema: 1,
    variant,
    deliverable: variant === "release",
    generator: { ...GENERATOR, activitySha256: sha256(activityCode), manifestSha256: sha256(manifestXml) },
    startedAt: startedAt.toISOString(),
    builtAt: new Date().toISOString(),
    app: { name: label, packageName, versionCode, versionName },
    apk: { file: apkName, bytes: apkBytes, sha256: apkHash },
    sdk: { minSdk, targetSdk: target, compileSdk: tc.sdk.platform.api, buildTools: bt.version },
    permissions: [...permissions],
    tools: { jdk: { version: tc.java.version, major: tc.java.major, vendor: tc.java.vendor, javaRelease: JAVA_RELEASE, javac: versionLine(javacv) }, aapt2: versionLine(aapt2v), d8: versionLine(d8v), apksigner: versionLine(signerv), zipalign: `Build-Tools ${bt.version}`, gradle: null },
    signing: { kind: "desarrollo del proyecto", certSha256, scheme: "APK Signature Scheme v2/v3", note: "Llave propia del proyecto, fuera de su carpeta. Solo para desarrollo; no sirve para publicar." },
    dex: { file: "classes.dex", sha256: dexHash },
    web: { root: path.relative(project, web.root).split(path.sep).join("/") || ".", files: web.files.length, bytes: web.bytes },
    assets: web.files.map((f) => ({ path: `web/${f.path}`, bytes: f.bytes, sha256: f.sha256 })),
    skipped: web.skipped
  };
  const infoPath = path.join(outAbs, "build-info.json");
  writeFileAtomic(infoPath, JSON.stringify(info, null, 2) + "\n");
  log(`Listo: ${apkOut} (${apkBytes} bytes, sha256 ${apkHash})`);

  // Old scratch folders go; the last few stay for the log of a failed or surprising build.
  try {
    const base = path.join(data, "android-builds", id);
    const old = fs.readdirSync(base).sort().slice(0, -keep);
    for (const folder of old) fs.rmSync(path.join(base, folder), { recursive: true, force: true, maxRetries: 3 });
  } catch { /* cleanup is best-effort */ }
  return { ok: true, apk: apkOut, buildInfo: info, buildInfoPath: infoPath, logPath: path.join(work, "build.log"), workDir: work, keyDir: signing.dir, toolchain: tc };
}

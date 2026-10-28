// Builds (and optionally verifies) the Android APK of a project from the command line. It installs nothing on any
// device. Usage:
//   node scripts/android-build.mjs --project <folder> --data <folder> --name "My app" [--web <subfolder>] [--package a.b.c]
//        [--permission android.permission.INTERNET] [--version-code 1] [--version-name 1.0] [--no-verify]
import path from "node:path";
import { buildAndroid } from "../server/androidbuild.mjs";
import { verifyApk } from "../server/androidverify.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const at = args.indexOf("--" + name); return at >= 0 ? args[at + 1] : undefined; };
const all = (name) => args.flatMap((a, i) => (a === "--" + name ? [args[i + 1]] : []));
const project = flag("project"), data = flag("data"), name = flag("name");
if (!project || !data || !name) {
  console.error("Uso: node scripts/android-build.mjs --project <carpeta> --data <carpeta de datos> --name <nombre> [--web <subcarpeta>] [--package a.b.c] [--permission P]... [--no-verify]");
  process.exit(2);
}
const permissions = all("permission");
const built = await buildAndroid({ projectDir: path.resolve(project), dataDir: path.resolve(data), name, webRoot: flag("web") ?? ".", packageName: flag("package"), permissions, versionCode: Number(flag("version-code") ?? 1), versionName: flag("version-name") ?? "1.0" });
if (!built.ok) {
  console.error(`FALLO en «${built.stage}» (${built.code}): ${built.error}\n${built.detail}\nRegistro: ${built.logPath}`);
  process.exit(1);
}
console.log(`APK: ${built.apk}\nSHA-256: ${built.buildInfo.apk.sha256}\nPaquete: ${built.buildInfo.app.packageName}\nRegistro: ${built.logPath}`);
if (!args.includes("--no-verify")) {
  const report = await verifyApk({ apkPath: built.apk, dataDir: path.resolve(data), projectDir: path.resolve(project), expected: { permissions, webRoot: path.resolve(project, flag("web") ?? ".") }, toolchain: built.toolchain, reportPath: path.join(path.dirname(built.apk), "verification.json") });
  for (const c of report.checks) console.log(`${c.ok ? "ok   " : c.level === "warning" ? "aviso" : "FALLA"} ${c.id}: ${c.detail}`);
  console.log(report.ok ? "Verificación estática: correcta. Funcionalidad en WebView: SIN COMPROBAR (hito A3)." : `Verificación estática: FALLÓ\n- ${report.errors.join("\n- ")}`);
  process.exit(report.ok ? 0 : 1);
}

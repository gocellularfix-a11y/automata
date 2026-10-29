// Builds dist/Automata-Setup-<version>.exe: a self-extracting installer made with the tools Windows already has (tar and
// IExpress). It adds no dependency and installs nothing here. It packs dist/Automata-Windows (run `npm run build:windows`
// first). The installer is NOT code-signed: Windows SmartScreen may warn the first time it runs.
//   node scripts/build-installer.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const app = path.join(root, "dist", "Automata-Windows");
if (process.platform !== "win32") throw new Error("El instalador solo se construye en Windows.");
if (!fs.existsSync(path.join(app, "Automata.exe"))) throw new Error("Falta dist/Automata-Windows: ejecuta primero `npm run build:windows`.");
const builtVersion = JSON.parse(fs.readFileSync(path.join(app, "resources", "app", "package.json"), "utf8")).version;
if (builtVersion !== pkg.version) throw new Error(`La app construida es ${builtVersion} y el proyecto ${pkg.version}: ejecuta \`npm run build:windows -- --refresh\`.`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "automata-installer-"));
const output = path.join(root, "dist", `Automata-Setup-${pkg.version}.exe`);
try {
  // 1. The payload: the app as one zip (IExpress flattens folders), the install/uninstall scripts and a PNG-in-ICO icon.
  const tar = path.join(process.env.SystemRoot, "System32", "tar.exe");
  execFileSync(tar, ["-a", "-cf", path.join(work, "app.zip"), "-C", path.join(root, "dist"), "Automata-Windows"], { stdio: "inherit" });
  // Windows PowerShell 5.1 reads a script without a BOM as ANSI and garbles the accents in its messages.
  for (const file of ["install.ps1", "uninstall.ps1"]) fs.writeFileSync(path.join(work, file), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(fs.readFileSync(path.join(root, "scripts", "installer", file), "utf8").replace(/^﻿/, ""), "utf8")]));
  fs.writeFileSync(path.join(work, "version.txt"), pkg.version);
  fs.writeFileSync(path.join(work, "install.cmd"), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0install.ps1"\r\nexit /b %ERRORLEVEL%\r\n');
  const png = fs.readFileSync(path.join(root, "public", "icon-512.png"));
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);       // icon, one image
  header.writeUInt8(0, 6); header.writeUInt8(0, 7);              // 0 = 256 px
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);     // planes, bits per pixel
  header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
  fs.writeFileSync(path.join(work, "Automata.ico"), Buffer.concat([header, png]));

  // 2. The IExpress recipe (plain ASCII: the file is read with the system code page).
  const files = ["install.cmd", "install.ps1", "uninstall.ps1", "version.txt", "Automata.ico", "app.zip"];
  const sed = [
    "[Version]", "Class=IEXPRESS", "SEDVersion=3",
    "[Options]", "PackagePurpose=InstallApp", "ShowInstallProgramWindow=0", "HideExtractAnimation=0", "UseLongFileName=1", "InsertLicense=0", "CAB_FixedSize=0", "CAB_ResvCodeSigning=0", "RebootMode=N",
    "InstallPrompt=%InstallPrompt%", "DisplayLicense=%DisplayLicense%", "FinishMessage=%FinishMessage%", "TargetName=%TargetName%", "FriendlyName=%FriendlyName%",
    "AppLaunched=%AppLaunched%", "PostInstallCmd=%PostInstallCmd%", "AdminQuietInstCmd=%AdminQuietInstCmd%", "UserQuietInstCmd=%UserQuietInstCmd%", "SourceFiles=SourceFiles",
    "[Strings]",
    `InstallPrompt=Instalar Automata ${pkg.version} para tu usuario de Windows? No necesita permisos de administrador y no toca tus proyectos.`,
    "DisplayLicense=", "FinishMessage=", `TargetName=${output}`, `FriendlyName=Instalador de Automata ${pkg.version}`,
    "AppLaunched=cmd /c .\\install.cmd", "PostInstallCmd=<None>", "AdminQuietInstCmd=cmd /c .\\install.cmd", "UserQuietInstCmd=cmd /c .\\install.cmd",
    ...files.map((f, i) => `FILE${i}="${f}"`),
    "[SourceFiles]", `SourceFiles0=${work}\\`,
    "[SourceFiles0]", ...files.map((_, i) => `%FILE${i}%=`)
  ].join("\r\n") + "\r\n";
  const sedFile = path.join(work, "automata.sed");
  fs.writeFileSync(sedFile, sed, "latin1");

  // 3. Build. IExpress is quiet and returns before the file is complete on some systems, so wait for it.
  fs.rmSync(output, { force: true });
  execFileSync(path.join(process.env.SystemRoot, "System32", "iexpress.exe"), ["/N", "/Q", sedFile], { stdio: "inherit", windowsHide: true });
  const started = Date.now();
  let size = -1, same = 0;
  while (Date.now() - started < 600000) {
    const now = fs.existsSync(output) ? fs.statSync(output).size : 0;
    if (now > 0 && now === size && ++same >= 3) break;
    if (now !== size) same = 0;
    size = now;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!fs.existsSync(output) || fs.statSync(output).size < 1024 * 1024) throw new Error("IExpress no generó el instalador.");
  console.log(`Instalador: ${output} (${(fs.statSync(output).size / 1048576).toFixed(1)} MB)`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

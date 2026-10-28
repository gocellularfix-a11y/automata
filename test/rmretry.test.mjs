// The mechanism behind the intermittent «EPERM» of the server test: a folder that is the working directory of a process
// cannot be removed until that process is gone. Shown with a real process, and the retry that waits for it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { removeFolder } from "./rmretry.mjs";

test("una carpeta que es el directorio de trabajo de un proceso vivo no se puede borrar; con reintentos se borra cuando el proceso termina", { skip: process.platform !== "win32" && "el bloqueo por directorio de trabajo es de Windows" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-rmretry-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1200)"], { cwd: dir, stdio: "ignore", windowsHide: true });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => fs.rmSync(dir, { recursive: true, force: true }), (error) => /^(?:EPERM|EBUSY)$/.test(error.code), "mientras el proceso vive, el borrado simple falla");
  const slow = Date.now();
  // The remover blocks this thread while it waits, so the child's exit is observed afterwards.
  const attempts = removeFolder(dir, { attempts: 60, delayMs: 100 });
  await exited;
  assert.ok(attempts > 1 && !fs.existsSync(dir), `se borró tras ${attempts} intentos (${Date.now() - slow} ms)`);
});

test("un error que no es de bloqueo no se reintenta", () => {
  assert.throws(() => removeFolder("\0no-valida"), (error) => !/^(?:EPERM|EBUSY)$/.test(error.code));
});

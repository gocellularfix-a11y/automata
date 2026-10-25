import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
export class Store {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
  }
  location(name) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("Nombre de archivo no válido.");
    return path.join(this.directory, name);
  }
  read(name, fallback = null) {
    try {
      return JSON.parse(fs.readFileSync(this.location(name), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return fallback;
      throw new Error(`No se puede leer ${name}: ${e.message}`);
    }
  }
  write(name, data) {
    const dest = this.location(name), tmp = `${dest}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 384 });
    fs.renameSync(tmp, dest);
  }
  runDir(id) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("ID no válido.");
    const dir = path.join(this.directory, "runs", id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  acquire() {
    const lock = this.location("coordinator.lock");
    try {
      this.fd = fs.openSync(lock, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const prior = Number(fs.readFileSync(lock, "utf8"));
      let running = false;
      try {
        process.kill(prior, 0);
        running = true;
      } catch (err) {
        if (err.code === "EPERM") running = true;
      }
      if (running || !Number.isInteger(prior) || prior <= 0) throw new Error("Automata ya está usando este directorio de datos.");
      fs.unlinkSync(lock);
      this.fd = fs.openSync(lock, "wx");
    }
    fs.writeFileSync(this.fd, String(process.pid));
    return () => {
      if (this.fd != null) {
        fs.closeSync(this.fd);
        this.fd = null;
        fs.unlinkSync(lock);
      }
    };
  }
}

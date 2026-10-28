// Removing a folder right after the server that ran in it was stopped can fail on Windows with EPERM/EBUSY for a
// moment (the process is gone but the system has not released its working directory yet). fs.rmSync's maxRetries does
// nothing in this Node (rmSync is native and the error surfaced in about a second, without retrying), so retry here.
import fs from "node:fs";

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function removeFolder(directory, { attempts = 40, delayMs = 150 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return attempt;
    } catch (error) {
      if (attempt >= attempts || !/^(?:EPERM|EBUSY|ENOTEMPTY|EACCES)$/.test(error.code)) throw error;
      sleep(delayMs);
    }
  }
}

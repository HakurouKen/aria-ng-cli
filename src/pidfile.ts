import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

/** A pidfile owned by the current process. */
export interface Pidfile {
  /** Absolute path to the pidfile. */
  readonly path: string;
  /** Removes the pidfile if it is still owned by the current process. */
  release(): Promise<void>;
}

/**
 * Atomically claims the per-user AriaNg pidfile for the current process.
 *
 * @returns The claimed pidfile and its cleanup operation.
 * @throws When another live process already owns the pidfile.
 */
export async function acquirePidfile(): Promise<Pidfile> {
  const path = getPidfilePath();
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  return claimPidfile(path);
}

async function claimPidfile(path: string): Promise<Pidfile> {
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) {
      throw error;
    }
  }

  if (file) {
    try {
      await file.writeFile(`${String(process.pid)}\n`, "utf8");
    } catch (error) {
      await file.close();
      await unlink(path).catch(() => undefined);
      throw error;
    }
    await file.close();
    return {
      path,
      release: async () => releasePidfile(path, process.pid),
    };
  }

  const existingPid = await readPid(path);
  if (isProcessRunning(existingPid)) {
    throw new Error(`AriaNg is already running (pid ${String(existingPid)})`);
  }

  try {
    await unlink(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
  return claimPidfile(path);
}

/** Returns the fixed per-user AriaNg pidfile path for the current platform. */
export function getPidfilePath(): string {
  const xdgRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  const runtimeDirectory =
    xdgRuntimeDirectory && isAbsolute(xdgRuntimeDirectory)
      ? xdgRuntimeDirectory
      : join(tmpdir(), `aria-ng-${process.getuid?.() ?? "user"}`);
  return join(runtimeDirectory, "aria-ng", "aria-ng.pid");
}

/**
 * Reads the live process referenced by the per-user pidfile.
 *
 * @returns The live process ID, or `undefined` when the pidfile is absent or stale.
 */
export async function getRunningPid(): Promise<number | undefined> {
  const path = getPidfilePath();
  let pid: number;
  try {
    pid = await readPid(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }

  if (isProcessRunning(pid)) {
    return pid;
  }

  await unlink(path);
  return undefined;
}

async function releasePidfile(path: string, expectedPid: number): Promise<void> {
  try {
    if ((await readPid(path)) === expectedPid) {
      await unlink(path);
    }
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function readPid(path: string): Promise<number> {
  const contents = await readFile(path, "utf8");
  const match = /^\s*(\d+)(?:\s|$)/.exec(contents);
  if (!match?.[1]) {
    throw new Error(`Invalid pidfile: ${path}`);
  }
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid pidfile: ${path}`);
  }
  return pid;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

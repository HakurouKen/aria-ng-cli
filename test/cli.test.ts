import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("--version reports the wrapper and bundled AriaNg versions", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--version"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "aria-ng-cli 0.1.0 (AriaNg 1.3.14)\n");
});

test("--help documents the complete public CLI", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    [
      "Usage:",
      "  aria-ng [options]",
      "  aria-ng start [options]",
      "  aria-ng stop",
      "",
      "Options:",
      "  -p, --port <port>  HTTP port (default: 6801)",
      "      --host <host>  HTTP host (default: 127.0.0.1)",
      "      --daemon       run in the background",
      "      --open         open AriaNg in the default browser",
      "  -h, --help         show help",
      "  -v, --version      show wrapper and AriaNg versions",
      "",
    ].join("\n"),
  );
});

test("invalid commands and command-specific options fail clearly", () => {
  const cases = [
    [["status"], "Unknown command: status\n"],
    [["start", "extra"], "Unexpected argument: extra\n"],
    [["stop", "--daemon"], "Option --daemon cannot be used with stop\n"],
  ] as const;

  for (const [arguments_, expectedError] of cases) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...arguments_], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, expectedError);
  }
});

test("start serves the bundled AriaNg release over HTTP", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "aria-ng-cli-test-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "start", "--port", "0"], {
    cwd: process.cwd(),
    env: { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const output = await readFirstLine(child);
    const match = /^AriaNg listening at (http:\/\/127\.0\.0\.1:\d+) \(pid \d+\)$/.exec(output);
    assert.ok(match, `unexpected startup output: ${output}`);
    assert.ok(match[1]);

    const response = await fetch(match[1]);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>AriaNg<\/title>/);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    await rm(runtimeDirectory, { force: true, recursive: true });
  }
});

test("start owns a standard pidfile until the server exits", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "aria-ng-cli-test-"));
  const pidfile = join(runtimeDirectory, "aria-ng", "aria-ng.pid");
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--port", "0"], {
    cwd: process.cwd(),
    env: { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await readFirstLine(child);
    assert.equal(await readFile(pidfile, "utf8"), `${String(child.pid)}\n`);
    assert.equal((await stat(join(runtimeDirectory, "aria-ng"))).mode & 0o777, 0o700);

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await assert.rejects(access(pidfile), { code: "ENOENT" });
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    await rm(runtimeDirectory, { force: true, recursive: true });
  }
});

test("a second start is rejected by the per-user singleton", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "aria-ng-cli-test-"));
  const environment = { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory };
  const first = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--port", "0"], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await readFirstLine(first);
    const second = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--port", "0"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
    });

    assert.equal(second.status, 1);
    assert.equal(second.stdout, "");
    assert.equal(second.stderr, `AriaNg is already running (pid ${String(first.pid)})\n`);
  } finally {
    if (first.exitCode === null) {
      first.kill("SIGTERM");
      await new Promise<void>((resolve) => first.once("exit", () => resolve()));
    }
    await rm(runtimeDirectory, { force: true, recursive: true });
  }
});

test("stop is idempotent when AriaNg is not running", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "aria-ng-cli-test-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "stop"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "AriaNg is not running\n");
  } finally {
    await rm(runtimeDirectory, { force: true, recursive: true });
  }
});

test("stop cleans a stale pidfile and remains idempotent", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "aria-ng-cli-test-"));
  const pidDirectory = join(runtimeDirectory, "aria-ng");
  const pidfile = join(pidDirectory, "aria-ng.pid");
  try {
    await mkdir(pidDirectory);
    await writeFile(pidfile, "99999999\n", "utf8");
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "stop"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "AriaNg is not running\n");
    await assert.rejects(access(pidfile), { code: "ENOENT" });
  } finally {
    await rm(runtimeDirectory, { force: true, recursive: true });
  }
});

test("stop rejects an unsafe pidfile instead of signaling a process group", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "aria-ng-cli-test-"));
  const pidDirectory = join(runtimeDirectory, "aria-ng");
  const pidfile = join(pidDirectory, "aria-ng.pid");
  try {
    await mkdir(pidDirectory);
    await writeFile(pidfile, "0\n", "utf8");
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "stop"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory },
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `Invalid pidfile: ${pidfile}\n`);
    assert.equal(await readFile(pidfile, "utf8"), "0\n");
  } finally {
    await rm(runtimeDirectory, { force: true, recursive: true });
  }
});

test("stop gracefully terminates the running AriaNg server", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "aria-ng-cli-test-"));
  const environment = { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory };
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--port", "0"], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await readFirstLine(child);
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "stop"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: environment,
      },
    );

    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `AriaNg stopped (pid ${String(child.pid)})\n`);
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    await assert.rejects(access(join(runtimeDirectory, "aria-ng", "aria-ng.pid")), {
      code: "ENOENT",
    });
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    await rm(runtimeDirectory, { force: true, recursive: true });
  }
});

test("--daemon returns only after the detached server is ready", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "aria-ng-cli-test-"));
  const environment = { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory };

  try {
    const started = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--daemon", "--port", "0"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: environment,
        timeout: 2_000,
      },
    );
    const match = /^AriaNg listening at (http:\/\/127\.0\.0\.1:\d+) \(pid (\d+)\)\n$/.exec(
      started.stdout,
    );
    assert.ok(match, `unexpected daemon output: ${started.stdout}`);
    assert.ok(match[1]);
    assert.equal(started.stderr, "");

    const response = await fetch(match[1]);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>AriaNg<\/title>/);
    assert.equal(
      await readFile(join(runtimeDirectory, "aria-ng", "aria-ng.pid"), "utf8"),
      `${match[2]}\n`,
    );

    const stopped = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "stop"],
      { cwd: process.cwd(), encoding: "utf8", env: environment },
    );
    assert.equal(stopped.stdout, `AriaNg stopped (pid ${match[2]})\n`);
  } finally {
    const pidfile = join(runtimeDirectory, "aria-ng", "aria-ng.pid");
    try {
      process.kill(Number((await readFile(pidfile, "utf8")).trim()), "SIGTERM");
    } catch {
      // The daemon either never started or was stopped by the assertion path.
    }
    await rm(runtimeDirectory, { force: true, recursive: true });
  }
});

test("--daemon reports a listen failure instead of returning success", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "aria-ng-cli-test-"));
  const occupiedServer = createServer();
  await new Promise<void>((resolve) => occupiedServer.listen(0, "127.0.0.1", resolve));
  const address = occupiedServer.address();
  assert.ok(address && typeof address !== "string");

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--daemon", "--port", String(address.port)],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory },
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^listen EADDRINUSE:/);
    await assert.rejects(access(join(runtimeDirectory, "aria-ng", "aria-ng.pid")), {
      code: "ENOENT",
    });
  } finally {
    occupiedServer.close();
    await rm(runtimeDirectory, { force: true, recursive: true });
  }
});

test(
  "--open warns without stopping the server when the browser launcher fails",
  { skip: process.platform !== "darwin" },
  async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "aria-ng-cli-test-"));
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--open", "--port", "0"],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: "", XDG_RUNTIME_DIR: runtimeDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      const output = await readFirstLine(child);
      assert.match(output, /^AriaNg listening at http:\/\/127\.0\.0\.1:\d+/);
      assert.match(await readStderrLine(child), /^Failed to open browser:/);
      assert.equal(child.exitCode, null);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
      await rm(runtimeDirectory, { force: true, recursive: true });
    }
  },
);

function readFirstLine(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CLI startup timed out")), 2_000);
    let stdout = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline !== -1) {
        clearTimeout(timeout);
        resolve(stdout.slice(0, newline));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`CLI exited before listening (code ${String(code)})`));
    });
  });
}

function readStderrLine(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CLI warning timed out")), 2_000);
    let stderr = "";

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      const newline = stderr.indexOf("\n");
      if (newline !== -1) {
        clearTimeout(timeout);
        resolve(stderr.slice(0, newline));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`CLI exited before warning (code ${String(code)})`));
    });
  });
}

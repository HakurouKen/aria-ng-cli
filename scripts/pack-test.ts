import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pnpmEntry = process.env.npm_execpath;
if (!pnpmEntry) {
  throw new Error("pack:test must be run through pnpm");
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "aria-ng-cli-pack-test-"));
try {
  await execFileAsync(
    process.execPath,
    [pnpmEntry, "pack", "--pack-destination", temporaryDirectory],
    { cwd: resolve(".") },
  );
  const archiveName = (await readdir(temporaryDirectory)).find((name) => name.endsWith(".tgz"));
  if (!archiveName) {
    throw new Error("pnpm pack did not produce a tarball");
  }

  await writeFile(
    join(temporaryDirectory, "package.json"),
    '{"name":"aria-ng-cli-pack-test","private":true}\n',
    "utf8",
  );
  await execFileAsync(
    process.execPath,
    [pnpmEntry, "add", "--offline", "--ignore-scripts", join(temporaryDirectory, archiveName)],
    { cwd: temporaryDirectory },
  );

  const packageDirectory = join(temporaryDirectory, "node_modules/aria-ng-cli");
  for (const path of [
    "dist/cli.js",
    "LICENSE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "vendor/ariang/index.html",
    "vendor/ariang/LICENSE",
    "vendor/ariang.manifest.json",
  ]) {
    await access(join(packageDirectory, path));
  }

  const packageJson = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  ) as { bin?: Record<string, string> };
  if (packageJson.bin?.["aria-ng"] !== "./dist/cli.js") {
    throw new Error("packed aria-ng bin does not target ./dist/cli.js");
  }

  const result = await execFileAsync(
    process.execPath,
    [join(packageDirectory, "dist/cli.js"), "--version"],
    {
      cwd: temporaryDirectory,
      encoding: "utf8",
    },
  );
  if (result.stdout !== "aria-ng-cli 0.1.0 (AriaNg 1.3.14)\n" || result.stderr !== "") {
    throw new Error("packed aria-ng executable returned unexpected version output");
  }

  process.stdout.write(`Verified packed artifact ${archiveName}\n`);
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

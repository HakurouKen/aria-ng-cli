import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, copyFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

void test("verify:ariang accepts the untouched official release", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-ariang.ts"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "Verified AriaNg 1.3.14 (32 files)\n");
});

void test("verify:ariang rejects a modified release file", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "aria-ng-integrity-test-"));
  try {
    await mkdir(join(fixture, "vendor"));
    await cp("vendor/ariang", join(fixture, "vendor/ariang"), { recursive: true });
    await copyFile("vendor/ariang.manifest.json", join(fixture, "vendor/ariang.manifest.json"));
    await appendFile(join(fixture, "vendor/ariang/index.html"), "modified", "utf8");

    const result = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), resolve("scripts/verify-ariang.ts")],
      { cwd: fixture, encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "AriaNg integrity check failed:\n- modified file: index.html\n");
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

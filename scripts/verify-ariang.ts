import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyAriaNgManifest, type AriaNgManifest } from "./ariang-manifest";

try {
  const manifestPath = resolve("vendor/ariang.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as AriaNgManifest;
  const errors = await verifyAriaNgManifest(resolve("vendor/ariang"), manifest);
  if (errors.length > 0) {
    throw new Error(
      `AriaNg integrity check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
  }
  process.stdout.write(
    `Verified AriaNg ${manifest.version} (${String(Object.keys(manifest.files).length)} files)\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

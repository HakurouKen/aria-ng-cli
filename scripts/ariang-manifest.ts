import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Integrity metadata for the vendored official AriaNg release. */
export interface AriaNgManifest {
  /** Official release archive metadata. */
  readonly archive: {
    /** SHA-256 published by GitHub for the release asset. */
    readonly sha256: string;
    /** Canonical official release asset URL. */
    readonly url: string;
  };
  /** SHA-256 values keyed by POSIX-style paths relative to the vendor directory. */
  readonly files: Readonly<Record<string, string>>;
  /** Bundled AriaNg version. */
  readonly version: string;
}

/**
 * Creates deterministic integrity metadata for an extracted AriaNg release.
 *
 * @param directory - Extracted official release directory.
 * @param metadata - Upstream release identity and archive digest.
 * @returns A manifest with paths sorted lexicographically.
 */
export async function createAriaNgManifest(
  directory: string,
  metadata: Pick<AriaNgManifest, "archive" | "version">,
): Promise<AriaNgManifest> {
  const paths = await listFiles(directory);
  const entries = await Promise.all(
    paths.map(async (path) => [path, sha256(await readFile(join(directory, ...path.split("/"))))]),
  );
  const files = Object.fromEntries(entries) as Record<string, string>;
  return { ...metadata, files };
}

/**
 * Compares an extracted AriaNg directory with a recorded integrity manifest.
 *
 * @param directory - Extracted release directory to inspect.
 * @param manifest - Trusted integrity metadata.
 * @returns Human-readable mismatches; an empty array means the directory is intact.
 */
export async function verifyAriaNgManifest(
  directory: string,
  manifest: AriaNgManifest,
): Promise<readonly string[]> {
  const actual = await createAriaNgManifest(directory, manifest);
  const errors: string[] = [];
  const paths = new Set([...Object.keys(manifest.files), ...Object.keys(actual.files)]);

  for (const path of [...paths].sort()) {
    const expectedHash = manifest.files[path];
    const actualHash = actual.files[path];
    if (expectedHash === undefined) {
      errors.push(`unexpected file: ${path}`);
    } else if (actualHash === undefined) {
      errors.push(`missing file: ${path}`);
    } else if (expectedHash !== actualHash) {
      errors.push(`modified file: ${path}`);
    }
  }
  return errors;
}

async function listFiles(directory: string, prefix = ""): Promise<readonly string[]> {
  const entries = await readdir(join(directory, ...prefix.split("/").filter(Boolean)), {
    withFileTypes: true,
  });
  const paths = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry): Promise<readonly string[]> => {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          return listFiles(directory, path);
        }
        if (entry.isFile()) {
          return [path];
        }
        throw new Error(`Unsupported vendor entry: ${path}`);
      }),
  );
  return paths.flat();
}

function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

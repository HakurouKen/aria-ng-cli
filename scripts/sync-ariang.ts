import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import extract from 'extract-zip';
import { createAriaNgManifest } from './ariang-manifest';

interface GitHubAsset {
  readonly browser_download_url: string;
  readonly digest: string | null;
  readonly name: string;
}

interface GitHubRelease {
  readonly assets: readonly GitHubAsset[];
}

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('Usage: pnpm sync:ariang -- <version>');
}

const assetName = `AriaNg-${version}.zip`;
const releaseResponse = await fetch(
  `https://api.github.com/repos/mayswind/AriaNg/releases/tags/${version}`,
  { headers: { Accept: 'application/vnd.github+json' } },
);
if (!releaseResponse.ok) {
  throw new Error(
    `Failed to load AriaNg ${version} release metadata: ${String(releaseResponse.status)}`,
  );
}

const release = (await releaseResponse.json()) as GitHubRelease;
const asset = release.assets.find((candidate) => candidate.name === assetName);
if (!asset?.digest?.startsWith('sha256:')) {
  throw new Error(`Official release asset ${assetName} has no SHA-256 digest`);
}

const archiveResponse = await fetch(asset.browser_download_url);
if (!archiveResponse.ok) {
  throw new Error(`Failed to download ${assetName}: ${String(archiveResponse.status)}`);
}

const archive = new Uint8Array(await archiveResponse.arrayBuffer());
const expectedSha256 = asset.digest.slice('sha256:'.length);
const actualSha256 = createHash('sha256').update(archive).digest('hex');
if (actualSha256 !== expectedSha256) {
  throw new Error(`SHA-256 mismatch for ${assetName}`);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'aria-ng-cli-sync-'));
try {
  const archivePath = join(temporaryDirectory, assetName);
  const extractedDirectory = join(temporaryDirectory, 'extracted');
  await writeFile(archivePath, archive);
  await extract(archivePath, { dir: extractedDirectory });

  const manifest = await createAriaNgManifest(extractedDirectory, {
    archive: {
      sha256: expectedSha256,
      url: asset.browser_download_url,
    },
    version,
  });

  const vendorDirectory = resolve('vendor/ariang');
  await rm(vendorDirectory, { force: true, recursive: true });
  await cp(extractedDirectory, vendorDirectory, { recursive: true });
  await writeFile(
    resolve('vendor/ariang.manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  const packagePath = resolve('package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>;
  packageJson.ariangVersion = version;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  await writeFile(
    resolve('THIRD_PARTY_NOTICES.md'),
    `# Third-party notices

## AriaNg ${version}

This package includes the unmodified Standard release of
[AriaNg ${version}](https://github.com/mayswind/AriaNg/releases/tag/${version}),
copyright mayswind and AriaNg contributors.

AriaNg is distributed under the MIT License. The upstream license text is
included at \`vendor/ariang/LICENSE\` in both this repository and the published
npm package.
`,
    'utf8',
  );
  process.stdout.write(
    `Synced AriaNg ${version} (${String(Object.keys(manifest.files).length)} files)\n`,
  );
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

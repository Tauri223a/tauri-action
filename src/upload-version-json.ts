import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

import { getOctokit } from '@actions/github';

import { uploadAssets } from './upload-release-assets';
import { getAssetName } from './utils';

import type { Artifact, TargetInfo } from './types';

type Platform = {
  signature: string;
  url: string;
};

type VersionContent = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: {
    [key: string]: Platform;
  };
};

const POSSIBLE_UPDATER_SIG_EXTENSIONS = [
  '.app.tar.gz.sig',
  '.AppImage.sig',
  '.msi.sig',
  '.exe.sig',
];

const POSSIBLE_UPDATER_SIG_EXTENSIONS_NON_ZIPPED = [
  '.app.tar.gz.sig',
  '.AppImage.tar.gz.sig',
  '.msi.zip.sig',
  '.nsis.zip.sig',
];

export async function uploadVersionJSON({
  owner,
  repo,
  version,
  notes,
  tagName,
  releaseId,
  artifacts,
  targetInfo,
  updaterJsonPreferNsis,
  updaterJsonKeepUniversal,
  updaterJsonUseNonZipped,
}: {
  owner: string;
  repo: string;
  version: string;
  notes: string;
  tagName: string;
  releaseId: number;
  artifacts: Artifact[];
  targetInfo: TargetInfo;
  updaterJsonPreferNsis: boolean;
  updaterJsonKeepUniversal: boolean;
  updaterJsonUseNonZipped: boolean;
}) {
  if (process.env.GITHUB_TOKEN === undefined) {
    throw new Error('GITHUB_TOKEN is required');
  }

  const github = getOctokit(process.env.GITHUB_TOKEN);

  const versionFilename = 'latest.json';
  const versionFile = resolve(process.cwd(), versionFilename);
  const versionContent: VersionContent = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {},
  };

  const assets = await github.rest.repos.listReleaseAssets({
    owner: owner,
    repo: repo,
    release_id: releaseId,
    per_page: 50,
  });
  const asset = assets.data.find((e) => e.name === versionFilename);

  if (asset) {
    const assetData = (
      await github.request(
        'GET /repos/{owner}/{repo}/releases/assets/{asset_id}',
        {
          owner: owner,
          repo: repo,
          asset_id: asset.id,
          headers: {
            accept: 'application/octet-stream',
          },
        },
      )
    ).data as unknown as ArrayBuffer;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    versionContent.platforms = JSON.parse(
      Buffer.from(assetData).toString(),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    ).platforms;
  }

  const preferedSigExtension = updaterJsonPreferNsis
    ? updaterJsonUseNonZipped
      ? '.exe.sig'
      : '.nsis.zip.sig'
    : updaterJsonUseNonZipped
      ? '.msi.sig'
      : '.msi.zip.sig';
  const signatureFile =
    artifacts.find((s) => {
      s.path.endsWith(preferedSigExtension);
    }) ||
    artifacts.find((artifact) => {
      for (const extension of updaterJsonUseNonZipped
        ? POSSIBLE_UPDATER_SIG_EXTENSIONS_NON_ZIPPED
        : POSSIBLE_UPDATER_SIG_EXTENSIONS) {
        if (artifact.path.endsWith(extension)) {
          return true;
        }
      }
    });
  if (!signatureFile) {
    console.warn(
      'Signature not found for the updater JSON. Skipping upload...',
    );
    return;
  }

  // Assets matching artifacts generated by this action
  const assetNames = new Set(
    artifacts.map((p) => getAssetName(p.path).trim().replace(/ /g, '.')), // GitHub replaces spaces in asset names with dots
  );
  const filteredAssets = assets.data.filter((data) =>
    assetNames.has(data.name),
  );
  const baseName = basename(signatureFile.path, extname(signatureFile.path));
  let downloadUrl = filteredAssets.find((asset) =>
    asset.browser_download_url.endsWith(baseName),
  )?.browser_download_url;
  if (!downloadUrl) {
    console.warn('Asset not found for the updater JSON. Skipping upload...');
    return;
  }
  // Untagged release downloads won't work after the release was published
  downloadUrl = downloadUrl.replace(
    /\/download\/(untagged-[^/]+)\//,
    tagName ? `/download/${tagName}/` : '/latest/download/',
  );

  let os = targetInfo.platform as string;
  if (os === 'macos') {
    os = 'darwin';
  }

  let arch = signatureFile.arch;
  arch =
    arch === 'amd64' || arch === 'x86_64' || arch === 'x64'
      ? 'x86_64'
      : arch === 'x86' || arch === 'i386'
        ? 'i686'
        : arch === 'arm'
          ? 'armv7'
          : arch === 'arm64'
            ? 'aarch64'
            : arch;

  // Expected targets: https://github.com/tauri-apps/tauri/blob/fd125f76d768099dc3d4b2d4114349ffc31ffac9/core/tauri/src/updater/core.rs#L856
  if (os === 'darwin' && arch === 'universal') {
    // Don't overwrite native builds
    if (!versionContent.platforms['darwin-aarch64']) {
      (versionContent.platforms['darwin-aarch64'] as unknown) = {
        signature: readFileSync(signatureFile.path).toString(),
        url: downloadUrl,
      };
    }
    if (!versionContent.platforms['darwin-x86_64']) {
      (versionContent.platforms['darwin-x86_64'] as unknown) = {
        signature: readFileSync(signatureFile.path).toString(),
        url: downloadUrl,
      };
    }
  }
  if (updaterJsonKeepUniversal || os !== 'darwin' || arch !== 'universal') {
    (versionContent.platforms[`${os}-${arch}`] as unknown) = {
      signature: readFileSync(signatureFile.path).toString(),
      url: downloadUrl,
    };
  }

  writeFileSync(versionFile, JSON.stringify(versionContent, null, 2));

  if (asset) {
    // https://docs.github.com/en/rest/releases/assets#update-a-release-asset
    await github.rest.repos.deleteReleaseAsset({
      owner: owner,
      repo: repo,
      release_id: releaseId,
      asset_id: asset.id,
    });
  }

  console.log(`Uploading ${versionFile}...`);
  await uploadAssets(owner, repo, releaseId, [{ path: versionFile, arch: '' }]);
}

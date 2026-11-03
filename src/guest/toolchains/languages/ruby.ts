// Ruby from RubyInstaller. Gems live in persistent storage.
import path from 'node:path';
import type { Toolchains } from '../../../core/types.js';
import { downloader, fetchJson } from '../../../shared/download/index.js';
import { SYSTEM } from '../../../shared/system.js';
import { dryRun } from '../../runtime/paths.js';
import { execHeavy as execAsync } from '../../runtime/pools.js';
import { exists } from '../../runtime/fs.js';
import { log } from '../../runtime/log.js';
import { installOnce } from '../package-ledger.js';
import { resolveCached } from '../version-cache.js';
import { tool, versionOf, type ToolEnv } from '../tool-env.js';
import { versionFromFiles } from '../detect.js';
import { pickPackageVersion } from '../../../core/detect/versions.js';

interface Asset {
  name: string;
  browser_download_url: string;
  digest?: string;
}
interface Release {
  draft: boolean;
  prerelease: boolean;
  assets: Asset[];
}
const RUBY_ASSET = /^rubyinstaller-(\d+\.\d+\.\d+)-(\d+)-x64\.7z$/;

/** The build number after the version in a RubyInstaller file name (rubyinstaller-3.3.1-1-x64.7z -> 1). */
const buildNumber = (asset: Asset): number => Number(RUBY_ASSET.exec(asset.name)?.[2] ?? 0);

/** RubyInstaller builds per Ruby version (newest build of each), from its GitHub releases. */
const rubyBuilds = async (): Promise<Map<string, Asset>> => {
  const releases = await fetchJson<Release[]>(
    'https://api.github.com/repos/oneclick/rubyinstaller2/releases?per_page=100',
  );
  const builds = new Map<string, Asset>();
  for (const asset of releases.filter((r) => !r.draft && !r.prerelease).flatMap((r) => r.assets)) {
    const version = RUBY_ASSET.exec(asset.name)?.[1];
    if (!version) continue;
    const known = builds.get(version);
    if (!known || buildNumber(known) < buildNumber(asset)) builds.set(version, asset);
  }
  return builds;
};

const sha256Of = (asset: Asset): string | null => (asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null);

export async function setupRuby(env: ToolEnv, config: Toolchains['ruby']): Promise<void> {
  const wantedSpec = versionFromFiles(['.ruby-version']) ?? { spec: config.version, source: 'config' };
  if (dryRun) {
    log('(dry run) would provision Ruby ' + wantedSpec.spec);
    return;
  }
  const version = await resolveCached(
    'ruby:' + wantedSpec.spec,
    async () =>
      pickPackageVersion([...(await rubyBuilds()).keys()], wantedSpec.spec) ??
      Promise.reject(new Error('No RubyInstaller build matches "' + wantedSpec.spec + '"')),
  );
  const home = tool('ruby', version);
  if (!exists(path.join(home, 'bin', 'ruby.exe'))) {
    const asset = (await rubyBuilds()).get(version);
    if (!asset) throw new Error('RubyInstaller ' + version + ' is no longer published');
    log('Downloading Ruby ' + version + ' (~100 MB once) ...');
    await downloader.archive(asset.browser_download_url, home, {
      sha256: sha256Of(asset),
      locate: 'ruby.exe',
      up: 1,
      fileName: asset.name,
    });
  }
  const gems = tool('ruby-gems', version.split('.').slice(0, 2).join('.'));
  Object.assign(env.vars, { GEM_HOME: gems, BUNDLE_USER_HOME: tool('bundle-home') });
  env.prepend.push(path.join(home, 'bin'), path.join(gems, 'bin'));
  env.summary.push(
    'ruby: ' +
      versionOf(path.join(home, 'bin', 'ruby.exe')) +
      ' (from ' +
      wantedSpec.source +
      '; gems with C extensions need MSYS2, not included)',
  );
  const gem = path.join(home, 'bin', 'gem.cmd');
  await installOnce(env, 'gem@' + version, config.gems, (pkg) =>
    execAsync(SYSTEM.cmd(), ['/d', '/c', gem, 'install', pkg, '--no-document'], {
      env: { ...process.env, GEM_HOME: gems },
    }),
  );
}

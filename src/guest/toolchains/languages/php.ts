// PHP from windows.php.net, with Composer. Composer's global packages live in persistent storage.
import fs from 'node:fs';
import path from 'node:path';
import type { Toolchains } from '../../../core/types.js';
import { downloader, fetchJson, fetchText } from '../../../shared/download/index.js';
import { dryRun } from '../../runtime/paths.js';
import { execOutput } from '../../runtime/process.js';
import { exists, mkdirp } from '../../runtime/fs.js';
import { log } from '../../runtime/log.js';
import { downloadFile } from '../install.js';
import { resolveCached } from '../version-cache.js';
import { tool, type ToolEnv } from '../tool-env.js';
import { versionFromFiles } from '../detect.js';
import { pickPackageVersion } from '../../../core/detect/versions.js';
import { setupVcRuntime } from '../native/vcruntime.js';

type PhpReleases = Record<
  string,
  { version: string } & Record<string, { zip?: { path: string; sha256: string } } | string>
>;
const PHP_EXTENSIONS = [
  'curl',
  'fileinfo',
  'gd',
  'intl',
  'mbstring',
  'openssl',
  'pdo_mysql',
  'pdo_pgsql',
  'pdo_sqlite',
  'sodium',
  'sqlite3',
  'zip',
] as const;
const COMPOSER = 'https://getcomposer.org/download/latest-stable/composer.phar';

/** The non-thread-safe x64 zip of the newest release matching `spec` ("8" -> newest 8.x, "8.3" -> newest 8.3.x). */
const phpBuild = async (spec: string): Promise<{ version: string; path: string; sha256: string }> => {
  const releases = await fetchJson<PhpReleases>('https://windows.php.net/downloads/releases/releases.json');
  const pick = pickPackageVersion(
    Object.values(releases).map((r) => r.version),
    spec,
  );
  const release = Object.values(releases).find((r) => r.version === pick);
  const build =
    release &&
    Object.entries(release).find(
      ([key, value]) => /^nts-vs\d+-x64$/.test(key) && typeof value === 'object' && value.zip,
    )?.[1];
  if (!release || typeof build !== 'object' || !build.zip)
    throw new Error('No PHP build for Windows matches "' + spec + '"');
  return { version: release.version, ...build.zip };
};

/** php.ini from the development template with the common extensions switched on (written whole, then renamed). */
const writePhpIni = (home: string): void => {
  const ini = path.join(home, 'php.ini');
  if (exists(ini) || !exists(path.join(home, 'php.ini-development'))) return;
  let text = fs
    .readFileSync(path.join(home, 'php.ini-development'), 'utf8')
    .replace(/^;\s*extension_dir\s*=\s*"ext"/m, 'extension_dir = "' + path.join(home, 'ext') + '"');
  for (const ext of PHP_EXTENSIONS.filter((e) => exists(path.join(home, 'ext', 'php_' + e + '.dll'))))
    text = text.replace(new RegExp('^;(extension=' + ext + ')\\s*$', 'm'), '$1');
  fs.writeFileSync(ini + '.tmp', text);
  fs.renameSync(ini + '.tmp', ini);
};

/** Writes `<name>.cmd` into tools\shims (on PATH). */
const shim = (env: ToolEnv, name: string, command: string): void => {
  fs.writeFileSync(path.join(mkdirp(tool('shims')), name + '.cmd'), '@echo off\r\n' + command + ' %*\r\n');
  env.prepend.push(tool('shims'));
};

const setupComposer = async (env: ToolEnv, php: string): Promise<void> => {
  const phar = tool('composer', 'composer.phar');
  if (!exists(phar)) {
    log('Downloading Composer (~3 MB once) ...');
    const sha256 = (await fetchText(COMPOSER + '.sha256sum')).trim().split(/\s+/)[0];
    await downloadFile(COMPOSER, phar, sha256);
  }
  const composerHome = tool('composer-home');
  env.vars.COMPOSER_HOME = composerHome;
  env.prepend.push(path.join(composerHome, 'vendor', 'bin'));
  shim(env, 'composer', '"' + php + '" "' + phar + '"');
  env.summary.push(
    'composer: ' + (/\d+\.\d+\.\d+/.exec(execOutput(php, [phar, '--version', '--no-ansi']))?.[0] ?? 'installed'),
  );
};

const PHP_RELEASES = 'https://windows.php.net/downloads/releases/';
const phpCache = (zip: string): string => tool('downloads', 'php-' + path.basename(zip));

/** Downloads PHP's zip ahead of the install (which unpacks it); nothing when PHP is there already. */
export async function fetchPhp(config: Toolchains['php']): Promise<void> {
  const spec = versionFromFiles(['.php-version']) ?? { spec: config.version, source: 'config' };
  const version = await resolveCached('php:' + spec.spec, async () => (await phpBuild(spec.spec)).version);
  if (exists(path.join(tool('php', version), 'php.exe'))) return;
  const build = await phpBuild(version);
  await downloader.file(PHP_RELEASES + build.path, phpCache(build.path), build.sha256);
}

export async function setupPhp(env: ToolEnv, config: Toolchains['php']): Promise<void> {
  const wantedSpec = versionFromFiles(['.php-version']) ?? { spec: config.version, source: 'config' };
  if (dryRun) {
    log('(dry run) would provision PHP ' + wantedSpec.spec + (config.composer ? ' + Composer' : ''));
    return;
  }
  // No summary line of its own: the Visual C++ runtime step (which runs first) already reports it.
  await setupVcRuntime(env, false);
  const version = await resolveCached('php:' + wantedSpec.spec, async () => (await phpBuild(wantedSpec.spec)).version);
  const home = tool('php', version);
  if (!exists(path.join(home, 'php.exe'))) {
    const build = await phpBuild(version);
    log('Downloading PHP ' + version + ' (~30 MB once) ...');
    await downloader.archive(PHP_RELEASES + build.path, home, {
      sha256: build.sha256,
      locate: 'php.exe',
      fileName: build.path,
      cached: phpCache(build.path),
    });
  }
  writePhpIni(home);
  env.prepend.push(home);
  env.summary.push('php: ' + version + ' (from ' + wantedSpec.source + ')');
  if (config.composer) await setupComposer(env, path.join(home, 'php.exe'));
}

// Java: Eclipse Temurin JDK (Adoptium), plus Maven and Gradle. All checksum-verified; the Maven repository and Gradle
// caches live in persistent storage, so dependencies download once.
import fs from 'node:fs';
import path from 'node:path';
import type { Toolchains } from '../../../core/types.js';
import { downloader, fetchJson, fetchText } from '../../../shared/download/index.js';
import { dryRun } from '../../runtime/paths.js';
import { exists } from '../../runtime/fs.js';
import { log, warn } from '../../runtime/log.js';
import { errMsg } from '../../../core/util/errors.js';
import { arch, emptyEnv, tool, type ToolEnv } from '../tool-env.js';
import { resolveCached } from '../version-cache.js';
import { versionFromFiles } from '../detect.js';
import { javaMajorFrom, pickPackageVersion } from '../../../core/detect/versions.js';

interface TemurinAsset {
  release_name: string;
  binary: { package: { link: string; name: string; checksum: string } };
}

const ADOPTIUM = 'https://api.adoptium.net/v3';
const MAVEN = 'https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/';

const temurin = async (major: string): Promise<TemurinAsset> => {
  const assets = await fetchJson<TemurinAsset[]>(
    ADOPTIUM +
      '/assets/latest/' +
      major +
      '/hotspot?image_type=jdk&os=windows&vendor=eclipse&architecture=' +
      (arch === 'arm64' ? 'aarch64' : 'x64'),
  );
  return (
    assets.find((a) => a.binary.package.name.endsWith('.zip')) ??
    Promise.reject(new Error('No Temurin ' + major + ' JDK zip for Windows'))
  );
};

/** A project's .java-version / .sdkmanrc, else the configured version ("lts" = the newest LTS). */
const javaMajor = async (config: Toolchains['java']): Promise<{ major: string; source: string }> => {
  const fromProject = versionFromFiles(['.java-version', '.sdkmanrc'], (text, name) =>
    javaMajorFrom(text, name === '.sdkmanrc'),
  );
  if (fromProject) return { major: fromProject.spec, source: fromProject.source };
  const spec = config.version.trim().toLowerCase();
  if (spec !== 'lts') return { major: javaMajorFrom(spec) ?? spec, source: 'config' };
  const lts = await resolveCached('java:lts', async () =>
    String((await fetchJson<{ most_recent_lts: number }>(ADOPTIUM + '/info/available_releases')).most_recent_lts),
  );
  return { major: lts, source: 'newest LTS' };
};

const setupJdk = async (env: ToolEnv, config: Toolchains['java']): Promise<void> => {
  const { major, source } = await javaMajor(config);
  const release = await resolveCached('java:' + major, async () => (await temurin(major)).release_name);
  const home = tool('java', release.replace(/[^A-Za-z0-9.-]/g, '_'));
  if (!exists(path.join(home, 'bin', 'java.exe'))) {
    const asset = await temurin(major);
    log('Downloading Java ' + release + ' (JDK, ~200 MB once) ...');
    await downloader.archive(asset.binary.package.link, home, {
      sha256: asset.binary.package.checksum,
      locate: 'release',
      fileName: asset.binary.package.name,
    });
  }
  env.vars.JAVA_HOME = home;
  env.prepend.push(path.join(home, 'bin'));
  env.summary.push('java: ' + release + ' (Temurin, from ' + source + ')');
};

/**
 * A JDK for tools that run on Java (DynamoDB Local): the newest one already installed, else the newest LTS. Returns its
 * folder; the agent's Java on PATH stays whatever toolchains.java says.
 */
export async function ensureJdk(): Promise<string> {
  const root = tool('java');
  const installed = exists(root)
    ? fs
        .readdirSync(root)
        .filter((d) => exists(path.join(root, d, 'bin', 'java.exe')))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    : [];
  if (installed.length) return path.join(root, installed[0]);
  const scratch = emptyEnv();
  await setupJdk(scratch, { enabled: true, version: 'lts', maven: false, gradle: false, kotlin: false });
  return scratch.vars.JAVA_HOME;
}

const setupMaven = async (env: ToolEnv): Promise<void> => {
  const version = await resolveCached('maven:3', async () => {
    const versions = [...(await fetchText(MAVEN + 'maven-metadata.xml')).matchAll(/<version>([^<]+)<\/version>/g)].map(
      (m) => m[1],
    );
    return pickPackageVersion(versions, '3') ?? Promise.reject(new Error('No Maven 3 release found'));
  });
  const home = tool('maven', version);
  if (!exists(path.join(home, 'bin', 'mvn.cmd'))) {
    const url = MAVEN + version + '/apache-maven-' + version + '-bin.zip';
    log('Downloading Maven ' + version + ' (~10 MB once) ...');
    await downloader.archive(url, home, {
      sha512: (await fetchText(url + '.sha512')).trim().split(/\s+/)[0],
      locate: 'LICENSE',
    });
  }
  const repo = tool('maven-repository');
  Object.assign(env.vars, { MAVEN_HOME: home, M2_HOME: home, MAVEN_OPTS: '-Dmaven.repo.local=' + repo });
  env.prepend.push(path.join(home, 'bin'));
  env.summary.push('maven: ' + version);
};

const setupGradle = async (env: ToolEnv): Promise<void> => {
  const current = await fetchJson<{ version: string; downloadUrl: string; checksumUrl: string }>(
    'https://services.gradle.org/versions/current',
  ).catch(() => null);
  const version = await resolveCached(
    'gradle',
    async () => current?.version ?? Promise.reject(new Error('Gradle version lookup failed')),
  );
  const home = tool('gradle', version);
  if (!exists(path.join(home, 'bin', 'gradle.bat'))) {
    if (!current || current.version !== version)
      throw new Error('Gradle ' + version + ' is not installed and cannot be downloaded right now');
    log('Downloading Gradle ' + version + ' (~130 MB once) ...');
    await downloader.archive(current.downloadUrl, home, {
      sha256: (await fetchText(current.checksumUrl)).trim(),
      locate: 'LICENSE',
      fileName: 'gradle-' + version + '.zip',
    });
  }
  const userHome = tool('gradle-home');
  fs.mkdirSync(userHome, { recursive: true });
  // File-system watching does not work on mapped folders (harmless but noisy "Couldn't add watch" on every build).
  Object.assign(env.vars, {
    GRADLE_HOME: home,
    GRADLE_USER_HOME: userHome,
    GRADLE_OPTS: '-Dorg.gradle.vfs.watch=false',
  });
  env.prepend.push(path.join(home, 'bin'));
  env.summary.push('gradle: ' + version);
};

export async function setupJava(env: ToolEnv, config: Toolchains['java']): Promise<void> {
  if (dryRun) {
    log(
      '(dry run) would provision Java ' +
        config.version +
        (config.maven ? ' + Maven' : '') +
        (config.gradle ? ' + Gradle' : ''),
    );
    return;
  }
  await setupJdk(env, config);
  // Maven and Gradle are extras: one failing must not take the JDK down with it.
  for (const [on, name, work] of [
    [config.maven, 'Maven', setupMaven],
    [config.gradle, 'Gradle', setupGradle],
  ] as const) {
    if (on)
      await work(env).catch((e: unknown) => {
        env.summary.push(name.toLowerCase() + ': FAILED');
        warn(name + ' setup failed (continuing without it): ' + errMsg(e));
      });
  }
}

// Where the latest version of an app is, for apps that are not a plain GitHub release: each looks it up on the
// vendor's own site (and its published checksum, where there is one). Named by AppSource.resolve in shared/apps.ts.
import { fetchJson, fetchText, githubAsset, latestGithubTag } from '../../shared/download/index.js';
import { AGENTS_WEB_RESOLVERS } from './resolvers-agents-web.js';
import { GAMEDEV_RESOLVERS } from './resolvers-gamedev.js';
import { MOBILE_RESOLVERS } from './resolvers-mobile.js';

export interface Download {
  url: string;
  fileName: string;
  sha256?: string | null;
  /** Only these paths of the archive (pgAdmin out of the PostgreSQL zip). */
  members?: string[];
}

/** The SHA-256 on the line of a SHA256SUMS-style file that names `file`. */
const sumFor = (sums: string, file: string): string | null =>
  sums
    .split(/\r?\n/)
    .map((l) => /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(l.trim()))
    .find((m) => m && m[2].trim().endsWith(file))?.[1]
    .toLowerCase() ?? null;
const firstHash = (text: string): string | null => /\b([0-9a-f]{64})\b/i.exec(text)?.[1].toLowerCase() ?? null;
const stripV = (tag: string): string => tag.replace(/^v/, '');

export const RESOLVERS: Record<string, () => Promise<Download>> = {
  ...GAMEDEV_RESOLVERS,
  ...MOBILE_RESOLVERS,
  ...AGENTS_WEB_RESOLVERS,
  sublime: async () => {
    // Sublime publishes no checksums; the download is HTTPS from sublimetext.com.
    const { latest_version: build } = await fetchJson<{ latest_version: number }>(
      'https://www.sublimetext.com/updates/4/stable_update_check',
    );
    return {
      url: 'https://download.sublimetext.com/sublime_text_build_' + build + '_x64.zip',
      fileName: 'sublime_text_' + build + '.zip',
    };
  },
  pgadmin: async () => {
    // pgAdmin is only an installer on pgadmin.org; EnterpriseDB's PostgreSQL binaries zip has a portable copy.
    const versions = (
      await fetchJson<{ major: number; latestMinor: number; current: boolean; supported: boolean }[]>(
        'https://www.postgresql.org/versions.json',
      )
    ).filter((v) => v.supported);
    const current = versions.find((v) => v.current) ?? versions[versions.length - 1];
    const exact = current.major + '.' + current.latestMinor;
    return {
      url: 'https://get.enterprisedb.com/postgresql/postgresql-' + exact + '-1-windows-x64-binaries.zip',
      fileName: 'postgresql-' + exact + '.zip',
      members: ['pgsql/pgAdmin 4'],
    };
  },
  everything: async () => {
    const page = await fetchText('https://www.voidtools.com/downloads/');
    const version = /Everything-([\d.]+)\.x64\.zip/.exec(page)?.[1];
    if (!version) throw new Error('could not find the Everything download on voidtools.com');
    const file = 'Everything-' + version + '.x64.zip';
    const sums = await fetchText('https://www.voidtools.com/Everything-' + version + '.sha256').catch(() => '');
    return { url: 'https://www.voidtools.com/' + file, fileName: file, sha256: sumFor(sums, file) };
  },
  chrome: async () => {
    type Downloads = { channels: { Stable: { downloads: { chrome: { platform: string; url: string }[] } } } };
    const data = await fetchJson<Downloads>(
      'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json',
    );
    const hit = data.channels.Stable.downloads.chrome.find((d) => d.platform === 'win64');
    if (!hit) throw new Error('no win64 Chrome for Testing build listed');
    return { url: hit.url, fileName: 'chrome-win64.zip' };
  },
  firefox: async () => {
    const { LATEST_FIREFOX_VERSION: v } = await fetchJson<{ LATEST_FIREFOX_VERSION: string }>(
      'https://product-details.mozilla.org/1.0/firefox_versions.json',
    );
    const base = 'https://archive.mozilla.org/pub/firefox/releases/' + v + '/';
    const sums = await fetchText(base + 'SHA256SUMS');
    return {
      url: base + 'win64/en-US/Firefox%20Setup%20' + v + '.exe',
      fileName: 'firefox-setup-' + v + '.exe',
      sha256: sumFor(sums, 'win64/en-US/Firefox Setup ' + v + '.exe'),
    };
  },
  blender: async () => {
    const releases = await fetchText('https://download.blender.org/release/');
    const series = [...releases.matchAll(/href="Blender(\d+)\.(\d+)\/"/g)]
      .map((m) => [Number(m[1]), Number(m[2])])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .pop();
    if (!series) throw new Error('could not list Blender releases');
    const folder = 'https://download.blender.org/release/Blender' + series[0] + '.' + series[1] + '/';
    const listing = await fetchText(folder);
    const files = [...listing.matchAll(/href="(blender-([\d.]+)-windows-x64\.zip)"/g)].map((m) => ({
      file: m[1],
      v: m[2].split('.').map(Number),
    }));
    const latest = files.sort((a, b) => a.v[2] - b.v[2]).pop();
    if (!latest) throw new Error('no Windows build in ' + folder);
    const sums = await fetchText(folder + 'blender-' + latest.v.join('.') + '.sha256').catch(() => '');
    return { url: folder + latest.file, fileName: latest.file, sha256: sumFor(sums, latest.file) };
  },
  kubectl: async () => {
    const v = (await fetchText('https://dl.k8s.io/release/stable.txt')).trim();
    const url = 'https://dl.k8s.io/release/' + v + '/bin/windows/amd64/kubectl.exe';
    return { url, fileName: 'kubectl.exe', sha256: firstHash(await fetchText(url + '.sha256')) };
  },
  helm: async () => {
    const v = await latestGithubTag('helm/helm');
    const url = 'https://get.helm.sh/helm-' + v + '-windows-amd64.zip';
    return { url, fileName: 'helm-' + v + '.zip', sha256: firstHash(await fetchText(url + '.sha256sum')) };
  },
  terraform: async () => {
    const { current_version: v } = await fetchJson<{ current_version: string }>(
      'https://checkpoint-api.hashicorp.com/v1/check/terraform',
    );
    const base = 'https://releases.hashicorp.com/terraform/' + v + '/';
    const file = 'terraform_' + v + '_windows_amd64.zip';
    return {
      url: base + file,
      fileName: file,
      sha256: sumFor(await fetchText(base + 'terraform_' + v + '_SHA256SUMS'), file),
    };
  },
  mitmproxy: async () => {
    // mitmproxy's GitHub releases have no files; its own download server has them (no published checksums).
    const v = stripV(await latestGithubTag('mitmproxy/mitmproxy'));
    return {
      url: 'https://downloads.mitmproxy.org/' + v + '/mitmproxy-' + v + '-windows-x86_64.zip',
      fileName: 'mitmproxy-' + v + '.zip',
    };
  },
  sqlite: async () => {
    // The download page lists every file in a CSV comment: PRODUCT,<version>,<year>/<file>,<size>,<sha3>.
    const page = await fetchText('https://sqlite.org/download.html');
    const file = /PRODUCT,[^,]+,(\d{4}\/sqlite-tools-win-x64-\d+\.zip),/.exec(page)?.[1];
    if (!file) throw new Error('could not find the sqlite tools download on sqlite.org');
    return { url: 'https://sqlite.org/' + file, fileName: file.split('/')[1] };
  },
  '7zip': async () => {
    const asset = await githubAsset('ip7z/7zip', /^7z\d+-x64\.exe$/);
    return { url: asset.url, fileName: asset.name, sha256: asset.sha256 };
  },
};

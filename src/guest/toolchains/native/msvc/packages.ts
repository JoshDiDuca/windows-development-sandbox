// Downloads the MSVC compiler and the Windows SDK from Microsoft's Visual Studio channel manifest, the way mmozeiko's
// portable-msvc.py does: each payload is checked against the manifest's sha256, the compiler is unpacked from its
// .vsix files, the SDK from its .msi files with `msiexec /a`.
import fs from 'node:fs';
import path from 'node:path';
import type { Toolchains } from '../../../../core/types.js';
import { downloader, extractArchive, fetchJson } from '../../../../shared/download/index.js';
import { safeRemove } from '../../../../shared/io/safe-remove.js';
import { system32 } from '../../../../shared/system.js';
import { runInstallerChecked } from '../../../runtime/pools.js';
import { exists, mkdirp } from '../../../runtime/fs.js';
import { log } from '../../../runtime/log.js';
import { msiCabs, pickMsvcVersion, pickWindowsSdk } from '../../../../core/detect/versions.js';
import { hostBin, ROOT } from './tree.js';

interface Payload {
  fileName: string;
  url: string;
  sha256: string;
  size: number;
}
interface Package {
  id: string;
  version: string;
  language?: string;
  payloads?: Payload[];
  dependencies?: Record<string, unknown>;
}
interface Manifest {
  packages: Package[];
}

const CHANNEL = 'https://aka.ms/vs/17/release/channel';
const MANIFEST_DAY_MS = 24 * 60 * 60 * 1000;

/** The compiler's packages (host x64, target x64): tools, resources, CRT headers/libs, ASAN/PGO headers. */
const MSVC_PARTS = [
  'tools.hostx64.targetx64.base',
  'tools.hostx64.targetx64.res.base',
  'crt.headers.base',
  'crt.x64.desktop.base',
  'crt.x64.store.base',
  'crt.source.base',
  'asan.headers.base',
  'pgo.headers.base',
] as const;
/** Without these the compiler is unusable; the other parts are taken when the manifest has them. */
const REQUIRED_PARTS = ['tools', 'crt.headers', 'crt.x64.desktop'] as const;
/** The SDK's .msi files (Desktop + UCRT + Store headers/libs/tools for x64), as in portable-msvc.py. */
const SDK_MSIS = [
  'Windows SDK for Windows Store Apps Tools-x86_en-us.msi',
  'Windows SDK for Windows Store Apps Headers-x86_en-us.msi',
  'Windows SDK for Windows Store Apps Headers OnecoreUap-x86_en-us.msi',
  'Windows SDK for Windows Store Apps Libs-x86_en-us.msi',
  'Universal CRT Headers Libraries and Sources-x86_en-us.msi',
  'Windows SDK Desktop Headers x86-x86_en-us.msi',
  'Windows SDK Desktop Headers x64-x86_en-us.msi',
  'Windows SDK Desktop Libs x64-x86_en-us.msi',
  'Windows SDK Desktop Tools x64-x86_en-us.msi',
] as const;

/** The VS manifest (~18 MB), cached for a day. */
const manifest = async (): Promise<Manifest> => {
  const cached = path.join(ROOT, '.manifest.json');
  if (exists(cached) && Date.now() - fs.statSync(cached).mtimeMs < MANIFEST_DAY_MS) {
    // A download cut short leaves unreadable JSON: fetch it again instead of failing until the day is over.
    try {
      return JSON.parse(fs.readFileSync(cached, 'utf8')) as Manifest;
    } catch {
      /* downloaded again below */
    }
  }
  const channel = await fetchJson<{ channelItems: { id: string; payloads?: Payload[] }[] }>(CHANNEL);
  const item = channel.channelItems.find((i) => i.id === 'Microsoft.VisualStudio.Manifests.VisualStudio')
    ?.payloads?.[0];
  if (!item) throw new Error('the Visual Studio channel has no package manifest');
  mkdirp(ROOT);
  // The channel's sha256 for the manifest is not the file's hash (portable-msvc.py does not check it either); the
  // manifest comes over HTTPS from Microsoft, and every package payload it lists IS checked against its own sha256.
  await downloader.file(item.url, cached);
  return JSON.parse(fs.readFileSync(cached, 'utf8')) as Manifest;
};

/** .vsix contents are percent-encoded file names under Contents/; unpack them into the root, names decoded. */
const unpackVsix = async (vsix: string, work: string): Promise<void> => {
  const out = mkdirp(path.join(work, 'vsix-' + path.basename(vsix)));
  await extractArchive(vsix, out, ['Contents']);
  const decode = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, entry.name);
      let name = entry.name;
      try {
        if (name.includes('%')) name = decodeURIComponent(name);
      } catch {
        /* not percent-encoded after all */
      }
      const to = path.join(dir, name);
      if (to !== from) fs.renameSync(from, to);
      if (entry.isDirectory()) decode(to);
    }
  };
  decode(out);
  fs.cpSync(path.join(out, 'Contents'), ROOT, { recursive: true, force: true });
  safeRemove(out, work);
};

/**
 * An administrative install only unpacks files; its verbose log explains a failure (e.g. a path over 260 characters).
 */
const unpackMsi = async (msi: string): Promise<void> => {
  const logFile = msi + '.log';
  try {
    await runInstallerChecked(system32('msiexec.exe'), ['/a', msi, '/quiet', '/qn', 'TARGETDIR=' + ROOT, '/l*v', logFile]);
  } catch (e) {
    const lines = exists(logFile)
      ? fs
          .readFileSync(logFile, 'utf16le')
          .split(/\r?\n/)
          .filter((l) => /error|return value 3|failed/i.test(l))
          .slice(-4)
          .join(' | ')
      : '';
    throw new Error(
      path.basename(msi) +
        ' did not unpack: ' +
        (e instanceof Error ? e.message : String(e)) +
        (lines ? ' (' + lines.slice(0, 600) + ')' : ''),
    );
  }
};

/** The manifest's packages by id, with the lookups the installer needs. */
const catalogue = (m: Manifest) => {
  const byId = new Map<string, Package[]>();
  for (const p of m.packages) byId.set(p.id.toLowerCase(), [...(byId.get(p.id.toLowerCase()) ?? []), p]);
  return {
    ids: [...byId.keys()],
    pick: (id: string): Package | undefined =>
      byId.get(id.toLowerCase())?.find((p) => !p.language || p.language === 'en-US'),
  };
};

/** Downloads (once, verified) into `work`; a verified file from an earlier attempt is reused. */
const payloadFetcher =
  (work: string) =>
  async (p: Payload): Promise<string> => {
    const file = path.join(work, path.basename(p.fileName.replace(/\\/g, '/')));
    if (!exists(file)) await downloader.file(p.url, file, p.sha256);
    return file;
  };

/**
 * Newest folder under VC\Tools\MSVC that holds a compiler (named after the toolset, 14.44.35207, not the package
 * version).
 */
const unpackedToolset = (): string | undefined => {
  const toolsRoot = path.join(ROOT, 'VC', 'Tools', 'MSVC');
  return fs
    .readdirSync(toolsRoot)
    .filter((d) => exists(hostBin(d, 'cl.exe')))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .pop();
};

/** Downloads and unpacks MSVC and the Windows SDK into tools\msvc; resolves with the toolset and SDK folder names. */
export async function installPackages(config: Toolchains['msvc']): Promise<{ msvc: string; sdk: string }> {
  const { ids, pick } = catalogue(await manifest());
  const version = pickMsvcVersion(ids, config.msvcVersion);
  if (!version) throw new Error('no MSVC ' + config.msvcVersion + ' in the Visual Studio manifest');
  const sdk = pickWindowsSdk(ids, config.sdkVersion);
  if (!sdk) throw new Error('no Windows SDK ' + config.sdkVersion + ' in the Visual Studio manifest');
  const work = mkdirp(path.join(ROOT, '.download'));
  const fetchPayload = payloadFetcher(work);

  log('Downloading the MSVC ' + version + ' compiler and C/C++ libraries ...');
  for (const part of MSVC_PARTS) {
    const p = pick('microsoft.vc.' + version + '.' + part);
    if (!p && REQUIRED_PARTS.some((r) => part.startsWith(r))) throw new Error('MSVC ' + version + ' has no ' + part);
    for (const payload of p?.payloads ?? []) await unpackVsix(await fetchPayload(payload), work);
  }
  for (const payload of pick('microsoft.visualcpp.dia.sdk')?.payloads ?? [])
    await unpackVsix(await fetchPayload(payload), work);

  // The SDK component depends on the package that holds the .msi/.cab payloads (e.g. Win11SDK_10.0.26100).
  const sdkPackage = pick(Object.keys(pick(sdk.componentId)?.dependencies ?? {})[0] ?? '');
  if (!sdkPackage?.payloads) throw new Error('the Windows SDK ' + sdk.build + ' package has no payloads');
  log('Downloading the Windows SDK ' + sdk.build + ' (headers, libraries; the biggest part) ...');
  const payload = (name: string): Payload | undefined =>
    sdkPackage.payloads!.find((p) => p.fileName.toLowerCase() === ('installers\\' + name).toLowerCase());
  const msis: string[] = [];
  for (const name of SDK_MSIS) {
    const p = payload(name);
    if (!p) throw new Error('the Windows SDK package has no ' + name);
    const file = await fetchPayload(p);
    msis.push(file);
    for (const cab of msiCabs(fs.readFileSync(file))) {
      const c = payload(cab);
      if (c) await fetchPayload(c);
    }
  }
  log('Unpacking the Windows SDK (a few minutes) ...');
  for (const msi of msis) await unpackMsi(msi);
  // msiexec /a also copies every .msi into the target; they are not needed.
  for (const name of fs.readdirSync(ROOT).filter((n) => n.toLowerCase().endsWith('.msi')))
    fs.rmSync(path.join(ROOT, name), { force: true });
  safeRemove(work, ROOT);

  const sdkVersion = fs
    .readdirSync(path.join(ROOT, 'Windows Kits', '10', 'Include'))
    .filter((d) => d.startsWith('10.0.' + sdk.build))
    .sort()
    .pop();
  if (!sdkVersion) throw new Error('the Windows SDK did not unpack (no Include\\10.0.' + sdk.build + '.*)');
  const toolset = unpackedToolset();
  if (!toolset) throw new Error('MSVC ' + version + ' did not unpack (no cl.exe under VC\\Tools\\MSVC)');
  return { msvc: toolset, sdk: sdkVersion };
}

// Unreal Engine development (toolchains.unreal): Visual Studio Community 2022 with the C++ game workload and the parts
// Unreal's build tool looks for (it finds Visual Studio through the Setup API, so the portable MSVC does not do), and
// the DirectX End-User Runtime. Real installers: they run every boot. The installers are kept in tools\ and run only
// when Microsoft's signature on them checks out; with keepInstallFiles an offline copy of the install files
// (tools\visualstudio\layout) spares later boots the download. The engine itself comes from the Epic Games Launcher.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Toolchains } from '../../../core/types.js';
import { spawnAsync } from '../../../shared/download/index.js';
import { writeJsonAtomic } from '../../../shared/io/json.js';
import { safeRemove } from '../../../shared/io/safe-remove.js';
import { dryRun } from '../../runtime/paths.js';
import { execOutput } from '../../runtime/process.js';
import { exists, mkdirp } from '../../runtime/fs.js';
import { log, warn } from '../../runtime/log.js';
import { errMsg } from '../../../core/util/errors.js';
import { downloadFile } from '../install.js';
import { tool, type ToolEnv } from '../tool-env.js';
import { MICROSOFT_SIGNER, signerOf } from './vcruntime.js';

const BOOTSTRAPPER_URL = 'https://aka.ms/vs/17/release/vs_community.exe';
const DIRECTX_URL =
  'https://download.microsoft.com/download/8/4/A/84A35BF1-DAFE-4AE8-82AF-AD2AE20B6B14/directx_Jun2010_redist.exe';

/**
 * What Epic lists for Unreal Engine 5 with Visual Studio 2022: the game workload, MSVC v143, a Windows SDK of
 * 10.0.18362 or newer, the C++ profiling tools, the .NET Framework targeting packs some engine tools build against,
 * Visual Studio's Unreal support and the Unreal Engine installer (the Epic Games Launcher).
 */
export const UNREAL_COMPONENTS = [
  'Microsoft.VisualStudio.Workload.NativeGame',
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  'Microsoft.VisualStudio.Component.Windows11SDK.22621',
  'Microsoft.VisualStudio.Component.VC.DiagnosticTools',
  'Microsoft.Net.Component.4.6.2.TargetingPack',
  'Microsoft.Net.Component.4.8.SDK',
  'Component.Unreal.Ide',
  'Component.Unreal',
] as const;

/** Visual Studio installer exit codes that mean installed: 0, and 3010 (a restart would finish it, not needed here). */
const OK_EXIT_CODES: readonly number[] = [0, 3010];
/** Free room the offline copy needs before it is made (it grows to about 10 GB). */
const LAYOUT_ROOM_BYTES = 15 * 1024 ** 3;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const VS_DIR = tool('visualstudio');
const BOOTSTRAPPER = path.join(VS_DIR, 'vs_community.exe');
const LAYOUT = path.join(VS_DIR, 'layout');
const LAYOUT_MARKER = path.join(LAYOUT, '.complete.json');
const LayoutSchema = z.object({ components: z.array(z.string()) });

const VSWHERE = path.join(
  process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
  'Microsoft Visual Studio',
  'Installer',
  'vswhere.exe',
);

/** The newest Visual Studio with the C++ compiler: its folder and version, or null. */
function installedVs(): { path: string; version: string } | null {
  if (!exists(VSWHERE)) return null;
  const ask = (property: string): string =>
    execOutput(VSWHERE, [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      property,
    ]);
  const at = ask('installationPath');
  return at ? { path: at, version: ask('installationVersion') || 'installed' } : null;
}

/** A Microsoft-signed installer kept in tools\ (downloaded once); a file with a bad signature is deleted. */
async function signedInstaller(url: string, file: string, what: string): Promise<string> {
  if (!exists(file)) {
    log('Downloading ' + what + ' ...');
    mkdirp(path.dirname(file));
    await downloadFile(url, file);
  }
  if (signerOf(file) !== MICROSOFT_SIGNER) {
    fs.rmSync(file, { force: true });
    throw new Error(path.basename(file) + ' is not signed by Microsoft; deleted it (it is downloaded again next boot)');
  }
  return file;
}

function freeBytes(dir: string): number {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return 0;
  }
}

/** The offline copy's installer when it holds every component; made or completed when there is room. */
async function layoutInstaller(bootstrapper: string, ids: readonly string[]): Promise<string | null> {
  const installer = path.join(LAYOUT, 'vs_community.exe');
  const has = (): boolean => {
    if (!exists(LAYOUT_MARKER) || !exists(installer)) return false;
    try {
      const done = LayoutSchema.parse(JSON.parse(fs.readFileSync(LAYOUT_MARKER, 'utf8')));
      return ids.every((id) => done.components.includes(id));
    } catch {
      return false;
    }
  };
  if (has()) return installer;
  if (freeBytes(mkdirp(VS_DIR)) < LAYOUT_ROOM_BYTES) {
    warn('unreal: not keeping the install files (less than 15 GB free in ' + VS_DIR + '); downloading this boot');
    return null;
  }
  log('Saving the Visual Studio install files for later boots (~10 GB, once) ...');
  fs.rmSync(LAYOUT_MARKER, { force: true });
  const code = await spawnAsync(bootstrapper, [
    '--layout',
    LAYOUT,
    '--lang',
    'en-US',
    '--quiet',
    '--wait',
    ...ids.flatMap((id) => ['--add', id]),
  ]);
  if (!OK_EXIT_CODES.includes(code) || !exists(installer)) {
    warn('unreal: saving the install files failed (exit ' + code + '); downloading this boot');
    return null;
  }
  writeJsonAtomic(LAYOUT_MARKER, { components: [...ids] });
  return installer;
}

async function installVisualStudio(config: Toolchains['unreal'], ids: readonly string[]): Promise<void> {
  const bootstrapper = await signedInstaller(BOOTSTRAPPER_URL, BOOTSTRAPPER, 'the Visual Studio installer');
  let installer: string | null = null;
  if (config.keepInstallFiles) {
    try {
      installer = await layoutInstaller(bootstrapper, ids);
    } catch (e) {
      warn('unreal: the offline copy failed (' + errMsg(e) + '); downloading this boot');
    }
  }
  log(
    'Installing Visual Studio Community 2022 with the C++ game workload' +
      (installer ? ' from the saved install files' : ' (downloads ~5-8 GB)') +
      ' ...',
  );
  const code = await spawnAsync(installer ?? bootstrapper, [
    '--quiet',
    '--wait',
    '--norestart',
    '--nocache',
    ...(installer ? ['--noWeb'] : []),
    ...ids.flatMap((id) => ['--add', id]),
  ]);
  if (!OK_EXIT_CODES.includes(code) || !installedVs())
    throw new Error(
      'the Visual Studio installer failed (exit ' + code + '); its logs are the dd_*.log files in ' + os.tmpdir(),
    );
}

/** The June 2010 DirectX End-User Runtime (D3DX, XAudio 2.7, XInput 1.3), which Epic lists for the engine. */
async function installDirectX(): Promise<void> {
  const system32 = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32');
  if (exists(path.join(system32, 'd3dx9_43.dll')) && exists(path.join(system32, 'XAudio2_7.dll'))) return;
  const redist = await signedInstaller(
    DIRECTX_URL,
    path.join(VS_DIR, 'directx_Jun2010_redist.exe'),
    'the DirectX End-User Runtime (~95 MB once)',
  );
  const unpacked = path.join(os.tmpdir(), 'directx-redist');
  safeRemove(unpacked, os.tmpdir());
  mkdirp(unpacked);
  if ((await spawnAsync(redist, ['/Q', '/T:' + unpacked])) !== 0 || !exists(path.join(unpacked, 'DXSETUP.exe')))
    throw new Error('could not unpack the DirectX End-User Runtime');
  const code = await spawnAsync(path.join(unpacked, 'DXSETUP.exe'), ['/silent']);
  safeRemove(unpacked, os.tmpdir());
  if (code !== 0) throw new Error('the DirectX End-User Runtime installer failed (exit ' + code + ')');
}

export async function setupUnreal(env: ToolEnv, config: Toolchains['unreal']): Promise<void> {
  if (!config.acceptLicense)
    throw new Error(
      'Unreal tools are installed only with toolchains.unreal.acceptLicense = true: Visual Studio Community and the DirectX End-User Runtime come under Microsoft licence terms (https://visualstudio.microsoft.com/license-terms/)',
    );
  const bad = config.components.find((id) => !ID.test(id));
  if (bad) throw new Error('toolchains.unreal.components: "' + bad + '" is not a Visual Studio component ID');
  const ids = [...new Set([...UNREAL_COMPONENTS, ...config.components])];
  if (dryRun) {
    log('(dry run) would install Visual Studio Community 2022 with ' + ids.join(', ') + ' and DirectX');
    return;
  }
  if (!installedVs()) await installVisualStudio(config, ids);
  await installDirectX();
  const vs = installedVs()!;
  env.summary.push(
    'unreal: Visual Studio Community ' +
      vs.version +
      ' (C++ game workload, Windows 11 SDK, Unreal support) at ' +
      vs.path +
      '; DirectX End-User Runtime; get the engine from the Epic Games Launcher (Start menu)',
  );
}

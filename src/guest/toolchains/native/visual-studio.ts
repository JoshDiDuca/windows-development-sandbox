// Visual Studio for the toolchains that need the real one (vs-request.ts says which): Community with the C++ game
// workload for Unreal (its build tool finds Visual Studio through the Setup API, so the portable MSVC does not do), or
// the Build Tools' C++ parts for Flutter desktop and Unity IL2CPP. A real installer: it runs every boot, on the
// sandbox's own disk, and never while sessions run (they would need a restart). The bootstrapper is kept in tools\
// and run only when Microsoft's signature checks out; with keepInstallFiles an offline copy of the install files
// (tools\visualstudio\layout) spares later boots the download.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { spawnAsync } from '../../../shared/download/index.js';
import { heavy, runInstaller } from '../../runtime/pools.js';
import { writeJsonAtomic } from '../../../shared/io/json.js';
import { robocopyFailed } from '../../../shared/io/robocopy-result.js';
import { safeRemove } from '../../../shared/io/safe-remove.js';
import { SYSTEM } from '../../../shared/system.js';
import { execOutput } from '../../runtime/process.js';
import { exists, mkdirp } from '../../runtime/fs.js';
import { log, warn } from '../../runtime/log.js';
import { logsDir } from '../../runtime/paths.js';
import { duringSession } from '../../runtime/project-context.js';
import { backgroundRunning } from '../../runtime/status.js';
import { errMsg } from '../../../core/util/errors.js';
import { SIGNERS, signedInstaller } from '../installers.js';
import { assertLocalRoom, freeBytes } from '../persisted.js';
import { tool, type ToolEnv } from '../tool-env.js';
import {
  LAYOUT_STAGING_BYTES,
  layoutNextStep,
  STAGING_RESERVE_BYTES,
  vsExitText,
  type VsRequest,
} from './vs-request.js';

export {
  BUILD_TOOLS_COMPONENTS,
  UNREAL_COMPONENTS,
  unrealUsesAutosdk,
  visualStudioWanted,
  type VsRequest,
} from './vs-request.js';

const BOOTSTRAPPERS: Readonly<Record<VsRequest['product'], { url: string; file: string; name: string }>> = {
  community: {
    url: 'https://aka.ms/vs/17/release/vs_community.exe',
    file: 'vs_community.exe',
    name: 'Visual Studio Community 2022',
  },
  buildtools: {
    url: 'https://aka.ms/vs/17/release/vs_buildtools.exe',
    file: 'vs_buildtools.exe',
    name: 'Visual Studio Build Tools 2022',
  },
};
/** What each takes on the sandbox's own disk (13 GB more must stay free: assertLocalRoom). */
const INSTALL_BYTES: Readonly<Record<VsRequest['product'], number>> = {
  community: 7 * 1024 ** 3,
  buildtools: 5 * 1024 ** 3,
};
/** Visual Studio installer exit codes that mean installed: 0, and 3010 (a restart would finish it, not needed here). */
const OK_EXIT_CODES: readonly number[] = [0, 3010];
/** Free room the offline copy needs before it is made (it grows to about 10 GB). */
const LAYOUT_ROOM_BYTES = 15 * 1024 ** 3;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const VS_DIR = tool('visualstudio');
const LayoutSchema = z.object({ components: z.array(z.string()) });

const VSWHERE = path.join(
  process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
  'Microsoft Visual Studio',
  'Installer',
  'vswhere.exe',
);

/** The newest Visual Studio (or Build Tools) with the C++ compiler: its folder and version, or null. */
export function installedVs(): { path: string; version: string } | null {
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

function layoutDir(product: VsRequest['product']): string {
  return path.join(VS_DIR, product === 'community' ? 'layout' : 'layout-buildtools');
}

/** The layout arguments of the bootstrapper (the same for the data disk and the staging folder). */
const layoutArgs = (req: VsRequest, folder: string): string[] => [
  '--layout',
  folder,
  '--lang',
  'en-US',
  '--quiet',
  '--wait',
  ...req.components.flatMap((id) => ['--add', id]),
];

/** The bootstrapper's newest log (dd_bootstrapper_*.log) in these folders, or null. */
function newestBootstrapperLog(folders: readonly string[]): string | null {
  const logs = folders.flatMap((dir) => {
    try {
      return fs
        .readdirSync(dir)
        .filter((n) => /^dd_bootstrapper_.*\.log$/i.test(n))
        .map((n) => path.join(dir, n));
    } catch {
      return []; // The folder is not there: no log in it.
    }
  });
  const stamp = (f: string): number => {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      return 0; // Gone since the listing.
    }
  };
  return logs.sort((x, y) => stamp(y) - stamp(x))[0] ?? null;
}

/** Says why the layout failed and keeps the installer's log where the sandbox's logs are. */
function reportLayoutFailure(code: number, temps: readonly string[]): void {
  warn('Visual Studio: saving the install files failed (exit ' + code + '): ' + vsExitText(code));
  const found = newestBootstrapperLog(temps);
  if (!found) return;
  const kept = path.join(logsDir, 'vs-layout-' + new Date().toISOString().slice(0, 10) + '.log');
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.copyFileSync(found, kept);
    warn('Visual Studio: the installer log is ' + found + ' (a copy is in ' + kept + ')');
  } catch (e) {
    warn('Visual Studio: the installer log is ' + found + ' (could not copy it: ' + errMsg(e) + ')');
  }
}

/** Copies a finished layout onto the data disk (never /MOV: mapped folders refuse rename-over). */
async function copyLayout(from: string, to: string): Promise<boolean> {
  mkdirp(to);
  const code = await heavy.run(() =>
    spawnAsync(SYSTEM.robocopy(), [from, to, '/E', '/COPY:DAT', '/R:1', '/W:1', '/MT:8', '/NP']),
  );
  return !robocopyFailed(code);
}

/** The offline copy's installer when it holds every component; made or completed when there is room. */
async function layoutInstaller(req: VsRequest, bootstrapper: string, lowPriority: boolean): Promise<string | null> {
  const layout = layoutDir(req.product);
  const marker = path.join(layout, '.complete.json');
  const installer = path.join(layout, BOOTSTRAPPERS[req.product].file);
  const has = (): boolean => {
    if (!exists(marker) || !exists(installer)) return false;
    try {
      const done = LayoutSchema.parse(JSON.parse(fs.readFileSync(marker, 'utf8')));
      return req.components.every((id) => done.components.includes(id));
    } catch {
      return false;
    }
  };
  const finish = (): string => {
    writeJsonAtomic(marker, { components: [...req.components] });
    return installer;
  };
  if (has()) return installer;
  if (freeBytes(mkdirp(VS_DIR)) < LAYOUT_ROOM_BYTES) {
    warn(
      'Visual Studio: not keeping the install files (less than 15 GB free in ' + VS_DIR + '); downloading this boot',
    );
    return null;
  }
  log('Saving the Visual Studio install files for later boots (~10 GB, once) ...');
  fs.rmSync(marker, { force: true });
  // The installer crashes (0xE0434352) when it builds the layout in a mapped folder, so it is built on the sandbox's
  // own disk and copied over. That runs before Visual Studio is installed and the copy on C: is deleted first, so it
  // needs room for the layout only (STAGING_RESERVE_BYTES spare), not for the layout and the install together.
  const drive = (process.env.SystemDrive ?? 'C:') + '\\';
  if (layoutNextStep(null, freeBytes(drive), STAGING_RESERVE_BYTES) !== 'stage') {
    warn(
      'Visual Studio: less than ' +
        Math.round((LAYOUT_STAGING_BYTES + STAGING_RESERVE_BYTES) / 1024 ** 3) +
        ' GB free on ' +
        drive +
        ' to build the install files; downloading this boot',
    );
    return null;
  }
  const staging = path.join(drive, 'vs-layout-staging');
  log('Building the install files on ' + drive + ' and copying them to ' + layout + ' ...');
  const stagedCode = await runInstaller(bootstrapper, layoutArgs(req, staging), { lowPriority });
  const staged = path.join(staging, BOOTSTRAPPERS[req.product].file);
  let kept = false;
  if (OK_EXIT_CODES.includes(stagedCode) && exists(staged)) {
    kept = await copyLayout(staging, layout);
    if (!kept) warn('Visual Studio: copying the install files to ' + layout + ' failed');
  } else {
    reportLayoutFailure(stagedCode, [os.tmpdir()]);
  }
  safeRemove(staging, drive);
  return kept && exists(installer) ? finish() : null;
}

/** The bootstrapper, downloaded (net pool) and checked; kept in tools\ for later boots. */
function bootstrapperFor(req: VsRequest): Promise<string> {
  const boot = BOOTSTRAPPERS[req.product];
  return signedInstaller(boot.url, path.join(VS_DIR, boot.file), 'the ' + boot.name + ' installer', SIGNERS.microsoft);
}

/** Downloads the bootstrapper now, so the install later starts without waiting for it. */
export async function prefetchVisualStudio(req: VsRequest): Promise<void> {
  if (!req.accepted || installedVs()) return;
  await bootstrapperFor(req);
}

async function install(req: VsRequest, keepInstallFiles: boolean, lowPriority: boolean): Promise<void> {
  const boot = BOOTSTRAPPERS[req.product];
  const bootstrapper = await bootstrapperFor(req);
  let installer: string | null = null;
  if (keepInstallFiles) {
    try {
      installer = await layoutInstaller(req, bootstrapper, lowPriority);
    } catch (e) {
      warn('Visual Studio: the offline copy failed (' + errMsg(e) + '); downloading this boot');
    }
  }
  const run = (from: string, offline: boolean): Promise<number> =>
    runInstaller(
      from,
      [
        '--quiet',
        '--wait',
        '--norestart',
        '--nocache',
        ...(offline ? ['--noWeb'] : []),
        ...req.components.flatMap((id) => ['--add', id]),
      ],
      { lowPriority },
    );
  log('Installing ' + boot.name + (installer ? ' from the saved install files' : ' (downloads ~5-8 GB)') + ' ...');
  let code = await run(installer ?? bootstrapper, installer !== null);
  if (installer && (!OK_EXIT_CODES.includes(code) || !installedVs())) {
    // The saved copy is on the shared data disk: if installing from it fails, this boot downloads instead.
    warn('Visual Studio: installing from the saved install files failed (' + vsExitText(code) + '); downloading');
    code = await run(bootstrapper, false);
  }
  if (!OK_EXIT_CODES.includes(code) || !installedVs())
    throw new Error(
      'the Visual Studio installer failed (exit ' +
        code +
        ': ' +
        vsExitText(code) +
        '); its logs are the dd_*.log files in ' +
        os.tmpdir(),
    );
}

/** Visual Studio as asked for: installed at boot when it is not there yet; its folder and version. */
export async function ensureVisualStudio(
  env: ToolEnv,
  req: VsRequest,
  o: { keepInstallFiles: boolean; lowPriority?: boolean },
): Promise<{ path: string; version: string }> {
  if (!req.accepted)
    throw new Error(
      'Visual Studio (for ' +
        req.for.join(', ') +
        ') is installed only with ' +
        req.licence +
        ' = true: it comes under Microsoft licence terms (https://visualstudio.microsoft.com/license-terms/)',
    );
  const bad = req.components.find((id) => !ID.test(id));
  if (bad) throw new Error('"' + bad + '" is not a Visual Studio component ID');
  const have = installedVs();
  if (have) return have;
  if (duringSession())
    throw new Error(
      backgroundRunning('Visual Studio')
        ? 'Visual Studio is still installing in the background; it is ready in a few minutes'
        : 'Visual Studio is installed when the sandbox starts: restart it (sandbox restart) to get it',
    );
  assertLocalRoom(INSTALL_BYTES[req.product], BOOTSTRAPPERS[req.product].name);
  await install(req, o.keepInstallFiles, o.lowPriority === true);
  const vs = installedVs()!;
  env.summary.push(
    'visual studio: ' +
      BOOTSTRAPPERS[req.product].name +
      ' ' +
      vs.version +
      ' at ' +
      vs.path +
      ' (for ' +
      req.for.join(', ') +
      ')',
  );
  return vs;
}

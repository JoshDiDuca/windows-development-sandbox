// Visual Studio for the toolchains that need the real one (vs-request.ts says which): Community with the C++ game
// workload for Unreal (its build tool finds Visual Studio through the Setup API, so the portable MSVC does not do), or
// the Build Tools' C++ parts. Installed once with Microsoft's installer (the bootstrapper is kept in tools\ and run
// only when Microsoft's signature checks out), then saved on the data disk (tools\visualstudio\persist, vs-persist.ts
// says what goes where). Later boots put the saved copy back in seconds: no download, no install, nothing big on C:.
// Never installed while sessions run (they would need a restart); putting a saved copy back only adds to the machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { heavy, runInstaller } from '../../runtime/pools.js';
import { readValid, writeJsonAtomic } from '../../../shared/io/json.js';
import { safeRemove } from '../../../shared/io/safe-remove.js';
import { execOutput, runScriptWithJsonAsync } from '../../runtime/process.js';
import { exists, mkdirp } from '../../runtime/fs.js';
import { log, warn } from '../../runtime/log.js';
import { duringSession } from '../../runtime/project-context.js';
import { backgroundRunning } from '../../runtime/status.js';
import { errMsg } from '../../../core/util/errors.js';
import { SIGNERS, signedInstaller } from '../installers.js';
import { assertLocalRoom, freeBytes } from '../persisted.js';
import { tool, type ToolEnv } from '../tool-env.js';
import { vsExitText, type VsRequest } from './vs-request.js';
import {
  MARKER_FILE,
  markerFrom,
  newestInstance,
  persistCovers,
  productFolder,
  restoreInput,
  rewriteInstanceState,
  SaveResultSchema,
  saveInput,
  VsPersistMarkerSchema,
  winPlaces,
  type VsPersistMarker,
} from './vs-persist.js';

export {
  BUILD_TOOLS_COMPONENTS,
  UNREAL_BUILD_TOOLS_COMPONENTS,
  UNREAL_COMPONENTS,
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
const GB = 1024 ** 3;
/** What each takes on the sandbox's own disk while it is installed (13 GB more must stay free: assertLocalRoom). */
const INSTALL_BYTES: Readonly<Record<VsRequest['product'], number>> = {
  community: 7 * GB,
  buildtools: 5 * GB,
};
/** Free room on the data disk the saved copy needs (Community with the Windows SDK is about 6.5 GB). */
const SAVE_ROOM_BYTES = 8 * GB;
/** Visual Studio installer exit codes that mean installed: 0, and 3010 (a restart would finish it, not needed here). */
const OK_EXIT_CODES: readonly number[] = [0, 3010];
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const VS_DIR = tool('visualstudio');
const PERSIST_DIR = path.join(VS_DIR, 'persist');
const MARKER = path.join(PERSIST_DIR, MARKER_FILE);
/** What older versions left in tools\visualstudio: the offline install files, which the installer never finished. */
const LEFTOVERS = ['layout', 'layout-buildtools', 'tmp'];
const PLACES = winPlaces(process.env);
const INSTALLER_DIR = path.join(PLACES.programFilesX86, 'Microsoft Visual Studio', 'Installer');
const VSWHERE = path.join(INSTALLER_DIR, 'vswhere.exe');

const VswhereSchema = z.array(
  z.looseObject({
    instanceId: z.string(),
    installationPath: z.string(),
    installationVersion: z.string().optional(),
  }),
);

export interface InstalledVs {
  readonly path: string;
  readonly version: string;
  readonly instanceId: string;
}

/** The newest Visual Studio (or Build Tools) with the C++ compiler, installed or put back: where it is, or null. */
export function installedVs(): InstalledVs | null {
  if (!exists(VSWHERE)) return null;
  const out = execOutput(VSWHERE, [
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-format',
    'json',
    '-utf8',
  ]);
  let found: unknown;
  try {
    found = JSON.parse(out || '[]');
  } catch {
    return null; // vswhere printed something else (it failed): no Visual Studio to use.
  }
  const first = newestInstance(VswhereSchema.safeParse(found).data ?? []);
  return first
    ? { path: first.installationPath, version: first.installationVersion ?? 'installed', instanceId: first.instanceId }
    : null;
}

/** The saved copy when it is complete and serves this request, else null. */
function savedCopy(req: VsRequest): VsPersistMarker | null {
  const marker = readValid(VsPersistMarkerSchema, MARKER);
  if (!marker || !persistCovers(marker, req)) return null;
  const product = path.join(PERSIST_DIR, productFolder(marker.product));
  const files = [
    path.join(product, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'),
    path.join(PERSIST_DIR, 'instance', 'state.json'),
    path.join(PERSIST_DIR, 'Installer', 'vswhere.exe'),
    path.join(PERSIST_DIR, 'Setup', 'x64', 'Microsoft.VisualStudio.Setup.Configuration.Native.dll'),
  ];
  return files.every(exists) ? marker : null;
}

/** Whether a later boot only puts Visual Studio back (quick enough to wait for) instead of installing it. */
export function visualStudioSaved(req: VsRequest): boolean {
  return savedCopy(req) !== null;
}

/** Puts the saved copy back: its fixed-path folders, the instance, the registry; then vswhere must find it. */
async function restoreSaved(marker: VsPersistMarker): Promise<InstalledVs> {
  const started = Date.now();
  log('Visual Studio: putting back the copy saved in ' + PERSIST_DIR + ' ...');
  const plan = restoreInput(marker, PERSIST_DIR, PLACES);
  await heavy.run(() => runScriptWithJsonAsync('restore-visual-studio.ps1', 'PlanFile', plan));
  const vs = installedVs();
  if (!vs) throw new Error('vswhere does not find the Visual Studio that was put back');
  log(
    'Visual Studio ' + vs.version + ' is back in ' + Math.round((Date.now() - started) / 1000) + ' s (' + vs.path + ')',
  );
  return vs;
}

/**
 * Saves a fresh install on the data disk for later boots (once). The marker goes last, after the instance's state is
 * moved to the saved folder; a failure leaves no marker and only costs the next boot another install.
 */
async function saveInstall(req: VsRequest, vs: InstalledVs, lowPriority: boolean): Promise<void> {
  const free = freeBytes(mkdirp(PERSIST_DIR));
  if (free < SAVE_ROOM_BYTES) {
    warn(
      'Visual Studio: not saved for later boots (' +
        (free / GB).toFixed(1) +
        ' GB free in ' +
        PERSIST_DIR +
        ', it needs 8 GB); the next boot installs it again',
    );
    return;
  }
  fs.rmSync(MARKER, { force: true });
  log('Saving Visual Studio in ' + PERSIST_DIR + ' for later boots (~6.5 GB, once) ...');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vs-'));
  const resultFile = path.join(dir, 'result.json');
  try {
    const plan = saveInput(
      { product: req.product, installationPath: vs.path, instanceId: vs.instanceId },
      PERSIST_DIR,
      PLACES,
      resultFile,
    );
    await heavy.run(() =>
      runScriptWithJsonAsync('save-visual-studio.ps1', 'PlanFile', plan, lowPriority ? ['-LowPriority'] : []),
    );
    const result = readValid(SaveResultSchema, resultFile);
    if (!result) throw new Error('the save script left no result');
    const state = path.join(PERSIST_DIR, 'instance', 'state.json');
    const saved = path.join(PERSIST_DIR, productFolder(req.product));
    fs.writeFileSync(state, rewriteInstanceState(fs.readFileSync(state, 'utf8'), vs.path, saved), 'utf8');
    // One product is kept: a Build Tools copy goes when Community replaces it (and the other way round).
    safeRemove(path.join(PERSIST_DIR, productFolder(req.product === 'community' ? 'buildtools' : 'community')), VS_DIR);
    writeJsonAtomic(
      MARKER,
      markerFrom(
        req,
        { installationPath: vs.path, instanceId: vs.instanceId, version: vs.version },
        result,
        new Date().toISOString(),
      ),
    );
    log('Visual Studio is saved: later boots put it back in seconds');
  } catch (e) {
    warn('Visual Studio: saving it for later boots failed (' + errMsg(e) + '); the next boot installs it again');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The bootstrapper, downloaded (net pool) and checked; kept in tools\ for later installs. */
function bootstrapperFor(req: VsRequest): Promise<string> {
  const boot = BOOTSTRAPPERS[req.product];
  return signedInstaller(boot.url, path.join(VS_DIR, boot.file), 'the ' + boot.name + ' installer', SIGNERS.microsoft);
}

/** Downloads the bootstrapper now, so the install later starts without waiting (not needed with a saved copy). */
export async function prefetchVisualStudio(req: VsRequest): Promise<void> {
  if (!req.accepted || installedVs() || savedCopy(req)) return;
  await bootstrapperFor(req);
}

async function install(req: VsRequest, lowPriority: boolean): Promise<void> {
  const boot = BOOTSTRAPPERS[req.product];
  const bootstrapper = await bootstrapperFor(req);
  log('Installing ' + boot.name + ' (downloads ~5-8 GB, once: it is saved on the data disk afterwards) ...');
  const code = await runInstaller(
    bootstrapper,
    ['--quiet', '--wait', '--norestart', '--nocache', ...req.components.flatMap((id) => ['--add', id])],
    { lowPriority },
  );
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

/** Removes what older versions left in tools\visualstudio (best effort). */
function removeLeftovers(): void {
  for (const name of LEFTOVERS) {
    const dir = path.join(VS_DIR, name);
    try {
      if (exists(dir)) safeRemove(dir, VS_DIR);
    } catch (e) {
      warn('Visual Studio: could not remove ' + dir + ' (' + errMsg(e) + ')');
    }
  }
}

/** Visual Studio as asked for: put back from the data disk, or installed (and saved) the first time. */
export async function ensureVisualStudio(
  env: ToolEnv,
  req: VsRequest,
  o: { lowPriority?: boolean } = {},
): Promise<InstalledVs> {
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
  removeLeftovers();
  const name = BOOTSTRAPPERS[req.product].name;
  const done = (vs: InstalledVs, how: string): InstalledVs => {
    env.append.push(INSTALLER_DIR);
    env.summary.push(
      'visual studio: ' + name + ' ' + vs.version + ' at ' + vs.path + ' (' + how + '; for ' + req.for.join(', ') + ')',
    );
    return vs;
  };
  const have = installedVs();
  if (have) return done(have, 'installed');
  const saved = savedCopy(req);
  if (saved) {
    try {
      return done(await restoreSaved(saved), 'kept on the data disk');
    } catch (e) {
      warn('Visual Studio: putting the saved copy back failed (' + errMsg(e) + '); installing it again');
    }
  }
  if (duringSession())
    throw new Error(
      backgroundRunning('Visual Studio')
        ? 'Visual Studio is still installing in the background; it is ready in a few minutes'
        : 'Visual Studio is installed when the sandbox starts: restart it (sandbox restart) to get it',
    );
  assertLocalRoom(INSTALL_BYTES[req.product], name);
  await install(req, o.lowPriority === true);
  const vs = installedVs()!;
  await saveInstall(req, vs, o.lowPriority === true);
  return done(vs, 'installed, saved for later boots');
}

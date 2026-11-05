// Unreal Engine development, machine-wide (toolchains.unreal, once per boot): the DirectX End-User Runtime the engine
// lists and the Epic Games Launcher (real installers: they run every boot), the launcher pointed at the data disk for
// engines and given back the engines it installed there, the Windows SDK debuggers for crash dumps, and a check that
// UnrealBuildTool finds Visual Studio the way it looks (the Setup Configuration API). Visual Studio itself is its own
// step (visual-studio.ts), which the plan runs first; each project's engine is set up by engines/unreal-engines.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Toolchains } from '../../../core/types.js';
import { errMsg } from '../../../core/util/errors.js';
import { readValid } from '../../../shared/io/json.js';
import { safeRemove } from '../../../shared/io/safe-remove.js';
import { VsSetupReportSchema, vsVerdict, type VsVerdict } from '../../../shared/unreal/index.js';
import { runInstaller } from '../../runtime/pools.js';
import { dryRun } from '../../runtime/paths.js';
import { exists, mkdirp } from '../../runtime/fs.js';
import { log, warn } from '../../runtime/log.js';
import { runScriptAsync } from '../../runtime/process.js';
import { ensureLauncher, fetchLauncher, placeEngines, restoreLauncherItems } from '../engines/epic-launcher.js';
import { resetUnrealStatus, updateUnrealStatus } from '../engines/unreal-status.js';
import { SIGNERS, signedInstaller } from '../installers.js';
import type { ToolCtx } from '../step.js';
import { tool, type ToolEnv } from '../tool-env.js';
import { ensureDebuggers } from './debuggers.js';
import { installedVs } from './visual-studio.js';

export { UNREAL_COMPONENTS } from './vs-request.js';

const DIRECTX_URL =
  'https://download.microsoft.com/download/8/4/A/84A35BF1-DAFE-4AE8-82AF-AD2AE20B6B14/directx_Jun2010_redist.exe';

/** The June 2010 DirectX End-User Runtime (D3DX, XAudio 2.7, XInput 1.3), which Epic lists for the engine. */
const directXInstalled = (): boolean => {
  const system32 = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32');
  return exists(path.join(system32, 'd3dx9_43.dll')) && exists(path.join(system32, 'XAudio2_7.dll'));
};

/** The redistributable (downloaded once, signature checked). */
const directXRedist = (): Promise<string> =>
  signedInstaller(
    DIRECTX_URL,
    path.join(tool('visualstudio'), 'directx_Jun2010_redist.exe'),
    'the DirectX End-User Runtime (~95 MB once)',
    SIGNERS.microsoft,
  );

/** Downloads the DirectX redistributable and the launcher ahead of the install (only once the licence is accepted). */
export async function fetchDirectX(config: Toolchains['unreal']): Promise<void> {
  if (!config.acceptLicense) return;
  if (!directXInstalled()) await directXRedist();
  await fetchLauncher();
}

async function installDirectX(): Promise<void> {
  if (directXInstalled()) return;
  const redist = await directXRedist();
  const unpacked = path.join(os.tmpdir(), 'directx-redist');
  safeRemove(unpacked, os.tmpdir());
  mkdirp(unpacked);
  if ((await runInstaller(redist, ['/Q', '/T:' + unpacked])) !== 0 || !exists(path.join(unpacked, 'DXSETUP.exe')))
    throw new Error('could not unpack the DirectX End-User Runtime');
  const code = await runInstaller(path.join(unpacked, 'DXSETUP.exe'), ['/silent']);
  safeRemove(unpacked, os.tmpdir());
  if (code !== 0) throw new Error('the DirectX End-User Runtime installer failed (exit ' + code + ')');
}

/** What UnrealBuildTool's way of finding Visual Studio finds (scripts\get-vs-setup.ps1 calls the Setup API). */
async function checkVisualStudio(): Promise<VsVerdict> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vs-check-'));
  const file = path.join(dir, 'result.json');
  try {
    await runScriptAsync('get-vs-setup.ps1', ['-ResultFile', file]);
    const report = readValid(VsSetupReportSchema, file);
    return report ? vsVerdict(report) : { ok: false, text: 'the check left no result' };
  } catch (e) {
    return { ok: false, text: 'the check failed: ' + errMsg(e) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs one part, warning (not failing the step) when it does not work. */
async function part<T>(what: string, work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (e) {
    warn('Unreal: ' + what + ' failed (' + errMsg(e) + ')');
    return fallback;
  }
}

export async function setupUnreal(env: ToolEnv, config: Toolchains['unreal'], _ctx: ToolCtx): Promise<void> {
  if (!config.acceptLicense)
    throw new Error(
      "Unreal tools are installed only with toolchains.unreal.acceptLicense = true: Visual Studio Community and the DirectX End-User Runtime come under Microsoft licence terms (https://visualstudio.microsoft.com/license-terms/), the Epic Games Launcher under Epic's (https://www.epicgames.com/site/eula)",
    );
  if (dryRun) {
    log('(dry run) would install the DirectX End-User Runtime and the Epic Games Launcher');
    return;
  }
  resetUnrealStatus();
  await part('the DirectX End-User Runtime', installDirectX, undefined);
  const launcher = await part('the Epic Games Launcher', ensureLauncher, null);
  // Before anyone opens the launcher: engines go to the data disk, and it knows the ones it installed there before.
  const place = placeEngines(config.persistEngines);
  if (config.persistEngines) await part("restoring the launcher's engines", async () => restoreLauncherItems(), []);
  if (place.problem) {
    warn('Unreal: ' + place.problem);
    env.summary.push('UNREAL: ' + place.problem);
  }
  const debuggers = await part('the Windows SDK debuggers', ensureDebuggers, null);
  if (debuggers) env.append.push(debuggers);
  const vs = installedVs();
  const check = vs ? await checkVisualStudio() : { ok: false, text: 'no Visual Studio with the C++ tools' };
  if (!check.ok) warn('Unreal: UnrealBuildTool would not find a compiler: ' + check.text);
  else log('Unreal: UnrealBuildTool finds ' + check.text);
  const kept = Boolean(vs && /\\visualstudio\\persist\\/i.test(vs.path + '\\'));
  updateUnrealStatus((s) => ({
    ...s,
    launcher: {
      installed: launcher !== null,
      exe: launcher,
      installLocation: place.installLocation,
      problem: place.problem,
      freeBytes: place.freeBytes,
      needBytes: place.needBytes,
    },
    visualStudio: {
      version: vs?.version ?? '',
      path: vs?.path ?? '',
      how: vs ? (kept ? 'kept on the data disk' : 'installed in this sandbox') : '',
      check: check.text,
      ok: check.ok,
    },
    debugger: debuggers ? path.join(debuggers, 'cdb.exe') : null,
  }));
  env.summary.push(
    'unreal tools: ' +
      (vs
        ? 'Visual Studio ' +
          vs.version +
          (check.ok ? ' (UnrealBuildTool finds it)' : ' (UnrealBuildTool would NOT find it)')
        : 'no Visual Studio') +
      ', DirectX End-User Runtime' +
      (launcher ? ', Epic Games Launcher' : '') +
      (debuggers ? ', cdb/windbg' : ''),
  );
}

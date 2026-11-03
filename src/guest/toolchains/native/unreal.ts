// Unreal Engine development (toolchains.unreal): the DirectX End-User Runtime the engine lists (a real installer: it
// runs every boot), then the engines (engines/unreal-engines.ts: the launcher's install folder on the data disk, PC
// engines from pcInstalls, the derived data cache). Visual Studio Community with the C++ game workload is its own step
// (visual-studio.ts), which the plan runs first. The engine itself comes from the Epic Games Launcher or its source.
import os from 'node:os';
import path from 'node:path';
import type { Toolchains } from '../../../core/types.js';
import { runInstaller } from '../../runtime/pools.js';
import { safeRemove } from '../../../shared/io/safe-remove.js';
import { dryRun } from '../../runtime/paths.js';
import { exists, mkdirp } from '../../runtime/fs.js';
import { log } from '../../runtime/log.js';
import { setupUnrealEngines } from '../engines/unreal-engines.js';
import { SIGNERS, signedInstaller } from '../installers.js';
import type { ToolCtx } from '../step.js';
import { tool, type ToolEnv } from '../tool-env.js';
import { setupAutosdk } from './autosdk.js';
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

/** Downloads the DirectX redistributable ahead of the install (only once the licence is accepted). */
export async function fetchDirectX(config: Toolchains['unreal']): Promise<void> {
  if (config.acceptLicense && !directXInstalled()) await directXRedist();
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

export async function setupUnreal(env: ToolEnv, config: Toolchains['unreal'], ctx: ToolCtx): Promise<void> {
  if (!config.acceptLicense)
    throw new Error(
      'Unreal tools are installed only with toolchains.unreal.acceptLicense = true: Visual Studio Community and the DirectX End-User Runtime come under Microsoft licence terms (https://visualstudio.microsoft.com/license-terms/)',
    );
  if (dryRun) {
    log('(dry run) would install the DirectX End-User Runtime and set up the Unreal engines');
    return;
  }
  await installDirectX();
  if (config.visualStudio === 'autosdk') await setupAutosdk(env);
  await setupUnrealEngines(env, config, ctx);
  const vs = installedVs();
  env.summary.push(
    'unreal: ' +
      (vs ? 'Visual Studio ' + vs.version + ' (C++ game workload, Windows 11 SDK, Unreal support); ' : '') +
      'DirectX End-User Runtime; get the engine from the Epic Games Launcher (Start menu)',
  );
}

// Unreal without Visual Studio (toolchains.unreal.visualStudio = "autosdk", experimental): an AutoSDK tree made from
// the portable MSVC (tools\msvc), at tools\unreal\autosdk, which UnrealBuildTool finds through UE_SDKS_ROOT. Made of
// copies (mapped folders refuse links), once; kept between sandboxes. The editor's Visual Studio integration is not
// available.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic } from '../../../shared/io/json.js';
import { robocopyFailed } from '../../../shared/io/robocopy-result.js';
import { spawnAsync } from '../../../shared/download/index.js';
import { SYSTEM } from '../../../shared/system.js';
import { exists, mkdirp } from '../../runtime/fs.js';
import { log } from '../../runtime/log.js';
import { tool, type ToolEnv } from '../tool-env.js';
import { hasCompiler, readInstalled, ROOT as MSVC_ROOT } from './msvc/tree.js';
import { autosdkLayout } from './vs-request.js';

const AUTOSDK_DIR = tool('unreal', 'autosdk');
const MARKER = path.join(AUTOSDK_DIR, '.complete.json');
const MarkerSchema = z.object({ msvc: z.string(), sdk: z.string() });

function builtFor(msvc: string, sdk: string): boolean {
  try {
    const done = MarkerSchema.parse(JSON.parse(fs.readFileSync(MARKER, 'utf8')));
    return done.msvc === msvc && done.sdk === sdk;
  } catch {
    return false; // No marker, or a half-written one: build again.
  }
}

/** Makes the AutoSDK tree from the portable MSVC when it is not there for this MSVC and SDK, and points Unreal at it. */
export async function setupAutosdk(env: ToolEnv): Promise<void> {
  const msvc = readInstalled();
  if (!msvc || !hasCompiler(msvc.msvc))
    throw new Error(
      'toolchains.unreal.visualStudio = "autosdk" builds from the portable MSVC, which is not installed (is toolchains.msvc off?)',
    );
  if (!builtFor(msvc.msvc, msvc.sdk)) {
    log('Making the Unreal AutoSDK from MSVC ' + msvc.msvc + ' (~2 GB, once) ...');
    fs.rmSync(MARKER, { force: true });
    for (const pair of autosdkLayout(MSVC_ROOT, msvc.msvc, msvc.sdk, AUTOSDK_DIR)) {
      mkdirp(pair.to);
      const code = await spawnAsync(SYSTEM.robocopy(), [pair.from, pair.to, '/E', '/COPY:DAT', '/R:1', '/W:1', '/NP']);
      if (robocopyFailed(code))
        throw new Error('could not copy ' + pair.from + ' into the AutoSDK (robocopy ' + code + ')');
    }
    writeJsonAtomic(MARKER, { msvc: msvc.msvc, sdk: msvc.sdk });
  }
  if (!exists(MARKER)) throw new Error('the Unreal AutoSDK was not completed');
  env.vars['UE_SDKS_ROOT'] = AUTOSDK_DIR;
  env.summary.push(
    'unreal autosdk: MSVC ' + msvc.msvc + ', Windows SDK ' + msvc.sdk + ' (UE_SDKS_ROOT=' + AUTOSDK_DIR + ')',
  );
}

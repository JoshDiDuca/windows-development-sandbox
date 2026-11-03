// New shells (PowerShell, PowerShell 7, cmd, Git Bash) start with the current machine PATH, whatever their parent had:
// pathsync.exe is built and the shells' start-up files call it (sandbox\scripts\install-shell-path.ps1).
import fs from 'node:fs';
import path from 'node:path';
import { dryRun, isWin, localDir, testMode, toolsDir } from '../runtime/paths.js';
import { mkdirp } from '../runtime/fs.js';
import { ensureCompiled } from '../runtime/csc.js';
import { runScriptAsync } from '../runtime/process.js';

export async function installShellPath(): Promise<void> {
  if (!isWin || dryRun || testMode) return;
  const helper = path.join(mkdirp(path.join(localDir, 'bin')), 'pathsync.exe');
  fs.copyFileSync(ensureCompiled('pathsync'), helper);
  await runScriptAsync('install-shell-path.ps1', [
    '-Helper',
    helper,
    '-PwshDir',
    path.join(toolsDir, 'pwsh'),
    '-GitRoot',
    path.join(toolsDir, 'git'),
  ]);
}

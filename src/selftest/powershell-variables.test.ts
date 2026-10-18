// PowerShell variable hygiene: scripts/check-variables.ps1 reads every .ps1 of the repository with the PowerShell 5.1
// parser and reports automatic variables used as ordinary ones, names that differ from a parameter only in case,
// preference variables leaking out of functions, names a dot-sourced file shares with its caller, and reads before an
// assignment. It must find nothing in the repository, and it must still find each kind in a deliberately bad file.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isWin } from '../core/util/index.js';
import { SYSTEM } from '../shared/system.js';
import type { Suite } from './support/suite.js';

const SKIP_FOLDERS = new Set(['node_modules', 'dist', '.git', '.claude']);

function powershellFiles(folder: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_FOLDERS.has(entry.name)) powershellFiles(full, found);
    } else if (entry.name.endsWith('.ps1')) found.push(full);
  }
  return found;
}

function check(checker: string, files: readonly string[]): { status: number | null; report: string } {
  const run = spawnSync(
    SYSTEM.powershell(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', checker, ...files],
    { encoding: 'utf8', windowsHide: true, timeout: 180000 },
  );
  return { status: run.status, report: run.stderr.trim() };
}

const BAD_SCRIPT = [
  'param([switch]$AutoUpdate)',
  '$autoUpdate = 1',
  '$matches = 3',
  'foreach ($input in 1, 2) { }',
  'function F { $global:ErrorActionPreference = "Stop"; $env:SOME_VARIABLE = 1; $x = $notSetAnywhere }',
  '',
].join('\r\n');

export const powershellVariablesSuite: Suite = {
  name: 'ps-variables',
  title: 'PowerShell scripts: no automatic-variable, case or scope collisions',
  run: (t) => {
    const checker = path.join(t.packageRoot, 'scripts', 'check-variables.ps1');
    if (!isWin || !fs.existsSync(checker)) {
      t.skip('needs Windows PowerShell and scripts/check-variables.ps1');
      return;
    }

    t.section('the checker finds each kind of collision');
    const bad = t.at('bad-variables.ps1');
    fs.writeFileSync(bad, BAD_SCRIPT);
    const caught = check(checker, [bad]);
    t.equal(caught.status, 1, 'a bad script fails the check');
    for (const kind of ['automatic', 'case', 'preference', 'env', 'unassigned', 'script-scope']) {
      t.check(caught.report.includes(': ' + kind + ':'), 'it reports "' + kind + '"');
    }

    t.section('the repository scripts are clean');
    const files = ['native', 'sandbox', 'scripts']
      .map((folder) => path.join(t.packageRoot, folder))
      .filter((folder) => fs.existsSync(folder))
      .flatMap((folder) => powershellFiles(folder));
    t.check(files.length > 0, 'it found the scripts (' + files.length + ')');
    const clean = check(checker, files);
    t.equal(clean.status, 0, 'no collisions' + (clean.report ? ':\n' + clean.report : ''));
  },
};

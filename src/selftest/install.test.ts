// scripts/install.ps1: it parses under Windows PowerShell 5.1 and writes the same shims as shimText() in
// src/host/install/shims.ts. Nothing is installed: the script prints a shim with -PrintShim and stops.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { shimText } from '../host/install/index.js';
import { nativeScript } from '../host/native.js';
import { SYSTEM } from '../shared/system.js';
import type { Suite } from './support/suite.js';
import type { Harness } from './support/harness.js';

/** The text install.ps1 writes for one shim, run by powershell.exe as a script file. */
function printedShim(script: string, kind: 'cmd' | 'sh', name: string, target?: string): string {
  const spec = kind + ':' + name + (target ? ':' + target : '');
  const run = spawnSync(
    SYSTEM.powershell(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-PrintShim', spec],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 },
  );
  return run.status === 0 ? run.stdout : 'exit ' + run.status + ': ' + run.stderr;
}

function installerText(t: Harness, script: string): void {
  t.section('install.ps1');
  const source = fs.readFileSync(script, 'utf8');
  t.check(/^\[CmdletBinding\(/m.test(source) && /^param\(/m.test(source), 'it starts with the options (param block)');
  t.check(
    !/[^\x00-\x7f]/.test(source),
    'it is plain ASCII (Windows PowerShell 5.1 reads a file without a BOM as ANSI)',
  );
  t.check(source.includes('\r\n') && !/[^\r]\n/.test(source), 'it has Windows line endings');

  const parse = spawnSync(SYSTEM.powershell(), nativeScript('check-syntax.ps1', ['-Path', script]), {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  });
  t.equal(parse.status, 0, 'it parses under the PowerShell 5.1 parser' + (parse.stderr ? ': ' + parse.stderr : ''));

  t.section('install.ps1: the storage helper (installs for everyone only)');
  t.check(
    /\[switch\]\$ContainedStorageHelper,/.test(source) &&
      /\[switch\]\$NoContainedStorageHelper,/.test(source) &&
      source.includes("$env:WDS_STORAGEHELPER -eq '1'"),
    'it has -ContainedStorageHelper / -NoContainedStorageHelper (and WDS_STORAGEHELPER)',
  );
  const helperStep = source.slice(source.indexOf('# 8b.'), source.indexOf('# 9. Automatic updates'));
  t.check(
    helperStep.includes('if ($machine) {') &&
      helperStep.includes('set-storage-helper.ps1') &&
      helperStep.includes('-Install -GroupSid $groupSid -InstallRoot $toolFolder'),
    'the helper is installed by its own script, only for an install for everyone, for the group',
  );
  t.check(
    helperStep.includes("Ask 'Install a small Windows service") && helperStep.includes('$record.storageHelper'),
    'asked once (default no), then the answer in install.json is kept',
  );
  t.check(
    source.includes('storageHelper = [bool]$helperOn') && /'staging', 'helper', 'active-version'/.test(source),
    'install.json records it, and uninstall removes the helper folder',
  );
  t.check(
    /if \(\$machine\) \{ Remove-StorageHelper/.test(source),
    'uninstall stops and deletes the service (and dismounts what it mounted) first',
  );

  t.section('install.ps1: the shims equal shimText()');
  const cases: [string, string | undefined][] = [
    ['sandbox', undefined],
    ['claude-sbx', 'dist/bin/claude-sbx.js'],
    ['agent-sandbox', 'dist/bin/agent-sandbox.js'],
  ];
  for (const [name, target] of cases)
    for (const kind of ['cmd', 'sh'] as const)
      t.equal(
        printedShim(script, kind, name, target),
        shimText(name, kind, target),
        name + '.' + kind + ' is identical',
      );
  t.includes(printedShim(script, 'cmd', 'x y'), 'exit', 'a name that is not a command name is refused');
}

export const installSuite: Suite = {
  name: 'install',
  title: 'the installer script: parses, writes the same shims as the program',
  run: (t) => {
    const script = path.join(t.packageRoot, 'scripts', 'install.ps1');
    if (!fs.existsSync(script)) {
      t.skip('scripts/install.ps1 is not part of the installed package');
      return;
    }
    installerText(t, script);
  },
};

// Builds the sandbox's small C# helpers (sandbox\csharp: PtyHost.cs, GitShim.cs, VsWhere.cs, ...) with the .NET
// Framework compiler that ships with Windows.
//
// The helpers are compiled onto the sandbox's own disk (wiped on close) on every boot, never cached in persistent
// storage: a tampered ptyhost.exe there would survive the wipe and see every keystroke typed from this PC.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { exists, mkdirp } from './fs.js';
import { launchDir } from './paths.js';

const CSC = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

/** Each helper's source in sandbox\csharp. */
const SOURCES = {
  ptyhost: 'PtyHost.cs',
  gitshim: 'GitShim.cs',
  vswhere: 'VsWhere.cs',
  openssl: 'OpenSsl.cs',
  cargoshim: 'CargoShim.cs',
  linkgate: 'LinkGate.cs',
  pathsync: 'PathSync.cs',
  memgov: 'MemGov.cs',
} as const;

export type Helper = keyof typeof SOURCES;

function sourceOf(name: Helper): string {
  return path.join(launchDir, 'sandbox', 'csharp', SOURCES[name]);
}

function sourceHash(name: Helper): string {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(sourceOf(name)))
    .digest('hex')
    .slice(0, 12);
}

/** %TEMP%\agent-sandbox\<name>-<hash>.exe, compiled from this launch's source the first time it is needed. */
export function ensureCompiled(name: Helper): string {
  const exe = path.join(os.tmpdir(), 'agent-sandbox', name + '-' + sourceHash(name) + '.exe');
  if (exists(exe)) return exe;
  if (!exists(CSC))
    throw new Error('The .NET Framework C# compiler was not found at ' + CSC + ' (it ships with Windows 10/11).');
  mkdirp(path.dirname(exe));
  const result = spawnSync(CSC, ['/nologo', '/optimize', '/target:exe', '/out:' + exe, sourceOf(name)], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0)
    throw new Error(
      'Compiling ' + name + ' failed: ' + ((result.stdout ?? '') + (result.stderr ?? '')).trim().slice(0, 1500),
    );
  return exe;
}

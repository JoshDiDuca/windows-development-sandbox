import path from 'node:path';
import type { AgentCommand } from './commands.js';

/** Marks files this tool wrote, so only those are ever replaced or removed. */
export const MARKER = 'windows-development-sandbox agent command';

/** What a forwarding file runs: the managed install's launcher when there is one, else node + the entry file. */
export interface ForwardTarget {
  readonly node: string;
  readonly entry: string;
  /** The managed install's `bin\sandbox.cmd`: it survives updates, which remove the version folder `entry` is in. */
  readonly launcher?: string;
}

/**
 * Where the forwarding files send the typed command. Under a managed install (installRoot, the folder with `bin`,
 * `versions` and `node`) that is its launcher; otherwise the entry file of this copy.
 */
export function forwardTarget(packageRoot: string, installRoot: string | null, node: string): ForwardTarget {
  const entry = path.join(packageRoot, 'dist', 'bin', 'sandbox.js');
  return installRoot ? { node, entry, launcher: path.join(installRoot, 'bin', 'sandbox.cmd') } : { node, entry };
}

const posix = (p: string): string =>
  p.replace(/^([A-Za-z]):/, (_m, d: string) => '/' + d.toLowerCase()).replace(/\\/g, '/');

/** The .cmd file for one agent (cmd, PowerShell and Windows Terminal all run it). */
export function forwardingCmd(a: AgentCommand, target: ForwardTarget): string {
  const launch = ' launch --harness ' + a.harness + ' --headless --terminal -- %*';
  return [
    '@echo off',
    'rem ' + MARKER + '. Turn off: sandbox agent-commands off. Run the real one: set SANDBOX_AGENT_DIRECT=1',
    'if "%SANDBOX_AGENT_DIRECT%"=="1" goto direct',
    // A missing program (the tool was uninstalled or moved) runs the real agent instead of failing.
    ...(target.launcher
      ? [
          'if not exist "' + target.launcher + '" goto direct',
          'call "' + target.launcher + '"' + launch,
        ]
      : [
          'if not exist "' + target.node + '" goto direct',
          'if not exist "' + target.entry + '" goto direct',
          '"' + target.node + '" "' + target.entry + '"' + launch,
        ]),
    'exit /b %errorlevel%',
    ':direct',
    'call "' + a.real + '" %*',
    '',
  ].join('\r\n');
}

/** The same for Git Bash, which looks for a file without an extension. */
export function forwardingSh(a: AgentCommand, target: ForwardTarget): string {
  const q = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";
  const launch = ' launch --harness ' + a.harness + ' --headless --terminal -- "$@"';
  const shLauncher = target.launcher ? posix(target.launcher).replace(/\.cmd$/i, '') : null;
  return [
    '#!/bin/sh',
    '# ' + MARKER + '. Turn off: sandbox agent-commands off. Run the real one: SANDBOX_AGENT_DIRECT=1',
    'if [ "$SANDBOX_AGENT_DIRECT" = "1" ]; then exec ' + q(posix(a.real)) + ' "$@"; fi',
    ...(shLauncher
      ? ['[ -f ' + q(shLauncher) + ' ] || exec ' + q(posix(a.real)) + ' "$@"', 'exec ' + q(shLauncher) + launch]
      : [
          '[ -f ' + q(posix(target.entry)) + ' ] || exec ' + q(posix(a.real)) + ' "$@"',
          'exec ' + q(posix(target.node)) + ' ' + q(posix(target.entry)) + launch,
        ]),
    '',
  ].join('\n');
}

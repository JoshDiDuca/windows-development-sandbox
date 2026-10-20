// Command lines for the agent: Windows argument quoting, and the extra layer cmd.exe needs for npm agents (.cmd files).
import path from 'node:path';

const quoted = (arg: string): string => '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
export function quoteArg(arg: string): string {
  return arg !== '' && !/[\s"]/.test(arg) ? arg : quoted(arg);
}

/**
 * Arguments on a `cmd /d /c <agent>.cmd ...` line (npm agents). cmd parses them twice: the /c line, then the .cmd's %*.
 * & | < > ^ are literal inside quotes, so arguments with them are quoted (https://x?a=1&b=2 survives). % expands even
 * inside quotes, so each one sits between quoted pieces ("50"%" off"): every %name% cmd could see then starts with a
 * quote, and no variable is called that. cmd's quote state runs across the whole line (an embedded \" toggles it too),
 * so a metacharacter it would see outside quotes gets ^^^ (one caret left after each parse). Arguments without any
 * of these are quoted as usual.
 */
export function cmdArgs(args: string[]): string {
  const pieces = args
    .map((arg) => (/[&|<>^%]/.test(arg) ? arg.split('%').map(quoted).join('%') : quoteArg(arg)))
    .join(' ');
  let inQuotes = false;
  return [...pieces]
    .map((c) => {
      if (c === '"') inQuotes = !inQuotes;
      return !inQuotes && /[&|<>^]/.test(c) ? '^^^' + c : c;
    })
    .join('');
}

/** The command line ptyhost starts; when the program is cmd.exe its arguments are quoted for cmd (cmdArgs). */
export function commandLine(file: string, args: string[]): string {
  return path.win32.basename(file).toLowerCase() === 'cmd.exe'
    ? [quoteArg(file), cmdArgs(args)].filter(Boolean).join(' ')
    : [file, ...args].map(quoteArg).join(' ');
}

/** A plain shell session's program: which shell, its absolute path and its arguments. */
export interface ShellLaunch {
  readonly name: 'pwsh' | 'powershell' | 'cmd';
  readonly file: string;
  readonly args: string[];
}

/** Where the shells are in this sandbox (pwsh: null when PowerShell 7 is not installed). */
export interface ShellPaths {
  readonly pwsh: string | null;
  readonly powershell: string;
  readonly cmd: string;
}

/** The shell a session asked for runs as (auto: PowerShell 7 when present, else Windows PowerShell). Pure. */
export function shellLaunch(asked: 'auto' | ShellLaunch['name'], paths: ShellPaths): ShellLaunch {
  if (asked === 'cmd') return { name: 'cmd', file: paths.cmd, args: [] };
  if (asked === 'powershell' || (asked === 'auto' && !paths.pwsh))
    return { name: 'powershell', file: paths.powershell, args: ['-NoLogo'] };
  if (!paths.pwsh)
    throw new Error(
      'PowerShell 7 is not installed in this sandbox (toolchains.pwsh). Open powershell or cmd instead, or turn pwsh on.',
    );
  return { name: 'pwsh', file: paths.pwsh, args: ['-NoLogo'] };
}

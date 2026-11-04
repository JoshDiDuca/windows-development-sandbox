// The one place that decides which folders are on the machine PATH, in what order, and how a process's PATH is brought
// up to date with the registry. Pure (no side effects): the self-test imports this file. The shells' own start-up code
// (sandbox\csharp\PathSync.cs) follows the same rules.
import path from 'node:path';

/** A folder as a comparison key: one slash style, no trailing slash (a drive root keeps its one), lower case. */
export function pathKey(folder: string): string {
  const slashes = folder.trim().replace(/^"|"$/g, '').replace(/\//g, '\\');
  return (slashes.length > 3 ? slashes.replace(/\\+$/, '') : slashes).toLowerCase();
}

/** The folders of a PATH string: no empty parts, no quotes around a folder. */
export function splitPath(value: string): string[] {
  return value
    .split(';')
    .map((part) => part.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/** Replaces %NAME% with the variable's value (any case); a name that is not set stays as written. */
export function expandVars(value: string, env: Readonly<Record<string, string | undefined>>): string {
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return value.replace(/%([^%;\\]+)%/g, (whole, name: string) => lower.get(name.toLowerCase()) ?? whole);
}

export interface PathPlanInput {
  /** In the order they should have: earlier entries win. */
  readonly entries: readonly string[];
  readonly exists: (folder: string) => boolean;
  /** Entries to leave out (a folder that must not be machine-wide, matched like pathKey). */
  readonly drop?: (folder: string) => boolean;
}

/** Ordered, de-duplicated (case, trailing slash) PATH folders; missing and dropped folders are left out. */
export function planPath(input: PathPlanInput): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of input.entries.flatMap(splitPath)) {
    const key = pathKey(entry);
    if (seen.has(key) || input.drop?.(entry) || !input.exists(entry)) continue;
    seen.add(key);
    result.push(entry);
  }
  return msvcBeforeGitUsr(result);
}

/**
 * The PATH folders of the agent environment (sessions, the machine PATH, terminal tabs): the sandbox's own commands
 * folder first, because its `claude` / `codex` shims carry the sandbox's flags and must beat a copy installed with
 * `npm i -g` in nvm's node folder; then the toolchains' folders, the process's own and the appended ones. No
 * duplicates (matched like pathKey); MSVC's tools before Git's usr\bin.
 */
export function sessionPath(o: {
  readonly commands: string;
  readonly prepend: readonly string[];
  readonly base: readonly string[];
  readonly append: readonly string[];
}): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const folder of [o.commands, ...o.prepend, ...o.base, ...o.append]) {
    const key = pathKey(folder);
    if (!folder.trim() || seen.has(key)) continue;
    seen.add(key);
    result.push(folder);
  }
  return msvcBeforeGitUsr(result);
}

/** `base` with the folders of `extra` it lacks added at the end (a process keeps its own order and entries). */
export function appendMissing(base: string, extra: string, skip: (folder: string) => boolean = () => false): string {
  const seen = new Set(splitPath(base).map(pathKey));
  const added = splitPath(extra).filter((folder) => {
    const key = pathKey(folder);
    if (seen.has(key) || skip(folder)) return false;
    seen.add(key);
    return true;
  });
  return msvcBeforeGitUsr([...splitPath(base), ...added]).join(';');
}

/**
 * What a new shell gets: folders only this process has first (a parent put them there on purpose), then the machine
 * and the user PATH with their %VARIABLES% expanded; no duplicates. `skip` leaves folders out (the runner's own Node).
 */
export function rebuildPath(o: {
  readonly machine: string;
  readonly user: string;
  readonly process: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly skip?: (folder: string) => boolean;
}): string {
  const registry = splitPath(expandVars(o.machine, o.env) + ';' + expandVars(o.user, o.env));
  const known = new Set(registry.map(pathKey));
  const only = splitPath(o.process).filter((f) => !known.has(pathKey(f)) && !o.skip?.(f));
  return planPath({ entries: [...only, ...registry], exists: () => true }).join(';');
}

/** The value of `Path` in the output of `reg query <key> /v Path` ('' when there is none). */
export function parseRegPath(output: string): string {
  const line = output.split(/\r?\n/).find((l) => /^\s+Path\s+REG_(EXPAND_)?SZ\s/i.test(l));
  return line ? line.replace(/^\s+Path\s+REG_(EXPAND_)?SZ\s+/i, '').trim() : '';
}

/** A folder of one pinned Node version (nvm's `v24.22.0`): never machine-wide, `nvm use` would not move it. */
export function isPinnedNodeDir(folder: string, nvmHome: string): boolean {
  const key = pathKey(folder);
  const home = pathKey(nvmHome);
  return key.startsWith(home + '\\') && /^v\d/.test(path.win32.basename(key));
}

/** MSVC's compiler folder (`...\VC\Tools\MSVC\<version>\bin\Host<arch>\<arch>`): where the real link.exe lives. */
export function isMsvcToolsDir(folder: string): boolean {
  return /\\vc\\tools\\msvc\\[^\\]+\\bin\\host[^\\]+\\[^\\]+$/.test(pathKey(folder));
}

/** Git for Windows' `usr\bin` (coreutils): its link.exe is not MSVC's linker, and it has many other lookalikes. */
export function isGitUsrBin(folder: string): boolean {
  const key = pathKey(folder);
  return key.endsWith('\\usr\\bin') && /\\git(\\|$)/.test(key);
}

/**
 * The same folders with MSVC's tools before Git's `usr\bin`, so `link` is the linker and not coreutils' `link` (a
 * msvc Rust build then died with os error 1392). Nothing else moves: MSVC folders found after the first Git `usr\bin`
 * are put just before it, in their own order.
 */
export function msvcBeforeGitUsr(folders: readonly string[]): string[] {
  const firstGit = folders.findIndex(isGitUsrBin);
  if (firstGit < 0 || !folders.slice(firstGit).some(isMsvcToolsDir)) return [...folders];
  const late = folders.slice(firstGit).filter(isMsvcToolsDir);
  return [...folders.slice(0, firstGit), ...late, ...folders.slice(firstGit).filter((f) => !isMsvcToolsDir(f))];
}

/** How `installedToolPaths` looks at the tools folder (injected so it is a pure function). */
export interface ToolsFs {
  readonly exists: (file: string) => boolean;
  /** Names in a folder ([] when it is missing). */
  readonly list: (folder: string) => readonly string[];
}

/** Compares "3.9.1" and "3.15.2" by their numbers. */
function compareVersions(a: string, b: string): number {
  const x = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const y = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * What a toolchain that is already installed in the persistent tools folder adds to PATH even when the project in this
 * session did not ask for it (python and rust: another project of the same sandbox, a terminal tab, a script that
 * calls `python`). Only PATH entries and the two variables rust's own tools read, nothing is installed or changed,
 * and the folders go at the END so they never shadow what a project's own toolchains put first. `skip` names the
 * toolchains whose own step already runs (they bring their own entries).
 */
export function installedToolPaths(
  toolsDir: string,
  fsApi: ToolsFs,
  skip: ReadonlySet<'python' | 'rust'> = new Set(),
): { readonly append: string[]; readonly vars: Record<string, string>; readonly summary: string[] } {
  const join = (...parts: string[]): string => path.win32.join(toolsDir, ...parts);
  const append: string[] = [];
  const vars: Record<string, string> = {};
  const summary: string[] = [];
  if (!skip.has('python')) {
    const newest = fsApi
      .list(join('python'))
      .filter((n) => /^python-\d+(\.\d+)*$/.test(n) && fsApi.exists(join('python', n, 'python.exe')))
      .map((n) => n.slice('python-'.length))
      .sort(compareVersions)
      .pop();
    if (newest) {
      const dir = join('python', 'python-' + newest);
      append.push(dir, join('python', 'python-' + newest, 'Scripts'));
      if (fsApi.exists(join('shims', 'py.cmd'))) append.push(join('shims'));
      summary.push('python: ' + newest + ' (already installed here, on PATH for every project)');
    }
  }
  if (!skip.has('rust') && fsApi.exists(join('rust', 'cargo', 'bin', 'rustup.exe'))) {
    append.push(join('rust', 'cargo', 'bin'));
    vars.RUSTUP_HOME = join('rust', 'rustup');
    vars.CARGO_HOME = join('rust', 'cargo');
    summary.push('rust: rustup (already installed here, on PATH for every project)');
  }
  return { append, vars, summary };
}

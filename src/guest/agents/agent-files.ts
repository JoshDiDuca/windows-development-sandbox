// Pure parts of the agents' files: where an agent is installed, the command that starts it in a terminal tab, and the
// SQLite folders it runs from the sandbox's own disk. No side effects: the self-test imports this file.
import path from 'node:path';
import type { Harness } from '../../core/types.js';

/** Where an agent lives in persistent storage: its folder, and the program (an .exe, or an npm .cmd) in it. */
export interface AgentPaths {
  readonly dir: string;
  readonly exe: string | null;
  readonly cmd: string | null;
}

export function agentPaths(toolsDir: string, name: string, harness: Harness): AgentPaths {
  const dir = path.join(toolsDir, 'agents', name);
  const exe = harness.hostExecutable ?? (harness.uvBin ? harness.uvBin + '.exe' : null);
  return {
    dir,
    exe: exe ? path.join(dir, exe) : null,
    cmd: harness.npmBin ? path.join(dir, harness.npmBin + '.cmd') : null,
  };
}

/** The word a user types for this agent (`claude`, `codex` ...). */
export function agentCommand(name: string, harness: Harness): string {
  return harness.npmBin ?? harness.uvBin ?? (harness.hostExecutable ?? name).replace(/\.exe$/i, '');
}

/** What a terminal needs to run the agent by name: the command, and the program it runs once installed. */
export interface AgentShim {
  readonly name: string;
  readonly command: string;
  readonly target: string;
}

/** One shim per configured agent that can be installed here (a name that is not a plain command word is skipped). */
export function agentShims(toolsDir: string, agents: Readonly<Record<string, Harness>>): AgentShim[] {
  return Object.entries(agents).flatMap(([name, harness]) => {
    const p = agentPaths(toolsDir, name, harness);
    const target = p.exe ?? p.cmd;
    const command = agentCommand(name, harness);
    return target && /^[A-Za-z0-9_-]+$/.test(command) && /^[A-Za-z0-9_-]+$/.test(name)
      ? [{ name, command, target }]
      : [];
  });
}

/**
 * The text of `<command>.cmd`: runs the installed agent, or installs it first (`install` = node + installer script).
 * The agent's own arguments pass through %* untouched.
 */
export function shimText(shim: AgentShim, install: { node: string; script: string }): string {
  return [
    '@echo off',
    'setlocal',
    'set "SBX_REAL=' + shim.target + '"',
    'if exist "%SBX_REAL%" goto run',
    'echo ' + shim.command + ' is not installed in this sandbox yet. Installing it now (one time)...',
    '"' + install.node + '" "' + install.script + '" install ' + shim.name,
    'if errorlevel 1 exit /b 1',
    ':run',
    'endlocal & "%SBX_REAL%" %*',
    '',
  ].join('\r\n');
}

/** The `sbx-agent` command: `sbx-agent install <agent>` / `sbx-agent list`. */
export function sbxAgentText(install: { node: string; script: string }): string {
  return '@"' + install.node + '" "' + install.script + '" %*\r\n';
}

/** A SQLite folder an agent runs from the sandbox's disk: the variable that points to `local`, and its saved copy. */
export interface LocalState {
  readonly agent: string;
  readonly env: string;
  /** The saved copy in persistent storage (state\<agent>\<folder>). */
  readonly store: string;
  /** The working copy on the sandbox's own disk. */
  readonly local: string;
  /** Image names of the programs that hold the databases open while they run. */
  readonly processes: readonly string[];
  /** Where the agent kept the databases before this existed (its state folder itself). */
  readonly legacy: string;
}

export function localStateEntries(
  agents: Readonly<Record<string, Harness>>,
  stateDir: string,
  localRoot: string,
): LocalState[] {
  return Object.entries(agents).flatMap(([agent, harness]) =>
    Object.entries(harness.localState ?? {}).map(([env, folder]) => ({
      agent,
      env,
      store: path.join(stateDir, agent, folder),
      local: path.join(localRoot, agent, folder),
      processes: [agentCommand(agent, harness) + '.exe'],
      legacy: path.join(stateDir, agent),
    })),
  );
}

/** Every agent's bootReset paths, absolute below its state folder (the schema allows only plain relative paths). */
export function bootResetPaths(
  agents: Readonly<Record<string, Harness>>,
  stateDir: string,
): { agent: string; path: string }[] {
  return Object.entries(agents).flatMap(([agent, harness]) =>
    (harness.bootReset ?? []).map((rel) => ({ agent, path: path.join(stateDir, agent, rel) })),
  );
}

/**
 * Codex's config.toml with its own command sandbox off, or null when it already says which one to use. Inside Windows
 * Sandbox that inner sandbox only costs: its setup re-grants ACLs over the whole profile at every boot (minutes), and
 * every command hangs until it is done. A `sandbox_mode` the user set (before the first [table]) is kept.
 */
export function codexConfigWithoutSandbox(toml: string): string | null {
  const firstTable = toml.search(/^\s*\[/m);
  const topLevel = firstTable < 0 ? toml : toml.slice(0, firstTable);
  if (/^\s*sandbox_mode\s*=/m.test(topLevel)) return null;
  return (
    '# Set by the sandbox: Windows Sandbox already contains Codex, its own command sandbox would only slow it down.\n' +
    'sandbox_mode = "danger-full-access"\n' +
    (toml ? '\n' + toml : '')
  );
}

/**
 * Codex's config.toml with its MCP sign-ins (OAuth tokens, e.g. Perplexity Computer's) kept in a file, or null when it
 * already says where to keep them. By default Codex keeps them in Windows Credential Manager, which is wiped with the
 * sandbox; in a file ($CODEX_HOME\.credentials.json, on the data folder) they last, and travel with saved logins.
 * A `mcp_oauth_credentials_store` the user set (before the first [table]) is kept.
 */
export function codexConfigWithMcpLoginsInFile(toml: string): string | null {
  const firstTable = toml.search(/^\s*\[/m);
  const topLevel = firstTable < 0 ? toml : toml.slice(0, firstTable);
  if (/^\s*mcp_oauth_credentials_store\s*=/m.test(topLevel)) return null;
  return (
    "# Set by the sandbox: Codex's MCP sign-ins are kept in .credentials.json, so the next sandbox has them too.\n" +
    'mcp_oauth_credentials_store = "file"\n' +
    (toml ? '\n' + toml : '')
  );
}

/** A SQLite database file or one of its -wal / -shm siblings. */
export const isDatabaseFile = (name: string): boolean => /\.(sqlite3?|db)(-wal|-shm)?$/i.test(name);

/** Files that make a consistent copy: the databases and their -wal (the -shm is rebuilt by SQLite). */
export const isCopyableDatabaseFile = (name: string): boolean => isDatabaseFile(name) && !/-shm$/i.test(name);

// Pure parts of the agents' files: where an agent is installed, the command that starts it in a terminal tab, and the
// SQLite folders it runs from the sandbox's own disk. No side effects: the self-test imports this file.
import path from 'node:path';
import type { Config, Harness } from '../../core/types.js';

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
  /** Flags the shim puts before the arguments of the caller (codex: the sandbox's own settings). */
  readonly arguments?: readonly string[];
}

/** One shim per configured agent that can be installed here (a name that is not a plain command word is skipped). */
export function agentShims(
  toolsDir: string,
  agents: Readonly<Record<string, Harness>>,
  flags: Readonly<Record<string, readonly string[]>> = {},
): AgentShim[] {
  return Object.entries(agents).flatMap(([name, harness]) => {
    const p = agentPaths(toolsDir, name, harness);
    const target = p.exe ?? p.cmd;
    const command = agentCommand(name, harness);
    return target && /^[A-Za-z0-9_-]+$/.test(command) && /^[A-Za-z0-9_-]+$/.test(name)
      ? [{ name, command, target, ...(flags[name]?.length ? { arguments: flags[name] } : {}) }]
      : [];
  });
}

/**
 * The text of `<command>.cmd`: runs the installed agent, or installs it first (`install` = node + installer script).
 * The agent's own arguments pass through %* untouched, after the shim's flags if it has any.
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
    'endlocal & "%SBX_REAL%" ' + (shim.arguments?.length ? shim.arguments.join(' ') + ' ' : '') + '%*',
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

type CodexSettings = Config['codex'];

/** The marker the sandbox puts above the lines it writes into config.toml. */
const CODEX_MARKER = '# Set by the sandbox';

/** The full marker line: what it is and where to change it. */
const CODEX_MARKER_LINE =
  CODEX_MARKER + ' from its codex settings (`sandbox config`); a line of your own without it wins.';

/** Markers whose lines count as the sandbox's: CODEX_MARKER, and a hand-made fix's (`# agent-sandbox:`). */
const CODEX_MARKERS = [CODEX_MARKER, '# agent-sandbox:'] as const;

/** The top-level keys the sandbox writes under its marker. */
const CODEX_OWNED_KEYS = ['sandbox_mode', 'approval_policy', 'model', 'model_reasoning_effort'] as const;

/**
 * The flags every Codex start through the sandbox gets (the codex.cmd shim, the daemon's sessions). Flags beat
 * config.toml and a resumed thread's saved permissions; config.toml carries the same settings for a start without
 * them (codexConfigOwned). Full access with no questions is the one flag that skips Codex's Windows sandbox setup for
 * certain. Pure.
 */
export function codexArguments(c: CodexSettings): string[] {
  const out =
    c.sandboxMode === 'danger-full-access' && c.approvalPolicy === 'never'
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--sandbox', c.sandboxMode, '--ask-for-approval', c.approvalPolicy];
  if (c.model) out.push('-c', 'model="' + c.model + '"');
  if (c.reasoningEffort !== 'default') out.push('-c', 'model_reasoning_effort="' + c.reasoningEffort + '"');
  return out;
}

/** The arguments an agent always starts with: its own, and for codex the sandbox's settings. */
export function agentArguments(name: string, harness: Harness, codex: CodexSettings | undefined): string[] {
  return name === 'codex' && codex ? [...harness.arguments, ...codexArguments(codex)] : [...harness.arguments];
}

/** The largest config.toml the sandbox edits. */
export const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;

/**
 * Codex's config.toml as the sandbox wants it, every other line byte for byte. Above the first table, under the
 * marker comment: sandbox_mode, approval_policy (and model, model_reasoning_effort when set), so ANY start of Codex
 * obeys the codex settings, also one without the shim's flags (a copy installed with npm -g). The marked lines are
 * replaced each time; a key the user set on a line of their own above the first table is left to them.
 * `[windows] sandbox` follows windowsSandbox ("off" removes the line, which Codex adds back after its own setup, so it
 * does not set up its own sandbox users), and mcp_oauth_credentials_store = "file" is added when it is not set.
 * Keeps the file's line endings; running it again changes nothing. Pure.
 */
export function codexConfigOwned(toml: string, c: CodexSettings): string {
  const eol = toml.includes('\r\n') ? '\r\n' : '\n';
  const firstTable = toml.search(/^[ \t]*\[/m);
  let top = firstTable < 0 ? toml : toml.slice(0, firstTable);
  const tables = firstTable < 0 ? '' : toml.slice(firstTable);
  top = top.replace(MARKED_LINES, '');
  if (c.mcpLoginsInFile && !hasKey(top, 'mcp_oauth_credentials_store')) {
    if (top && !top.endsWith('\n')) top += eol;
    top += 'mcp_oauth_credentials_store = "file"' + eol + (tables ? eol : '');
  }
  const values: Record<(typeof CODEX_OWNED_KEYS)[number], string> = {
    sandbox_mode: c.sandboxMode,
    approval_policy: c.approvalPolicy,
    model: c.model,
    model_reasoning_effort: c.reasoningEffort === 'default' ? '' : c.reasoningEffort,
  };
  const lines = CODEX_OWNED_KEYS.filter((k) => values[k] && !hasKey(top, k)).map(
    (k) => k + ' = ' + JSON.stringify(values[k]),
  );
  const marked = lines.length ? [CODEX_MARKER_LINE, ...lines].join(eol) + eol + (top || tables ? eol : '') : '';
  return marked + top + codexWindowsSandbox(tables, c.windowsSandbox, eol);
}

/** True when the top of config.toml sets the key on a line of its own. */
function hasKey(top: string, key: string): boolean {
  return new RegExp('^[ \t]*' + key + '[ \t]*=', 'm').test(top);
}

/** The lines the sandbox wrote above the first table: a marker comment, the keys it owns, then one blank line. */
const MARKED_LINES = new RegExp(
  '^(?:' +
    CODEX_MARKERS.join('|') +
    ')[^\r\n]*\r?\n(?:(?:' +
    CODEX_OWNED_KEYS.join('|') +
    ')[ \t]*=[^\r\n]*(?:\r?\n|$))*(?:[ \t]*\r?\n)?',
  'm',
);

/** The tables of config.toml (from the first one on) with `[windows] sandbox` set to the mode, or removed for "off". */
function codexWindowsSandbox(tables: string, mode: CodexSettings['windowsSandbox'], eol: string): string {
  const setting = 'sandbox = "' + mode + '"';
  const header = /^[ \t]*\[windows\][ \t]*(#[^\r\n]*)?(\r?\n|$)/m.exec(tables);
  if (!header) {
    if (mode === 'off') return tables;
    const gap = tables && !tables.endsWith('\n') ? eol : '';
    return tables + gap + (tables ? eol : '') + '[windows]' + eol + setting + eol;
  }
  const bodyStart = header.index + header[0].length;
  const next = tables.slice(bodyStart).search(/^[ \t]*\[/m);
  const bodyEnd = next < 0 ? tables.length : bodyStart + next;
  const body = tables.slice(bodyStart, bodyEnd);
  const line = /^[ \t]*sandbox[ \t]*=[^\r\n]*(\r?\n|$)/m.exec(body);
  let updated: string;
  if (!line) updated = mode === 'off' ? body : setting + eol + body;
  else if (mode === 'off') updated = body.slice(0, line.index) + body.slice(line.index + line[0].length);
  else updated = body.slice(0, line.index) + setting + line[1] + body.slice(line.index + line[0].length);
  const head = tables.slice(0, bodyStart);
  return (head.endsWith('\n') || !updated ? head : head + eol) + updated + tables.slice(bodyEnd);
}

/**
 * Codex's config.toml with its own command sandbox off, or null when that changes nothing. Kept for callers that
 * predate the codex settings; use codexConfigOwned.
 */
export function codexConfigWithoutSandbox(toml: string): string | null {
  const out = codexConfigOwned(toml, {
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    model: '',
    reasoningEffort: 'default',
    windowsSandbox: 'off',
    mcpLoginsInFile: true,
  });
  return out === toml ? null : out;
}

/** A SQLite database file or one of its -wal / -shm siblings. */
export const isDatabaseFile = (name: string): boolean => /\.(sqlite3?|db)(-wal|-shm)?$/i.test(name);

/** Files that make a consistent copy: the databases and their -wal (the -shm is rebuilt by SQLite). */
export const isCopyableDatabaseFile = (name: string): boolean => isDatabaseFile(name) && !/-shm$/i.test(name);

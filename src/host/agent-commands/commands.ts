// Agent commands: with agentCommands.enabled, typing an agent's own command on this PC (claude, codex, ...)
// starts it in a hidden sandbox for the folder you are in and attaches that terminal. Small forwarding files in
// <storage>\agent-commands go first on YOUR PATH (so they win over npm's and the installers' copies); turning it off
// removes the files and that one PATH entry. SANDBOX_AGENT_DIRECT=1 runs the real agent on this PC instead.
import path from 'node:path';
import type { Config } from '../../core/types.js';
import { fileExists, fileExistsAsync } from '../../core/util/index.js';

export function commandsDir(storageRoot: string): string {
  return path.join(storageRoot, 'agent-commands');
}
const EXTENSIONS = ['.exe', '.cmd', '.bat'];

export interface AgentCommand {
  harness: string;
  command: string;
  real: string;
}

/** cmd.exe expands % and ^ even inside quotes: such paths cannot go into a forwarding file safely. */
export function cmdSafe(p: string): boolean {
  return !/[%"^\r\n]/.test(p);
}

/** The folders of PATH to look in, without this tool's forwarding folder. */
function searchDirs(skipDir: string, pathValue: string): string[] {
  const skip = path.resolve(skipDir).toLowerCase();
  return pathValue.split(path.delimiter).filter((d) => d && path.resolve(d).toLowerCase() !== skip);
}

/** The agent's own executable on this PC, skipping this tool's forwarding files. */
export function realAgent(
  command: string,
  skipDir: string,
  pathValue = process.env.PATH ?? process.env.Path ?? '',
): string | null {
  for (const dir of searchDirs(skipDir, pathValue))
    for (const ext of EXTENSIONS) {
      const candidate = path.join(dir, command + ext);
      if (fileExists(candidate)) return candidate;
    }
  return null;
}

/** realAgent without blocking the program: every candidate is looked up at once, the first in PATH order wins. */
export async function realAgentAsync(
  command: string,
  skipDir: string,
  pathValue = process.env.PATH ?? process.env.Path ?? '',
): Promise<string | null> {
  const candidates = searchDirs(skipDir, pathValue).flatMap((dir) =>
    EXTENSIONS.map((ext) => path.join(dir, command + ext)),
  );
  const found = await Promise.all(candidates.map(fileExistsAsync));
  const at = found.indexOf(true);
  return at < 0 ? null : candidates[at];
}

/** The agents that may get a forwarding command (listed, or "auto" = all) and the command each is typed as. */
function wantedCommands(config: Config): { harness: string; command: string }[] {
  const wanted = config.agentCommands.agents;
  return Object.entries(config.harnesses).flatMap(([harness, h]) => {
    if (wanted !== 'auto' && !wanted.includes(harness)) return [];
    const command = h.npmBin ?? (h.hostExecutable ? path.parse(h.hostExecutable).name : harness);
    return /^[A-Za-z0-9._-]+$/.test(command) ? [{ harness, command }] : [];
  });
}

/** The agents that get a forwarding command: installed on this PC, and listed (or "auto" = all of them). */
export function agentCommands(config: Config, storageRoot: string, pathValue?: string): AgentCommand[] {
  return wantedCommands(config).flatMap(({ harness, command }): AgentCommand[] => {
    const real = realAgent(command, commandsDir(storageRoot), pathValue);
    return real && cmdSafe(real) ? [{ harness, command, real }] : [];
  });
}

/** agentCommands without blocking the program. */
export async function agentCommandsAsync(
  config: Config,
  storageRoot: string,
  pathValue?: string,
): Promise<AgentCommand[]> {
  const found = await Promise.all(
    wantedCommands(config).map(async ({ harness, command }): Promise<AgentCommand[]> => {
      const real = await realAgentAsync(command, commandsDir(storageRoot), pathValue);
      return real && cmdSafe(real) ? [{ harness, command, real }] : [];
    }),
  );
  return found.flat();
}

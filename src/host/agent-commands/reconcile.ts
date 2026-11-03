import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../../core/types.js';
import { ensureDir, fileExists } from '../../core/util/index.js';
import { writeFileAtomic } from '../../shared/io/index.js';
import { safeRemove } from '../../shared/io/index.js';
import { MARKER, forwardingCmd, forwardingSh, type ForwardTarget } from './forwarders.js';
import { type AgentCommand, commandsDir, cmdSafe, agentCommands } from './commands.js';
import { editUserPath, userPathHas } from './user-path.js';

const ownFiles = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .map((f) => path.join(dir, f))
        .filter((f) => {
          try {
            return fs.lstatSync(f).isFile() && fs.readFileSync(f, 'utf8').includes(MARKER);
          } catch {
            return false;
          }
        })
    : [];

export interface Reconciled {
  on: boolean;
  commands: AgentCommand[];
  changed: boolean;
}

/**
 * Makes this PC match agentCommands: on = a forwarding file per installed agent and the folder first on your PATH;
 * off = no files, no PATH entry. Only touches files it wrote and its own PATH entry; does nothing when already right.
 */
export function reconcileAgentCommands(config: Config, storageRoot: string, target: ForwardTarget): Reconciled {
  const dir = commandsDir(storageRoot);
  if (!config.agentCommands.enabled) {
    if (!fs.existsSync(dir)) return { on: false, commands: [], changed: false };
    for (const f of ownFiles(dir)) fs.rmSync(f, { force: true });
    editUserPath(dir, false, storageRoot);
    if (fs.readdirSync(dir).length === 0) safeRemove(dir, storageRoot);
    return { on: false, commands: [], changed: true };
  }
  if (![target.node, target.entry, target.launcher ?? ''].every(cmdSafe))
    throw new Error(
      'This tool is installed in a folder whose path has % " or ^, which cannot go into a command file safely.',
    );
  const commands = agentCommands(config, storageRoot);
  ensureDir(dir);
  const wanted = new Map<string, string>();
  for (const a of commands) {
    wanted.set(path.join(dir, a.command + '.cmd'), forwardingCmd(a, target));
    wanted.set(path.join(dir, a.command), forwardingSh(a, target));
  }
  let changed = false;
  for (const f of ownFiles(dir))
    if (!wanted.has(f)) {
      fs.rmSync(f, { force: true });
      changed = true;
    }
  for (const [file, text] of wanted) {
    const current = fileExists(file) ? fs.readFileSync(file, 'utf8') : null;
    // A file of the same name that this tool did not write is never replaced.
    if (current !== null && !current.includes(MARKER)) continue;
    if (current !== text) {
      writeFileAtomic(file, text);
      changed = true;
    }
  }
  // Your PATH as stored (not this process's copy of it, which an older terminal keeps): the registry says if it is on.
  const onPath = !changed && userPathHas(dir, storageRoot);
  if (changed || !onPath) editUserPath(dir, true, storageRoot);
  return { on: true, commands, changed: changed || !onPath };
}

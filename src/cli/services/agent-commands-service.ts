// "Agent commands": typing claude, codex ... on this PC starts them in a hidden sandbox. Never prints.
import fs from 'node:fs';
import { loadConfig, userConfigPath } from '../../core/config/index.js';
import type { Config } from '../../core/types.js';
import { fail } from '../../core/util/index.js';
import {
  agentCommands,
  agentCommandsAsync,
  commandsDir,
  forwardTarget,
  reconcileAgentCommands,
  type Reconciled,
} from '../../host/agent-commands/index.js';
import { InstallLayout } from '../../host/install/layout.js';
import { insideSandbox } from '../../host/sandbox/index.js';
import { writeFileAtomic } from '../../shared/io/index.js';
import type { Context } from '../commands/context.js';
import { editConfigText } from '../../app/features/settings/settings-file.js';

export type AgentCommand = ReturnType<typeof agentCommands>[number];

export interface AgentCommandsStatus {
  readonly enabled: boolean;
  /** Folder with the forwarding commands. */
  readonly dir: string;
  /** Agents found on this PC's PATH. */
  readonly found: AgentCommand[];
}

export class AgentCommandsService {
  constructor(private readonly ctx: Context) {}

  /** Agent commands change this PC's PATH, so they are set up from the PC, not inside the sandbox. */
  assertOnPc(): void {
    if (insideSandbox())
      fail(
        "Agent commands change your PC's PATH, so they are set up from your PC, not inside the sandbox.",
        'Run sandbox agent-commands on in a terminal on your PC.',
      );
  }

  /** Your settings as they are on disk now (a switch made a moment ago, here or in Settings, counts). */
  private config(): Config {
    return loadConfig(this.ctx.loaded.configPath ?? undefined).config;
  }

  status(): AgentCommandsStatus {
    const config = this.config();
    return {
      enabled: config.agentCommands.enabled,
      dir: commandsDir(this.ctx.storageRoot),
      found: agentCommands(config, this.ctx.storageRoot),
    };
  }

  /** status() that does not block the program (the menu asks while it stays responsive). */
  async statusAsync(): Promise<AgentCommandsStatus> {
    const config = this.config();
    return {
      enabled: config.agentCommands.enabled,
      dir: commandsDir(this.ctx.storageRoot),
      found: await agentCommandsAsync(config, this.ctx.storageRoot),
    };
  }

  /** Writes agentCommands.enabled to your config file, then brings this PC in line with it. */
  setEnabled(on: boolean): Reconciled | null {
    const file = this.ctx.loaded.configPath ?? userConfigPath();
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const edited = editConfigText(text, ['agentCommands', 'enabled'], on ? true : undefined);
    if ('problems' in edited)
      fail(
        'Could not change ' + file + ': ' + edited.problems.join('; '),
        'Fix the file with sandbox config check, then try again.',
      );
    writeFileAtomic(file, edited.text);
    return this.reconcile(loadConfig(file).config);
  }

  /** Brings this PC in line with agentCommands. Null inside a sandbox (nothing to change there). */
  reconcile(config: Config): Reconciled | null {
    if (insideSandbox()) return null;
    // Under a managed install the forwarding files call its launcher, which keeps working after an update.
    const installRoot = InstallLayout.detect(this.ctx.packageRoot)?.root ?? null;
    return reconcileAgentCommands(
      config,
      this.ctx.storageRoot,
      forwardTarget(this.ctx.packageRoot, installRoot, process.execPath),
    );
  }
}

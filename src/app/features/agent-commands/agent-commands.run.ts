// Agent commands' work: the status, and turning them on or off (your settings file, then the files and PATH on this
// PC). The same function runs after a change of agentCommands.* in Settings (settings.run.ts), so every surface agrees.
import { requireOnPc } from '../../../cli/commands/context.js';
import { AgentCommandsService } from '../../../cli/services/agent-commands-service.js';
import { implement } from '../../context.js';
import {
  agentCommandsOff,
  agentCommandsOn,
  agentCommandsStatus,
  AGENT_COMMANDS_EXPLAINED,
  type AgentCommandsStatus,
} from './agent-commands.def.js';

export async function readAgentCommands(service: AgentCommandsService): Promise<AgentCommandsStatus> {
  const s = await service.statusAsync();
  return {
    enabled: s.enabled,
    dir: s.dir,
    found: s.found.map((a) => ({ command: a.command, harness: a.harness, real: a.real })),
  };
}

export const agentCommandsStatusRun = implement(agentCommandsStatus, (ctx) =>
  readAgentCommands(new AgentCommandsService(ctx)),
);

/** Switches agent commands, with the words that say what changed. */
export function switchAgentCommands(
  service: AgentCommandsService,
  on: boolean,
): {
  on: boolean;
  commands: string[];
  message: string;
} {
  const result = service.setEnabled(on);
  const commands = result?.on ? result.commands.map((a) => a.command) : [];
  const message = on
    ? 'Agent commands are on for: ' +
      (commands.join(', ') || 'no installed agents found yet') +
      '. ' +
      AGENT_COMMANDS_EXPLAINED
    : 'Agent commands are off: claude, codex ... run on this PC again. Open a new terminal.';
  return { on, commands, message };
}

export const agentCommandsOnRun = implement(agentCommandsOn, (ctx) => {
  requireOnPc('agent-commands on');
  return switchAgentCommands(new AgentCommandsService(ctx), true);
});

export const agentCommandsOffRun = implement(agentCommandsOff, (ctx) => {
  requireOnPc('agent-commands off');
  return switchAgentCommands(new AgentCommandsService(ctx), false);
});

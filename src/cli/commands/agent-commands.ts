// Agent commands on the command line: `sandbox agent-commands [status|on|off]` is the shared core's (src/app/features/
// agent-commands). What stays here is the sync after a launch.
import type { Config } from '../../core/types.js';
import type { Reconciled } from '../../host/agent-commands/index.js';
import { c } from '../output/index.js';
import { AgentCommandsService } from '../services/index.js';
import { type Context } from './context.js';

/** Brings this PC in line with agentCommands and says what changed (used after on/off, settings and launch). */
export function syncAgentCommands(ctx: Context, config: Config, quiet = false): Reconciled | null {
  const result = new AgentCommandsService(ctx).reconcile(config);
  if (!result || !result.changed || quiet) return result;
  if (result.on) {
    console.log(
      'Agent commands are on for: ' + (result.commands.map((a) => a.command).join(', ') || 'no installed agents found'),
    );
    console.log(
      c.dim(
        'Open a new terminal, then type e.g. claude in any project folder. Run the real one: set SANDBOX_AGENT_DIRECT=1',
      ),
    );
  } else console.log('Agent commands are off: claude, codex ... run on this PC again (open a new terminal).');
  return result;
}

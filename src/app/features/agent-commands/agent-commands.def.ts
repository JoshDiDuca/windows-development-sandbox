// Agent commands: typing claude, codex ... on this PC starts them in a hidden sandbox and attaches the terminal.
// Pure: schemas, labels and the page section; agent-commands.run.ts does the work (files and PATH on this PC).
import { z } from 'zod';
import { action, defineOperation, defineQuery, type Item, type Section } from '../../kernel/index.js';

export const AgentCommandsStatusSchema = z.object({
  enabled: z.boolean().describe('Typing claude, codex ... starts them in a sandbox (setting agentCommands.enabled)'),
  dir: z.string().describe('The folder with the forwarding commands (first on your PATH while this is on)'),
  found: z
    .array(
      z.object({
        command: z.string().describe('What you type (claude)'),
        harness: z.string().describe('The agent it starts in the sandbox'),
        real: z.string().describe('The real program on this PC'),
      }),
    )
    .describe('The agents found on this PC'),
});
export type AgentCommandsStatus = z.output<typeof AgentCommandsStatusSchema>;

export const agentCommandsStatus = defineQuery({
  id: 'agentCommands.status',
  title: 'Agent commands',
  summary: 'whether claude, codex ... on this PC start in a sandbox, and which agents were found',
  input: z.object({}),
  output: AgentCommandsStatusSchema,
  text: (o) => agentCommandsText(o),
  cli: { name: 'agent-commands', action: 'status', json: true },
});

const ChangedSchema = z.object({
  on: z.boolean().describe('Agent commands are on now'),
  commands: z.array(z.string()).describe('The commands that start an agent in a sandbox'),
  message: z.string().describe('What happened'),
});

export const agentCommandsOn = defineOperation({
  id: 'agentCommands.on',
  title: 'Turn agent commands on',
  summary: 'make claude, codex ... on this PC start in a hidden sandbox and attach',
  input: z.object({}).strict(),
  output: ChangedSchema,
  text: (o) => o.message,
  cli: { name: 'agent-commands', action: 'on' },
});

export const agentCommandsOff = defineOperation({
  id: 'agentCommands.off',
  title: 'Turn agent commands off',
  summary: 'make claude, codex ... on this PC run on the PC again',
  input: z.object({}).strict(),
  output: ChangedSchema,
  text: (o) => o.message,
  cli: { name: 'agent-commands', action: 'off' },
});

/** The words printed by `sandbox agent-commands status`. Pure. */
export function agentCommandsText(s: AgentCommandsStatus): string {
  const lines = ['Agent commands: ' + (s.enabled ? 'on' : 'off') + '  (' + s.dir + ')'];
  if (s.found.length)
    for (const a of s.found)
      lines.push('  ' + a.command + '  sandboxed ' + a.harness + (s.enabled ? '' : ' when on') + '  real: ' + a.real);
  else lines.push('No agents found on this PC (claude, codex, gemini ... on your PATH).');
  return lines.join('\n');
}

/** What turning them on does, in words (also the message after it). */
export const AGENT_COMMANDS_EXPLAINED =
  'Typing claude, codex ... in a folder on this PC starts that agent in a hidden sandbox and attaches your terminal. Open a new terminal after turning it on or off. To run the real program once, set SANDBOX_AGENT_DIRECT=1.';

/** The "Agent commands" section of the agents page: the switch, then one row per agent found. Pure. */
export function agentCommandsSection(s: AgentCommandsStatus): Section {
  const toggle = s.enabled
    ? action(agentCommandsOff, {}, { label: 'Turn off', verb: 'turn off', key: 'o' })
    : action(agentCommandsOn, {}, { label: 'Turn on', verb: 'turn on', key: 'o' });
  const rows: Item[] = [
    {
      id: 'agentCommands',
      label: 'Agent commands',
      hint: s.enabled ? 'on' : 'off',
      tone: s.enabled ? 'ok' : 'muted',
      description: AGENT_COMMANDS_EXPLAINED,
      primary: toggle,
      keys: 'o turns it ' + (s.enabled ? 'off' : 'on') + '.',
      actions: [toggle],
    },
    ...s.found.map((a): Item => ({
      id: 'agentCommand:' + a.command,
      label: a.command,
      hint: s.enabled ? 'starts in a sandbox' : 'runs on this PC',
      tone: s.enabled ? 'ok' : 'muted',
      description: s.enabled
        ? 'Typing ' + a.command + ' starts ' + a.harness + ' in a sandbox. The real program: ' + a.real
        : 'Typing ' +
          a.command +
          ' runs the real program (' +
          a.real +
          '). Turn agent commands on to use a sandbox instead.',
    })),
  ];
  return { id: 'agentCommands', title: 'Agent commands', items: rows };
}

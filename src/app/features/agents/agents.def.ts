// The agents you can start: the list, starting one in a project of the running sandbox, adding one, making one the
// default and removing one you added. Pure: schemas, labels and the view; agents.run.ts does the work.
import { z } from 'zod';
import { action, defineOperation, defineQuery, defineView, link, type Item, type Page } from '../../kernel/index.js';

/** Agent and project names as the web UI has always accepted them. */
const NameText = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

export const AgentRowSchema = z.object({
  name: z.string().describe('The agent'),
  ready: z.boolean().describe('Installed in the sandbox already (starts without an install)'),
  isDefault: z.boolean().describe('The agent that starts by default'),
  removable: z.boolean().describe('You added it (built-in agents cannot be removed)'),
});
export type AgentRow = z.output<typeof AgentRowSchema>;

export const AgentsListSchema = z.object({
  folder: z.string().describe('The folder a start works on (the current folder)'),
  defaultAgent: z.string().describe('The default agent'),
  agents: z.array(AgentRowSchema).describe('Every agent in your settings, built in or added'),
});
export type AgentsList = z.output<typeof AgentsListSchema>;

export const listAgents = defineQuery({
  id: 'agents.list',
  title: 'Agents',
  summary: 'the agents you can start, and which one is the default',
  input: z.object({}),
  output: AgentsListSchema,
  surfaces: { except: { cli: 'sandbox config list shows the agents (harnesses) and the default (defaultHarness)' } },
});

export const startAgent = defineOperation({
  id: 'agents.start',
  title: 'Start an agent',
  summary: 'start an agent in a project of the running sandbox',
  input: z.object({
    agent: NameText.describe('The agent to start'),
    project: NameText.optional().describe('The project of the running sandbox (asked when there are several)'),
  }),
  output: z.object({
    session: z.string().describe('The new session'),
    message: z.string().describe('What happened'),
  }),
  text: (o) => o.message,
  surfaces: {
    except: {
      cli: 'sandbox <agent> and sandbox launch start agents on the command line (they boot the sandbox and can attach the terminal)',
      menu: 'the menu starts agents with launch, which can boot the sandbox and attach this terminal',
    },
  },
});

export const addAgent = defineOperation({
  id: 'agents.add',
  title: 'Add an agent…',
  summary: 'add an agent by its npm or Python package, or a program on this PC',
  input: z.object({}),
  output: z.object({ name: z.string().describe('The new agent'), message: z.string().describe('What happened') }),
  text: (o) => o.message,
  surfaces: { except: { cli: 'sandbox config set harnesses adds agents on the command line' } },
});

export const makeDefaultAgent = defineOperation({
  id: 'agents.makeDefault',
  title: 'Make default',
  summary: 'make an agent the one that starts by default',
  input: z.object({ name: z.string().describe('The agent') }),
  output: z.object({ message: z.string().describe('What happened') }),
  text: (o) => o.message,
  surfaces: { except: { cli: 'sandbox config set defaultHarness <name> does this on the command line' } },
});

export const removeAgent = defineOperation({
  id: 'agents.remove',
  title: 'Remove',
  summary: 'take an agent you added out of your settings',
  input: z.object({ name: z.string().describe('The agent') }),
  output: z.object({ message: z.string().describe('What happened') }),
  danger: true,
  text: (o) => o.message,
  surfaces: { except: { cli: 'sandbox config set harnesses removes agents on the command line' } },
});

function folderName(folder: string): string {
  return folder.split(/[\\/]/).pop() ?? folder;
}

/** The description of an agent row: what a start does, and whether you can remove it. Pure. */
function agentDescription(a: AgentRow, where: string): string {
  const removing = a.removable
    ? a.isDefault
      ? ' You added it. Make another agent the default to remove it.'
      : ' You added it.'
    : '';
  return 'Starts ' + a.name + ' in ' + where + '.' + (a.isDefault ? ' It is the default agent.' : '') + removing;
}

/** The menu's words for the remove key, on an agent you added that is not the default. */
function agentKeys(a: AgentRow): string | undefined {
  return a.removable && !a.isDefault ? 'x removes it.' : undefined;
}

function agentItem(a: AgentRow, where: string): Item {
  return {
    id: 'agent:' + a.name,
    label: a.name,
    hint: a.ready ? 'ready' : 'installs on first start',
    tone: a.ready ? 'ok' : 'muted',
    icon: a.name,
    badges: a.isDefault ? [{ text: 'default', tone: 'accent' }] : [],
    description: agentDescription(a, where),
    keys: agentKeys(a),
    primary: link({ kind: 'start-agent', agent: a.name }, 'Start ' + a.name, { verb: 'start' }),
    actions: [
      ...(a.isDefault
        ? []
        : [action(makeDefaultAgent, { name: a.name }, { key: 'd', verb: 'make default', importance: 1 })]),
      ...(a.removable && !a.isDefault
        ? [action(removeAgent, { name: a.name }, { key: 'x', verb: 'remove', importance: 1 })]
        : []),
    ],
  };
}

/** The agents page: the default agent first, then the others, then "Add an agent…" (ids `agent:<name>` and `add`). */
export function agentsPage(o: AgentsList): Page {
  const where = folderName(o.folder);
  const sorted = [...o.agents].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return {
    title: 'Agents',
    sections: [
      {
        id: 'start',
        title: 'Start in ' + where,
        cards: true,
        items: [
          ...sorted.map((a) => agentItem(a, where)),
          {
            id: 'add',
            label: 'Add an agent…',
            description:
              'Add another agent by its npm or Python package, or a program on this PC. It is saved in your settings and appears in this list.',
            primary: action(addAgent, {}, { verb: 'add' }),
          },
        ],
      },
    ],
  };
}

export const agentsView = defineView({
  id: 'agents',
  title: 'Agents',
  summary: 'The agents you can start: start one, add one, choose the default.',
  queries: { agents: listAgents },
  operations: [startAgent, addAgent, makeDefaultAgent, removeAgent],
  build: ({ agents }) => agentsPage(agents),
});

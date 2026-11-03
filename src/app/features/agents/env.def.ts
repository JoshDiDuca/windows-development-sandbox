// The environment variables of an agent, edited on every surface. Claude has a catalogue (claude-env.def.ts):
// names grouped with plain words, flags that switch on and off, numbers that are checked. Any agent also has "your own
// variables". The values are the agent's `environment` in your settings; secrets are never sent to a screen. Pure.
import { z } from 'zod';
import { ENV_GROUPS, ENV_NAME, MAX_SUBAGENTS_DEFAULT, MAX_SUBAGENTS_VAR } from './claude-env.def.js';
import {
  action,
  defineOperation,
  defineQuery,
  defineView,
  humanize,
  type Field,
  type Item,
  type Page,
  type Section,
} from '../../kernel/index.js';

/** Agent names as the settings accept them. */
const AgentName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

export const EnvRowSchema = z.object({
  name: z.string().describe('The variable'),
  group: z.enum(ENV_GROUPS).describe('The group it is listed under'),
  label: z.string().describe('What it is called here'),
  kind: z.enum(['flag', 'number', 'text', 'enum']).describe('What kind of value it takes'),
  description: z.string().describe('What it does'),
  choices: z.array(z.string()).optional().describe('The values an enum takes'),
  range: z.string().optional().describe('The numbers a number takes, in words'),
  secret: z.boolean().describe('Its value is never shown'),
  defaultText: z.string().optional().describe('What Claude does when it is not set'),
  value: z.string().nullable().describe('Its value; null when it is not set or is a secret'),
  set: z.boolean().describe('Set in your settings or by the sandbox'),
  fromSandbox: z.boolean().describe('The sandbox sets it (your settings can change it, not remove it)'),
});
export type EnvRow = z.output<typeof EnvRowSchema>;

export const CustomEnvSchema = z.object({
  name: z.string().describe('The variable'),
  fromSandbox: z.boolean().describe('The sandbox sets it'),
});

export const AgentEnvSchema = z.object({
  agent: z.string().describe('The agent'),
  rows: z.array(EnvRowSchema).describe('The variables of the catalogue (Claude only)'),
  custom: z.array(CustomEnvSchema).describe('Variables of your own (values are never shown)'),
});
export type AgentEnv = z.output<typeof AgentEnvSchema>;

const CLI_EXEMPT = 'sandbox config set harnesses.<agent>.environment.<NAME> <value> does this on the command line';

export const agentEnv = defineQuery({
  id: 'agents.env',
  title: 'Agent environment',
  summary: "an agent's environment variables, with the catalogue of Claude's",
  input: z.object({ agent: AgentName.default('claude').describe('The agent') }),
  output: AgentEnvSchema,
  surfaces: { except: { cli: CLI_EXEMPT } },
});

export const agentsEnvSet = defineOperation({
  id: 'agents.env.set',
  title: 'Set variable',
  summary: 'set or remove one environment variable of an agent in your settings (empty removes it)',
  input: z.object({
    agent: AgentName.describe('The agent'),
    name: z.string().regex(ENV_NAME).describe('The variable'),
    value: z.string().max(4000).nullable().default(null).describe('Its value; empty removes it'),
  }),
  output: z.object({ message: z.string().describe('What happened') }),
  text: (o) => o.message,
  surfaces: { except: { cli: CLI_EXEMPT } },
});

/** The words for a value of a row: what the page shows beside the name. Pure. */
export function envValueText(r: EnvRow): string {
  if (!r.set) return r.defaultText ? r.defaultText + " (Claude's default)" : 'not set';
  if (r.secret) return 'set';
  if (r.kind === 'flag') return 'on';
  return r.value ?? 'set';
}

/** The editor of a row's value: a Field every surface can draw (a flag is switched, so it has none). Pure. */
export function envField(r: EnvRow): Field | undefined {
  if (r.kind === 'flag') return undefined;
  const help = [
    r.description,
    r.range,
    r.choices ? 'One of: ' + r.choices.join(', ') + '.' : undefined,
    'Empty removes it.',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    name: 'value',
    key: ['value'],
    kind: r.secret ? 'secret' : r.kind === 'enum' ? 'enum' : 'text',
    label: r.label,
    help,
    optional: true,
    ...(r.kind === 'enum' && r.choices ? { choices: r.choices.map((c) => ({ value: c, label: c })) } : {}),
  };
}

function rowItem(agent: string, r: EnvRow): Item {
  const field = envField(r);
  const input = { agent, name: r.name };
  return {
    id: 'env:' + r.name,
    label: r.label,
    hint: envValueText(r),
    ...(r.set ? { tone: 'ok' as const } : { tone: 'muted' as const }),
    badges: r.fromSandbox ? [{ text: 'set by the sandbox', tone: 'muted' as const }] : [],
    description: r.description,
    code: r.name,
    keywords: r.name,
    primary: field
      ? action(agentsEnvSet, input, {
          label: 'Change',
          verb: 'edit',
          inline: true,
          fields: [field],
          initial: { value: r.secret ? '' : (r.value ?? '') },
        })
      : action(
          agentsEnvSet,
          { ...input, value: r.set ? null : '1' },
          { label: r.set ? 'Turn off' : 'Turn on', verb: r.set ? 'turn off' : 'turn on' },
        ),
    actions:
      r.set && !r.fromSandbox
        ? [action(agentsEnvSet, { ...input, value: null }, { label: 'Remove', verb: 'remove', key: 'r' })]
        : [],
  };
}

const ownField: Field = {
  name: 'value',
  key: ['value'],
  kind: 'secret',
  label: 'Value',
  help: 'The value. It is not shown again. Empty removes the variable.',
  optional: true,
};

/** The page of an agent's variables: a section per group, then the ones of your own and "Add variable…". Pure. */
export function agentEnvPage(o: AgentEnv): Page {
  const sections: Section[] = ENV_GROUPS.flatMap((group) => {
    const rows = o.rows.filter((r) => r.group === group);
    return rows.length ? [{ id: group.toLowerCase(), title: group, items: rows.map((r) => rowItem(o.agent, r)) }] : [];
  });
  sections.push({
    id: 'own',
    title: 'Your own variables',
    description:
      'Any other variable the agent should start with. Values are kept in your settings and not shown again.',
    items: [
      ...o.custom.map((c): Item => ({
        id: 'env:' + c.name,
        label: c.name,
        hint: 'set',
        tone: 'ok',
        badges: c.fromSandbox ? [{ text: 'set by the sandbox', tone: 'muted' }] : [],
        code: c.name,
        primary: action(
          agentsEnvSet,
          { agent: o.agent, name: c.name },
          { label: 'Change', verb: 'edit', inline: true, fields: [ownField], initial: { value: '' } },
        ),
        actions: c.fromSandbox
          ? []
          : [
              action(
                agentsEnvSet,
                { agent: o.agent, name: c.name, value: null },
                { label: 'Remove', verb: 'remove', key: 'r' },
              ),
            ],
      })),
      {
        id: 'add',
        label: 'Add variable…',
        description: 'A variable that is not in the list above.',
        primary: action(
          agentsEnvSet,
          { agent: o.agent },
          {
            label: 'Add variable…',
            verb: 'add',
            fields: [
              {
                name: 'name',
                key: ['name'],
                kind: 'text',
                label: 'Name',
                help: 'Letters, digits and _, e.g. MY_TOKEN.',
                optional: false,
              },
              ownField,
            ],
          },
        ),
      },
    ],
  });
  return { title: o.agent === 'claude' ? 'Claude environment' : humanize(o.agent) + ' environment', sections };
}

export interface AgentEnvParams {
  readonly agent?: string;
}

export const agentEnvView = defineView({
  id: 'agentEnv',
  title: 'Claude environment',
  summary: "An agent's environment variables: Claude's by group (how many subagents, models, limits), and your own.",
  queries: { env: agentEnv },
  operations: [agentsEnvSet],
  params: ['agent'],
  inputs: (p: AgentEnvParams) => ({ env: p.agent ? { agent: p.agent } : {} }),
  build: ({ env }) => agentEnvPage(env),
});

/** The "Subagents at once" row of the Agents page: its value in words. Pure. */
export function subagentsText(n: number | null): string {
  return n === null ? MAX_SUBAGENTS_DEFAULT + " (Claude's default)" : String(n);
}

/** Which catalogue row says how many subagents run at once. */
export const SUBAGENTS_VAR = MAX_SUBAGENTS_VAR;

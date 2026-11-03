// The work of the agent environment editor: reads an agent's variables from your settings (secrets never leave this
// file), and sets or removes one through the same config file the settings use. Talks only through io.
import _ from 'lodash';
import { DEFAULTS } from '../../../core/config/index.js';
import { fail } from '../../../core/util/index.js';
import { CLAUDE_ENV, envSpec, envValue, type EnvVarSpec } from './claude-env.def.js';
import { anthropicKeyProblem } from '../../../shared/accounts/index.js';
import { implement } from '../../context.js';
import { ConfigFile } from '../settings/settings-file.js';
import { agentEnv, agentsEnvSet, type AgentEnv, type EnvRow } from './env.def.js';

/** The variables written in your own settings file for an agent (a value that is not text is ignored). */
function ownVariables(file: ConfigFile, agent: string): Record<string, string> {
  const raw = file.valueInFile(['harnesses', agent, 'environment']);
  if (!_.isPlainObject(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
  ) as Record<string, string>;
}

function rangeText(spec: EnvVarSpec): string | undefined {
  if (spec.kind !== 'number') return undefined;
  const min = spec.min ?? 0;
  return 'A whole number from ' + min + (spec.max !== undefined ? ' to ' + spec.max : ' up') + '.';
}

/** The agent must be one of your settings' agents. */
function knownAgent(file: ConfigFile, agent: string): void {
  if (!(agent in file.userConfig().harnesses)) fail('There is no agent called "' + agent + '".');
}

export const agentEnvRun = implement(agentEnv, (ctx, input): AgentEnv => {
  const file = ConfigFile.user(ctx.loaded.configPath);
  knownAgent(file, input.agent);
  const mine = ownVariables(file, input.agent);
  const base: Readonly<Record<string, string>> = DEFAULTS.harnesses[input.agent]?.environment ?? {};
  const names = new Set([...Object.keys(base), ...Object.keys(mine)]);
  const catalogue = input.agent === 'claude' ? CLAUDE_ENV : [];
  const rows = catalogue.map((spec): EnvRow => {
    const value = mine[spec.name] ?? base[spec.name];
    return {
      name: spec.name,
      group: spec.group,
      label: spec.label,
      kind: spec.kind,
      description: spec.description,
      ...(spec.choices ? { choices: [...spec.choices] } : {}),
      ...(rangeText(spec) ? { range: rangeText(spec) } : {}),
      secret: spec.secret === true,
      ...(spec.defaultText ? { defaultText: spec.defaultText } : {}),
      // A secret's value stays here.
      value: value === undefined || spec.secret ? null : value,
      set: value !== undefined,
      fromSandbox: mine[spec.name] === undefined && base[spec.name] !== undefined,
    };
  });
  const known = new Set(catalogue.map((s) => s.name));
  const custom = [...names]
    .filter((n) => !known.has(n))
    .sort()
    .map((name) => ({ name, fromSandbox: mine[name] === undefined }));
  return { agent: input.agent, rows, custom };
});

export const agentsEnvSetRun = implement(agentsEnvSet, (ctx, input) => {
  const file = ConfigFile.user(ctx.loaded.configPath);
  knownAgent(file, input.agent);
  const spec = input.agent === 'claude' ? envSpec(input.name) : undefined;
  const shownName = spec?.label ?? input.name;
  const checked = envValue(spec, input.value, anthropicKeyProblem);
  if ('problem' in checked) fail(shownName + ': ' + checked.problem);
  const mine = ownVariables(file, input.agent);
  if (checked.save === null && mine[input.name] === undefined) {
    const sandbox = DEFAULTS.harnesses[input.agent]?.environment?.[input.name] !== undefined;
    return {
      message: sandbox
        ? shownName + ' is set by the sandbox; give it another value to change it.'
        : shownName + ' was not set.',
    };
  }
  const result = file.set(['harnesses', input.agent, 'environment', input.name], checked.save ?? undefined);
  if (typeof result === 'object') fail('It could not be saved: ' + result.problems.join('; '));
  if (checked.save === null) return { message: shownName + ' is removed.' };
  // Only the value of a plain catalogue entry is said back: everything else may hold a login.
  const said = spec && !spec.secret ? (spec.kind === 'flag' ? 'on' : checked.save) : 'saved';
  return { message: shownName + (said === 'saved' ? ' is saved.' : ' is ' + said + '.') };
});

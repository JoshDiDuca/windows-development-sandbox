// Checks what the user typed before anything starts, so a typo fails at once with the list of valid values
// instead of halfway into a sandbox boot. Pure helpers first, then validateOptions (the one call from the dispatcher).
import fs from 'node:fs';
import path from 'node:path';
import { DATABASES } from '../core/detect/index.js';
import { fail } from '../core/util/index.js';
import { AccountsService } from './services/accounts-service.js';
import type { CliOptions } from './args.js';
import type { Context } from './commands/context.js';

/** Edit distance, for "did you mean". */
export function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** The closest of `choices` to `input`, when it is close enough to be a typo. */
export function closest(input: string, choices: readonly string[]): string | undefined {
  const best = choices
    .map((c) => ({ c, d: distance(input.toLowerCase(), c.toLowerCase()) }))
    .sort((x, y) => x.d - y.d)[0];
  return best && best.d <= Math.max(2, Math.floor(input.length / 3)) ? best.c : undefined;
}

/** "Unknown agent "cluade". Did you mean claude?" with the valid values as the fix. */
export function unknownValue(what: string, input: string, choices: readonly string[], howToList: string): never {
  const hint = closest(input, choices);
  return fail(
    'Unknown ' + what + ' "' + input + '".' + (hint ? ' Did you mean ' + hint + '?' : ''),
    (choices.length ? 'Choose one of: ' + choices.join(', ') + '. ' : '') + howToList,
  );
}

/** Node: 22, 22.1, v22.1.0, lts, lts/*, lts/iron, latest, current, node. */
export function validNodeSpec(spec: string): boolean {
  return /^(v?\d+(\.\d+){0,2}|node|latest|current|stable|lts(\/(\*|[a-z]+))?)$/i.test(spec.trim());
}
/** Python 3: 3, 3.12, 3.12.4. */
export function validPythonSpec(spec: string): boolean {
  return /^v?3(\.\d+){0,2}$/.test(spec.trim());
}

export function checkHarness(name: string | undefined, harnesses: string[]): void {
  if (name !== undefined && !harnesses.includes(name))
    unknownValue('agent', name, harnesses, 'Add your own under "harnesses" in your settings (sandbox config).');
}

/** Commands that read these options; checked only for them (restart/doctor take --harness too). */
const LAUNCHING = new Set(['launch', 'generate', 'host-claude']);

export const PROJECT_ACTIONS = ['list', 'choose', 'add', 'remove', 'include', 'exclude', 'all', 'roots'] as const;

/** `sandbox projects <action> [value] [folder]`: the action, then what it needs. Pure (no file checks). */
export function validateProjectsArgs(args: string[], canAsk = false): void {
  const [action = 'list', value, folder] = args;
  if (!(PROJECT_ACTIONS as readonly string[]).includes(action))
    unknownValue('projects action', action, PROJECT_ACTIONS, 'sandbox projects with no action lists your projects.');
  if (['add', 'remove', 'include', 'exclude'].includes(action) && !value && !canAsk)
    fail('Which folder?', 'Usage: sandbox projects ' + action + ' <folder>   (. = this folder)');
  if (action === 'all' && value !== undefined && !['on', 'off'].includes(value))
    unknownValue('value for projects all', value, ['on', 'off'], 'sandbox projects all on|off');
  if (action === 'roots' && value !== undefined && !['list', 'add', 'remove'].includes(value))
    unknownValue(
      'projects roots action',
      value,
      ['list', 'add', 'remove'],
      'sandbox projects roots add|remove <folder>',
    );
  if (action === 'roots' && (value === 'add' || value === 'remove') && !folder)
    fail('Which folder?', 'Usage: sandbox projects roots ' + value + ' <folder>');
}

/** Fails with what is wrong and what is valid, before anything is started. */
export function validateOptions(ctx: Context): void {
  const o: CliOptions = ctx.options;
  const harnesses = Object.keys(ctx.loaded.config.harnesses);
  if (['launch', 'generate', 'restart', 'doctor'].includes(o.command)) checkHarness(o.harness, harnesses);
  if (o.command === 'projects') validateProjectsArgs(o.positionals, Boolean(process.stdin.isTTY));
  if (!LAUNCHING.has(o.command)) return;
  if (o.node !== undefined && !validNodeSpec(o.node))
    fail('"' + o.node + '" is not a Node version.', 'Use a number like 22 or 22.11.0, or lts, latest.');
  if (o.python !== undefined && !validPythonSpec(o.python))
    fail('"' + o.python + '" is not a Python 3 version.', 'Use 3, 3.12 or 3.12.4.');
  for (const db of o.databases
    .flatMap((d) => d.split(','))
    .map((d) => d.trim())
    .filter(Boolean)) {
    if (!(DATABASES as readonly string[]).includes(db))
      unknownValue('database', db, DATABASES, 'Repeat --database for several.');
  }
  if (o.account !== undefined) {
    // The launched agent's saved logins (an agent that keeps none says so).
    const agent = o.harness ?? ctx.loaded.config.defaultHarness;
    const names = new AccountsService(ctx).list(agent).map((a) => a.name);
    if (!names.includes(o.account))
      unknownValue(
        'account',
        o.account,
        names,
        names.length
          ? 'See them with: sandbox account list' + (agent === 'claude' ? '' : ' --agent ' + agent)
          : 'None saved yet: sign in inside the sandbox, then run sandbox account save <name>' +
              (agent === 'claude' ? '' : ' --agent ' + agent) +
              '.',
      );
  }
  for (const s of o.sessions) {
    checkHarness(s.harness, harnesses);
    if (!fs.existsSync(s.folder) || !fs.statSync(s.folder).isDirectory())
      fail(
        'The folder ' + s.folder + ' (--session ' + s.harness + '@...) does not exist.',
        'Check the path after the @.',
      );
  }
  if (o.sessions.length && (o.harness !== undefined || o.workspace !== undefined))
    fail(
      '--session names the agent and folder of each session, so --harness and --workspace do not apply.',
      'Use only --session <agent>@<folder> (repeatable).',
    );
  if (o.workspace !== undefined && !fs.existsSync(path.resolve(o.workspace)))
    fail(
      'The folder ' + path.resolve(o.workspace) + ' does not exist.',
      'Check the --workspace path (or leave it out to use the current folder).',
    );
  for (const script of o.scripts)
    if (!fs.existsSync(path.resolve(script)))
      fail('The script ' + path.resolve(script) + ' does not exist.', 'Check the --script path.');
}

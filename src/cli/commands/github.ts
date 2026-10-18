// `sandbox github [status|login|logout]`: the actions are the GitHub feature's operations (src/app/features/github);
// with no action the command shows the status page.
import { fail } from '../../core/util/index.js';
import { githubStatus } from '../../app/features/github/index.js';
import { definitionHandler } from '../operations/index.js';
import { type Context } from './context.js';

export function github(ctx: Context): number | Promise<number | void> {
  const action = ctx.options.positionals[0];
  if (action === undefined) return definitionHandler(githubStatus)(ctx);
  return fail('Unknown GitHub action "' + action + '".', 'Use: sandbox github status | login | logout');
}

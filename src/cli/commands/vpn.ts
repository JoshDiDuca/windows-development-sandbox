// `sandbox vpn [status|login|logout]`: the actions are the VPN feature's operations (src/app/features/vpn); with no
// action the command shows the status page.
import { fail } from '../../core/util/index.js';
import { vpnStatus } from '../../app/features/vpn/index.js';
import { definitionHandler } from '../operations/index.js';
import { type Context } from './context.js';

export function vpn(ctx: Context): number | Promise<number | void> {
  const action = ctx.options.positionals[0];
  if (action === undefined) return definitionHandler(vpnStatus)(ctx);
  return fail('Unknown VPN action "' + action + '".', 'Use: sandbox vpn status | login | logout');
}

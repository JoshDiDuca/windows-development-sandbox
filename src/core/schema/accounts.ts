// accounts: which saved service sign-ins sandboxes get (the sign-ins themselves are not settings: they are kept
// encrypted by `sandbox account import|login`, or come back from a sandbox you signed in in).
import { z } from 'zod';
import { SERVICE_SPECS, type ServiceKind } from '../../shared/accounts/kinds.js';

function share(kind: ServiceKind, how: string): z.ZodObject<{ share: z.ZodBoolean }, z.core.$strict> {
  const spec = SERVICE_SPECS[kind];
  return z.strictObject({
    share: z
      .boolean()
      .describe(
        'Hand your saved ' +
          spec.label +
          ' sign-in to sandboxes that use ' +
          spec.usedBy.join(' or ') +
          ' (' +
          how +
          '). Kept encrypted on this PC; ' +
          spec.warnings.join(' ') +
          ' Yours only: a project file can only turn it off.',
      ),
  });
}

export const AccountsSchema = z
  .strictObject({
    epic: share('epic', "sign in to the launcher once in a sandbox, or take this PC's: sandbox account import epic"),
    steam: share(
      'steam',
      'sign in once with sbx-steam login, or: sandbox account import steam --from <steamcmd folder>',
    ),
    unity: share('unity', "sign in once in a sandbox, or take this PC's licence: sandbox account import unity"),
    cfx: share('cfx', 'sandbox account login cfx'),
    keystore: share('keystore', 'sandbox account import keystore --from <upload.jks>'),
    play: share('play', 'sandbox account import play --from <service-account.json>'),
    expo: share('expo', 'sandbox account login expo'),
    appstore: share('appstore', 'sandbox account import appstore --from <AuthKey.p8>'),
  })
  .describe(
    'Service sign-ins for sandboxes (game stores, engines, app signing). Manage them in Accounts: sandbox account status.',
  );

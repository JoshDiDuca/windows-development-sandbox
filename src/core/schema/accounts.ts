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
    epic: share('epic', "sign in to the launcher once in a sandbox, or take this PC's from Accounts"),
    steam: share('steam', 'sign in once with sbx-steam login, or take it from a SteamCMD folder in Accounts'),
    unity: share('unity', "sign in once in a sandbox, or take this PC's licence from Accounts"),
    cfx: share('cfx', 'type the key in Accounts'),
    keystore: share('keystore', 'import the upload.jks file in Accounts'),
    play: share('play', 'import the service-account.json file in Accounts'),
    expo: share('expo', 'type the token in Accounts'),
    appstore: share('appstore', 'import the AuthKey.p8 file in Accounts'),
  })
  .describe('Service sign-ins for sandboxes (game stores, engines, app signing). Manage them in Accounts.');

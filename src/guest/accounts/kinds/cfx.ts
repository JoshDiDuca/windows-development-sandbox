// Cfx.re: the server licence key in a cfg on the sandbox's own disk that FXServer reads with +exec. Not available
// yet: the sign-in is not used.
import type { Payload } from '../../../shared/accounts/index.js';
import { notAvailableYet, type GuestAdapter } from '../adapter.js';

export const cfxAdapter: GuestAdapter<'cfx'> = {
  kind: 'cfx',
  apply(_p: Payload<'cfx'>) {
    return notAvailableYet('cfx');
  },
};

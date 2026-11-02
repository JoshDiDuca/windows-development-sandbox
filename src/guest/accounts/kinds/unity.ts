// Unity: the licence file (Unity_lic.ulf) where the editor reads it, or a sign-in with the Unity ID; a Pro seat is
// returned when the sandbox stops. Not available yet: the sign-in is not used.
import type { Payload } from '../../../shared/accounts/index.js';
import { notAvailableYet, type GuestAdapter } from '../adapter.js';

export const unityAdapter: GuestAdapter<'unity'> = {
  kind: 'unity',
  apply(_p: Payload<'unity'>) {
    return notAvailableYet('unity');
  },
};

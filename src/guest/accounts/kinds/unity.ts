// Unity: the licence file (Unity_lic.ulf) or the named-user licence where the editor reads it, or a sign-in with the
// Unity ID; a Plus or Pro seat is returned when the sandbox stops. Not available yet: the sign-in is not used.
import type { Payload } from '../../../shared/accounts/index.js';
import type { UnityStatus } from '../../../shared/unity/status.js';
import { notAvailableYet, type GuestAdapter } from '../adapter.js';

export const unityAdapter: GuestAdapter<'unity'> = {
  kind: 'unity',
  apply(_p: Payload<'unity'>) {
    return notAvailableYet('unity');
  },
};

/** Activates the licence the sandbox holds (a serial) once an editor exists, and reports where it stands. A stub. */
export async function activateUnityLicence(_o: {
  readonly editorExe: string | null;
  readonly unityExe: string | null;
}): Promise<UnityStatus['licence']> {
  return { state: 'unknown', kind: '', detail: 'not checked', user: null };
}

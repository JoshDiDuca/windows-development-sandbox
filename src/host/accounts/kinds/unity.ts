// Unity: this PC's licence file (Unity_lic.ulf), a .ulf you name, or the Unity ID typed for a sandbox to sign in
// with. Not available yet.
import type { Payload } from '../../../shared/accounts/index.js';
import { notAvailableYet, type HostSource, type PcEnv } from '../source.js';

export const unitySource: HostSource<'unity'> = {
  fromPc(_pc: PcEnv, _from?: string): Payload<'unity'> | null {
    return notAvailableYet('unity');
  },
  fromFile(_bytes: Buffer, _answers: Readonly<Record<string, string>>): Payload<'unity'> {
    return notAvailableYet('unity');
  },
  fromAnswers(_answers: Readonly<Record<string, string>>): Payload<'unity'> {
    return notAvailableYet('unity');
  },
  summary: () => null,
};

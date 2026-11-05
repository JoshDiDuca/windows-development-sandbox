// Unity: this PC's licence file (Unity_lic.ulf, or the named-user UnityEntitlementLicense.xml), a licence file you
// name, or the Unity ID (and serial) typed for a sandbox to sign in with. Unity ties a licence file to the computer, so
// a sandbox may refuse one taken from this PC; the typed Unity ID is the way that always works.
import path from 'node:path';
import {
  MAX_ULF_BYTES,
  unityEntitlementFile,
  unitySummary,
  unityUlfFile,
  UnityPayloadSchema,
  type Payload,
} from '../../../shared/accounts/index.js';
import { fail } from '../../../core/util/index.js';
import { decodeText, readBoundedFile } from '../../../shared/io/index.js';
import type { HostSource, PcEnv } from '../source.js';

const NOT_A_LICENCE = 'That is not a Unity licence file (Unity_lic.ulf) or entitlement file.';
const WHERE = 'Pick the file from C:\\ProgramData\\Unity or %LOCALAPPDATA%\\Unity\\licenses.';

function readText(file: string): string | null {
  const bytes = readBoundedFile(file, MAX_ULF_BYTES);
  return bytes ? decodeText(bytes).text : null;
}

/** The email, password and serial answers that were typed (trimmed, empty ones left out). */
function typed(answers: Readonly<Record<string, string>>): { email?: string; password?: string; serial?: string } {
  const out: { email?: string; password?: string; serial?: string } = {};
  const email = (answers.email ?? '').trim();
  const password = answers.password ?? '';
  const serial = (answers.serial ?? '').trim();
  if (email) out.email = email;
  if (password) out.password = password;
  if (serial) out.serial = serial;
  return out;
}

function checked(candidate: Record<string, string>): Payload<'unity'> {
  const parsed = UnityPayloadSchema.safeParse(candidate);
  if (!parsed.success)
    fail('That Unity sign-in is not valid (check the email, and that the licence file is not too big).', WHERE);
  return parsed.data;
}

export const unitySource: HostSource<'unity'> = {
  fromPc(pc: PcEnv, from?: string): Payload<'unity'> | null {
    const ulf =
      (pc.programData || from ? readText(unityUlfFile(from ? path.resolve(from) : pc.programData)) : null) ??
      (pc.localAppData
        ? readText(path.win32.join(pc.localAppData, 'VirtualStore', 'ProgramData', 'Unity', 'Unity_lic.ulf'))
        : null);
    const entitlement = pc.localAppData ? readText(unityEntitlementFile(pc.localAppData)) : null;
    if (ulf === null && entitlement === null) return null;
    return { ...(ulf !== null ? { ulf } : {}), ...(entitlement !== null ? { entitlement } : {}) };
  },
  fromFile(bytes: Buffer, answers: Readonly<Record<string, string>>): Payload<'unity'> {
    const text = decodeText(bytes).text;
    const candidate: Record<string, string> = { ...typed(answers) };
    if (text.includes('Entitlement')) candidate.entitlement = text;
    else if (text.includes('<License')) candidate.ulf = text;
    else fail(NOT_A_LICENCE, WHERE);
    return checked(candidate);
  },
  fromAnswers(answers: Readonly<Record<string, string>>): Payload<'unity'> {
    const t = typed(answers);
    if (t.serial && !(t.email && t.password))
      fail('A serial needs your Unity ID email and password.', 'Type them too, or leave the serial empty.');
    if (!t.email || !t.password)
      fail('A Unity sign-in needs your Unity ID email and password.', 'Type both: sandbox account login unity');
    return checked(t as Record<string, string>);
  },
  summary: unitySummary,
};

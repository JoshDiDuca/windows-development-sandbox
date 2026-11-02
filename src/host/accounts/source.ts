// How a sign-in reaches the store on this PC: taken from this PC's own program (fromPc), read from a file you name
// (fromFile, `sandbox account import <kind> --from <file>`), or typed (fromAnswers, `sandbox account login <kind>`).
// One module per kind under kinds/; sources.ts lists them.
import type { Payload, ServiceKind } from '../../shared/accounts/index.js';
import { fail } from '../../core/util/index.js';
import { SERVICE_SPECS } from '../../shared/accounts/index.js';

/** This PC's profile folders (passed in, so the self-test uses its own). */
export interface PcEnv {
  readonly localAppData: string;
  readonly appData: string;
  readonly programData: string;
}

export interface HostSource<K extends ServiceKind> {
  /** This PC's program's sign-in (`from`: another folder to read it from), or null when it has none. */
  fromPc?(pc: PcEnv, from?: string): Payload<K> | null;
  /** A file you named (its bytes, bounded by the caller) and the answers to the kind's fields. */
  fromFile?(bytes: Buffer, answers: Readonly<Record<string, string>>): Payload<K>;
  /** The answers to the kind's fields. */
  fromAnswers?(answers: Readonly<Record<string, string>>): Payload<K>;
  /** A short summary for the status (e.g. the Steam account name); never the secret. */
  summary(p: Payload<K>): string | null;
}

/** This PC's folders from the environment (never HOME or USERPROFILE). */
export function pcEnv(): PcEnv {
  const env = process.env;
  return {
    localAppData: env.LOCALAPPDATA ?? '',
    appData: env.APPDATA ?? '',
    programData: env.ProgramData ?? env.PROGRAMDATA ?? 'C:\\ProgramData',
  };
}

/** What a kind whose host side is not written yet says. */
export function notAvailableYet(kind: ServiceKind): never {
  return fail(
    'Saving a ' + SERVICE_SPECS[kind].label + ' sign-in comes in a later version of the sandbox.',
    'Nothing was changed.',
  );
}

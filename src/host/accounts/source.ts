// How a sign-in reaches the store on this PC: taken from this PC's own program (fromPc), read from a file you name
// (fromFile, `sandbox account import <kind> --from <file>`), or typed (fromAnswers, `sandbox account login <kind>`).
// One module per kind under kinds/; sources.ts lists them.
import { spawnSync } from 'node:child_process';
import type { Payload, ServiceKind } from '../../shared/accounts/index.js';
import { fail } from '../../core/util/index.js';
import { SYSTEM } from '../../shared/system.js';
import { refuseInSelfTest } from '../test-guard.js';
import { SERVICE_SPECS } from '../../shared/accounts/index.js';

/** This PC's profile folders and environment (passed in, so the self-test uses its own). */
export interface PcEnv {
  readonly localAppData: string;
  readonly appData: string;
  readonly programData: string;
  /** C:\Program Files (where the Epic Games Launcher installs engines by default). */
  readonly programFiles?: string;
  /** The environment the command runs with (a variable set in this terminal). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** A variable of this Windows user's saved environment (HKCU\Environment), or null when it is not set. */
  readonly userVariable?: (name: string) => string | null;
}

/** The value of `name` in `reg query <key> /v <name>` output, or null. */
export function parseRegValue(text: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('^\\s+' + escaped + '\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$', 'im').exec(text);
  return m ? m[1].trim() : null;
}

/** A variable of this Windows user's saved environment, read with reg.exe (by its full path); null when unset. */
function savedUserVariable(name: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(name)) return null;
  refuseInSelfTest("read this PC's saved environment");
  const r = spawnSync(SYSTEM.reg(), ['query', 'HKCU\\Environment', '/v', name], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 64 * 1024,
  });
  return r.status === 0 ? parseRegValue(String(r.stdout ?? ''), name) : null;
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
    programFiles: env.ProgramFiles ?? 'C:\\Program Files',
    env,
    userVariable: savedUserVariable,
  };
}

/** What a kind whose host side is not written yet says. */
export function notAvailableYet(kind: ServiceKind): never {
  return fail(
    'Saving a ' + SERVICE_SPECS[kind].label + ' sign-in comes in a later version of the sandbox.',
    'Nothing was changed.',
  );
}

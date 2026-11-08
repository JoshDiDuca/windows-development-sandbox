// Joining a running sandbox from another project. Its protections (network, LAN block, git access, clipboard, the
// .wsb device settings, read-only) are machine-wide: they were fixed when the sandbox booted for the first project.
// A second project may never loosen them, and a project that needs a STRICTER setting than the running sandbox has
// cannot get it there without changing it for the sessions already running, so that launch is refused with a clear
// message. A project asking for less than the sandbox has simply runs with the sandbox's (stricter) setting.
// Pure: the host checks it before registering a project, the tests drive it directly.
import _ from 'lodash';
import type { Config } from '../types.js';
import { asDirection, compareDirection, resolveClipboard } from '../clipboard.js';
import { DIRECTION_SETTING, NEVER_LOOSER, strictness } from './overrides.js';

/** The protections of a running sandbox, by setting path (`sandbox.networking`, `provisioning.git.access`, ...). */
export type Protections = Record<string, boolean | string>;

export function protectionsOf(config: Config): Protections {
  const base = Object.fromEntries(NEVER_LOOSER.map((p) => [p, _.get(config, p) as boolean | string]));
  const plan = resolveClipboard(config.sandbox);
  return {
    ...base,
    'sandbox.clipboard': plan.mode,
    'sandbox.clipboardDirection': plan.direction,
    'sandbox.protectedClient': plan.protectedClient,
  };
}

/** 1 = `wanted` is stricter than `running`, -1 = looser, 0 = the same. */
const compare = (
  setting: string,
  running: boolean | string | undefined,
  wanted: boolean | string | undefined,
): number => {
  if (setting === DIRECTION_SETTING) return compareDirection(asDirection(running), asDirection(wanted));
  return Math.sign(strictness(setting, wanted) - strictness(setting, running));
};

export interface JoinCheck {
  /** Settings this project needs stricter than the running sandbox: the launch is refused. */
  stricter: string[];
  /** Settings it would have looser: it gets the sandbox's (stricter) value; shown as a note. */
  looser: string[];
  /** Settings the sandbox turned on at its start for another project you allowed them for: shared, shown as a note. */
  shared: string[];
}

/**
 * Compares a project's effective protections with the running sandbox's. Hub projects are always read/write
 * (Windows Sandbox maps the hub once, read/write), so a read-only project counts as stricter. `widened`: the boot
 * settings the sandbox turned on for another of its projects (with your consent); a project that has them off
 * shares them instead of being refused.
 */
export function checkJoin(running: Protections, wanted: Protections, widened: string[] = []): JoinCheck {
  const stricter: string[] = [];
  const looser: string[] = [];
  const shared: string[] = [];
  for (const setting of NEVER_LOOSER) {
    // A sandbox with no clipboard: the direction does not matter.
    if (setting === DIRECTION_SETTING && strictness('sandbox.clipboard', running['sandbox.clipboard']) === 2) continue;
    const result = compare(setting, setting === 'readOnly' ? false : running[setting], wanted[setting]);
    if (result > 0 && widened.includes(setting)) shared.push(setting);
    else if (result > 0)
      stricter.push(
        setting +
          ' = ' +
          JSON.stringify(wanted[setting]) +
          ' (the running sandbox has ' +
          JSON.stringify(setting === 'readOnly' ? false : running[setting]) +
          ')',
      );
    if (result < 0) looser.push(setting + ' stays ' + JSON.stringify(running[setting]));
  }
  return { stricter, looser, shared };
}

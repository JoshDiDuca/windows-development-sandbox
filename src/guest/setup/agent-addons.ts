// Agent add-ons in this sandbox: rtk is plugged into the agents only while it is chosen (apps.install) AND its program
// is really there (a failed download adds no hook that would fail on every command).
import { findExe } from '../apps/find-exe.js';
import { dryRun } from '../runtime/paths.js';
import { session } from '../runtime/session.js';
import { tool } from '../toolchains/tool-env.js';

/** rtk.exe when rtk is chosen and installed, else null. */
export function installedRtk(): string | null {
  if (dryRun || !(session.apps?.install ?? []).includes('rtk')) return null;
  return findExe(tool('apps', 'rtk'), 'rtk.exe');
}

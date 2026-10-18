// The HCS engine (alpha), only when sandbox.engine is "hcs": can this PC run it. Looks only; the fixes are commands for
// you to run (they change Windows), never run by repair.
import { checkHcs, lookForLeftovers, realHcsProbes, type HcsProbes } from '../../../../host/engines/index.js';
import type { Check, Finding, RepairEnv } from '../types.js';
import { ok } from './common.js';

const hcsInUse = (env: RepairEnv): boolean => env.ctx.loaded.config.sandbox.engine === 'hcs';

/** Replaceable by tests: the probes the row looks through. */
export const HCS_PROBES: { current: HcsProbes | null } = { current: null };

export const HCS_CHECKS: Check[] = [
  {
    id: 'hcs-engine',
    group: 'Sandbox',
    name: 'HCS engine (alpha)',
    checking: 'the HCS engine',
    applies: hcsInUse,
    timeoutMs: 60000,
    run: (): Finding => {
      const check = checkHcs(HCS_PROBES.current ?? realHcsProbes());
      if (check.available) return ok('this PC can run it (starting it is not enabled yet in this alpha)');
      return {
        status: 'needs-you',
        detail: check.reasons.length + ' thing(s) missing: ' + check.reasons[0],
        means: check.reasons.join(' '),
        fix: check.fixes.join('  |  '),
      };
    },
  },
  {
    id: 'hcs-leftovers',
    group: 'Sandbox',
    name: 'HCS systems left running',
    checking: 'HCS systems left running',
    // Shown for the HCS engine, and on any PC where one of ours is found (never builds HcsHost.exe to look).
    applies: (env) => hcsInUse(env) || lookQuietly(env).length > 0,
    timeoutMs: 60000,
    run: (env): Finding => {
      const look = lookForLeftovers(env.ctx.loaded.config.storage.root, true);
      if (!look.available)
        return { status: 'skipped', detail: look.reason, means: 'No HCS system can be left running here.' };
      if (!look.systems.length) return ok('none of ours is running');
      return {
        status: 'warn',
        detail: look.systems.length + ' running: ' + look.systems.map((s) => s.id).join(', '),
        means: 'A command that crashed left them up. They hold memory until stopped; no data is lost.',
        fix: 'sandbox engine clean',
      };
    },
  },
];

/** The ids of ours that are running ([] when HCS is not there or has never been used). */
function lookQuietly(env: RepairEnv): string[] {
  const look = lookForLeftovers(env.ctx.loaded.config.storage.root, true);
  return look.available ? look.systems.map((s) => s.id) : [];
}

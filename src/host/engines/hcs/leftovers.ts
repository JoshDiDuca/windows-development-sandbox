// HCS compute systems this tool left running (a crashed command: they are created to outlive their handle). Only
// systems with our id prefix AND our Owner are ever listed or stopped; HcsHost.exe checks both again before it
// terminates one. Nothing here runs unless the PC has the Host Compute Service.
import path from 'node:path';
import { z } from 'zod';
import { errMsg, fail } from '../../../core/util/index.js';
import { realHcsProbes, system32Dir, type HcsProbes } from './check.js';
import { HCS_OWNER } from './documents.js';
import { HcsHelper, builtHcsHostExe, isOurSystemId } from './helper.js';

export interface LeftoverSystem {
  readonly id: string;
  /** Container or VirtualMachine (the utility VM). */
  readonly kind: string;
  readonly state: string;
  /** When it was created (ISO text), when HCS says. */
  readonly since: string | null;
}

export type LeftoverLook =
  | { readonly available: true; readonly systems: readonly LeftoverSystem[] }
  | { readonly available: false; readonly reason: string };

export interface LeftoverOutcome {
  readonly id: string;
  readonly stopped: boolean;
  /** Why not, in plain words. */
  readonly problem?: string;
}

/** What the look runs on: replaceable by tests (probes of a pretend PC, a fake helper). */
export interface LeftoverDeps {
  readonly probes: HcsProbes;
  /** The helper, or null when HcsHost.exe was never built (then nothing of ours can be running). Never builds it. */
  helper(storageRoot: string): HcsHelper | null;
}

export const LEFTOVER_DEPS: { current: LeftoverDeps | null } = { current: null };

function realDeps(): LeftoverDeps {
  return {
    probes: realHcsProbes(),
    helper: (root) => {
      const exe = builtHcsHostExe(root);
      return exe ? new HcsHelper(() => exe) : null;
    },
  };
}

const SystemListSchema = z.array(
  z
    .object({
      Id: z.string().max(300),
      SystemType: z.string().max(100).optional(),
      Owner: z.string().max(300).optional(),
      State: z.string().max(100).optional(),
      CreateTimestamp: z.string().max(100).optional(),
    })
    .passthrough(),
);

/** The reason HCS cannot be there at all, or null. Looks only (service list, one file). */
function noHcsReason(p: HcsProbes): string | null {
  if (!p.isWindows()) return 'HCS only exists on Windows.';
  if (!p.fileExists(path.join(system32Dir(), 'computecore.dll')) || p.serviceInstalled('vmcompute') === false)
    return 'The Host Compute Service is not on this PC.';
  return null;
}

/** Ours only: the id has our prefix and the system names us as its Owner. Anything else is never shown or touched. */
function ownedSystems(helper: HcsHelper): LeftoverSystem[] {
  let list: unknown;
  try {
    list = JSON.parse(helper.enumerate().json || '[]');
  } catch (e) {
    if (e instanceof SyntaxError) return fail('The Host Compute Service answered with something that is not JSON.');
    throw e;
  }
  const parsed = SystemListSchema.safeParse(list);
  if (!parsed.success) return [];
  return parsed.data
    .filter((s) => s.Owner === HCS_OWNER && isOurSystemId(s.Id))
    .map((s) => ({
      id: s.Id,
      kind: s.SystemType ?? 'unknown',
      state: s.State ?? 'unknown',
      since: s.CreateTimestamp && !Number.isNaN(Date.parse(s.CreateTimestamp)) ? s.CreateTimestamp : null,
    }));
}

/**
 * The compute systems of ours that exist now. Never builds HcsHost.exe: a PC that never used HCS has none, and
 * nothing of ours can be running there.
 */
export function lookForLeftovers(storageRoot: string): LeftoverLook {
  const deps = LEFTOVER_DEPS.current ?? realDeps();
  const none = noHcsReason(deps.probes);
  if (none) return { available: false, reason: none };
  try {
    const helper = deps.helper(storageRoot);
    if (!helper) return { available: true, systems: [] };
    return { available: true, systems: ownedSystems(helper) };
  } catch (e) {
    return { available: false, reason: 'The Host Compute Service could not be asked: ' + errMsg(e) };
  }
}

/**
 * Stops the named systems, containers before the utility VM that hosts them. Each id is looked up again first: one that
 * is not one of ours (or is gone) never reaches the helper; the helper checks the Owner with HCS itself once more.
 */
export function stopLeftovers(storageRoot: string, ids: readonly string[]): LeftoverOutcome[] {
  const deps = LEFTOVER_DEPS.current ?? realDeps();
  const helper = deps.helper(storageRoot);
  if (!helper) return ids.map((id) => ({ id, stopped: false, problem: 'HcsHost.exe is not available.' }));
  const now = ownedSystems(helper);
  const wanted = [...ids].sort((a, b) => Number(b.endsWith('-c')) - Number(a.endsWith('-c')));
  return wanted.map((id): LeftoverOutcome => {
    if (!now.some((s) => s.id === id)) return { id, stopped: false, problem: 'it is gone, or it is not one of ours' };
    try {
      helper.terminate(id);
      return { id, stopped: true };
    } catch (e) {
      return { id, stopped: false, problem: errMsg(e) };
    }
  });
}

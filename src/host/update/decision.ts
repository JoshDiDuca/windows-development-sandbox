// Whether the updater installs the latest release now. Pure: the caller supplies the clock, the state and whether a
// sandbox runs, so every reason to skip is testable without a network or a PC.
import { compareVersions } from '../install/layout.js';
import type { ReleaseInfo } from './release-source.js';
import type { UpdateState } from './update-state.js';

export type SkipReason = 'no-release' | 'up-to-date' | 'failed-before' | 'too-soon';

export type UpdateDecision = { kind: 'install'; release: ReleaseInfo } | { kind: 'skip'; reason: SkipReason };

export interface DecisionInput {
  /** The version that is installed and active now. */
  current: string;
  /** null when no release was looked up (or none exists). */
  latest: ReleaseInfo | null;
  state: UpdateState;
  now: Date;
  sandboxRunning: boolean;
  minHoursBetweenChecks: number;
  /** Ignores the time gate between checks (a manual `sandbox update`). */
  force?: boolean;
}

/** True when GitHub was asked less than `minHours` ago. */
export function isTooSoon(state: UpdateState, now: Date, minHours: number): boolean {
  if (!state.lastCheck) return false;
  const last = Date.parse(state.lastCheck);
  if (Number.isNaN(last)) return false;
  return now.getTime() - last < minHours * 60 * 60 * 1000;
}

/**
 * Install only a version newer than the current one, and never a version that failed before (or an older one than
 * the failure). A running sandbox is no reason to wait: each version has its own folder, the sandbox and this PC's
 * helpers keep running the version they started with, and old versions are only removed when no sandbox runs.
 */
export function decideUpdate(input: DecisionInput): UpdateDecision {
  const skip = (reason: SkipReason): UpdateDecision => ({ kind: 'skip', reason });
  if (!input.force && isTooSoon(input.state, input.now, input.minHoursBetweenChecks)) return skip('too-soon');
  if (!input.latest) return skip('no-release');
  const latest = input.latest;
  if (compareVersions(latest.version, input.current) <= 0) return skip('up-to-date');
  const failed = input.state.failed;
  if (failed && compareVersions(latest.version, failed.version) <= 0) return skip('failed-before');
  return { kind: 'install', release: latest };
}

// Windows Sandbox leaves its programs behind when the VM dies (a crash, a kill from the host side): the next start then
// fails ("the sandbox was signed out", or "already running"). This ends those leftovers, after asking, and when Windows
// still refuses, restarts the Windows Sandbox service (CmService), which needs administrator permission. The decisions
// are pure and the actions are injected, so tests never end a process.
import { spawnSync } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
import { refuseInSelfTest } from '../test-guard.js';
import { nativeScript } from '../native.js';
import { judgeSandbox, LEFTOVER_IMAGES, type SandboxFacts, type SandboxJudgement } from '../health/stale.js';

const HELPER_TIMEOUT_MS = 15000;
const SERVICE_TIMEOUT_MS = 120000;

/** taskkill arguments that end exactly these programs (pure). */
export function killArgs(pids: readonly number[]): string[] {
  const safe = pids.filter((pid) => Number.isInteger(pid) && pid > 4);
  return ['/F', ...safe.flatMap((pid) => ['/PID', String(pid)])];
}

/** Ends these Windows Sandbox programs (taskkill by absolute path). Returns false when taskkill failed. */
export function endSandboxPrograms(pids: readonly number[]): boolean {
  refuseInSelfTest('end Windows Sandbox programs');
  if (killArgs(pids).length <= 1) return true;
  const result = spawnSync(SYSTEM.taskkill(), killArgs(pids), { windowsHide: true, timeout: HELPER_TIMEOUT_MS });
  return result.status === 0;
}

/** Restarts the Windows Sandbox service (CmService) in an elevated PowerShell: Windows asks for permission. */
export function restartSandboxService(): boolean {
  refuseInSelfTest('restart the Windows Sandbox service');
  const result = spawnSync(
    SYSTEM.powershell(),
    nativeScript('run-elevated.ps1', ['-Command', 'Restart-Service -Name CmService -Force']),
    { windowsHide: true, timeout: SERVICE_TIMEOUT_MS },
  );
  return result.status === 0;
}

/** What the person is asked, and what is done about it: everything outside the decision is passed in. */
export interface CleanupDeps {
  /** The facts now (a fresh process list each time). */
  readonly facts: () => Promise<SandboxFacts>;
  readonly end: (pids: readonly number[]) => boolean;
  readonly restartService: () => boolean;
  /** An interactive question: true for yes. */
  readonly confirm: (q: { title: string; lines: string[]; yes: string }) => Promise<boolean>;
  readonly say: (line: string) => void;
  /** Also restart the service even when the programs ended (the caller said Windows still refuses). */
  readonly alsoService?: boolean;
}

export type CleanupOutcome =
  /** Nothing of the sandbox is on this PC. */
  | 'nothing'
  /** A live sandbox (or another user's): nothing was ended. */
  | 'alive'
  | 'declined'
  | 'cleaned'
  | 'service-restarted'
  | 'failed';

const NAMES = (j: SandboxJudgement): string => j.images.join(', ');

/** The question for a judgement of "leftover" (pure). */
export function cleanupQuestion(j: SandboxJudgement): { title: string; lines: string[]; yes: string } {
  return {
    title: 'Close the leftover Windows Sandbox programs?',
    lines: [
      j.why,
      'Windows Sandbox leaves its programs behind when the sandbox dies, and then refuses to start again.',
      'Only these programs of your Windows session are closed: ' + NAMES(j) + '. Nothing else.',
    ],
    yes: 'Close them',
  };
}

/** The whole clean-up: judge, ask, end, check, and (when needed and allowed) restart the service. */
export async function cleanUpLeftovers(deps: CleanupDeps): Promise<CleanupOutcome> {
  const first = judgeSandbox(await deps.facts());
  if (first.state === 'none') return 'nothing';
  if (first.state !== 'leftover') {
    deps.say(first.why + ' Nothing was closed.');
    return 'alive';
  }
  if (!(await deps.confirm(cleanupQuestion(first)))) return 'declined';
  const ended = deps.end(first.pids);
  const after = judgeSandbox(await deps.facts());
  const gone = after.state === 'none' || after.state === 'foreign';
  if (gone && !deps.alsoService) {
    deps.say('Closed ' + first.pids.length + ' leftover program(s). The sandbox can start again now.');
    return 'cleaned';
  }
  if (!gone) deps.say(ended ? 'Some programs are still there.' : 'Windows would not let them be closed.');
  const restart =
    deps.alsoService === true ||
    (await deps.confirm({
      title: 'Restart the Windows Sandbox service?',
      lines: [
        'Windows still holds the old sandbox. Restarting its service (CmService) clears that.',
        'Windows asks for administrator permission once.',
      ],
      yes: 'Restart it',
    }));
  if (!restart) return gone ? 'cleaned' : 'declined';
  if (!deps.restartService()) {
    deps.say('The service was not restarted (the permission was declined, or Windows refused).');
    return 'failed';
  }
  deps.say('The Windows Sandbox service was restarted.');
  return 'service-restarted';
}

export { LEFTOVER_IMAGES };

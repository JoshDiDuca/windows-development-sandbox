// C:\AgentData\run\sandbox.json: the boot's phase and progress, which the host shows while it waits.
import os from 'node:os';
import type { SandboxStatus } from '../../core/types.js';
import type { BackgroundWork, BootProgress } from '../../shared/channel/schema.js';
import { now } from '../../shared/channel/run-dir.js';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { errMsg } from '../../core/util/errors.js';
import { warn } from './log.js';
import { run } from './paths.js';
import { session, workspace } from './session.js';

/** The boot's structured progress (the host shows it as one line); kept between status writes. */
let progress: BootProgress | undefined;
/** What goes on after the boot is ready (Visual Studio installing), and the phase it is reported under. */
let background: BackgroundWork[] = [];
let current: { phase: SandboxStatus['phase']; message: string } = { phase: 'booting', message: '' };

/**
 * Best-effort: progress reporting must never be what breaks the boot. `update` changes the structured progress
 * (a new step, what is being set up); it stays as it was otherwise.
 */
export function setSandboxStatus(phase: SandboxStatus['phase'], message: string, update?: Partial<BootProgress>): void {
  current = { phase, message };
  try {
    if (update)
      progress = fitProgress({ step: 1, steps: 1, title: '', active: [], done: 0, total: 0, ...progress, ...update });
    writeStatus(phase, message);
  } catch (e) {
    warn('Could not update sandbox status: ' + errMsg(e));
  }
}

/** Within the limits the host accepts (it drops a progress that is not). */
function fitProgress(p: BootProgress): BootProgress {
  return {
    ...p,
    title: p.title.slice(0, 120),
    done: Math.min(p.done, 1000),
    total: Math.min(p.total, 1000),
    active: p.active.slice(0, 8).map((a) => ({
      name: a.name.slice(0, 64),
      ...(a.percent === undefined ? {} : { percent: Math.max(0, Math.min(100, Math.round(a.percent))) }),
    })),
  };
}

/** Whether the boot (another process: the daemon asks) still has this work running in the background. */
export function backgroundRunning(name: string): boolean {
  return (run.readSandboxStatus()?.background ?? []).some((w) => w.state === 'running' && w.name.includes(name));
}

/** Lists the work that continues after the boot (the phase and message stay as they are). */
export function setBackgroundWork(work: readonly BackgroundWork[]): void {
  background = work.slice(0, 16).map((w) => ({ name: w.name.slice(0, 64), state: w.state }));
  try {
    writeStatus(current.phase, current.message);
  } catch (e) {
    warn('Could not update sandbox status: ' + errMsg(e));
  }
}

function ownAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => Boolean(i) && i!.family === 'IPv4' && !i!.internal)
    .map((i) => i.address)
    .slice(0, 8);
}

function writeStatus(phase: SandboxStatus['phase'], message: string): void {
  writeJsonAtomic(run.sandboxFile, {
    launchId: session.launchId,
    phase,
    message,
    updatedAt: now(),
    workspaceHost: session.workspaceHost,
    guestWorkspace: workspace,
    headless: session.headless,
    addresses: ownAddresses(),
    ...(progress ? { progress } : {}),
    ...(background.length ? { background } : {}),
  } satisfies SandboxStatus);
}

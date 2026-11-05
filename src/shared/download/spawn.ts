import os from 'node:os';
import { spawn, type SpawnOptions } from 'node:child_process';

export interface SpawnAsyncOptions extends SpawnOptions {
  /** Below-normal priority for the program and what it starts: unpacking must not make the desktop sluggish. */
  readonly lowPriority?: boolean;
}

/** Lowers a process to below-normal priority; best effort (it may have ended already). */
export function lowerPriority(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    /* a normal priority only makes it a little slower to share the machine */
  }
}

/** Runs a program without blocking the event loop (parallel downloads keep going); resolves with its exit code. */
export function spawnAsync(file: string, args: string[], options: SpawnAsyncOptions = {}): Promise<number> {
  const { lowPriority, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true, ...spawnOptions });
    if (lowPriority) lowerPriority(child.pid);
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? -1));
  });
}

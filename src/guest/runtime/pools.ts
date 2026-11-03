// The guest's work pools: network bodies, heavy local work and installers. A task takes one slot at the leaf (the
// call that downloads, unpacks or installs), never while it holds another: the limiter refuses nested pools.
import os from 'node:os';
import { spawn, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { heavy, installer, net, INSTALLER_WAIT_MS, installerRetry } from '../../shared/concurrency/index.js';
import { downloader, limitExtraction } from '../../shared/download/index.js';
import { log } from './log.js';
import { execAsync } from './process.js';

export { net, heavy, installer };

/** Called at the start of the boot and of the daemon: the downloader and the extractor use the pools from then on. */
export function installPools(): void {
  downloader.limit = net;
  limitExtraction(heavy);
}

const BELOW_NORMAL = os.constants.priority.PRIORITY_BELOW_NORMAL;

/** Lowers a process (and the children it starts from now on) to below-normal priority; best effort. */
export function belowNormal(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    os.setPriority(pid, BELOW_NORMAL);
  } catch {
    /* the process may have ended already; a normal priority only makes it a little slower to share the machine */
  }
}

export interface InstallerOptions {
  /** Below-normal priority for the installer and what it starts (the background Visual Studio). */
  readonly lowPriority?: boolean;
  readonly cwd?: string;
  readonly stdio?: 'ignore' | 'inherit';
  /** Tests: how long to wait between tries. */
  readonly waitMs?: number;
}

/**
 * Runs an installer in the one installer slot and starts it again while another process holds the Windows Installer
 * lock (exit 1618). Resolves with the exit code of the last try.
 */
export async function runInstaller(file: string, args: string[], o: InstallerOptions = {}): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    const code = await installer.run(
      () =>
        new Promise<number>((resolve, reject) => {
          const child = spawn(file, args, {
            stdio: o.stdio ?? 'ignore',
            windowsHide: true,
            ...(o.cwd ? { cwd: o.cwd } : {}),
          });
          if (o.lowPriority) belowNormal(child.pid);
          child.once('error', reject);
          child.once('close', (c) => resolve(c ?? -1));
        }),
    );
    if (!installerRetry(code, attempt)) return code;
    log(path.basename(file) + ': another install is running; trying again in a moment (' + attempt + ')');
    await new Promise((r) => setTimeout(r, o.waitMs ?? INSTALLER_WAIT_MS));
  }
}

/** runInstaller that throws like execAsync when the installer fails. */
export async function runInstallerChecked(file: string, args: string[], o: InstallerOptions = {}): Promise<void> {
  const code = await runInstaller(file, args, o);
  if (code !== 0)
    throw new Error(path.basename(file) + ' ' + args.slice(0, 3).join(' ') + ' failed with exit code ' + code);
}

/** execAsync for heavy local work (npm, uv, rustup ...): one of the two heavy slots. */
export function execHeavy(file: string, args: string[], options: SpawnOptions = {}): Promise<void> {
  return heavy.run(() => execAsync(file, args, options));
}

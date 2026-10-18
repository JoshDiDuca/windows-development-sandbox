// This PC's memory (RAM and commit) for sizing the sandbox, the host watchdog and the doctor. HostTools.exe
// memory-status reads it (built in <storage>\bin), else native\scripts\memory-status.ps1. Windows Sandbox takes its
// memory from this PC as it goes (the setting is a ceiling, not a reservation), so what decides "slow or closed" is the
// PC's commit limit (RAM plus paging files), not only free RAM.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isWin } from '../../core/util/index.js';
import { SYSTEM } from '../../shared/system.js';
import { hostToolsExe, nativeScript } from '../native.js';
import { selfTestRunning } from '../test-guard.js';

export const HostMemorySchema = z.object({
  totalMb: z.number().int().nonnegative(),
  availableMb: z.number().int().nonnegative(),
  commitLimitMb: z.number().int().nonnegative(),
  commitAvailableMb: z.number().int().nonnegative(),
  /** How the paging file is set up: Windows manages it, a fixed size, or none. */
  pageFile: z.enum(['auto', 'fixed', 'none']).catch('auto'),
  /** Fixed: the total of its maximum sizes (MB). */
  pageFileMaxMb: z.number().int().nonnegative().catch(0),
  /** The disks' queue length now (all disks together); absent when this PC has no such counter. */
  diskQueue: z.number().nonnegative().max(100000).optional().catch(undefined),
});
export type HostMemory = z.output<typeof HostMemorySchema>;

const TIMEOUT_MS = 20000;

/** The parsed answer of memory-status, or null (not Windows, unreadable, nonsense). */
export function parseHostMemory(text: string): HostMemory | null {
  try {
    const parsed = HostMemorySchema.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.totalMb > 0 ? parsed.data : null;
  } catch {
    return null;
  }
}

function command(storageRoot: string): { file: string; args: string[] } {
  const tools = hostToolsExe(storageRoot);
  return tools
    ? { file: tools, args: ['memory-status'] }
    : { file: SYSTEM.powershell(), args: nativeScript('memory-status.ps1') };
}

/** This PC's memory now, or null when it cannot be read (and always during the self-test: it never asks Windows). */
export function readHostMemory(storageRoot: string): HostMemory | null {
  if (!isWin || selfTestRunning()) return null;
  const { file, args } = command(storageRoot);
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: TIMEOUT_MS });
  return parseHostMemory(result.stdout || '');
}

/** A reading older than this is not used (the stream stopped answering): the watcher asks once instead. */
const STREAM_FRESH_MS = 30000;
/** A stream that ended is started again at most this often. */
const STREAM_RESTART_MS = 60000;

/**
 * One long-running `HostTools memory-status --serve` for the watcher: a reading every `seconds`, instead of starting a
 * program (and building a disk counter) for each one. Without HostTools.exe it does nothing and `latest()` stays null.
 */
export class HostMemoryStream {
  private child: ChildProcess | null = null;
  private last: { readonly at: number; readonly memory: HostMemory } | null = null;
  private startedAt = 0;
  private stopped = false;

  constructor(
    private readonly storageRoot: string,
    private readonly seconds: number,
  ) {}

  start(): void {
    if (!isWin || selfTestRunning() || this.stopped || this.child) return;
    const tools = hostToolsExe(this.storageRoot);
    if (!tools) return;
    this.startedAt = Date.now();
    try {
      const child = spawn(tools, ['memory-status', '--serve', String(this.seconds)], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      this.child = child;
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer = (buffer + chunk).slice(-16384);
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const memory = parseHostMemory(buffer.slice(0, end).trim());
          buffer = buffer.slice(end + 1);
          if (memory) this.last = { at: Date.now(), memory };
        }
      });
      child.stdin.on('error', () => undefined);
      child.on('error', () => (this.child = null));
      child.on('exit', () => (this.child = null));
    } catch {
      // Could not start it: the watcher asks the old way.
      this.child = null;
    }
  }

  /** The newest reading while it is fresh; starts the stream again when it ended (at most once a minute). */
  latest(): HostMemory | null {
    if (!this.child && Date.now() - this.startedAt >= STREAM_RESTART_MS) this.start();
    return this.last && Date.now() - this.last.at < STREAM_FRESH_MS ? this.last.memory : null;
  }

  /** Ends it (closing its input ends HostTools). */
  stop(): void {
    this.stopped = true;
    this.child?.stdin?.end();
    this.child = null;
  }
}

/** The same without blocking: for the watcher, which must never wait on it. */
export function readHostMemoryAsync(storageRoot: string): Promise<HostMemory | null> {
  if (!isWin || selfTestRunning()) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const { file, args } = command(storageRoot);
      const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8').slice(0, 4096)));
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
      child.on('error', () => resolve(null));
      child.on('close', () => {
        clearTimeout(timer);
        resolve(parseHostMemory(out));
      });
    } catch {
      // Could not even start it: no answer this time.
      resolve(null);
    }
  });
}

/** How low this PC's memory is: what the host watchdog acts on (pure). */
export interface HostPressure {
  readonly low: boolean;
  /** Plain words for the log and the sandbox. */
  readonly reason: string;
}

/** Low = available commit under half the reserve, or available RAM under 2 GB. */
export function hostPressure(memory: HostMemory, reserveHostMb: number): HostPressure {
  if (memory.commitAvailableMb < reserveHostMb / 2)
    return {
      low: true,
      reason: 'this PC has only ' + memory.commitAvailableMb + ' MB of memory (RAM plus paging file) left to hand out',
    };
  if (memory.availableMb < 2048)
    return { low: true, reason: 'this PC has only ' + memory.availableMb + ' MB of free RAM left' };
  return { low: false, reason: '' };
}

/** One line for the host memory log. */
export function hostMemoryLine(memory: HostMemory, at: Date = new Date()): string {
  return (
    at.toISOString() +
    ' | RAM free/total MB ' +
    memory.availableMb +
    '/' +
    memory.totalMb +
    ' | commit free/limit MB ' +
    memory.commitAvailableMb +
    '/' +
    memory.commitLimitMb +
    ' | page file ' +
    memory.pageFile +
    (memory.diskQueue === undefined ? '' : ' | disk queue ' + memory.diskQueue)
  );
}

/**
 * Whether Windows Sandbox could push this PC past its commit limit (pure): the paging file is fixed or off and the
 * commit limit leaves less than the sandbox's memory plus what this PC already uses. Null when all is well.
 */
export function pageFileRisk(memory: HostMemory, sandboxMb: number): { neededGb: number; text: string } | null {
  if (memory.pageFile === 'auto') return null;
  const inUseMb = memory.commitLimitMb - memory.commitAvailableMb;
  const neededMb = inUseMb + sandboxMb;
  if (memory.commitLimitMb >= neededMb) return null;
  // The commit limit is RAM plus the paging files: the paging file has to make up the difference.
  const neededGb = Math.max(1, Math.ceil((neededMb - memory.totalMb) / 1024));
  return {
    neededGb,
    text:
      'Windows Sandbox takes its memory from this PC as it goes; if this PC runs out, Windows closes the sandbox instead of slowing it down. ' +
      'Let Windows manage the page file size (System > Advanced system settings > Performance > Settings > Advanced > Virtual memory: "Automatically manage paging file size"), or make the page file at least ' +
      neededGb +
      ' GB.',
  };
}

const HINT_EVERY_MS = 24 * 60 * 60 * 1000;

/** Whether the page file hint may be shown now (once a day at most); records that it was. */
export function takePageFileHint(storageRoot: string, now: Date = new Date()): boolean {
  const file = path.join(storageRoot, 'run', 'pagefile-hint.txt');
  try {
    const last = Number(fs.readFileSync(file, 'utf8'));
    if (Number.isFinite(last) && now.getTime() - last < HINT_EVERY_MS) return false;
  } catch {
    // Never shown: show it.
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(now.getTime()));
  } catch {
    // Cannot record it: showing it again next time is fine.
  }
  return true;
}

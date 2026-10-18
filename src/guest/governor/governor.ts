// The memory governor: samples the sandbox's memory every 2 seconds (memgov.exe, sandbox/csharp/MemGov.cs) and turns
// a dial as it fills: the build programs the agents started get lower priority, lower memory priority, less CPU, and
// take turns (decide.ts). Builds slow down; nothing fails. What it does goes to the memory log and run\pressure.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { DIAL_STEPS, maxCompilers, type LoadProfile } from '../../shared/memory/index.js';
import { ensureCompiled } from '../runtime/csc.js';
import { dataDir } from '../runtime/paths.js';
import { warn } from '../runtime/log.js';
import { run } from '../runtime/paths.js';
import { session } from '../runtime/session.js';
import { errMsg } from '../../core/util/errors.js';
import { GovernorCore, type GovernorPort } from './core.js';
import type { MemSample } from './decide.js';

const SampleSchema = z.object({
  ramTotalMb: z.number(),
  ramAvailMb: z.number(),
  commitLimitMb: z.number(),
  commitAvailMb: z.number(),
  procs: z
    .array(
      z.object({
        pid: z.number().int(),
        name: z.string().max(128),
        mb: z.number(),
        prio: z.enum(['idle', 'below', 'normal']).catch('normal'),
      }),
    )
    .max(1024),
});

/** memgov.exe as a child process: samples come out of its stdout, commands go into its stdin. */
class MemGovProcess implements GovernorPort {
  private child: ChildProcess | null = null;

  constructor(private readonly onSample: (s: MemSample) => void) {}

  start(): void {
    try {
      const child = spawn(ensureCompiled('memgov'), ['serve', '--interval', '2'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
      this.child = child;
      createInterface({ input: child.stdout! }).on('line', (line) => {
        try {
          this.onSample(SampleSchema.parse(JSON.parse(line)));
        } catch (e) {
          warn('governor: bad sample: ' + errMsg(e));
        }
      });
      child.stdin!.on('error', () => undefined);
      child.once('exit', () => {
        this.child = null;
        // It ends only when something is wrong: try again in a while.
        setTimeout(() => this.start(), 30000).unref();
      });
    } catch (e) {
      warn('governor: could not start memgov.exe (no memory governor): ' + errMsg(e));
    }
  }

  setPriority(pid: number, to: 'idle' | 'below' | 'normal'): void {
    this.send('priority ' + pid + ' ' + to);
  }

  hold(pid: number, ms: number): void {
    this.send('suspend ' + pid + ' ' + ms);
  }

  setMemoryPriority(pid: number, low: boolean): void {
    this.send('memprio ' + pid + ' ' + (low ? 'low' : 'normal'));
  }

  throttle(pid: number): void {
    this.send('throttle ' + pid);
  }

  setCpuRate(percent: number): void {
    this.send('cpurate ' + Math.round(percent));
  }

  trim(pid: number): void {
    this.send('trim ' + pid);
  }

  private send(line: string): void {
    this.child?.stdin?.write(line + '\n');
  }
}

/** The newest memory log SandboxTools writes, to add the governor's lines to it. */
function appendToMemoryLog(line: string): void {
  try {
    const logs = path.join(dataDir, 'logs');
    const newest = fs
      .readdirSync(logs)
      .filter((f) => /^memory-\d{8}-\d{6}\.log$/.test(f))
      .sort()
      .pop();
    if (!newest) return;
    const t = new Date();
    const stamp = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    fs.appendFileSync(path.join(logs, newest), stamp + ' | ' + line + '\r\n');
  } catch {
    // The log is for people; a missing or locked one never matters.
  }
}

/** The daemon's governor: on unless sandbox.pressureResponse is off. */
export class Governor {
  private core: GovernorCore | null = null;

  describe(): string {
    const profile = session.loadProfile === 'gentle' ? 'gentle' : 'normal';
    const first = DIAL_STEPS[profile][0];
    return session.pressureResponse === false
      ? 'off (sandbox.pressureResponse)'
      : profile +
          ' profile: slows builds down from ' +
          first.availablePercent +
          '% free RAM or ' +
          first.commitPercent +
          '% commit, in steps';
  }

  start(): void {
    if (session.pressureResponse === false) return;
    const profile: LoadProfile = session.loadProfile === 'gentle' ? 'gentle' : 'normal';
    const proc = new MemGovProcess((s) => this.core?.onSample(s));
    this.core = new GovernorCore({
      port: proc,
      profile,
      maxCompilers: maxCompilers(os.cpus().length, profile),
      now: () => Date.now(),
      logLine: appendToMemoryLog,
      warn,
      saveStatus: (status) => {
        try {
          writeJsonAtomic(run.pressureFile, status);
        } catch (e) {
          warn('governor: could not write its status: ' + errMsg(e));
        }
      },
    });
    proc.start();
  }

  /** The host's watchdog: this PC is low (or nearly out of memory) for a while. */
  hostPressure(seconds: number, reason: string, level: 'slow' | 'severe' = 'slow'): void {
    this.core?.hostPressure(seconds, reason, level);
  }
}

export const governor = new Governor();

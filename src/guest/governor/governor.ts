// The memory governor: samples the sandbox's memory every 2 seconds (memgov.exe, sandbox/csharp/MemGov.cs) and turns
// a dial as it fills: the build programs the agents started get lower priority, lower memory priority, less CPU, and
// take turns (decide.ts). Builds slow down; nothing fails. What it does goes to the memory log and run\pressure.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { PressureStatus } from '../../shared/channel/schema.js';
import { now } from '../../shared/channel/run-dir.js';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { DIAL_STEPS, maxCompilers, type LoadProfile } from '../../shared/memory/index.js';
import { ensureCompiled } from '../runtime/csc.js';
import { dataDir } from '../runtime/paths.js';
import { warn } from '../runtime/log.js';
import { run } from '../runtime/paths.js';
import { session } from '../runtime/session.js';
import { errMsg } from '../../core/util/errors.js';
import { decide, HOLD_MS, INITIAL_STATE, type Action, type GovernorState, type MemSample } from './decide.js';

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

/** What the governor needs from Windows (injectable: the tests use a fake). */
export interface GovernorPort {
  setPriority(pid: number, to: 'idle' | 'below' | 'normal'): void;
  /** Suspends for `ms`, then resumes (memgov resumes it even if the daemon goes away). */
  hold(pid: number, ms: number): void;
  setMemoryPriority(pid: number, low: boolean): void;
  /** Into the throttle job (whose CPU cap setCpuRate sets). */
  throttle(pid: number): void;
  setCpuRate(percent: number): void;
  trim(pid: number): void;
}

/** Everything a step changes outside the decision, behind injectable functions. */
export interface GovernorDeps {
  readonly port: GovernorPort;
  readonly profile: LoadProfile;
  /** At most this many heavy compilers run at once (null = no cap). */
  readonly maxCompilers?: number | null;
  readonly now: () => number;
  /** A line in the memory log. */
  readonly logLine: (line: string) => void;
  /** run\pressure.json. */
  readonly saveStatus: (status: PressureStatus) => void;
}

const STEP_TEXT: readonly string[] = [
  'builds back to normal',
  'build programs at lower priority',
  'builds get less CPU and take turns',
  'builds take turns, waiting ones go to the paging file',
  'one compiler at a time',
];

/** The governor's logic over a port: feed it samples; the host's "slow down" requests go to hostPressure. */
export class GovernorCore {
  private state: GovernorState = INITIAL_STATE;
  private lastAction = '';
  private lastWrite = '';
  private lastWriteAt = 0;
  /** Compilers waiting their turn now, by pid (name), to log a hold once. */
  private held = new Map<number, string>();

  constructor(private readonly deps: GovernorDeps) {}

  hostPressure(seconds: number, reason: string, level: 'slow' | 'severe' = 'slow'): void {
    const nowMs = this.deps.now();
    const until = nowMs + seconds * 1000;
    const active = this.state.hostUntil > nowMs;
    const step = Math.max(level === 'severe' ? 4 : 2, active ? this.state.hostStep : 0);
    if (!active || step > this.state.hostStep)
      this.deps.logLine(
        'governor: this PC is ' +
          (level === 'severe' ? 'nearly out of memory' : 'low') +
          ' (' +
          reason +
          '); builds to step ' +
          step,
      );
    this.state = { ...this.state, hostUntil: Math.max(until, this.state.hostUntil), hostStep: step };
  }

  get current(): GovernorState {
    return this.state;
  }

  onSample(sample: MemSample): void {
    const nowMs = this.deps.now();
    const before = this.state.step;
    const d = decide(this.state, sample, nowMs, this.deps.profile, this.deps.maxCompilers ?? null);
    this.state = d.state;
    const holding = new Set<number>();
    for (const action of d.actions) {
      if (action.kind === 'hold') holding.add(action.pid);
      this.apply(action);
    }
    for (const pid of [...this.held.keys()]) if (!holding.has(pid)) this.held.delete(pid);
    if (d.state.step !== before)
      this.deps.logLine(
        'governor: step ' +
          d.state.step +
          ' (' +
          d.ramFreePercent +
          '% RAM free, commit ' +
          d.commitPercent +
          '% used): ' +
          STEP_TEXT[d.state.step],
      );
    const status: PressureStatus = {
      level: d.level,
      step: d.state.step,
      profile: this.deps.profile,
      ramFreePercent: Math.max(0, Math.min(100, d.ramFreePercent)),
      commitPercent: Math.max(0, Math.min(100, d.commitPercent)),
      lowered: Object.keys(d.state.lowered).length,
      paused: [...this.held]
        .slice(0, 8)
        .map(([pid, name]) => ({ name: name.slice(0, 64), pid, seconds: HOLD_MS / 1000 })),
      cpuPercent: d.state.cpuRate,
      pcLow: nowMs < d.state.hostUntil,
      lastAction: this.lastAction.slice(0, 300),
      updatedAt: now(),
    };
    // Written when something changed, else once a minute (the host reads it, never polls it hard).
    const shape = JSON.stringify({ ...status, updatedAt: '', paused: status.paused.map((p) => p.pid) });
    if (shape !== this.lastWrite || nowMs - this.lastWriteAt > 60000) {
      this.lastWrite = shape;
      this.lastWriteAt = nowMs;
      this.deps.saveStatus(status);
    }
  }

  private apply(action: Action): void {
    const port = this.deps.port;
    try {
      switch (action.kind) {
        case 'hold':
          port.hold(action.pid, action.ms);
          if (!this.held.has(action.pid)) {
            this.held.set(action.pid, action.name);
            this.note(action.name + ' (' + action.pid + ') waits its turn');
          }
          return;
        case 'priority':
          port.setPriority(action.pid, action.to);
          this.note(action.name + ' (' + action.pid + ') priority ' + action.to);
          return;
        case 'memory':
          port.setMemoryPriority(action.pid, action.low);
          return;
        case 'throttle':
          port.throttle(action.pid);
          return;
        case 'cpu':
          port.setCpuRate(action.percent);
          this.note(action.percent >= 100 ? 'compilers: no CPU cap' : 'compilers: at most ' + action.percent + '% CPU');
          return;
        case 'trim':
          port.trim(action.pid);
          return;
      }
    } catch (e) {
      warn('governor: ' + errMsg(e));
    }
  }

  private note(text: string): void {
    this.lastAction = text;
    this.deps.logLine('governor: ' + text);
  }
}

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

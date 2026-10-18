// The governor's logic over a port (pure of the guest runtime: no session.json, no log folder, so tests can load it):
// feed it memory samples, it turns the dial (decide.ts) and applies the actions through the port. governor.ts wires it
// to memgov.exe and the sandbox's files.
import type { PressureStatus } from '../../shared/channel/schema.js';
import { now } from '../../shared/channel/run-dir.js';
import type { LoadProfile } from '../../shared/memory/index.js';
import { errMsg } from '../../core/util/errors.js';
import { decide, HOLD_MS, INITIAL_STATE, type Action, type GovernorState, type MemSample } from './decide.js';
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
  /** A problem worth the guest log (an action Windows refused). */
  readonly warn: (text: string) => void;
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
      this.deps.warn('governor: ' + errMsg(e));
    }
  }

  private note(text: string): void {
    this.lastAction = text;
    this.deps.logLine('governor: ' + text);
  }
}

// The memory governor's decisions (pure): given a memory sample and what it did before, how far to turn the dial and
// what that means for the build programs in the agents' job. Like a PC that gets slower instead of failing: lower
// priority, lower memory priority (their pages are trimmed first), less CPU, fewer compilers at a time (the others wait
// their turn, suspended and always resumed), waiting compilers trimmed to the paging file. Agents, shells and Windows
// are never touched. Nothing here touches Windows; governor.ts carries the actions out through a port.
import {
  compilersAllowed,
  DIAL_CALM_SAMPLES,
  DIAL_CPU_RATE,
  DIAL_EXIT_MARGIN,
  DIAL_STEPS,
  type LoadProfile,
} from '../../shared/memory/index.js';

export type Priority = 'idle' | 'below' | 'normal';

export interface ProcSample {
  readonly pid: number;
  readonly name: string;
  /** Private memory in MB. */
  readonly mb: number;
  readonly prio: Priority;
}

export interface MemSample {
  readonly ramTotalMb: number;
  readonly ramAvailMb: number;
  readonly commitLimitMb: number;
  readonly commitAvailMb: number;
  /** Only the processes in the agents' job. */
  readonly procs: readonly ProcSample[];
}

/** Programs that compile or link: they may be slowed down and, as the last resort, paused for a few seconds. */
const COMPILERS = new Set([
  'rustc',
  'clippy-driver',
  'rustdoc',
  'cc1',
  'cc1plus',
  'cc1obj',
  'collect2',
  'gcc',
  'g++',
  'c++',
  'cc',
  'clang',
  'clang++',
  'clang-cl',
  'cl',
  'link',
  'lld',
  'lld-link',
  'ld',
  'ld.lld',
  'as',
  'tsc',
  'javac',
]);
/** Build tools and workers: slowed down but never paused (a node process may be a dev server or an agent). */
// Not node: agents such as Codex and Gemini run as node.exe, and the agents are never slowed down.
const BUILD_TOOLS = new Set([
  'dotnet',
  'msbuild',
  'vbcscompiler',
  'ninja',
  'make',
  'mingw32-make',
  'cmake',
  'cargo',
  'go',
  'java',
  'gradle',
  'python',
]);
/** Never touched: the agents themselves, shells, terminals, this tool's own programs, Windows. */
const NEVER = new Set([
  'claude',
  'codex',
  'gemini',
  'opencode',
  'aider',
  'cursor-agent',
  'cmd',
  'powershell',
  'pwsh',
  'bash',
  'sh',
  'zsh',
  'git',
  'conhost',
  'openconsole',
  'windowsterminal',
  'wt',
  'ptyhost',
  'memgov',
  'sandboxtools',
  'sbx-db',
  'explorer',
  'csrss',
  'wininit',
  'winlogon',
  'services',
  'svchost',
  'lsass',
  'system',
  'smss',
  'dwm',
]);

const key = (name: string): string => name.toLowerCase().replace(/\.exe$/, '');

export const isNeverTouched = (name: string): boolean => NEVER.has(key(name));
export const canLower = (name: string): boolean =>
  !isNeverTouched(name) && (COMPILERS.has(key(name)) || BUILD_TOOLS.has(key(name)));
/** The heavy ones the concurrency cap counts (drivers like gcc and collect2 only wait for these). */
const HEAVY = new Set([
  'rustc',
  'clippy-driver',
  'rustdoc',
  'cc1',
  'cc1plus',
  'clang',
  'clang++',
  'clang-cl',
  'cl',
  'link',
  'lld',
  'lld-link',
  'ld',
  'ld.lld',
]);
export const isHeavyCompiler = (name: string): boolean => !isNeverTouched(name) && HEAVY.has(key(name));
export const canPause = (name: string): boolean => !isNeverTouched(name) && COMPILERS.has(key(name));

export type Level = 'ok' | 'throttled' | 'suspending';

export interface GovernorState {
  /** The dial: 0 nothing wrong, 1 lower priority, 2 less CPU and fewer compilers, 3 and 4 harder. */
  readonly step: number;
  /** Samples in a row clear of the current step (it turns down after DIAL_CALM_SAMPLES). */
  readonly calm: number;
  /** What was lowered and to what, by pid. */
  readonly lowered: Readonly<Record<number, Priority>>;
  /** Pids whose memory priority is low. */
  readonly memLow: readonly number[];
  /** Pids put in the throttle job (its CPU cap follows the step). */
  readonly throttled: readonly number[];
  /** Pids whose working set was trimmed while they waited. */
  readonly trimmed: readonly number[];
  /** The CPU cap last set on the throttle job (percent; 100 = none). */
  readonly cpuRate: number;
  /** Used commit (MB) and when, at the last sample: how fast it grows. */
  readonly lastCommitMb: number;
  readonly lastAt: number;
  /** The PC asked for slowing down until this time (ms): the dial is at least at `hostStep` until then. */
  readonly hostUntil: number;
  /** 2 when the PC is low, 4 when it is nearly out of memory. */
  readonly hostStep: number;
}

export const INITIAL_STATE: GovernorState = {
  step: 0,
  calm: 0,
  lowered: {},
  memLow: [],
  throttled: [],
  trimmed: [],
  cpuRate: 100,
  lastCommitMb: 0,
  lastAt: 0,
  hostUntil: 0,
  hostStep: 0,
};

export type Action =
  | { readonly kind: 'priority'; readonly pid: number; readonly name: string; readonly to: Priority }
  | { readonly kind: 'memory'; readonly pid: number; readonly name: string; readonly low: boolean }
  /** Into the throttle job, whose CPU cap follows the dial. */
  | { readonly kind: 'throttle'; readonly pid: number; readonly name: string }
  | { readonly kind: 'cpu'; readonly percent: number }
  /** Waits (suspended) for its turn; repeated while it waits, always resumed, never killed. */
  | { readonly kind: 'hold'; readonly pid: number; readonly name: string; readonly ms: number }
  /** Its pages go to the paging file while it waits, so the compilers that run have the RAM. */
  | { readonly kind: 'trim'; readonly pid: number; readonly name: string };

/** How long a held compiler waits before it may get a turn again (the governor repeats the hold while it waits). */
export const HOLD_MS = 3000;
/** Which compilers wait their turn changes this often, so none waits for ever. */
export const ROTATE_MS = 20000;

export interface Decision {
  readonly state: GovernorState;
  readonly actions: readonly Action[];
  readonly level: Level;
  readonly ramFreePercent: number;
  readonly commitPercent: number;
}

/** The step a sample calls for on its own: the highest step whose threshold it crosses. */
export function stepFor(ramFree: number, commit: number, secondsToLimit: number, profile: LoadProfile): number {
  let step = 0;
  DIAL_STEPS[profile].forEach((t, i) => {
    const soon = t.secondsToLimit !== undefined && secondsToLimit < t.secondsToLimit;
    if (ramFree < t.availablePercent || commit > t.commitPercent || soon) step = i + 1;
  });
  return step;
}

/** Is the sample clear of `step` by the exit margins (so the dial may turn down from it)? */
function clearOf(step: number, ramFree: number, commit: number, profile: LoadProfile): boolean {
  if (step === 0) return true;
  const t = DIAL_STEPS[profile][step - 1];
  return (
    ramFree > t.availablePercent + DIAL_EXIT_MARGIN.availablePercent &&
    commit < t.commitPercent - DIAL_EXIT_MARGIN.commitPercent
  );
}

/**
 * One step of the governor. The dial turns up at once and down one step at a time after calm samples. `gentle` (vGPU
 * on): compilers rest below normal priority, and `maxCompilers` caps how many heavy compilers run at any step.
 */
export function decide(
  prev: GovernorState,
  sample: MemSample,
  nowMs: number,
  profile: LoadProfile,
  maxCompilers: number | null = null,
): Decision {
  const ramFree = (sample.ramAvailMb / Math.max(1, sample.ramTotalMb)) * 100;
  const usedMb = sample.commitLimitMb - sample.commitAvailMb;
  const commit = (usedMb / Math.max(1, sample.commitLimitMb)) * 100;
  const seconds = (nowMs - prev.lastAt) / 1000;
  const growth = prev.lastAt > 0 && seconds > 0 ? (usedMb - prev.lastCommitMb) / seconds : 0;
  const secondsToLimit = growth > 0 ? sample.commitAvailMb / growth : Number.POSITIVE_INFINITY;
  const pcLow = nowMs < prev.hostUntil;
  const wanted = Math.max(stepFor(ramFree, commit, secondsToLimit, profile), pcLow ? prev.hostStep : 0);

  let step = prev.step;
  let calm = 0;
  if (wanted > prev.step) step = wanted;
  else if (prev.step > 0 && wanted < prev.step && clearOf(prev.step, ramFree, commit, profile)) {
    calm = prev.calm + 1;
    if (calm >= DIAL_CALM_SAMPLES) {
      step = prev.step - 1;
      calm = 0;
    }
  }

  const actions: Action[] = [];
  const present = new Set(sample.procs.map((p) => p.pid));
  const keep = (pids: readonly number[]): number[] => pids.filter((pid) => present.has(pid));
  const lowered: Record<number, Priority> = {};
  for (const [pid, to] of Object.entries(prev.lowered)) if (present.has(Number(pid))) lowered[Number(pid)] = to;
  const memLow = new Set(keep(prev.memLow));
  const throttled = new Set(keep(prev.throttled));
  const trimmed = new Set(keep(prev.trimmed));

  // CPU priority: where a program rests (normal; compilers below in the gentle profile), below from step 1, idle
  // from step 2. Only changes are sent.
  for (const p of sample.procs) {
    if (!canLower(p.name)) continue;
    const rest: Priority = profile === 'gentle' && canPause(p.name) ? 'below' : 'normal';
    const target: Priority = step >= 2 ? 'idle' : step === 1 ? 'below' : rest;
    const was = lowered[p.pid];
    const touched = was !== undefined || target !== 'normal';
    if (touched && was !== target && p.prio !== target)
      actions.push({ kind: 'priority', pid: p.pid, name: p.name, to: target });
    if (target === 'normal') delete lowered[p.pid];
    else lowered[p.pid] = target;
  }

  // Memory priority: low from step 1, so Windows trims the builds' pages before the agents'.
  const lowMemory = step >= 1;
  for (const p of sample.procs) {
    if (!canLower(p.name) || lowMemory === memLow.has(p.pid)) continue;
    actions.push({ kind: 'memory', pid: p.pid, name: p.name, low: lowMemory });
    if (lowMemory) memLow.add(p.pid);
    else memLow.delete(p.pid);
  }

  // CPU share of the compilers: they join the throttle job once (from step 2); its cap follows the dial.
  if (step >= 2)
    for (const p of sample.procs)
      if (canPause(p.name) && !throttled.has(p.pid)) {
        actions.push({ kind: 'throttle', pid: p.pid, name: p.name });
        throttled.add(p.pid);
      }
  const cpuRate = DIAL_CPU_RATE[step] ?? 100;
  if (cpuRate !== prev.cpuRate) actions.push({ kind: 'cpu', percent: cpuRate });

  // Turns: of the heavy compilers only so many go on; the rest wait, and who waits changes every ROTATE_MS.
  const heavy = sample.procs.filter((p) => isHeavyCompiler(p.name)).sort((a, b) => a.pid - b.pid);
  let allowed = compilersAllowed(step, heavy.length);
  if (maxCompilers !== null) allowed = Math.min(allowed, Math.max(1, maxCompilers));
  if (allowed < heavy.length) {
    const turn = Math.floor(nowMs / ROTATE_MS) % heavy.length;
    const order = [...heavy.slice(turn), ...heavy.slice(0, turn)];
    for (const p of order.slice(allowed)) {
      actions.push({ kind: 'hold', pid: p.pid, name: p.name, ms: HOLD_MS });
      if (step >= 3 && !trimmed.has(p.pid)) {
        actions.push({ kind: 'trim', pid: p.pid, name: p.name });
        trimmed.add(p.pid);
      }
    }
    for (const p of order.slice(0, allowed)) trimmed.delete(p.pid);
  } else trimmed.clear();

  const level: Level = step >= 3 ? 'suspending' : step >= 1 ? 'throttled' : 'ok';
  return {
    state: {
      step,
      calm,
      lowered,
      memLow: [...memLow],
      throttled: [...throttled],
      trimmed: [...trimmed],
      cpuRate,
      lastCommitMb: usedMb,
      lastAt: nowMs,
      hostUntil: prev.hostUntil,
      hostStep: prev.hostStep,
    },
    actions,
    level,
    ramFreePercent: Math.round(ramFree),
    commitPercent: Math.round(commit),
  };
}

// Heavy load must slow builds down, not close the sandbox: memory sizing with the PC's commit, the agents' memory
// limit, the guest governor (thresholds, hysteresis, which programs), the host watchdog, the crash report and the C#
// helpers behind them.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULTS } from '../core/config/index.js';
import { isWin } from '../core/util/index.js';
import { SYSTEM } from '../shared/system.js';
import { GuestRequestSchema, PressureStatusSchema } from '../shared/channel/index.js';
import {
  compilersAllowed,
  DIAL_CALM_SAMPLES,
  DIAL_STEPS,
  HOST_THRESHOLDS,
  buildJobs,
  cargoJobs,
  linkSlotsFor,
  usableCpus,
  effectiveCpuLimit,
  gentleCpuLimit,
  maxCompilers,
} from '../shared/memory/index.js';
import {
  cappedMemoryMb,
  decideMemory,
  memoryNote,
  residentCapMb,
  residentNote,
  resolveMemoryMb,
} from '../host/launch/index.js';
import { vgpuWarning, GENTLE_NOTE } from '../host/launch/risk-notes.js';
import {
  bugcheckCode,
  cpuPercentBetween,
  explainStop,
  findDumps,
  findingLines,
  freezeLine,
  hostPressure,
  lowReason,
  severeHost,
  pageFileRisk,
  parseHostMemory,
  crashReportText,
  watchdogStep,
  WATCHDOG_START,
  type HostMemory,
  type StopEvent,
} from '../host/life/index.js';
// The pure governor files only: governor.ts loads the guest runtime (session.json), which exists only in a sandbox.
import {
  canLower,
  canPause,
  decide,
  INITIAL_STATE,
  ROTATE_MS,
  type Action,
  type MemSample,
  type ProcSample,
} from '../guest/governor/decide.js';
import { GovernorCore, type GovernorPort } from '../guest/governor/core.js';
import type { Suite } from './support/suite.js';

const GB = 1024;
const MB_SANDBOX = DEFAULTS.sandbox;

const proc = (pid: number, name: string, mb: number, prio: ProcSample['prio'] = 'normal'): ProcSample => ({
  pid,
  name,
  mb,
  prio,
});
const sample = (ramFreePercent: number, commitPercent: number, procs: ProcSample[]): MemSample => ({
  ramTotalMb: 10000,
  ramAvailMb: ramFreePercent * 100,
  commitLimitMb: 10000,
  commitAvailMb: (100 - commitPercent) * 100,
  procs,
});
const pc = (over: Partial<HostMemory> = {}): HostMemory => ({
  totalMb: 32768,
  availableMb: 20000,
  commitLimitMb: 49152,
  commitAvailableMb: 40000,
  pageFile: 'auto',
  pageFileMaxMb: 0,
  ...over,
});

export const heavyLoadSuite: Suite = {
  name: 'heavy-load',
  title: 'heavy load: memory sizing, agent memory limit, governor, watchdog, crash report',
  run: async (t, f) => {
    t.section('memory sizing looks at the commit as well as free RAM');
    const base = decideMemory(MB_SANDBOX, 20 * GB, 32 * GB, null);
    t.check(base.mb === 12 * GB, 'without a commit reading: free RAM minus the reserve', String(base.mb));
    const tight = decideMemory(MB_SANDBOX, 20 * GB, 32 * GB, 14 * GB);
    t.check(
      tight.mb === 6 * GB && tight.limitedBy === 'commit',
      'a small commit lowers it (14 GB left - 8 GB reserve = 6 GB)',
      JSON.stringify(tight),
    );
    const roomy = decideMemory(MB_SANDBOX, 20 * GB, 32 * GB, 60 * GB);
    t.check(roomy.mb === base.mb && roomy.limitedBy === 'free', 'plenty of commit changes nothing');
    t.check(
      resolveMemoryMb(MB_SANDBOX, 20 * GB * 1048576, 32 * GB * 1048576, 14 * GB) === 6 * GB,
      'resolveMemoryMb uses it',
    );
    t.check(
      memoryNote(tight)?.includes('6 GB of memory instead of 12 GB') === true,
      'the launch note says plainly what happened',
    );
    t.check(
      memoryNote(base) === null && memoryNote(decideMemory(MB_SANDBOX, 20 * GB, 32 * GB, 19 * GB)) === null,
      'no note when it hardly changed',
    );
    let refused = '';
    try {
      resolveMemoryMb(MB_SANDBOX, 20 * GB * 1048576, 32 * GB * 1048576, 10 * GB);
    } catch (e) {
      refused = String(e instanceof Error ? e.message : e);
    }
    t.check(refused.includes('RAM plus paging file'), 'too little commit refuses with the real reason', refused);
    t.check(
      resolveMemoryMb({ ...MB_SANDBOX, memoryMb: 5000 }, 1, 1, 1) === 5000,
      'a fixed memoryMb is taken as asked (the resident cap below is the only limit on it)',
    );
    t.check(
      residentCapMb({ ...MB_SANDBOX, vGpu: false }, 32768) === 24576 &&
        residentCapMb({ ...MB_SANDBOX, vGpu: true }, 32768) === 22528 &&
        residentCapMb({ ...MB_SANDBOX, vGpu: false }, 65536) === 49152,
      'what this PC can keep in RAM for the sandbox: its RAM minus max(reserve, 25 %), 2 GB more with vGPU',
    );
    t.check(
      cappedMemoryMb(32768, { ...MB_SANDBOX, vGpu: true }, 32768) === 22528 &&
        cappedMemoryMb(16384, { ...MB_SANDBOX, vGpu: true }, 32768) === 16384 &&
        cappedMemoryMb(8192, MB_SANDBOX, 6144) === 8192,
      'a fixed memoryMb above it is lowered to it (never on a PC too small to keep 4 GB)',
    );
    t.check(
      residentNote(32768, 22528)?.includes('gets 22528 MB') === true && residentNote(16384, 16384) === null,
      'and the launch says so',
    );
    t.check(
      decideMemory(
        { ...MB_SANDBOX, maxMemoryPercent: 100, maxMemoryMb: 65536, reserveHostMb: 1024 },
        32000,
        32768,
        null,
      ).limitedBy === 'resident',
      '"auto" never goes above it either',
    );

    t.section("the agents' job backstop");
    const gen = await f.launch({}, { args: ['--version'] });
    const session = JSON.parse(fs.readFileSync(gen.sessionPath, 'utf8')) as Record<string, unknown>;
    t.check(
      session.agentBackstop === 'auto' &&
        session.agentMemoryLimitMb === undefined &&
        session.pressureResponse === true &&
        session.loadProfile === 'normal',
      'session.json carries the backstop setting (no limit from RAM any more), the governor switch and the profile',
      JSON.stringify(session.agentBackstop),
    );
    const vgpuConfig = f.makeConfig();
    vgpuConfig.sandbox.vGpu = true;
    const gentle = await f.launch({}, { args: ['--version'], config: vgpuConfig });
    const gs = JSON.parse(fs.readFileSync(gentle.sessionPath, 'utf8')) as Record<string, unknown>;
    t.check(
      gs.loadProfile === 'gentle' && gs.cpuLimitPercent === 65,
      'vGPU on: the gentle profile and a CPU cap 15 points lower (80 -> 65)',
      JSON.stringify([gs.loadProfile, gs.cpuLimitPercent]),
    );
    t.check(gentleCpuLimit(60) === 50 && gentleCpuLimit('none') === 85, 'the gentle cap never goes below 50 %');
    t.check(
      effectiveCpuLimit('none', 'normal') === null && effectiveCpuLimit(80, 'normal') === 80,
      'normal profile: unchanged',
    );
    t.check(
      vgpuWarning('your settings').includes('can freeze the whole PC') && GENTLE_NOTE.includes('gentler'),
      'the vGPU texts',
    );

    t.section('cargo jobs fit the memory and the sessions');
    t.check(cargoJobs(16, 32, 1) === 4, '16 CPUs, 32 GB: 4 jobs');
    t.check(cargoJobs(16, 8, 1) === 2 && cargoJobs(16, 3, 1) === 1, 'about 4 GB per job');
    t.check(cargoJobs(16, 32, 3) === 2 && cargoJobs(16, 32, 8) === 1, 'fewer when several sessions build');
    t.check(cargoJobs(32, 32, 1) === 8, '32 processors, 32 GB: 8 jobs for one session');
    t.check(
      buildJobs(32, 32) === 8 && buildJobs(32, 64) === 19 && buildJobs(4, 64) === 4 && buildJobs(16, 4) === 2,
      'the build budget: 3 GB per job after 6 GB, never more than the processors, at least 2',
    );
    t.check(
      linkSlotsFor(32) === 8 && linkSlotsFor(16) === 3 && linkSlotsFor(8) === 2 && linkSlotsFor(128) === 8,
      'links at once ("auto"): one per 3 GB after 6 GB, 2 to 8',
    );
    t.check(
      usableCpus(32, 80) === 25 && usableCpus(32, null) === 32 && usableCpus(4, 10) === 2 && usableCpus(8, 100) === 8,
      'the processors programs see follow the CPU cap (at least 2)',
    );

    t.section('the governor: which programs');
    t.check(
      canPause('rustc.exe') && canPause('link.exe') && canPause('ld.lld.exe'),
      'compilers and linkers may be paused',
    );
    t.check(
      !canPause('node.exe') && !canLower('node.exe') && canLower('MSBuild.exe'),
      'build tools are only slowed down',
    );
    t.check(
      [
        'claude.exe',
        'codex.exe',
        'cmd.exe',
        'powershell.exe',
        'ptyhost.exe',
        'git.exe',
        'svchost.exe',
        'memgov.exe',
      ].every((n) => !canLower(n) && !canPause(n)),
      'agents, shells, ptyhost, git and system programs are never touched',
    );

    t.section('the governor: the dial turns up in steps, down slowly');
    const procs = [
      proc(1, 'rustc.exe', 2800),
      proc(2, 'rustc.exe', 2000),
      proc(3, 'claude.exe', 900),
      proc(4, 'link.exe', 500),
    ];
    const of = (d: { actions: readonly Action[] }, kind: Action['kind']): Action[] =>
      d.actions.filter((a) => a.kind === kind);
    const pids = (actions: readonly Action[]): string =>
      actions
        .map((a) => ('pid' in a ? a.pid : 0))
        .sort()
        .join();
    const calm = decide(INITIAL_STATE, sample(50, 50, procs), 1000, 'normal');
    t.check(calm.state.step === 0 && calm.level === 'ok' && calm.actions.length === 0, '50 % free: nothing happens');
    t.check(
      decide(INITIAL_STATE, sample(16, 79, procs), 1000, 'normal').state.step === 0,
      '16 % free and 79 % commit are fine (step 1 starts at 15 % and 80 %)',
    );
    const one = decide(INITIAL_STATE, sample(14, 50, procs), 1000, 'normal');
    t.check(
      one.state.step === 1 &&
        of(one, 'priority').every((a) => a.kind === 'priority' && a.to === 'below') &&
        pids(of(one, 'priority')) === '1,2,4' &&
        pids(of(one, 'memory')) === '1,2,4' &&
        of(one, 'hold').length === 0 &&
        of(one, 'cpu').length === 0,
      'step 1: build programs get lower CPU and memory priority, nothing waits, the agent is untouched',
    );
    const two = decide(INITIAL_STATE, sample(9, 50, procs), 1000, 'normal');
    t.check(
      two.state.step === 2 &&
        of(two, 'priority').every((a) => a.kind === 'priority' && a.to === 'idle') &&
        pids(of(two, 'throttle')) === '1,2,4' &&
        of(two, 'cpu').some((a) => a.kind === 'cpu' && a.percent === 60) &&
        of(two, 'hold').length === 1,
      'step 2: idle priority, compilers share 60 % of the CPU, 2 of 3 compilers go on',
    );
    const three = decide(INITIAL_STATE, sample(5, 50, procs), 1000, 'normal');
    t.check(
      three.state.step === 3 &&
        three.level === 'suspending' &&
        of(three, 'cpu').some((a) => a.kind === 'cpu' && a.percent === 35) &&
        of(three, 'hold').length === 2 &&
        pids(of(three, 'trim')) === pids(of(three, 'hold')),
      'step 3: 35 % CPU, one compiler goes on, the waiting ones are trimmed to the paging file',
    );
    t.check(
      decide(INITIAL_STATE, sample(50, 98, procs), 1000, 'normal').state.step === 4,
      'commit above 97 % is step 4',
    );
    const growing = decide(
      { ...INITIAL_STATE, lastCommitMb: 1000, lastAt: 1000 },
      sample(50, 60, procs),
      2000,
      'normal',
    );
    t.check(
      growing.state.step === 4,
      'commit that would reach its limit within seconds turns the dial up before it gets there',
      'step ' + growing.state.step,
    );
    const everything = [one, two, three, growing].flatMap((d) => d.actions);
    t.check(
      everything.every((a) => !('pid' in a) || a.pid !== 3),
      'the agent is never slowed, held or trimmed at any step',
    );

    // Hysteresis: step 2 holds while memory is between its entry (10 %) and its exit (15 %).
    let h = decide(INITIAL_STATE, sample(9, 50, procs), 0, 'normal').state;
    h = decide(h, sample(12, 50, procs), 2000, 'normal').state;
    t.check(h.step === 2, 'between the entry and the exit of a step it stays (no flapping)');
    const steps: number[] = [];
    for (let i = 0; i < 2 * DIAL_CALM_SAMPLES; i++) {
      h = decide(h, sample(40, 40, procs), 4000 + i * 2000, 'normal').state;
      steps.push(h.step);
    }
    t.check(
      steps.join() === '2,2,1,1,1,0',
      'it turns down one step after ' + DIAL_CALM_SAMPLES + ' calm samples: ' + steps.join(),
    );
    const back = decide(
      { ...INITIAL_STATE, step: 1, calm: DIAL_CALM_SAMPLES - 1, lowered: { 1: 'below' }, memLow: [1], cpuRate: 100 },
      sample(40, 40, [proc(1, 'rustc.exe', 2800, 'below')]),
      9000,
      'normal',
    );
    t.check(
      back.state.step === 0 &&
        of(back, 'priority').some((a) => a.kind === 'priority' && a.to === 'normal') &&
        of(back, 'memory').some((a) => a.kind === 'memory' && !a.low),
      'at step 0 the compilers get their normal CPU and memory priority back',
    );
    const uncapped = decide(
      { ...INITIAL_STATE, step: 2, calm: DIAL_CALM_SAMPLES - 1, cpuRate: 60 },
      sample(40, 40, procs),
      9000,
      'normal',
    );
    t.check(
      uncapped.state.step === 1 && of(uncapped, 'cpu').some((a) => a.kind === 'cpu' && a.percent === 100),
      'the CPU cap is lifted when the dial goes below step 2',
    );
    const hostAsked = decide({ ...INITIAL_STATE, hostUntil: 5000, hostStep: 2 }, sample(60, 40, procs), 1000, 'normal');
    t.check(hostAsked.state.step >= 2, 'the PC asking for it turns the dial to at least step 2 while it lasts');
    const turnA = of(decide(INITIAL_STATE, sample(5, 50, procs), 0, 'normal'), 'hold');
    const turnB = of(decide(INITIAL_STATE, sample(5, 50, procs), ROTATE_MS, 'normal'), 'hold');
    t.check(pids(turnA) !== pids(turnB), 'who waits changes over time, so no compiler waits for ever');
    t.check(
      compilersAllowed(2, 10) === 6 && compilersAllowed(3, 10) === 4 && compilersAllowed(4, 10) === 1,
      'how many compilers go on at steps 2, 3 and 4',
    );

    t.section('the gentle profile (vGPU on)');
    t.check(
      DIAL_STEPS.gentle[0].availablePercent > DIAL_STEPS.normal[0].availablePercent &&
        DIAL_STEPS.gentle[0].commitPercent < DIAL_STEPS.normal[0].commitPercent,
      'every step starts earlier',
    );
    const g = decide(INITIAL_STATE, sample(50, 50, procs), 0, 'gentle');
    t.check(
      g.state.step === 0 &&
        g.actions.length === 3 &&
        g.actions.every((a) => a.kind === 'priority' && a.to === 'below' && a.pid !== 3),
      'compilers rest below normal even with plenty of memory (the agent does not)',
    );
    t.check(decide(INITIAL_STATE, sample(19, 50, procs), 0, 'gentle').state.step === 1, '19 % free is step 1');

    t.section('the compiler cap (vGPU on)');
    t.check(
      maxCompilers(16, 'gentle') === 4 && maxCompilers(4, 'gentle') === 2 && maxCompilers(16, 'normal') === null,
      'at most max(2, cores / 4) with vGPU, none otherwise',
    );
    const many = [
      proc(10, 'rustc.exe', 800),
      proc(11, 'rustc.exe', 900),
      proc(12, 'clippy-driver.exe', 700),
      proc(13, 'link.exe', 100),
      proc(3, 'claude.exe', 500),
      proc(14, 'node.exe', 400),
    ];
    const capped = decide(INITIAL_STATE, sample(60, 40, many), 0, 'gentle', 2);
    const holds = of(capped, 'hold').map((a) => ('pid' in a ? a.pid : 0));
    t.check(holds.length === 2, 'beyond the cap, compilers wait their turn', holds.join(','));
    t.check(!holds.includes(3) && !holds.includes(14), 'agents (claude, and codex or gemini as node) are never held');
    t.check(
      of(decide(INITIAL_STATE, sample(60, 40, many), 0, 'gentle', null), 'hold').length === 0,
      'no cap, no pressure: nothing waits',
    );
    t.check(
      of(decide(INITIAL_STATE, sample(60, 40, many.slice(0, 2)), 0, 'gentle', 2), 'hold').length === 0,
      'under the cap nothing waits',
    );

    t.section('the governor over a port (fake Windows)');
    const calls: string[] = [];
    const port: GovernorPort = {
      setPriority: (pid, to) => calls.push('prio ' + pid + ' ' + to),
      hold: (pid, ms) => calls.push('hold ' + pid + ' ' + ms),
      setMemoryPriority: (pid, low) => calls.push('mem ' + pid + ' ' + (low ? 'low' : 'normal')),
      throttle: (pid) => calls.push('throttle ' + pid),
      setCpuRate: (percent) => calls.push('cpu ' + percent),
      trim: (pid) => calls.push('trim ' + pid),
    };
    const logs: string[] = [];
    const statuses: unknown[] = [];
    let clock = 0;
    const core = new GovernorCore({
      port,
      profile: 'normal',
      now: () => clock,
      logLine: (l) => logs.push(l),
      saveStatus: (s) => statuses.push(s),
      warn: (line) => logs.push(line),
    });
    for (let i = 0; i < 4; i++) {
      clock = i * 2000;
      core.onSample(sample(5, 60, procs));
    }
    t.check(
      calls.includes('prio 1 idle') &&
        calls.includes('mem 1 low') &&
        calls.includes('cpu 35') &&
        calls.some((c) => c.startsWith('hold ')) &&
        calls.some((c) => c.startsWith('trim ')) &&
        !calls.some((c) => / 3( |$)/.test(c)),
      'priority, memory priority, CPU cap, turns and trimming go through the port; the agent untouched',
      calls.join('; '),
    );
    t.check(
      logs.some((l) => l.includes('step 3')) && logs.some((l) => l.includes('waits its turn')),
      'what it did goes to the memory log',
    );
    const lastStatus = statuses[statuses.length - 1];
    t.check(
      statuses.length > 0 && PressureStatusSchema.safeParse(lastStatus).success,
      'its status file matches the schema the host reads',
      JSON.stringify(lastStatus),
    );
    core.hostPressure(60, 'test');
    t.check(core.current.hostStep === 2, 'the PC being low asks for step 2');
    core.hostPressure(60, 'test', 'severe');
    t.check(core.current.hostStep === 4, 'the PC nearly out of memory asks for step 4 at once');
    core.hostPressure(60, 'test');
    t.check(core.current.hostStep === 4, 'a later "low" does not lower a severe request while it lasts');
    t.check(
      decide({ ...INITIAL_STATE, hostUntil: clock + 60000, hostStep: 4 }, sample(60, 40, procs), clock, 'normal').state
        .step === 4,
      'with plenty of memory in the sandbox, a severe PC still turns the dial to 4',
    );
    t.check(core.current.hostUntil === clock + 60000, 'a host request is remembered for its seconds');

    t.section("the PC's watchdog");
    const input = (
      memory: HostMemory | null,
      nowMs: number,
      cpu: number | null = 10,
      profile: 'normal' | 'gentle' = 'normal',
    ) => ({
      memory,
      cpuPercent: cpu,
      intervalSeconds: 10,
      nowMs,
      reserveHostMb: 8192,
      profile,
    });
    t.check(watchdogStep(WATCHDOG_START, input(pc(), 0)).state.low === false, 'plenty of memory: quiet');
    t.check(
      severeHost(pc({ availableMb: 1200 })) &&
        severeHost(pc({ commitAvailableMb: 1500 })) &&
        !severeHost(pc({ availableMb: 3000 })),
      'nearly out of memory: under 1.5 GB of RAM free, or commit within max(2 GB, 4 %) of its limit',
    );
    const lowState = watchdogStep(WATCHDOG_START, input(pc({ availableMb: 3000 }), 100000)).state;
    const severeNow = watchdogStep(lowState, input(pc({ availableMb: 1200 }), 105000));
    t.check(severeNow.severe && severeNow.send, 'getting severe is sent at once (not after the usual 30 seconds)');
    t.check(lowReason(pc({ availableMb: 3000 }), 8192, HOST_THRESHOLDS.normal, 1) !== '', 'under 4 GB of RAM: low');
    t.check(
      lowReason(pc({ availableMb: 5000 }), 8192, HOST_THRESHOLDS.normal, 1) === '',
      '5 GB free on a 32 GB PC is fine (limit max(4 GB, 12 % = 3.9 GB))',
    );
    t.check(
      lowReason(pc({ totalMb: 65536, availableMb: 7000 }), 8192, HOST_THRESHOLDS.normal, 1) !== '',
      '12 % of 64 GB = 7.7 GB: 7 GB is low',
    );
    t.check(
      lowReason(pc({ commitAvailableMb: 6000 }), 8192, HOST_THRESHOLDS.normal, 1) !== '',
      'commit under 15 % of the limit: low',
    );
    t.check(
      lowReason(pc({ availableMb: 5000 }), 8192, HOST_THRESHOLDS.gentle, 1) !== '',
      'the gentle profile acts at 6 GB',
    );
    const first = watchdogStep(WATCHDOG_START, input(pc({ availableMb: 2000 }), 100000));
    t.check(first.send && first.changed && first.state.low, 'low: asks the sandbox at once');
    const second = watchdogStep(first.state, input(pc({ availableMb: 2000 }), 110000));
    t.check(!second.send, 'and not again within 30 s');
    t.check(
      watchdogStep(second.state, input(pc({ availableMb: 2000 }), 131000)).send,
      'but repeats every 30 s while it lasts',
    );
    let w = first.state;
    w = watchdogStep(w, input(pc({ availableMb: 4500 }), 140000)).state;
    t.check(w.low, 'just above the limit is not recovered yet (needs 1.25 times)');
    for (let i = 0; i < 3; i++) w = watchdogStep(w, input(pc({ availableMb: 12000 }), 150000 + i * 10000)).state;
    t.check(!w.low, 'recovered after 3 good samples');
    let cpu = WATCHDOG_START;
    let sent = false;
    for (let i = 0; i < 7; i++) {
      const s = watchdogStep(cpu, input(pc(), i * 10000, 97));
      cpu = s.state;
      sent = sent || s.send;
    }
    t.check(sent && cpu.low, 'CPU above 95 % for 60 s: asks the sandbox to slow down');
    t.check(!watchdogStep(WATCHDOG_START, input(pc(), 0, 97)).state.low, 'a short CPU peak is nothing');
    let disk = WATCHDOG_START;
    let diskSent = false;
    for (let i = 0; i < 5; i++) {
      const st = watchdogStep(disk, input(pc({ diskQueue: 40 }), i * 10000));
      disk = st.state;
      diskSent = diskSent || st.send;
    }
    t.check(diskSent && disk.low, 'a disk queue of 32 or more for 40 s: asks the sandbox to slow down');
    t.check(!watchdogStep(WATCHDOG_START, input(pc({ diskQueue: 40 }), 0)).state.low, 'a short disk peak is nothing');
    t.check(!watchdogStep(WATCHDOG_START, input(pc(), 0)).state.low, 'no disk counter: memory and CPU only');
    t.check(
      cpuPercentBetween(
        [{ times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } } as never],
        [{ times: { user: 90, nice: 0, sys: 0, idle: 10, irq: 0 } } as never],
      ) === 90,
      'CPU use from two readings',
    );
    t.check(
      GuestRequestSchema.safeParse({ kind: 'pressure', id: 'p1', reason: 'low', seconds: 90, createdAt: 'now' })
        .success &&
        !GuestRequestSchema.safeParse({ kind: 'pressure', id: 'p1', reason: 'x', seconds: 99999, createdAt: 'now' })
          .success &&
        !GuestRequestSchema.safeParse({ kind: 'pressure', id: '../x', reason: 'x', seconds: 30, createdAt: 'now' })
          .success &&
        !GuestRequestSchema.safeParse({
          kind: 'pressure',
          id: 'p1',
          reason: 'x',
          seconds: 30,
          createdAt: 'now',
          extra: 1,
        }).success,
      'the pressure request is validated (id, seconds, no extra fields)',
    );
    t.check(
      hostPressure(pc({ commitAvailableMb: 3000 }), 8192).low && !hostPressure(pc(), 8192).low,
      'hostPressure (launch-time helper)',
    );

    t.section('host memory reading and the page file warning');
    t.check(
      parseHostMemory(
        '{"totalMb":32766,"availableMb":23596,"commitLimitMb":49150,"commitAvailableMb":38910,"pageFile":"fixed","pageFileMaxMb":16384}',
      )?.pageFile === 'fixed' &&
        parseHostMemory('not json') === null &&
        parseHostMemory('{"totalMb":0}') === null &&
        parseHostMemory('{"totalMb":1,"availableMb":1,"commitLimitMb":1,"commitAvailableMb":1}')?.pageFile === 'auto',
      'memory-status output is parsed and checked',
    );
    t.check(pageFileRisk(pc(), 20000) === null, 'Windows manages the page file: no warning');
    const risk = pageFileRisk(pc({ pageFile: 'fixed', commitLimitMb: 40000, commitAvailableMb: 10000 }), 20000);
    t.check(
      risk !== null &&
        risk.text.includes('closes the sandbox instead of slowing it down') &&
        risk.text.includes('Automatically manage paging file size') &&
        risk.neededGb >= 1,
      'a fixed small page file: warns in plain words and names the size',
      JSON.stringify(risk),
    );
    t.check(
      pageFileRisk(pc({ pageFile: 'none', commitLimitMb: 32768, commitAvailableMb: 30000 }), 31000) !== null,
      'no page file at all warns too',
    );
    t.check(
      pageFileRisk(pc({ pageFile: 'fixed', commitLimitMb: 90000, commitAvailableMb: 80000 }), 20000) === null,
      'a fixed but large one is fine',
    );

    t.section('the crash report');
    const ev = (id: number, provider: string, at: string, process = ''): StopEvent => ({ id, provider, at, process });
    t.check(
      bugcheckCode('BugcheckCode 209') === '0xD1' && bugcheckCode('BugcheckCode 0') === null,
      'Kernel-Power 41 stop code',
    );
    const cause = explainStop([ev(41, 'Microsoft-Windows-Kernel-Power', '2026-10-15T20:53:47Z', 'BugcheckCode 0')]);
    t.check(cause?.kind === 'crash' && cause.text.includes('freeze'), 'no stop code: a freeze, crash or power cut');
    t.check(
      explainStop([
        ev(41, 'Microsoft-Windows-Kernel-Power', '2026-10-15T20:53:47Z', 'BugcheckCode 209'),
      ])?.text.includes('0xD1') === true,
      'with a stop code: a blue screen',
    );
    t.check(
      freezeLine(cause!, '2026-10-15T19:40:57Z')?.includes('73 minutes later') === true &&
        freezeLine(cause!, '2026-10-15T20:53:00Z') === null,
      'a long gap says the PC stopped responding; a short one says nothing',
    );
    const events = [
      ev(2004, 'Microsoft-Windows-Resource-Exhaustion-Detector', '2026-10-15T19:41:00Z', 'low virtual memory'),
      ev(41, 'Microsoft-Windows-Kernel-Power', '2026-10-15T20:53:47Z', 'BugcheckCode 0'),
      ev(19, 'Microsoft-Windows-WHEA-Logger', '2026-10-15T19:41:10Z', 'corrected hardware error'),
      ev(1000, 'Application Error', '2026-10-15T19:41:12Z', 'vmwp.exe crashed'),
    ];
    const meaning = findingLines(events).join('\n');
    t.check(
      meaning.includes('memory ran out') &&
        meaning.includes('froze, lost power') &&
        meaning.includes('hardware error') &&
        meaning.includes('vmwp.exe'),
      'what each finding usually means, in plain words',
      meaning,
    );
    const dumps = path.join(t.at('crash-dumps'), 'Minidump');
    fs.mkdirSync(dumps, { recursive: true });
    fs.writeFileSync(path.join(dumps, '101526-1.dmp'), 'x');
    t.check(
      findDumps([dumps], new Date(Date.now() - 3600000)).length === 1 &&
        findDumps([dumps], new Date(Date.now() + 3600000)).length === 0 &&
        findDumps([path.join(dumps, 'none')], new Date(0)).length === 0,
      'dumps: names and times only, newer than the start, a missing folder is fine',
    );
    const report = crashReportText(
      cause!,
      [...events, events[0]],
      'time | RAM\n19:40:45 | 9400/27600',
      '2026-10-15T19:40:57Z',
      {
        hostMemoryLog: '2026-10-15T19:40:50Z | RAM free/total MB 900/32768',
        dumps: [{ name: 'C:\\Windows\\Minidump\\a.dmp', at: '2026-10-15T20:54:00Z' }],
        vgpu: true,
      },
    );
    t.check(
      report.includes('stopped responding') &&
        report.includes('What that usually means') &&
        report.includes('RAM free/total MB 900/32768') &&
        report.includes('a.dmp') &&
        report.includes('vGPU was on') &&
        report.split('Resource-Exhaustion-Detector 2004').length === 3,
      "the report has the freeze, the meanings, this PC's memory, dumps and vGPU; a repeated event is shown once",
      report,
    );

    t.section('the C# helpers compile (C# 5, the csc that ships with Windows)');
    if (!isWin || !fs.existsSync(SYSTEM.csc())) {
      t.check(true, 'skipped: no Windows csc on this machine');
      return;
    }
    const out = t.at('heavy-csc');
    fs.mkdirSync(out, { recursive: true });
    const build = (name: string, files: string[], target = 'exe'): string => {
      const exe = path.join(out, name + '.exe');
      const r = spawnSync(SYSTEM.csc(), ['/nologo', '/target:' + target, '/out:' + exe, ...files], {
        encoding: 'utf8',
        windowsHide: true,
      });
      t.check(r.status === 0, name + ' compiles', r.stdout);
      return exe;
    };
    const sandboxCs = (n: string): string => path.join(t.packageRoot, 'sandbox', 'csharp', n);
    build('ptyhost', [sandboxCs('PtyHost.cs')]);
    const memgov = build('memgov', [sandboxCs('MemGov.cs')]);
    const hostDir = path.join(t.packageRoot, 'native', 'csharp', 'HostTools');
    const tools = build(
      'HostTools',
      fs
        .readdirSync(hostDir)
        .filter((n) => n.endsWith('.cs'))
        .map((n) => path.join(hostDir, n)),
    );
    const status = spawnSync(tools, ['memory-status'], { encoding: 'utf8', windowsHide: true });
    const parsed = parseHostMemory(status.stdout);
    t.check(
      parsed !== null && parsed.commitLimitMb >= parsed.totalMb,
      'HostTools memory-status answers with valid JSON',
      status.stdout,
    );
    const usage = spawnSync(memgov, [], { encoding: 'utf8', windowsHide: true });
    t.check(usage.status === 2, 'memgov without a command is a usage error (it starts nothing)');
    const served = spawnSync(memgov, ['serve', '--interval', '1'], {
      encoding: 'utf8',
      windowsHide: true,
      input: '',
      timeout: 15000,
    });
    const firstLine = (served.stdout ?? '').split(/\r?\n/)[0] ?? '';
    let sampleOk = false;
    try {
      // In a sandbox started by 1.10 or later the real agents job exists, so the list may hold its processes.
      const parsedSample = JSON.parse(firstLine) as { procs: { pid?: unknown; name?: unknown }[]; ramTotalMb: number };
      sampleOk =
        Array.isArray(parsedSample.procs) &&
        parsedSample.procs.every((p) => typeof p.pid === 'number' && typeof p.name === 'string') &&
        parsedSample.ramTotalMb > 0;
    } catch {
      // Not JSON: the check below fails.
    }
    t.check(
      sampleOk && served.status === 0,
      'memgov serve prints a well-formed sample and ends when its input closes',
      firstLine,
    );
    for (const script of ['memory-status.ps1', 'stop-events.ps1']) {
      const text = fs.readFileSync(path.join(t.packageRoot, 'native', 'scripts', script), 'utf8');
      t.check(text.startsWith('#Requires -Version 5.1'), script + ' says its PowerShell version');
    }
  },
};

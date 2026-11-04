// The parallel boot (docs/design/parallel-boot.md): the task runner, the pools, the boot graph and the toolchain
// scheduler's download phase and background split. Fake tasks and deferred promises only: no machine state.
import { BootRunner, checkGraph, duration, type BootTaskDef, type RunnerOptions } from '../guest/boot/runner.js';
import { BOOT_TASKS, STAGES, stageTitle } from '../guest/boot/graph.js';
import { backgroundNames, mergeParts, runSplit } from '../guest/toolchains/split.js';
import { StepScheduler, type SchedulerSink } from '../guest/toolchains/step-scheduler.js';
import type { ToolchainStep } from '../guest/toolchains/step.js';
import { type ToolEnv } from '../guest/toolchains/tool-env.js';
import { Limiter, asBackground, installerRetry, INSTALLER_RETRIES } from '../shared/concurrency/index.js';
import type { Suite } from './support/suite.js';

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

const deferred = (): Deferred => {
  let resolve = (): void => undefined;
  let reject = (_: Error): void => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Lets queued promise callbacks run (a few turns of the event loop). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await sleep(1);
};

const def = (
  id: string,
  after: string[] = [],
  more: Partial<BootTaskDef> = {},
): BootTaskDef & { readonly stage: number } => ({
  id,
  stage: 1,
  title: id.toUpperCase(),
  after,
  critical: false,
  ...more,
});

interface Fixture {
  readonly lines: string[];
  readonly warnings: string[];
  /** What the progress view heard: "started X" / "finished X done". */
  readonly events: string[];
  readonly contexts: { quiet: boolean }[];
  options(extra?: Partial<RunnerOptions>): RunnerOptions;
}

const fixture = (): Fixture => {
  const lines: string[] = [];
  const warnings: string[] = [];
  const events: string[] = [];
  const contexts: { quiet: boolean }[] = [];
  return {
    lines,
    warnings,
    events,
    contexts,
    options: (extra = {}) => ({
      trace: (line) => void lines.push(line),
      observer: {
        started: (task) => void events.push('started ' + task.id),
        finished: (task, outcome) => void events.push('finished ' + task.id + ' ' + outcome.state),
      },
      warn: (line) => void warnings.push(line),
      now: () => Date.now(),
      dryRun: false,
      stages: 9,
      stageTitle: (n) => 'Stage ' + n,
      inContext: (ctx, work) => {
        contexts.push({ quiet: ctx.quiet });
        return work();
      },
      ...extra,
    }),
  };
};

const rejection = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

const throws = (work: () => unknown): string => {
  try {
    work();
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

/** The transitive dependencies of a task in the boot graph. */
const ancestors = (id: string): Set<string> => {
  const seen = new Set<string>();
  const visit = (name: string): void => {
    for (const a of BOOT_TASKS.find((d) => d.id === name)?.after ?? [])
      if (!seen.has(a)) {
        seen.add(a);
        visit(a);
      }
  };
  visit(id);
  return seen;
};

const step = (name: string, o: Partial<ToolchainStep> = {}): ToolchainStep => ({
  name,
  enabled: true,
  install: () => undefined,
  ...o,
});

const sink = (): SchedulerSink & { warnings: string[] } => {
  const warnings: string[] = [];
  return { warnings, warn: (m) => void warnings.push(m), status: () => undefined };
};

export const bootRunnerSuite: Suite = {
  name: 'boot-runner',
  title: 'parallel boot: task runner, pools, boot graph, toolchain download phase and background split',
  run: async (t) => {
    t.section('runner: ordering');
    {
      const f = fixture();
      const log: string[] = [];
      const gates = new Map<string, Deferred>();
      const defs = [def('a'), def('b', ['a']), def('c', ['a']), def('d', ['b', 'c']), def('e')];
      const impl = Object.fromEntries(
        defs.map((d) => [
          d.id,
          async () => {
            log.push('start ' + d.id);
            gates.set(d.id, deferred());
            await gates.get(d.id)!.promise;
            log.push('end ' + d.id);
          },
        ]),
      );
      const runner = new BootRunner(defs, impl, f.options());
      const running = runner.run('foreground');
      for (let i = 0; i < 30 && log.filter((l) => l.startsWith('end')).length < defs.length; i++) {
        await settle();
        // Finish the oldest task that has started and not ended, newest dependencies last.
        const open = [...gates.keys()].filter((id) => !log.includes('end ' + id));
        if (open.length) gates.get(open[open.length - 1])!.resolve();
      }
      await running;
      const at = (l: string): number => log.indexOf(l);
      t.check(
        defs.every((d) => d.after.every((a) => at('end ' + a) < at('start ' + d.id))),
        'every task starts after all the tasks it comes after have ended',
        log.join(', '),
      );
      t.check(
        at('start e') < at('end a') && at('start a') < at('start d'),
        'a task with no dependencies starts at once, next to a running one',
        log.join(', '),
      );
    }
    {
      const f = fixture();
      const order: string[] = [];
      // Declared out of dependency order on purpose: x needs z, z needs y.
      const defs = [def('x', ['z']), def('p'), def('y'), def('z', ['y']), def('q', ['p'])];
      const impl = Object.fromEntries(defs.map((d) => [d.id, () => void order.push(d.id)]));
      await new BootRunner(defs, impl, f.options({ parallel: 1 })).run('foreground');
      t.equal(
        order,
        ['p', 'y', 'z', 'x', 'q'],
        'with one task at a time the order is the declaration-order topological sort',
      );
    }

    t.section('runner: limits');
    {
      const f = fixture();
      let now = 0;
      let peak = 0;
      const defs = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => def(id));
      const impl = Object.fromEntries(
        defs.map((d) => [
          d.id,
          async () => {
            now++;
            peak = Math.max(peak, now);
            await sleep(15);
            now--;
          },
        ]),
      );
      await new BootRunner(defs, impl, f.options({ parallel: 2 })).run('foreground');
      t.check(peak === 2, '6 independent tasks with parallel 2 never run more than 2 at once', 'peak ' + peak);
    }
    {
      const f = fixture();
      let now = 0;
      let exclusiveSaw = -1;
      let startedDuring = 0;
      let exclusiveRunning = false;
      const tick = (id: string) => async (): Promise<void> => {
        if (exclusiveRunning) startedDuring++;
        if (id === 'x') {
          exclusiveRunning = true;
          exclusiveSaw = now;
        }
        now++;
        await sleep(15);
        now--;
        if (id === 'x') exclusiveRunning = false;
      };
      const defs = [def('a'), def('b'), def('x', [], { exclusive: true }), def('c'), def('d')];
      await new BootRunner(defs, Object.fromEntries(defs.map((d) => [d.id, tick(d.id)])), f.options()).run(
        'foreground',
      );
      t.check(
        exclusiveSaw === 0 && startedDuring === 0,
        'an exclusive task runs alone and holds back the ones declared after it',
        exclusiveSaw + ' / ' + startedDuring,
      );
    }

    t.section('runner: failures');
    {
      const f = fixture();
      const ran: string[] = [];
      const defs = [def('a'), def('b', ['a']), def('c', ['b']), def('d')];
      const impl = {
        a: () => {
          ran.push('a');
          throw new Error('boom');
        },
        b: () => void ran.push('b'),
        c: () => void ran.push('c'),
        d: () => void ran.push('d'),
      };
      const out = await new BootRunner(defs, impl, f.options()).run('foreground');
      t.check(
        f.warnings.some((w) => w.includes('A failed (continuing): boom')) &&
          [...ran].sort().join('') === 'abcd' &&
          out.find((o) => o.id === 'a')?.state === 'failed' &&
          out.find((o) => o.id === 'c')?.state === 'done',
        'a soft failure is a warning "failed (continuing)", the siblings and dependants still run, the outcome is failed',
        f.warnings.join(' | ') + ' / ' + ran.join(''),
      );
    }
    {
      const f = fixture();
      const ran: string[] = [];
      const slow = deferred();
      const defs = [def('a', [], { critical: true }), def('b', ['a']), def('c', ['b']), def('slow')];
      const impl = {
        a: async () => {
          await sleep(5);
          ran.push('a');
          throw new Error('fatal');
        },
        b: () => void ran.push('b'),
        c: () => void ran.push('c'),
        slow: async () => {
          await slow.promise;
          ran.push('slow');
        },
      };
      const runner = new BootRunner(defs, impl, f.options());
      const result = rejection(runner.run('foreground'));
      await sleep(40);
      let early = true;
      void result.then(() => (early = false));
      await settle();
      t.check(early, 'run() waits for the tasks that are still running before it rejects');
      slow.resolve();
      const message = await result;
      const by = new Map(runner.results().map((o) => [o.id, o]));
      t.check(
        message === 'fatal' &&
          ran.join(',') === 'a,slow' &&
          by.get('b')?.state === 'skipped' &&
          by.get('c')?.state === 'skipped' &&
          by.get('slow')?.state === 'done' &&
          f.lines.some((l) => l.includes('B: skipped (A failed)')),
        'a critical failure skips what comes after it, an independent long task completes, run() rejects',
        message + ' / ' + ran.join(',') + ' / ' + [...by.values()].map((o) => o.id + ':' + o.state).join(' '),
      );
    }

    t.section('runner: background');
    {
      const f = fixture();
      const ran: string[] = [];
      const defs = [def('a'), def('bg', ['a'], { background: true })];
      const impl = { a: () => void ran.push('a'), bg: () => void ran.push('bg') };
      const runner = new BootRunner(defs, impl, f.options());
      await runner.run('foreground');
      await settle();
      const before = ran.join(',');
      const quietBefore = f.contexts.map((c) => c.quiet).join(',');
      await runner.run('background');
      t.check(
        before === 'a' && quietBefore === 'false' && ran.join(',') === 'a,bg' && f.contexts[1]?.quiet === true,
        'a background task starts only on run("background"), in a quiet (file-only) log context',
        before + ' / ' + quietBefore,
      );
      t.check(
        !f.events.some((e) => e.includes(' bg')) && f.events.join(',') === 'started a,finished a done',
        'the progress view hears only the foreground tasks (the background ones are file-only)',
        f.events.join(','),
      );
    }

    t.section('runner: graph checks');
    t.check(throws(() => checkGraph([def('a', ['b']), def('b', ['a'])])).includes('circle'), 'a cycle is refused');
    t.check(
      throws(() => checkGraph([def('a', ['nope'])])).includes('does not exist'),
      'an unknown dependency is refused',
    );
    t.check(throws(() => checkGraph([def('a'), def('a')])).includes('twice'), 'a duplicate id is refused');
    t.check(
      throws(() => checkGraph([def('bg', [], { background: true }), def('fg', ['bg'])])).includes('background task'),
      'a foreground task that waits for a background one is refused',
    );
    t.check(
      throws(() => new BootRunner([def('a', ['a'])], { a: () => undefined }, fixture().options())).length > 0,
      'the constructor runs the same checks',
    );

    t.section('pools');
    {
      const pool = new Limiter(2, 'p');
      let now = 0;
      await Promise.all(
        Array.from({ length: 6 }, () =>
          pool.run(async () => {
            now++;
            await sleep(10);
            now--;
          }),
        ),
      );
      t.check(pool.peak === 2 && now === 0, 'Limiter(2) peaks at 2', 'peak ' + pool.peak);
    }
    {
      const pool = new Limiter(1, 'p');
      const order: string[] = [];
      const hold = deferred();
      const first = pool.run(() => hold.promise);
      const back = asBackground(() => pool.run(() => void order.push('background')));
      const front = pool.run(() => void order.push('foreground'));
      await settle();
      hold.resolve();
      await Promise.all([first, back, front]);
      t.equal(order, ['foreground', 'background'], 'foreground work queued after background work still goes first');
    }
    {
      const a = new Limiter(1, 'a');
      const b = new Limiter(1, 'b');
      const message = await rejection(a.run(() => b.run(() => undefined)));
      const again = await rejection(a.run(() => a.run(() => undefined)));
      t.check(
        message.includes('nested pool') && again.includes('nested pool'),
        'taking a second pool (or the same one) while holding one throws "nested pool"',
        message,
      );
      t.check((await a.run(() => 7)) === 7 && a.running === 0, 'the slot is free again after a nested-pool error');
    }
    t.check(
      installerRetry(1618, 1) &&
        installerRetry(1618, INSTALLER_RETRIES) &&
        !installerRetry(1618, INSTALLER_RETRIES + 1) &&
        !installerRetry(0, 1) &&
        !installerRetry(1603, 1) &&
        !installerRetry(null, 1),
      'an installer that exits 1618 is retried up to the limit; 0 and 1603 are not',
    );

    t.section('timing');
    {
      const defs = [def('a'), def('b'), def('c')];
      const impl = Object.fromEntries(defs.map((d) => [d.id, () => sleep(100)]));
      const began = Date.now();
      await new BootRunner(defs, impl, fixture().options({ parallel: 3 })).run('foreground');
      const took = Date.now() - began;
      t.check(took < 250, '3 independent 100 ms tasks with parallel 3 finish in under 250 ms', took + ' ms');
      const pool = new Limiter(1, 'one');
      const start = Date.now();
      await Promise.all([1, 2, 3].map(() => pool.run(() => sleep(100))));
      const serial = Date.now() - start;
      // setTimeout may fire a millisecond early: 3 x 100 ms in a row is at least 295 ms.
      t.check(serial >= 295, '3 100 ms jobs on Limiter(1) take 300 ms', serial + ' ms');
    }

    t.section('boot graph');
    {
      const defs = BOOT_TASKS as unknown as BootTaskDef[];
      t.check(throws(() => checkGraph(defs)) === '', 'the boot graph is acyclic and every dependency exists');
      const foreground = BOOT_TASKS.filter((d) => !('background' in d && d.background));
      const reach = ancestors('session');
      t.equal(
        foreground.map((d) => d.id).filter((id) => id !== 'session' && !reach.has(id)),
        [],
        'session depends, directly or not, on every foreground task',
      );
      const pre = BOOT_TASKS.find((d) => d.id === 'hooksPreAgent') as BootTaskDef | undefined;
      t.check(pre?.exclusive === true, 'the pre-agent hooks run exclusively');
      const before = (first: string, second: string): boolean => ancestors(second).has(first);
      const orders: [string, string][] = [
        ['network', 'toolchains'],
        ['toolchains', 'allowOnly'],
        ['allowOnly', 'env'],
        ['vpn', 'githubLogin'],
        ['vpn', 'agentProvision'],
        ['gitConfig', 'githubLogin'],
        ['headroomReady', 'managedSettings'],
        ['managedSettings', 'guide'],
        ['bootEnv', 'guide'],
        ['claudeProfile', 'mcpServers'],
        ['audit', 'session'],
        ['profileLinks', 'agentProvision'],
        ['toolchains', 'vpn'],
        ['hooksPreProvision', 'toolchains'],
        ['hooksPreAgent', 'session'],
      ];
      t.equal(
        orders.filter(([a, b]) => !before(a, b)).map(([a, b]) => a + ' < ' + b),
        [],
        'the required orderings hold (network < toolchains < allowOnly < env, vpn before git and the agent, ...)',
      );
      const writers = new Map<string, string[]>();
      for (const d of BOOT_TASKS) for (const w of d.writes) writers.set(w, [...(writers.get(w) ?? []), d.id]);
      t.equal(
        [...writers].filter(([, w]) => w.length !== 1).map(([k]) => k),
        [],
        'every boot state field has exactly one writing task',
      );
      const unread = BOOT_TASKS.flatMap((d) =>
        d.reads
          .filter((r) => {
            const writer = writers.get(r)?.[0];
            return !writer || !ancestors(d.id).has(writer);
          })
          .map((r) => d.id + ' reads ' + r),
      );
      t.equal(unread, [], 'every task that reads boot state comes after the task that writes it');
      t.check(
        STAGES === 9 &&
          [1, 2, 3, 4, 5, 6, 7, 8, 9].every((n) => stageTitle(n).length > 0) &&
          stageTitle(4, { vpnServer: 'x' }).includes('x') &&
          stageTitle(4) === 'VPN (off)',
        'there are nine stage titles, the VPN one names the server or says off',
      );
    }
    t.equal(
      [duration(0), duration(4630), duration(59949), duration(60000), duration(422400)],
      ['0.0s', '4.6s', '59.9s', '1m00s', '7m02s'],
      'durations: tenths of a second under a minute, then minutes and seconds',
    );

    t.section('toolchain scheduler');
    {
      const events: string[] = [];
      const gate = deferred();
      const steps = [
        step('A', {
          install: async () => {
            events.push('A installing');
            await gate.promise;
            events.push('A done');
          },
        }),
        step('B', {
          after: ['A'],
          fetch: async () => void events.push('B fetch'),
          install: () => void events.push('B install'),
        }),
      ];
      const scheduler = new StepScheduler(sink());
      const run = scheduler.run(steps, {});
      await settle();
      t.check(
        events.includes('B fetch') && !events.includes('A done'),
        "a step's download starts at once, before the steps it comes after have finished",
        events.join(','),
      );
      gate.resolve();
      await run;
      t.equal(
        events,
        ['B fetch', 'A installing', 'A done', 'B install'],
        'the install follows its dependencies after the download',
      );
    }
    {
      const s = sink();
      const steps = [
        step('A', {
          fetch: () => Promise.reject(new Error('offline')),
          install: () => undefined,
        }),
      ];
      const envs = await new StepScheduler(s).run(steps, {});
      t.check(
        envs.has('A') && !s.warnings.length,
        'a failed download is ignored: the install downloads again and reports',
      );
    }
    {
      const names = backgroundNames([
        step('Visual Studio', { background: true }),
        step('Unreal', { after: ['Visual Studio'] }),
        step('Rust', { after: ['Unreal'] }),
        step('Go'),
        step('Kotlin', { after: ['Go'] }),
      ]);
      t.equal(
        [...names].sort(),
        ['Rust', 'Unreal', 'Visual Studio'],
        'a step that comes after a background step is a background step too',
      );
    }
    {
      const events: string[] = [];
      const open = deferred();
      const steps = [
        step('VS', {
          background: true,
          install: async (env: ToolEnv) => {
            events.push('VS install');
            env.prepend.push('vs');
          },
        }),
        step('Unreal', { after: ['VS'], install: () => void events.push('Unreal install') }),
        step('Go', { install: () => void events.push('Go install') }),
      ];
      const split = await runSplit(new StepScheduler(sink()), steps, {}, { gate: open.promise });
      await settle();
      t.check(
        split.nowNames.join(',') === 'Go' &&
          split.laterNames.join(',') === 'VS,Unreal' &&
          [...split.now.keys()].join(',') === 'Go' &&
          events.join(',') === 'Go install',
        'background steps (and their dependants) are left out of the foreground result and wait for the gate',
        events.join(',') + ' / ' + split.nowNames.join(',') + ' / ' + split.laterNames.join(','),
      );
      open.resolve();
      const later = await split.later!;
      t.check(
        events.join(',') === 'Go install,VS install,Unreal install' && [...later.keys()].join(',') === 'VS,Unreal',
        'they start once the gate opens and return only their own parts',
        events.join(','),
      );
    }
    {
      // The first step finishes last: PATH order still follows the plan.
      const slow = deferred();
      const steps = [
        step('First', {
          install: async (env: ToolEnv) => {
            await slow.promise;
            env.prepend.push('first');
          },
        }),
        step('Second', {
          install: (env: ToolEnv) => {
            env.prepend.push('second');
          },
        }),
      ];
      const running = new StepScheduler(sink()).run(steps, {});
      await settle();
      slow.resolve();
      const parts = await running;
      const merged = mergeParts(['First', 'Second'], parts, { environment: { X: '1' }, bin: 'bin' });
      t.equal(
        merged.prepend,
        ['bin', 'first', 'second'],
        'the merged PATH order equals the plan order whichever step finishes first',
      );
      t.check(merged.vars.X === '1', "the config's own variables are merged in");
    }
  },
};

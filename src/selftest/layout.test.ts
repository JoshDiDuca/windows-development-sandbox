// The architecture rules, checked on the compiled output (dist/**/*.js): which areas may import which, the guest's
// portable core, the pure guest files the host and tests may load without the guest runtime's side effects, and no
// import cycles. The bundled dist/runtime is left out (it has no imports); the bundled commands (dist/bin) must import
// only their own chunks.
import fs from 'node:fs';
import path from 'node:path';
import type { Suite } from './support/suite.js';

interface Module {
  /** Relative imports resolved to dist-relative paths (a/b.js), static and dynamic ones apart. */
  readonly statics: string[];
  readonly dynamics: string[];
  /** Bare specifiers (node:fs, zod, ...). */
  readonly bare: string[];
}

const STATIC = /^\s*(?:import|export)\b[^;]*?\bfrom\s*(['"])([^'"\n]+)\1;?\s*$|^\s*import\s*(['"])([^'"\n]+)\3;?\s*$/gm;
const DYNAMIC = /\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g;

const PORTABLE_CORE = [
  /^core\/types\.js$/,
  /^core\/schema\//,
  /^core\/detect\/(toolchains|versions)\.js$/,
  /^core\/util\/errors\.js$/,
];
const PURE_GUEST = [
  'guest/git/decision.js',
  'guest/setup/git-rules.js',
  'guest/boot/project-env.js',
  'guest/audit/parse.js',
  'guest/sessions/cmdline.js',
  'guest/agents/agent-files.js',
  'guest/setup/path-plan.js',
  'guest/toolchains/catalogue.js',
  'guest/toolchains/tools/vscode-profile.js',
  'guest/governor/decide.js',
  'guest/governor/core.js',
];
const SIDE_EFFECTS = ['guest/runtime/session.js', 'guest/runtime/log.js'];

const readModules = (dist: string): Map<string, Module> => {
  const files = fs
    .readdirSync(dist, { recursive: true, encoding: 'utf8' })
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => f.endsWith('.js') && !f.startsWith('runtime/'));
  const modules = new Map<string, Module>();
  for (const file of files) {
    const text = fs.readFileSync(path.join(dist, file), 'utf8');
    const resolve = (spec: string): string => path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    const statics: string[] = [];
    const bare: string[] = [];
    for (const m of text.matchAll(STATIC)) {
      const spec = m[2] ?? m[4];
      if (spec.startsWith('.')) statics.push(resolve(spec));
      else bare.push(spec);
    }
    const dynamics = [...text.matchAll(DYNAMIC)]
      .map((m) => m[2])
      .filter((s) => s.startsWith('.'))
      .map(resolve);
    modules.set(file, { statics, dynamics, bare });
  }
  return modules;
};

/** Every file reached from `start` through static imports (start included). */
const closure = (modules: Map<string, Module>, start: string): Set<string> => {
  const seen = new Set<string>();
  const visit = (f: string): void => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const d of modules.get(f)?.statics ?? []) visit(d);
  };
  visit(start);
  return seen;
};

const findCycle = (modules: Map<string, Module>): string[] | null => {
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (f: string): string[] | null => {
    state.set(f, 'open');
    stack.push(f);
    for (const d of modules.get(f)?.statics ?? []) {
      if (state.get(d) === 'open') return [...stack.slice(stack.indexOf(d)), d];
      if (!state.has(d)) {
        const found = visit(d);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(f, 'done');
    return null;
  };
  for (const f of modules.keys()) {
    if (state.has(f)) continue;
    const found = visit(f);
    if (found) return found;
  }
  return null;
};

const area = (file: string): string => file.split('/')[0];
const list = (items: string[]): string => items.slice(0, 10).join('\n') + (items.length > 10 ? '\n...' : '');

export const layoutSuite: Suite = {
  name: 'layout',
  title: 'architecture rules on the compiled code (areas, portable core, pure guest files, cycles)',
  run: (t) => {
    const modules = readModules(path.join(t.packageRoot, 'dist'));
    const files = [...modules.keys()];
    t.check(files.length > 100 && modules.has('guest/entries/main.js'), 'the compiled code is there to check');

    t.section('areas');
    const guestFiles = files.filter((f) => area(f) === 'guest');
    const guestReach = new Set(guestFiles.flatMap((f) => [...closure(modules, f)]));
    const guestBad = [...guestReach].filter(
      (f) =>
        ['host', 'cli', 'sync', 'selftest'].includes(area(f)) ||
        (area(f) === 'core' && !PORTABLE_CORE.some((p) => p.test(f))),
    );
    t.check(
      !guestBad.length,
      'guest code reaches no host, cli, sync or selftest file, and only the portable core',
      list(guestBad),
    );
    const hostSide = files.filter((f) => ['host', 'cli', 'core', 'sync', 'shared'].includes(area(f)));
    const intoGuest = hostSide.flatMap((f) =>
      [...modules.get(f)!.statics, ...modules.get(f)!.dynamics]
        .filter((d) => area(d) === 'guest')
        .map((d) => f + ' -> ' + d),
    );
    t.check(!intoGuest.length, 'host, cli, core, sync and shared import no guest file', list(intoGuest));

    // The self-test runs outside a sandbox too (GitHub Actions): no test may load the guest runtime, which reads
    // C:\AgentLaunch\session.json and creates the log folder on import.
    const testsIntoRuntime = files
      .filter((f) => area(f) === 'selftest')
      .flatMap((f) => [...closure(modules, f)].filter((d) => SIDE_EFFECTS.includes(d)).map((d) => f + ' -> ' + d));
    t.check(
      !testsIntoRuntime.length,
      'no test loads the guest runtime (session.json, log folder), so the self-test runs outside a sandbox',
      list(testsIntoRuntime),
    );

    t.section('pure guest files');
    for (const pure of PURE_GUEST) {
      t.check(modules.has(pure), pure + ' exists');
      const reached = [...closure(modules, pure)].filter((f) => SIDE_EFFECTS.includes(f));
      t.check(!reached.length, pure + ' never loads the guest runtime (session.json, log folder)', list(reached));
    }
    const guard = 'guest/entries/gitguard.js';
    const guardReach = [...closure(modules, guard)].filter((f) => f !== guard && f !== 'guest/git/decision.js');
    const guardBare = [...closure(modules, guard)]
      .flatMap((f) => modules.get(f)?.bare ?? [])
      .filter((b) => !b.startsWith('node:'));
    t.check(
      !guardReach.length && !guardBare.length,
      'the git guard loads only git/decision.js and Node built-ins',
      list([...guardReach, ...guardBare]),
    );

    t.section('imports');
    const cycle = findCycle(modules);
    t.check(!cycle, 'no static import cycles', cycle?.join(' -> '));
    const intoEntries = files.flatMap((f) =>
      [...modules.get(f)!.statics, ...modules.get(f)!.dynamics]
        .filter((d) => d.startsWith('guest/entries/'))
        .map((d) => f + ' -> ' + d),
    );
    t.check(!intoEntries.length, 'nothing imports an entry point (guest/entries)', list(intoEntries));

    t.section('the shared core');
    const pure = (f: string): boolean =>
      f.startsWith('app/kernel/') || /^app\/features\/(.+\/)?[^/]+\.def\.js$/.test(f) || f === 'app/features/defs.js';
    const pureReach = new Set(files.filter(pure).flatMap((f) => [...closure(modules, f)]));
    const strays = [...pureReach].filter((f) => !pure(f) && f !== 'core/util/errors.js');
    const packages = [...pureReach].flatMap((f) => modules.get(f)?.bare ?? []).filter((b) => b !== 'zod');
    t.check(
      files.some((f) => f === 'app/features/defs.js') && !strays.length && !packages.length,
      'the kernel and the *.def files (what the web bundle imports) reach only each other, core/util/errors and zod',
      list([...strays, ...packages]),
    );
    const intoApp = files
      .filter((f) => !['app', 'cli', 'selftest', 'bin'].includes(area(f)) && f !== 'api.js')
      .flatMap((f) =>
        [...modules.get(f)!.statics, ...modules.get(f)!.dynamics]
          .filter((d) => area(d) === 'app' && !(area(f) === 'host' && d.startsWith('app/kernel/')))
          .map((d) => f + ' -> ' + d),
      );
    t.check(!intoApp.length, 'below the CLI only host code uses the shared core, and only its kernel', list(intoApp));

    t.section('the commands');
    // Loading the CLI as hundreds of modules took most of a second before anything was shown (scripts/bundle.mjs).
    const bins = files.filter((f) => area(f) === 'bin');
    const unbundled = bins.flatMap((f) =>
      modules
        .get(f)!
        .statics.filter((d) => area(d) !== 'bin')
        .map((d) => f + ' -> ' + d),
    );
    t.check(
      bins.includes('bin/sandbox.js') && bins.some((f) => f.startsWith('bin/chunk-')) && !unbundled.length,
      'the commands (dist/bin) are bundled: they load no compiled module one by one',
      list(unbundled),
    );
  },
};

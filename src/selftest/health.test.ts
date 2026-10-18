// doctor and repair: the engine (order, time limit, fixes, summary, JSON shape), the printer and the log, and the
// decisions of the new checks (install pointers and shims, stale records, run state, orphan watchers, permissions,
// PATH, settings backups) on temp folders. Nothing here touches this PC.
import fs from 'node:fs';
import path from 'node:path';
import { ALL_CHECKS } from '../cli/commands/repair/checks/index.js';
import { proxyProblem } from '../cli/commands/repair/checks/network.js';
import type { AppContext } from '../app/context.js';
import {
  healthPage,
  ioEvents,
  summaryText as featureSummaryText,
  type HealthLast,
} from '../app/features/health/index.js';
import { fakeIO } from '../app/kernel/index.js';
import { runDefinition } from '../app/registry.js';
import type { Context } from '../cli/commands/context.js';
import { menuView } from '../cli/menu/render-view.js';
import { HealthRun, summarize } from '../cli/commands/repair/engine.js';
import { logText, writeRepairLog } from '../cli/commands/repair/log.js';
import { HealthPrinter, summaryText } from '../cli/commands/repair/printer.js';
import { runHealth } from '../cli/commands/repair/run.js';
import type { Check, CheckResult, Finding, RepairEnv } from '../cli/commands/repair/types.js';
import {
  configBackups,
  findCommandCopies,
  fileOnDisk,
  groupEntries,
  inspectPointers,
  lineDiff,
  orphanWatchers,
  parseGroupMembers,
  parseIcacls,
  parseRegPath,
  pathHas,
  privacyProblems,
  repairPointers,
  runStateProblems,
  shimProblems,
  staleActiveRecords,
  staleLaunchFolders,
  watcherRecords,
  type SystemProbe,
} from '../host/health/index.js';
import { InstallLayout, writeShims } from '../host/install/index.js';
import { ActiveRecords } from '../host/sharing/index.js';
import type { Harness } from './support/harness.js';
import type { Suite } from './support/suite.js';

const SID = 'S-1-5-21-1-2-3-1001';

function fakeSystem(over: Partial<SystemProbe> = {}): SystemProbe {
  return {
    processes: () => [],
    pidAlive: () => false,
    stop: () => undefined,
    registryPath: () => null,
    updateTaskExists: () => null,
    icacls: () => null,
    groupMembers: () => null,
    tokenHasGroup: () => null,
    reachable: () => Promise.resolve(true),
    ...over,
  };
}

function fakeEnv(t: Harness, name: string, over: Partial<RepairEnv> = {}): RepairEnv {
  const storageRoot = t.dir('health', name, 'storage');
  const dataPath = t.dir('health', name, 'storage', 'data', 'default');
  const userDir = t.dir('health', name, 'user');
  return {
    ctx: {} as Context,
    running: false,
    dataPath,
    storageRoot,
    toolsDir: path.join(dataPath, 'tools'),
    configError: null,
    layout: null,
    record: null,
    machineHome: t.dir('health', name, 'machine'),
    userDir,
    configFile: path.join(userDir, 'config.json'),
    migrations: [],
    userInstallRoot: null,
    system: fakeSystem(),
    now: () => Date.now(),
    facts: () => {
      throw new Error('no facts in tests');
    },
    ...over,
  };
}

const check = (id: string, group: Check['group'], over: Partial<Check> = {}): Check => ({
  id,
  group,
  name: id,
  run: (): Finding => ({ status: 'ok', detail: id + ' is fine' }),
  ...over,
});

const byId = (id: string): Check => {
  const found = ALL_CHECKS.find((c) => c.id === id);
  if (!found) throw new Error('no check ' + id);
  return found;
};

/** Looks with one real check and returns its result (and the run, to fix with). */
async function lookAt(env: RepairEnv, id: string): Promise<{ run: HealthRun; result: CheckResult }> {
  const run = new HealthRun([byId(id)], env);
  const [result] = await run.look();
  return { run, result };
}

async function engine(t: Harness): Promise<void> {
  t.section('engine: order, time limit, fixes, summary');
  const env = fakeEnv(t, 'engine');
  const started: string[] = [];
  const ended: string[] = [];
  const order = new HealthRun(
    [check('net', 'Network'), check('inst-a', 'Install'), check('pc', 'This PC'), check('inst-b', 'Install')],
    env,
    { lookStart: (c) => started.push(c.id), lookEnd: (r) => ended.push(r.id) },
  );
  const looked = await order.look();
  t.equal(
    looked.map((r) => r.id),
    ['pc', 'inst-a', 'inst-b', 'net'],
    'checks run grouped by heading, in listed order',
  );
  t.equal(started, ended, 'each check is announced before its result');
  t.check(
    looked.every((r) => r.status === 'ok' && !r.fixable),
    'a check that finds nothing is ok and not fixable',
  );

  const slow = new HealthRun(
    [
      check('slow', 'Network', { timeoutMs: 30, run: () => new Promise<Finding>(() => undefined) }),
      check('after', 'Network'),
    ],
    env,
  );
  const slowResults = await slow.look();
  t.equal(
    [slowResults[0].status, slowResults[0].detail, slowResults[0].timedOut],
    ['skipped', 'took too long, skipped', true],
    'a check that never answers is skipped after its time limit',
  );
  t.equal(slowResults[1].status, 'ok', 'the checks after a stuck one still run');

  const crash = new HealthRun(
    [
      check('crash', 'Data folder', {
        run: () => {
          throw new Error('disk on fire');
        },
      }),
    ],
    env,
  );
  const crashed = (await crash.look())[0];
  t.check(
    crashed.status === 'needs-you' && crashed.detail.includes('disk on fire'),
    'a check that throws is reported, not fatal',
  );

  t.section('engine: fixes');
  const state = { fixed: false, stuck: 0 };
  const bad = (plan: string | undefined, over: Partial<Finding> = {}): Finding => ({
    status: 'needs-you',
    detail: 'broken',
    plan,
    means: 'it hurts',
    ...over,
  });
  const checks: Check[] = [
    check('throws', 'Data folder', {
      run: () => bad('mend it'),
      fix: () => {
        throw new Error('boom');
      },
    }),
    check('works', 'Data folder', {
      run: () => (state.fixed ? { status: 'ok', detail: 'whole' } : bad('mend it for real', { detail: 'cracked' })),
      fix: () => {
        state.fixed = true;
        return { done: 'glued it' };
      },
    }),
    check('still', 'Data folder', { run: () => bad('try'), fix: () => ({ done: 'tried' }) }),
    check('manual', 'Data folder', { run: () => bad(undefined, { fix: 'do it yourself' }) }),
    check('idle', 'Sandbox', { needsIdle: 'fix', run: () => bad('only when closed'), fix: () => ({ done: 'x' }) }),
  ];
  const running = { ...env, running: true };
  const run = new HealthRun(checks, running);
  const found = await run.look();
  t.equal(
    found.map((r) => r.fixable),
    [true, true, true, false, true],
    'fixable means: a plan and a fix function (a check with only advice is not)',
  );
  t.equal(summarize(found).fixable, 4, 'the summary counts what can be fixed');
  const fixed = await run.fix(found);
  const by = Object.fromEntries(fixed.map((r) => [r.id, r]));
  t.equal(
    [by.throws.status, by.throws.error],
    ['needs-you', 'boom'],
    'a fix that throws leaves the problem and says why',
  );
  t.equal(
    [by.works.status, by.works.applied?.done, by.works.applied?.before, by.works.applied?.after],
    ['fixed', 'glued it', 'cracked', 'whole'],
    'a fix that works is checked again and keeps before and after',
  );
  t.check(
    by.still.status === 'needs-you' && (by.still.error ?? '').includes('still not right'),
    'a fix that changes nothing is not called fixed',
  );
  t.equal(by.manual.status, 'needs-you', 'advice-only checks are left alone');
  t.equal(by.idle.status, 'skipped', 'a fix that needs no running sandbox waits while one runs');
  const final = summarize(fixed);
  t.equal(
    [final.fixed, final.needsYou, final.skipped, final.total],
    [1, 3, 1, 5],
    'the summary counts fixed, need you and skipped after the fixes',
  );

  t.section('summary text and JSON shape');
  t.equal(
    summaryText({ total: 9, ok: 6, fixed: 1, warn: 1, needsYou: 1, skipped: 0, fixable: 0 }),
    '6 ok, 1 fixed, 1 needs you, 1 warning',
    'summary line',
  );
  t.equal(
    summaryText({ total: 3, ok: 0, fixed: 0, warn: 0, needsYou: 2, skipped: 1, fixable: 0 }),
    '0 ok, 2 need you, 1 skipped',
    'summary line plurals',
  );
  const json = JSON.parse(JSON.stringify(by.works)) as Record<string, unknown>;
  t.check(
    ['id', 'group', 'name', 'status', 'detail', 'fixable', 'ms', 'applied'].every((k) => k in json),
    'a result prints as JSON with id, group, name, status, detail, fixable, ms (and applied after a fix)',
    Object.keys(json).join(', '),
  );

  t.section('doctor and repair decisions');
  const calls: string[] = [];
  const fixCheck = (): Check[] => [
    check('f', 'Data folder', {
      run: () => (calls.includes('fix') ? { status: 'ok', detail: 'ok' } : bad('mend')),
      fix: () => {
        calls.push('fix');
        return { done: 'mended' };
      },
    }),
  ];
  const ask = (answer: boolean) => (): Promise<boolean> => {
    calls.push('asked');
    return Promise.resolve(answer);
  };
  const plan = { yes: false, ask: false, question: (n: number): string => n + '?' };
  calls.length = 0;
  let report = await runHealth(env, null, plan, fixCheck(), ask(true));
  t.equal([report.changed, calls], [false, []], 'without --yes and without a terminal nothing is changed or asked');
  calls.length = 0;
  report = await runHealth(env, null, { ...plan, ask: true }, fixCheck(), ask(false));
  t.equal([report.changed, calls], [false, ['asked']], 'a "no" changes nothing');
  calls.length = 0;
  report = await runHealth(env, null, { ...plan, ask: true }, fixCheck(), ask(true));
  t.equal(
    [report.changed, report.summary.fixed, calls],
    [true, 1, ['asked', 'fix']],
    'a "yes" fixes, then looks again',
  );
  calls.length = 0;
  report = await runHealth(env, null, { ...plan, yes: true }, fixCheck(), ask(false));
  t.equal([report.changed, calls], [true, ['fix']], '--yes fixes without asking');

  t.section('printer and log');
  const out: string[] = [];
  const printer = new HealthPrinter({ write: (s) => void out.push(s) }, false);
  calls.length = 0;
  await runHealth(env, printer, { ...plan, yes: true }, [
    check('p1', 'This PC', { name: 'Windows' }),
    check('p2', 'Data folder', {
      name: 'Cracks',
      run: () =>
        calls.includes('cracks') ? { status: 'ok', detail: 'whole' } : bad('mend the cracks', { fix: undefined }),
      fix: () => {
        calls.push('cracks');
        return { done: 'mended the cracks' };
      },
    }),
    check('p3', 'Network', {
      name: 'GitHub',
      run: () => ({ status: 'warn', detail: 'no answer', fix: 'check your VPN' }),
    }),
  ]);
  const text = out.join('');
  t.includes(text, '\nThis PC\n  [ok] Windows: p1 is fine', 'headings, then one line per check with a status mark');
  t.includes(text, 'What it means: it hurts', 'a problem says what it means');
  t.includes(text, 'Fix: sandbox repair will mend the cracks', 'a fixable problem says repair will fix it');
  t.includes(text, 'Fix: check your VPN', 'a problem repair cannot mend says what to do');
  t.includes(text, 'Repair will change:', 'the changes are listed before they are made');
  t.includes(text, '[fixed] Cracks: mended the cracks', 'a fix is reported on its own line');
  const storage = fakeEnv(t, 'log').storageRoot;
  const when = new Date(2026, 9, 15, 9, 30, 12);
  const sample = await runHealth(env, null, { ...plan, yes: true }, fixCheck());
  const logFile = writeRepairLog(
    storage,
    logText({
      when,
      version: '1.5.0',
      command: 'sandbox repair --yes',
      found: sample.found,
      final: sample.final,
      summary: sample.summary,
    }),
    when,
  );
  t.equal(logFile && path.basename(logFile), 'repair-20261015-093012.log', 'the repair log is named by the time');
  const logged = logFile ? fs.readFileSync(logFile, 'utf8') : '';
  t.check(
    logged.includes('changed: mended') && logged.includes('before:  broken') && logged.includes('after:   ok'),
    'the log has what was found, changed, before and after',
  );
  t.equal(
    writeRepairLog(path.join(storage, 'missing'), 'x', when),
    null,
    'no log is written when the storage folder does not exist',
  );
}

function installChecks(t: Harness, mode: 'pointers' | 'shims'): Promise<void> {
  const root = t.dir('health', 'install-' + mode, 'WindowsDevelopmentSandbox');
  const layout = InstallLayout.at(root, 'user');
  const pkg = (v: string, bin: object): void => {
    t.writeJson(path.join(layout.packageDir(v), 'package.json'), { name: 'x', version: v, bin });
  };
  pkg('1.4.0', { sandbox: 'dist/bin/sandbox.js' });
  pkg('1.5.0', { sandbox: 'dist/bin/sandbox.js', 'agent-sandbox': 'dist/bin/agent-sandbox.js' });
  t.dir('health', 'install-' + mode, 'WindowsDevelopmentSandbox', 'versions', '1.6.0', 'staging');
  t.write(layout.nodeExe('v22.1.0'), 'x');
  t.write(layout.nodeExe('v22.11.0'), 'x');
  t.dir('health', 'install-' + mode, 'WindowsDevelopmentSandbox', 'node', 'v24.0.0');
  const env = fakeEnv(t, 'install-' + mode, { layout });
  return mode === 'pointers' ? pointers(t, layout, env) : shims(t, layout, env);
}

async function pointers(t: Harness, layout: InstallLayout, env: RepairEnv): Promise<void> {
  t.section('install: version and Node pointers');
  t.write(path.join(layout.root, 'active-version'), '1.9.9\n');
  t.write(path.join(layout.root, 'active-node'), 'v22.1.0\n');
  let state = inspectPointers(layout);
  t.equal(state.versions, ['1.4.0', '1.5.0'], 'only versions with a package.json count as installed');
  t.equal(state.nodes, ['v22.1.0', 'v22.11.0'], 'only Node folders with node.exe count as installed');
  t.check(
    state.problems.length === 1 && state.problems[0].includes('1.9.9'),
    'a pointer at a version that is not installed is found',
  );
  t.equal(
    state.want,
    { version: '1.5.0', node: 'v22.1.0' },
    'the wanted pointers keep a good Node and take the newest whole version',
  );
  const { run, result } = await lookAt(env, 'install-pointers');
  t.check(
    result.status === 'needs-you' && result.fixable && (result.plan ?? '').includes('1.5.0'),
    'the check offers to repoint',
  );
  const fixed = await run.fix([result]);
  t.equal(
    [fixed[0].status, layout.activeVersion(), layout.activeNode()],
    ['fixed', '1.5.0', 'v22.1.0'],
    'the fix moves only the pointers',
  );
  t.equal(layout.installedVersions(), ['1.4.0', '1.5.0', '1.6.0'], 'no version is deleted');
  fs.rmSync(path.join(layout.root, 'active-node'));
  state = inspectPointers(layout);
  t.check(state.problems[0].includes('active-node is missing'), 'a missing pointer file is found');
  t.equal(
    repairPointers(layout, state),
    'active-version 1.5.0, active-node v22.11.0',
    'a missing Node pointer takes the newest Node',
  );
  t.write(path.join(layout.root, 'active-version'), 'banana');
  t.check(
    inspectPointers(layout).problems[0].includes('says "banana"'),
    'a pointer that is not a version number is named',
  );
}

async function shims(t: Harness, layout: InstallLayout, env: RepairEnv): Promise<void> {
  t.section('install: shims');
  layout.setActive('1.5.0', 'v22.11.0');
  const bins = { sandbox: 'dist/bin/sandbox.js', 'agent-sandbox': 'dist/bin/agent-sandbox.js' };
  writeShims(layout, bins);
  t.equal(shimProblems(layout, bins), { missing: [], different: [] }, 'freshly written shims are fine');
  fs.rmSync(path.join(layout.binDir, 'sandbox.cmd'));
  fs.writeFileSync(path.join(layout.binDir, 'agent-sandbox'), '#!/bin/sh\necho old\n');
  const problems = shimProblems(layout, bins);
  t.equal(
    [problems.missing, problems.different],
    [['sandbox.cmd'], ['agent-sandbox']],
    'a missing and an out-of-date shim are found',
  );
  const { run, result } = await lookAt(env, 'install-shims');
  t.check(result.status === 'needs-you' && result.fixable, 'the shims check offers to rewrite them');
  const fixed = await run.fix([result]);
  t.equal(fixed[0].status, 'fixed', 'rewriting the shims fixes it');
  t.equal(shimProblems(layout, bins), { missing: [], different: [] }, 'the shims read the active version again');
  fs.writeFileSync(path.join(layout.binDir, 'extra.cmd'), 'echo mine');
  t.check(fs.existsSync(path.join(layout.binDir, 'extra.cmd')), 'a file that is not one of ours is left alone');
}

async function copiesOnPath(t: Harness): Promise<void> {
  t.section('install: copies of the commands on the PATH');
  const pf = t.dir('copies', 'Program Files');
  const managedBin = path.join(pf, 'WindowsDevelopmentSandbox', 'bin');
  const npmBin = t.dir('copies', 'nodejs');
  const oldBin = path.join(t.dir('copies', 'Scripts'), 'agent-sandbox', 'bin');
  t.write(path.join(npmBin, 'sandbox.cmd'), '@echo off');
  t.write(path.join(npmBin, 'sandbox'), '#!/bin/sh');
  t.write(path.join(npmBin, 'node_modules', 'windows-development-sandbox', 'package.json'), '{}');
  t.write(path.join(managedBin, 'sandbox.cmd'), '@echo off');
  t.write(path.join(managedBin, 'claude-sbx.cmd'), '@echo off');
  t.write(path.join(managedBin, 'claude-sbx.exe'), '');
  t.write(path.join(oldBin, 'claude-sbx.cmd'), '@echo off');
  const machinePath = [npmBin, managedBin].join(';');
  const userPath = [oldBin, npmBin, t.dir('copies', 'empty')].join(';');
  const pathext = '.COM;.EXE;.BAT;.CMD';
  const found = findCommandCopies({
    machinePath,
    userPath,
    pathext,
    programFiles: pf,
    localAppData: null,
    exists: fileOnDisk,
  });
  t.equal(
    found.map((c) => [c.kind, c.files.join(',')]),
    [
      ['npm', 'sandbox.cmd'],
      ['managed-machine', 'sandbox.cmd,claude-sbx.exe'],
      ['old-scripts', 'claude-sbx.cmd'],
    ],
    'copies come in PATH order (machine first, a folder once), each command as its PATHEXT match, extensionless files ignored',
  );
  const asked: string[] = [];
  const saved = process.env.ProgramFiles;
  process.env.ProgramFiles = pf;
  try {
    const system = fakeSystem({
      registryPath: (scope) => {
        asked.push(scope);
        return scope === 'machine' ? machinePath : userPath;
      },
    });
    const wrongOne = fakeEnv(t, 'copies-wrong', { system, ctx: { packageRoot: managedBin } as Context });
    const { result } = await lookAt(wrongOne, 'install-copies');
    t.check(
      result.status === 'needs-you' &&
        !result.fixable &&
        result.detail.includes(npmBin) &&
        (result.lines ?? []).some((l) => l.includes('npm uninstall -g windows-development-sandbox')) &&
        (result.lines ?? []).some((l) => l.includes('Remove-Item -Recurse -Force') && l.includes('agent-sandbox')),
      'an npm copy in front of the install is named as the one that runs, with the exact removal of each other copy',
    );
    t.check(
      !(result.lines ?? []).some((l) => l.startsWith(managedBin)),
      'the managed install is the one to keep: it is never offered for removal',
    );
    const alone = fakeEnv(t, 'copies-alone', {
      system: fakeSystem({ registryPath: (scope) => (scope === 'machine' ? managedBin : '') }),
      ctx: { packageRoot: managedBin } as Context,
    });
    t.equal((await lookAt(alone, 'install-copies')).result.status, 'ok', 'a single copy is fine');
  } finally {
    if (saved === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = saved;
  }
}

async function staleState(t: Harness): Promise<void> {
  t.section('stale records, run state, launch folders, watchers');
  const record = (sid: string, session: number): Parameters<ActiveRecords['write']>[0] => ({
    user: 'me',
    sid,
    windowsSession: session,
    dataPath: 'C:\\x',
    shared: false,
    startedAt: new Date().toISOString(),
    version: '1.5.0',
    projects: [],
  });
  const rows = [{ image: 'WindowsSandboxClient.exe', pid: 10, session: 1 }];
  t.equal(
    staleActiveRecords([record(SID, 1), record(SID.replace('1001', '1002'), 2)], rows).map((r) => r.windowsSession),
    [2],
    'a record whose session has no sandbox is stale',
  );
  t.equal(staleActiveRecords([record(SID, 1)], []).length, 1, 'with no sandbox at all every record is stale');

  const machine = fakeEnv(t, 'machine', {
    layout: InstallLayout.at(t.dir('health', 'machine-install'), 'machine'),
    record: { scope: 'machine', groupSid: null, autoUpdate: false, installedAt: 'x' },
  });
  const records = new ActiveRecords(path.join(machine.machineHome, 'active'));
  records.write(record(SID, 3));
  const { run, result } = await lookAt(
    { ...machine, system: fakeSystem({ processes: () => [] }) },
    'machine-active-records',
  );
  t.check(result.status === 'needs-you' && result.fixable, 'a stale sharing record is found');
  const fixed = await run.fix([result]);
  t.equal([fixed[0].status, records.readAll().length], ['fixed', 0], 'the fix removes the record');

  const env = fakeEnv(t, 'runstate');
  t.equal(runStateProblems(env.dataPath).any, false, 'an empty run folder is clean');
  t.write(path.join(env.dataPath, 'run', 'requests', 'junk.json'), 'not json');
  t.write(
    path.join(env.dataPath, 'run', 'sandbox.json'),
    JSON.stringify({
      launchId: 'l1',
      phase: 'booting',
      message: 'x',
      updatedAt: new Date().toISOString(),
      workspaceHost: 'C:\\w',
      guestWorkspace: 'C:\\Workspace\\w',
      headless: false,
    }),
  );
  const problems = runStateProblems(env.dataPath);
  t.equal(
    [problems.requests, problems.unfinishedBoot],
    [1, 'booting'],
    'an unanswered request and an unfinished boot are found',
  );
  const looked = await lookAt(env, 'sandbox-run-state');
  t.check(looked.result.fixable, 'the run state of a closed sandbox can be cleared');
  const cleared = await looked.run.fix([looked.result]);
  t.equal(
    [cleared[0].status, runStateProblems(env.dataPath).any],
    ['fixed', false],
    'clearing it leaves a clean run folder',
  );
  const runningEnv = { ...env, running: true };
  t.equal(
    (await lookAt(runningEnv, 'sandbox-run-state')).result.status,
    'ok',
    'while a sandbox runs its state is left alone',
  );

  const launches = t.dir('health', 'launches', 'storage');
  const oldLaunch = t.dir('health', 'launches', 'storage', 'launches', 'old');
  t.dir('health', 'launches', 'storage', 'launches', 'new');
  const longAgo = new Date(Date.now() - 20 * 24 * 3600 * 1000);
  fs.utimesSync(oldLaunch, longAgo, longAgo);
  t.equal(
    staleLaunchFolders(launches, 7, Date.now()).map((o) => path.basename(o.path)),
    ['old'],
    'only launch folders older than 7 days are stale',
  );
  t.equal(staleLaunchFolders(launches, 7, Date.now(), ['old']).length, 0, 'a launch folder in use is kept');

  const wenv = fakeEnv(t, 'watchers');
  const pidFile = path.join(wenv.storageRoot, 'run', 'watcher-default.pid');
  t.write(pidFile, '4242');
  fs.utimesSync(pidFile, longAgo, longAgo);
  const infos = watcherRecords(wenv.storageRoot, Date.now());
  t.equal([infos.length, infos[0].pid], [1, 4242], 'watcher records are read with their pid');
  const alive = (pid: number): boolean => pid === 4242;
  const node = (): string => 'node.exe';
  t.equal(
    orphanWatchers(infos, { running: false, alive, image: node }).length,
    1,
    'an old watcher with no sandbox is an orphan',
  );
  t.equal(
    orphanWatchers(infos, { running: true, alive, image: node }).length,
    0,
    'with a sandbox running no watcher is an orphan',
  );
  t.equal(
    orphanWatchers(infos, { running: false, alive, image: () => 'chrome.exe' }).length,
    0,
    'a pid that is another program is never touched',
  );
  t.equal(
    orphanWatchers(infos, { running: false, alive: () => false, image: node }).length,
    0,
    'a watcher that is gone is not an orphan',
  );
  t.equal(
    orphanWatchers([{ ...infos[0], ageMs: 60_000 }], { running: false, alive, image: node }).length,
    0,
    'a young watcher is spared',
  );
  t.equal(
    orphanWatchers([{ ...infos[0], logAgeMs: 30_000 }], { running: false, alive, image: node }).length,
    0,
    'a watcher still writing its log is spared',
  );

  const stopped: number[] = [];
  const live = new Set([4242]);
  const system = fakeSystem({
    processes: () => [{ image: 'node.exe', pid: 4242, session: 1 }],
    pidAlive: (pid) => live.has(pid),
    stop: (pid) => {
      stopped.push(pid);
      live.delete(pid);
    },
  });
  const orphan = await lookAt({ ...wenv, system }, 'sandbox-orphan-watchers');
  t.check(orphan.result.status === 'needs-you' && orphan.result.fixable, 'the check finds the orphaned watcher');
  const stoppedResult = await orphan.run.fix([orphan.result]);
  t.equal(
    [stoppedResult[0].status, stopped, fs.existsSync(pidFile)],
    ['fixed', [4242], false],
    'the fix stops it and removes its record',
  );
}

function parsing(t: Harness): void {
  t.section('permissions, PATH, group and settings backups');
  const dir = 'C:\\ProgramData\\AgentSandbox\\users\\me';
  const private_ = [
    dir + ' NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
    '                                     BUILTIN\\Administrators:(OI)(CI)(F)',
    '                                     PC\\me:(OI)(CI)(F)',
    '',
    'Successfully processed 1 files; Failed processing 0 files',
  ].join('\r\n');
  const entries = parseIcacls(private_, dir);
  t.equal(
    entries.map((e) => e.principal),
    ['NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators', 'PC\\me'],
    'icacls entries are read',
  );
  t.equal(privacyProblems(entries, 'Agent Sandbox Users'), [], 'SYSTEM, Administrators and you only is private');
  const open = parseIcacls(
    [dir + ' PC\\Agent Sandbox Users:(RX)', '   BUILTIN\\Users:(I)(OI)(CI)(RX)', '   PC\\me:(I)(F)'].join('\n'),
    dir,
  );
  t.equal(
    privacyProblems(open, 'Agent Sandbox Users'),
    ['PC\\Agent Sandbox Users', 'BUILTIN\\Users (inherited)', 'PC\\me (inherited)'],
    'broad and inherited entries break privacy',
  );
  t.equal(groupEntries(open, 'Agent Sandbox Users').length, 1, 'the sharing group is found by name');

  t.check(
    pathHas('C:\\Windows;"C:\\Tools\\Bin\\";%SystemRoot%\\x', 'c:\\tools\\bin') &&
      pathHas('%SystemRoot%\\x', process.env.SystemRoot + '\\x'),
    'PATH entries match ignoring case, quotes, a trailing slash and %VARIABLES%',
  );
  t.check(
    !pathHas('C:\\Windows', 'C:\\Tools\\bin') && !pathHas(null, 'C:\\x'),
    'a folder that is not on PATH is not found',
  );
  t.equal(
    parseRegPath('\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\x\r\n'),
    '%USERPROFILE%\\bin;C:\\x',
    'the PATH value is read from reg query',
  );
  t.equal(
    parseGroupMembers(
      'Alias name     Agent Sandbox Users\r\nComment\r\n\r\nMembers\r\n\r\n-------\r\nPC\\me\r\nPC\\you\r\nThe command completed successfully.\r\n',
    ),
    ['PC\\me', 'PC\\you'],
    'the members of the sharing group are read',
  );
  t.check(
    proxyProblem('http://proxy.example.com:8080') === null && proxyProblem('proxy:3128') === null,
    'proxy addresses are accepted',
  );
  t.check(proxyProblem('http://') !== null, 'an empty proxy address is refused');
}

function backups(t: Harness): void {
  const storage = t.dir('health', 'backups', 'storage');
  const config = path.join(t.dir('health', 'backups', 'user'), 'config.json');
  const make = (name: string, body: string, original = config): string => {
    const folder = path.join(storage, 'backups', name);
    const copy = path.join(folder, 'files', '0-config.json');
    t.write(copy, body);
    t.writeJson(path.join(folder, 'manifest.json'), { entries: [{ original, copy, existed: true }] });
    return copy;
  };
  const older = make('migrate-1.3.0-1.4.0-20260901080000', '{ "a": 1 }');
  const newer = make('migrate-1.4.0-1.5.0-20261014093012', '{ "a": 2 }');
  make('migrate-1.4.0-1.5.0-20261015000000', '{ "b": 1 }', path.join(storage, 'other.json'));
  const outside = t.write(path.join(storage, 'elsewhere.json'), '{}');
  t.writeJson(path.join(storage, 'backups', 'migrate-9.0.0-9.0.1-20270101000000', 'manifest.json'), {
    entries: [{ original: config, copy: outside, existed: true }],
  });
  const found = configBackups(storage, config);
  t.equal(
    found.map((b) => b.copy),
    [newer, older],
    'saved copies of the settings file come newest first',
  );
  t.equal(found[0].label, '1.4.0 to 1.5.0 at 2026-10-14 09:30:12', 'a backup is labelled with its versions and time');
  t.equal(
    lineDiff('{\n  "a": 1,\n  "x": 3\n}', '{\n  "a": 2,\n  "x": 3\n}'),
    ['- "a": 1,', '+ "a": 2,'],
    'the difference shows the lines only in one file',
  );
}

/** The shared core: the same run as the menu and the web use, the saved results, and the health page. */
async function sharedCore(t: Harness): Promise<void> {
  t.section('the shared core');
  const bad = (plan: string | undefined, over: Partial<Finding> = {}): Finding => ({
    status: 'needs-you',
    detail: 'broken',
    plan,
    means: 'it hurts',
    ...over,
  });
  const cracks: string[] = [];
  const three: Check[] = [
    check('p1', 'This PC', { name: 'Windows' }),
    check('p2', 'Data folder', {
      name: 'Cracks',
      run: () => (cracks.length ? { status: 'ok', detail: 'whole' } : bad('mend the cracks', { fix: undefined })),
      fix: () => {
        cracks.push('mended');
        return { done: 'mended the cracks' };
      },
    }),
    check('p3', 'Network', {
      name: 'GitHub',
      run: () => ({ status: 'warn', detail: 'no answer', fix: 'check your VPN' }),
    }),
  ];
  const fake = fakeIO();
  await runHealth(fakeEnv(t, 'events'), ioEvents(fake.io), { yes: true, ask: false, question: () => '' }, three, () =>
    Promise.resolve(true),
  );
  const logged = fake.seen.logs.map((l) => l.text).join('\n');
  t.includes(logged, '  [ok] Windows: p1 is fine', 'ioEvents writes a line per result, like the printer');
  t.includes(logged, 'What it means: it hurts', 'ioEvents says what a problem means');
  t.includes(logged, 'Fix: sandbox repair will mend the cracks', 'ioEvents says what repair would do');
  t.includes(logged, 'Repair will change:', 'ioEvents lists the changes before they are made');
  t.includes(logged, '[fixed] Cracks: mended the cracks', 'ioEvents reports a fix on its own line');

  t.equal(
    featureSummaryText({ total: 9, ok: 6, fixed: 1, warn: 1, needsYou: 1, skipped: 0, fixable: 0 }),
    '6 ok, 1 fixed, 1 needs you, 1 warning',
    'summaryText moved to the feature and reads the same',
  );
  t.equal(
    featureSummaryText({ total: 3, ok: 0, fixed: 0, warn: 0, needsYou: 2, skipped: 1, fixable: 0 }),
    '0 ok, 2 need you, 1 skipped',
    'summaryText plurals (feature)',
  );

  const saved: HealthLast = {
    at: '2026-10-15T09:30:12.000Z',
    mode: 'check',
    checks: [{ id: 'p1', group: 'This PC', name: 'Windows', status: 'ok', detail: 'fine', fixable: false }],
    summary: { total: 1, ok: 1, fixed: 0, warn: 0, needsYou: 0, skipped: 0, fixable: 0 },
    details: [['Config file', 'valid']],
    setup: { checks: [{ name: 'Edition', status: 'ok', detail: 'Pro' }], canEnable: false, error: null },
    log: null,
  };
  const storage = t.dir('health', 'saved', 'storage');
  const ctx = { storageRoot: storage } as unknown as AppContext;
  const none = await runDefinition('health.last', ctx, {}, fakeIO().io);
  t.equal(none, { last: null }, 'nothing saved yet: no results');
  t.writeJson(path.join(storage, 'health', 'last.json'), saved);
  const read = await runDefinition('health.last', ctx, {}, fakeIO().io);
  t.equal(read, { last: saved }, 'a check is saved and read back by health.last');
  t.write(path.join(storage, 'health', 'last.json'), '{ this is not json');
  t.equal(
    await runDefinition('health.last', ctx, {}, fakeIO().io),
    { last: null },
    'a damaged results file reads as nothing saved',
  );

  const empty = healthPage({ last: null });
  const emptyIds = empty.sections.flatMap((s) => (s.items ?? []).map((i) => i.id));
  t.equal(emptyIds, ['health:check', 'repair:run'], 'before any check the page offers the check and the repair');
  t.equal(
    menuView(empty, { category: 'health', refresh: false }).enterLabel('health', 'repair:run'),
    'check and fix',
    'Enter on the repair row says check and fix',
  );
  const page = healthPage({ last: saved });
  const ids = page.sections.flatMap((s) => (s.items ?? []).map((i) => i.id));
  t.check(
    ['doctor:0', 'repair:0', 'setup:0'].every((id) => ids.includes(id)),
    'with results the page lists the doctor, repair and setup rows',
    ids.join(', '),
  );
  const keys = menuView(page, { category: 'health', refresh: false }).actions.map((a) => a.key);
  t.equal(keys, ['f', 'l'], 'the health keys are f and l (e only when Windows Sandbox can be turned on)');
  const canEnable = healthPage({ last: { ...saved, setup: { ...saved.setup!, canEnable: true } } });
  t.equal(
    menuView(canEnable, { category: 'health', refresh: false }).actions.map((a) => a.key),
    ['f', 'l', 'e'],
    'e turns Windows Sandbox on when the setup says it can be',
  );
  const problems = healthPage({
    last: {
      ...saved,
      mode: 'repair',
      checks: [
        {
          id: 'stale',
          group: 'Data folder',
          name: 'Stale run folders',
          status: 'needs-you',
          detail: 'two folders from a sandbox that did not close',
          means: 'they take space',
          fix: 'stop the sandbox',
          lines: ['run-20261012-0931'],
          fixable: false,
        },
        {
          id: 'net',
          group: 'Network',
          name: 'GitHub',
          status: 'warn',
          detail: 'no answer',
          fix: 'check your VPN',
          fixable: false,
        },
      ],
    },
  });
  const repairItems = problems.sections.find((s) => s.id === 'repair')?.items ?? [];
  const stale = repairItems[0];
  t.equal(
    stale?.details,
    ['Found: two folders from a sandbox that did not close', 'Fix: stop the sandbox', 'run-20261012-0931'],
    'a repair row lists what was found as a Found: line, then the fix and the paths (ids stay plain)',
  );
  t.equal(stale?.description, 'they take space', 'a repair row with a meaning shows it as the description');
  const net = repairItems[1];
  t.equal(
    net?.details,
    ['Found: no answer', 'Fix: check your VPN'],
    'a repair row without a meaning still says Found:',
  );
  t.equal(net?.description, undefined, 'without a meaning, the found text is not repeated as the description');
}

export const healthSuite: Suite = {
  name: 'health',
  title: 'doctor and repair (engine, printer, log, the install, stale state, permissions, settings backups)',
  run: async (t) => {
    await engine(t);
    await installChecks(t, 'pointers');
    await installChecks(t, 'shims');
    await copiesOnPath(t);
    await staleState(t);
    parsing(t);
    backups(t);
    await sharedCore(t);
  },
};

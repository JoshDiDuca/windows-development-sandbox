// The sandbox: Windows Sandbox itself, whether one runs, and what a closed or crashed one leaves behind (run files,
// hidden windows, background watchers, old launch folders), plus the helper programs this tool builds or downloads
// on the PC.
import fs from 'node:fs';
import path from 'node:path';
import { dirExists, fileExists, isLink } from '../../../../core/util/index.js';
import { SandboxChannel } from '../../../../host/channel/index.js';
import { orphanWatchers, runStateProblems, staleLaunchFolders, watcherRecords } from '../../../../host/health/index.js';
import { vgpuSource, vgpuWarning } from '../../../../host/launch/index.js';
import { hostToolsExe } from '../../../../host/native.js';
import { sandboxFeatureInstalled } from '../../../../host/sandbox/index.js';
import { assertTestWritable, refuseInSelfTest } from '../../../../host/test-guard.js';
import { conptyDir, terminalDir, terminalExe } from '../../../../host/tools/index.js';
import { RunDir } from '../../../../shared/channel/index.js';
import { safeRemove } from '../../../../shared/io/index.js';
import { removeTree } from '../../../services/data-remove.js';
import { deadPidFiles } from '../finders.js';
import type { Check, Finding, FixOutcome, RepairEnv } from '../types.js';
import { fromFacts } from './pc.js';
import { ok, plural, rel } from './common.js';

const LAUNCH_DAYS = 7;

const hiddenWindowsFile = (env: RepairEnv): string => path.join(env.storageRoot, 'run', 'hidden-windows.json');

export const SANDBOX_CHECKS: Check[] = [
  {
    id: 'sandbox-vgpu',
    group: 'Sandbox',
    name: 'vGPU',
    run: (env: RepairEnv): Finding =>
      env.ctx.loaded.config.sandbox.vGpu
        ? {
            status: 'warn',
            detail: 'vGPU is on in your settings',
            means: vgpuWarning(vgpuSource(true)),
            fix: 'Run: sandbox config set sandbox.vGpu false',
          }
        : ok('off'),
  },
  {
    id: 'sandbox-exe',
    group: 'Sandbox',
    name: 'WindowsSandbox.exe',
    run: (): Finding =>
      sandboxFeatureInstalled()
        ? ok('present')
        : {
            status: 'needs-you',
            detail: 'WindowsSandbox.exe is not in Windows\\System32',
            means: 'Windows Sandbox is not turned on (it appears after the restart that follows turning it on).',
            fix: 'Run: sandbox setup (it checks this PC and offers to turn it on).',
          },
  },
  fromFacts('sandbox-feature', 'Sandbox', 'Windows Sandbox feature', 'Windows Sandbox feature'),
  {
    id: 'sandbox-running',
    group: 'Sandbox',
    name: 'Running sandbox',
    run: (env: RepairEnv): Finding => {
      if (!env.running) return ok('none running');
      const run = new RunDir(env.dataPath);
      const known = fs.existsSync(run.sandboxFile) || run.listSessions().length > 0;
      if (known) return ok('one is running, with its status in your data folder; fixes that touch its folders wait');
      return {
        status: 'warn',
        detail: 'a Windows Sandbox is running, but nothing of yours is in the data folder',
        means:
          'It was started by another user, by hand, or its status files were removed. Windows allows only one at a time.',
        fix: 'Close its window (or run sandbox stop) before starting yours.',
      };
    },
  },
  {
    id: 'sandbox-run-state',
    group: 'Sandbox',
    name: 'Sandbox run state',
    run: (env: RepairEnv): Finding => {
      const run = new RunDir(env.dataPath);
      if (env.running) return ok('a sandbox is running; its state is in use');
      if (isLink(run.root))
        return {
          status: 'needs-you',
          detail: 'the run folder is a link',
          means: 'It could lead anywhere on this PC; it is never followed.',
          plan: 'remove the link itself',
        };
      const problems = runStateProblems(env.dataPath);
      if (!problems.any) return ok('clean');
      const what = [
        problems.sessions ? plural(problems.sessions, 'session') + ' still marked running' : '',
        problems.requests ? plural(problems.requests, 'request') + ' never answered' : '',
        problems.unfinishedBoot ? 'a start that stopped while ' + problems.unfinishedBoot : '',
      ].filter(Boolean);
      return {
        status: 'needs-you',
        detail: 'no sandbox is running, but ' + what.join(', '),
        means: 'sandbox status and attach would show sessions that are not there.',
        plan:
          'clear the run state of the closed sandbox (' + what.length + ' item' + (what.length === 1 ? '' : 's') + ')',
        lines: what,
      };
    },
    fix: (env: RepairEnv): FixOutcome => {
      new SandboxChannel(env.dataPath, () => env.running).reset();
      return { done: 'cleared the run state of the closed sandbox' };
    },
  },
  {
    id: 'sandbox-hidden-windows',
    group: 'Sandbox',
    name: 'Hidden-window list',
    run: (env: RepairEnv): Finding => {
      const file = hiddenWindowsFile(env);
      if (!fs.existsSync(file) && !isLink(file)) return ok('clean');
      if (env.running) return ok('a sandbox is running; kept');
      return {
        status: 'needs-you',
        detail: 'a list of hidden windows from a sandbox that is no longer running',
        plan: 'remove the saved hidden-window list',
      };
    },
    fix: (env: RepairEnv): FixOutcome => {
      const file = hiddenWindowsFile(env);
      assertTestWritable(file);
      fs.rmSync(file, { force: true });
      return { done: 'removed the saved hidden-window list' };
    },
  },
  {
    id: 'sandbox-watcher-records',
    group: 'Sandbox',
    name: 'Sync watcher records',
    run: (env: RepairEnv): Finding => {
      const dead = deadPidFiles(path.join(env.storageRoot, 'run'), (pid) => env.system.pidAlive(pid));
      if (!dead.length) return ok('no stale records');
      return {
        status: 'needs-you',
        detail: plural(dead.length, 'record') + ' of a history sync watcher that is no longer running',
        plan: 'remove ' + plural(dead.length, 'stale watcher record') + ' (the next start begins a new watcher)',
        data: dead,
      };
    },
    fix: (_env: RepairEnv, finding: Finding): FixOutcome => {
      const dead = Array.isArray(finding.data) ? (finding.data as string[]) : [];
      for (const f of dead) {
        assertTestWritable(f);
        fs.rmSync(f, { force: true });
      }
      return { done: 'removed ' + plural(dead.length, 'stale watcher record') };
    },
  },
  {
    id: 'sandbox-orphan-watchers',
    group: 'Sandbox',
    name: 'Background watchers',
    timeoutMs: 40_000,
    run: (env: RepairEnv): Finding => {
      const infos = watcherRecords(env.storageRoot, env.now());
      const rows = infos.length && !env.running ? env.system.processes() : [];
      const image = (pid: number): string | null => rows.find((r) => r.pid === pid)?.image ?? null;
      const orphans = orphanWatchers(infos, { running: env.running, alive: (pid) => env.system.pidAlive(pid), image });
      if (!orphans.length) return ok(infos.length ? 'every watcher has a sandbox to watch' : 'none running');
      return {
        status: 'needs-you',
        detail: plural(orphans.length, 'background history watcher') + ' running with no sandbox',
        means: 'They use memory and keep files open until stopped.',
        plan: 'stop ' + plural(orphans.length, 'orphaned watcher') + ' (history already synced stays)',
        lines: orphans.map((o) => 'process ' + o.pid + ' (' + rel(env.storageRoot, o.file) + ')'),
        data: orphans.map((o) => ({ pid: o.pid, file: o.file })),
      };
    },
    fix: (env: RepairEnv, finding: Finding): FixOutcome => {
      const list = Array.isArray(finding.data) ? (finding.data as { pid: number; file: string }[]) : [];
      for (const w of list) {
        env.system.stop(w.pid);
        assertTestWritable(w.file);
        fs.rmSync(w.file, { force: true });
      }
      return { done: 'stopped ' + plural(list.length, 'orphaned watcher') };
    },
  },
  {
    id: 'sandbox-launch-folders',
    group: 'Sandbox',
    name: 'Old launch folders',
    needsIdle: 'fix',
    run: (env: RepairEnv): Finding => {
      const old = staleLaunchFolders(env.storageRoot, LAUNCH_DAYS, env.now());
      if (!old.length) return ok('none older than ' + LAUNCH_DAYS + ' days');
      return {
        status: 'needs-you',
        detail: plural(old.length, 'launch folder') + ' older than ' + LAUNCH_DAYS + ' days',
        means: 'Each belongs to a start that is long over; they only use disk space.',
        plan: 'remove ' + plural(old.length, 'old launch folder'),
        lines: old.map((o) => rel(env.storageRoot, o.path) + ' (' + o.ageDays + ' days)'),
        data: old.map((o) => o.path),
      };
    },
    fix: (env: RepairEnv, finding: Finding): FixOutcome => {
      const old = Array.isArray(finding.data) ? (finding.data as string[]) : [];
      for (const p of old) safeRemove(p, env.storageRoot);
      return { done: 'removed ' + plural(old.length, 'old launch folder') };
    },
  },
  {
    id: 'sandbox-hosttools',
    group: 'Sandbox',
    name: 'HostTools.exe',
    timeoutMs: 150_000,
    run: (env: RepairEnv): Finding => {
      const bin = path.join(env.storageRoot, 'bin');
      const built =
        dirExists(bin) &&
        fs.readdirSync(bin).some((n) => /^[0-9a-f]{12}$/i.test(n) && fs.existsSync(path.join(bin, n, 'HostTools.exe')));
      if (built) return ok('built in ' + bin);
      return {
        status: 'warn',
        detail: 'HostTools.exe is not built yet',
        means:
          'It keeps this PC awake and edits your PATH; it is built the first time one is needed, and until then a slower PowerShell fallback runs.',
        plan: 'build HostTools.exe now',
      };
    },
    fix: (env: RepairEnv): FixOutcome => {
      refuseInSelfTest('build HostTools.exe');
      const exe = hostToolsExe(env.storageRoot);
      if (!exe) throw new Error('it could not be built (is the .NET Framework compiler csc.exe missing?)');
      return { done: 'built ' + exe };
    },
  },
  {
    id: 'sandbox-conpty',
    group: 'Sandbox',
    name: 'Pseudo console (conpty)',
    needsIdle: 'fix',
    run: (env: RepairEnv): Finding => {
      const dir = conptyDir(env.dataPath);
      if (!dirExists(dir)) return ok('not downloaded yet (the next start downloads it)');
      if (fileExists(path.join(dir, 'conpty.dll')) && fileExists(path.join(dir, 'OpenConsole.exe')))
        return ok('downloaded');
      return {
        status: 'warn',
        detail: 'the conpty download is incomplete',
        means: 'Agent terminals would use the older Windows console and can garble after a resize.',
        plan: 'remove the incomplete download (the next start downloads it again)',
        data: dir,
      };
    },
    fix: (env: RepairEnv, finding: Finding): FixOutcome => {
      removeTree(String(finding.data), env.dataPath);
      return { done: 'removed the incomplete conpty download' };
    },
  },
  {
    id: 'sandbox-terminal',
    group: 'Sandbox',
    name: 'Windows Terminal download',
    needsIdle: 'fix',
    run: (env: RepairEnv): Finding => {
      const dir = terminalDir(env.dataPath);
      if (!dirExists(dir)) return ok('not downloaded yet (the next start downloads it)');
      if (fileExists(terminalExe(env.dataPath))) return ok('downloaded');
      return {
        status: 'warn',
        detail: 'the Windows Terminal download is incomplete',
        means: 'The sandbox window falls back to a plain console.',
        plan: 'remove the incomplete download (the next start downloads it again)',
        data: dir,
      };
    },
    fix: (env: RepairEnv, finding: Finding): FixOutcome => {
      removeTree(String(finding.data), env.dataPath);
      return { done: 'removed the incomplete Windows Terminal download' };
    },
  },
];

// `sandbox update` and the automatic update: the service on a managed install in a temp folder (a folder feed instead
// of GitHub, a fake scheduled task), the one-time notice, the command output and the task script. Nothing touches this
// PC: no real scheduled task, no real sandbox check. The Updater itself is tested in update.test.ts.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseCli } from '../cli/args.js';
import { describeResult } from '../app/features/updates/update-lines.js';
import { updateWith } from '../app/features/updates/updates.run.js';
import { fakeIO } from '../app/kernel/index.js';
import { UpdateService, runsAsSystem, type UpdateTaskPort } from '../cli/services/index.js';
import { InstallLayout, InstallRecordFile, UpdateTask, shimText } from '../host/install/index.js';
import { nativeScript } from '../host/native.js';
import { FolderFeed, UpdateLock, updateNotice } from '../host/update/index.js';
import { SYSTEM } from '../shared/system.js';
import { NODE, installFirst, publish, runShim } from './support/releases.js';
import type { Harness } from './support/harness.js';
import type { Suite } from './support/suite.js';

/** A scheduled task that only remembers what it was asked. */
class FakeTask implements UpdateTaskPort {
  readonly calls: string[] = [];
  fail = false;
  register(): void {
    if (this.fail) throw new Error('needs admin');
    this.calls.push('register');
  }
  remove(): void {
    if (this.fail) throw new Error('needs admin');
    this.calls.push('remove');
  }
}

async function service(t: Harness): Promise<void> {
  t.section('update service on a managed install');
  const root = t.dir('svc', 'install');
  const feed = t.at('svc', 'feed');
  const userDir = t.dir('svc', 'user');
  const layout = await installFirst(t, root);
  const clock = { at: new Date('2026-10-14T12:00:00Z') };
  let sandbox = false;
  const svc = new UpdateService(layout, {
    source: new FolderFeed(feed),
    sandboxRunning: () => sandbox,
    task: new FakeTask(),
    version: '1.0.0',
    userDir,
    now: () => clock.at,
  });

  const emptyCheck = (await svc.check()).available;
  publish(t, feed, '1.0.1', 'good');
  const found = await svc.check();
  t.check(
    svc.managed &&
      svc.status().version === '1.0.0' &&
      svc.status().autoUpdate === false &&
      emptyCheck === false &&
      found.available &&
      found.latest?.version === '1.0.1' &&
      layout.activeVersion() === '1.0.0',
    'a managed install reports its version, automatic updates off by default; check finds a newer version and changes nothing',
  );

  sandbox = true;
  const blocked = await svc.run();
  t.check(
    blocked?.kind === 'skipped' && blocked.reason === 'sandbox-running' && layout.activeVersion() === '1.0.0',
    'a running sandbox stops the update',
  );
  sandbox = false;

  const held = new UpdateLock(root, () => clock.at).acquire();
  const whileHeld = held !== null && (await svc.run()) === null;
  held?.();
  fs.writeFileSync(path.join(root, 'update.lock'), JSON.stringify({ pid: 2147483000, at: clock.at.toISOString() }));
  t.check(
    whileHeld && new UpdateLock(root, () => clock.at).acquire() !== null,
    'a second update while one runs does nothing; a lock left by a process that died is taken over',
  );
  fs.rmSync(path.join(root, 'update.lock'));

  const noticeBefore = svc.notice();
  const done = await svc.run();
  t.check(
    noticeBefore === null && done?.kind === 'installed' && done.version === '1.0.1' && runShim(layout) === '1.0.1',
    'no notice before any update; run installs the newer version',
  );
  const notice = svc.notice();
  if (notice) svc.markNoticeSeen(notice);
  t.check(
    notice?.text === 'Updated to 1.0.1.' &&
      svc.notice() === null &&
      new UpdateService(layout, {
        source: new FolderFeed(feed),
        userDir: t.dir('svc', 'other-user'),
        version: '1.0.1',
      }).notice() !== null,
    'the user is told about the update once; another user is told too',
  );

  publish(t, feed, '1.0.2', 'broken');
  clock.at = new Date(clock.at.getTime() + 25 * 3600_000);
  const bad = await svc.run();
  const blockedCheck = await svc.check();
  t.check(
    bad?.kind === 'failed' &&
      bad.blocked &&
      svc.notice()?.text.includes('Update to 1.0.2 failed') === true &&
      !blockedCheck.available &&
      blockedCheck.blocked,
    'a broken release fails, is blocked and announced',
  );
  t.check(
    svc.rollback() === '1.0.0' && runShim(layout) === '1.0.0',
    'rollback returns the version the update replaced',
  );

  t.section('update service: automatic updates');
  const dueOff = svc.autoUpdateDue();
  svc.setAuto(true);
  const savedOn = new InstallRecordFile(root).read()?.autoUpdate === true;
  const dueSoon = svc.autoUpdateDue();
  clock.at = new Date(clock.at.getTime() + 25 * 3600_000);
  const due = svc.autoUpdateDue();
  sandbox = true;
  t.equal(
    [dueOff, savedOn, dueSoon, due, svc.autoUpdateDue()],
    [false, true, false, true, false],
    'never due while off; the setting is in install.json; not due a moment after a look, due after a day, never while a sandbox runs',
  );
  sandbox = false;
}

/** A failed install puts the old version back (pointers, shims), turns automatic updates off and says so once. */
async function failedInstall(t: Harness): Promise<void> {
  t.section('update service: a failed install is undone');
  const root = t.dir('fail', 'install');
  const feed = t.at('fail', 'feed');
  const layout = await installFirst(t, root, 'machine', true);
  const task = new FakeTask();
  const clock = { at: new Date('2026-10-14T12:00:00Z') };
  const svc = new UpdateService(layout, {
    source: new FolderFeed(feed),
    sandboxRunning: () => false,
    task,
    version: '1.0.0',
    userDir: t.dir('fail', 'user'),
    now: () => clock.at,
  });
  const record = new InstallRecordFile(root);

  publish(t, feed, '1.0.1', 'good');
  fs.rmSync(path.join(feed, 'windows-development-sandbox-1.0.1.tgz'));
  const offline = await svc.run();
  t.check(
    offline?.kind === 'failed' &&
      !offline.blocked &&
      !offline.autoUpdateOff &&
      offline.rolledBack &&
      record.read()?.autoUpdate === true &&
      task.calls.length === 0 &&
      svc.status().autoOffText === null &&
      svc.notice() === null,
    'a download that never arrived (the network) changes nothing and leaves automatic updates on',
  );

  const goodShim = fs.readFileSync(path.join(layout.binDir, 'sandbox.cmd'), 'utf8');
  t.check(goodShim === shimText('sandbox', 'cmd'), 'the shim text is the standard one before the failed update');
  fs.writeFileSync(path.join(layout.binDir, 'sandbox.cmd'), '@echo off\r\nrem marker\r\n');
  publish(t, feed, '1.0.2', 'broken');
  clock.at = new Date(clock.at.getTime() + 3600_000);
  const bad = await svc.run();
  t.check(
    bad?.kind === 'failed' &&
      bad.blocked &&
      bad.rolledBack &&
      bad.autoUpdateOff &&
      layout.activeVersion() === '1.0.0' &&
      layout.activeNode() === NODE &&
      fs.readFileSync(path.join(layout.binDir, 'sandbox.cmd'), 'utf8') === goodShim &&
      runShim(layout) === '1.0.0' &&
      !layout.installedVersions().includes('1.0.2'),
    'a release that does not start is undone: pointers, shims and the version folder are as before',
  );
  t.check(
    record.read()?.autoUpdate === false &&
      task.calls.join() === 'remove' &&
      svc.status().autoUpdate === false &&
      svc.status().state.autoOff?.version === '1.0.2',
    'automatic updates are off in install.json, the scheduled task is removed, the reason is recorded',
  );
  const told = svc.notice();
  if (told) svc.markNoticeSeen(told);
  t.check(
    told?.text ===
      'The update to 1.0.2 failed and was undone (you are on 1.0.0). Automatic updates are off; turn them back on in Maintenance > Updates or with sandbox update --auto on.' &&
      svc.notice() === null &&
      svc.status().autoOffText === told.text,
    'the user is told once, in plain words; the status carries the same sentence for the menu',
    told?.text,
  );
  svc.setAuto(true);
  t.check(
    svc.status().autoOffText === null && record.read()?.autoUpdate === true,
    'turning updates back on clears the remark',
  );

  // The same failure when the task cannot be removed (no admin): not an error; install.json is what the task reads.
  const root2 = t.dir('fail2', 'install');
  const feed2 = t.at('fail2', 'feed');
  const layout2 = await installFirst(t, root2, 'machine', true);
  const task2 = new FakeTask();
  task2.fail = true;
  publish(t, feed2, '1.0.1', 'broken');
  const svc2 = new UpdateService(layout2, {
    source: new FolderFeed(feed2),
    sandboxRunning: () => false,
    task: task2,
    version: '1.0.0',
  });
  const bad2 = await svc2.run();
  t.check(
    bad2?.kind === 'failed' &&
      bad2.autoUpdateOff &&
      new InstallRecordFile(root2).read()?.autoUpdate === false &&
      (await updateWith(svc2, { check: false, rollback: false, unattended: true }, fakeIO().io)).line === '' &&
      layout2.activeVersion() === '1.0.0',
    'a task that cannot be removed does not stop the rollback; an unattended run with updates off does nothing',
  );
  publish(t, feed2, '1.0.2', 'good');
  const ok2 = await svc2.run();
  fs.writeFileSync(path.join(layout2.binDir, 'sandbox.cmd'), '@echo off\r\nrem marker\r\n');
  const back = ok2?.kind === 'installed' ? svc2.rollback() : null;
  t.check(
    back === '1.0.0' &&
      fs.readFileSync(path.join(layout2.binDir, 'sandbox.cmd'), 'utf8') === goodShim &&
      runShim(layout2) === '1.0.0',
    'sandbox update --rollback writes the shims of the version it returns to',
  );
}

function pure(t: Harness): void {
  t.section('update notice and options');
  const state = { lastResult: { version: '1.5.0', ok: true, at: '2026-10-14T03:00:00Z' } };
  const failedLater = { ...state, failed: { version: '1.6.0', at: '2026-10-15T03:00:00Z', reason: 'x' } };
  t.check(
    updateNotice(state, '1.5.0', undefined)?.text === 'Updated to 1.5.0.' &&
      updateNotice(state, '1.5.0', 'ok@2026-10-14T03:00:00Z') === null &&
      updateNotice(state, '1.6.0', undefined) === null &&
      updateNotice(failedLater, '1.5.0', undefined)?.text.includes('Update to 1.6.0 failed') === true,
    'the notice shows a success once on that version; a newer failure wins',
  );
  const flags = parseCli(['update', '--check', '--unattended', '--feed', 'C:\\feed']);
  t.check(
    parseCli(['update', '--auto', 'on']).autoUpdate === 'on' &&
      parseCli(['update', '--auto', 'on']).auto === false &&
      parseCli(['resume', '--auto']).auto === true &&
      parseCli(['resume', '--auto']).autoUpdate === undefined &&
      flags.check &&
      flags.unattended &&
      flags.feed === 'C:\\feed' &&
      parseCli(['update', '--rollback']).rollback,
    'update options parse; update --auto is not resume --auto',
  );
  t.check(
    runsAsSystem({ USERNAME: 'PC$' }, 'PC$') &&
      runsAsSystem({}, 'SYSTEM') &&
      !runsAsSystem({ USERNAME: 'alice' }, 'alice'),
    'the service account is a machine account or SYSTEM, not a person',
  );
}

async function command(t: Harness): Promise<void> {
  t.section('sandbox update: what it prints');
  const lines: string[] = [];
  // sandbox update's work through the feature: the line it returns is what the command prints.
  const runU = async (svc: UpdateService, input: { check?: boolean; auto?: 'on' | 'off' }): Promise<string> => {
    const auto = input.auto ? { auto: input.auto } : {};
    const out = await updateWith(
      svc,
      { check: input.check ?? false, rollback: false, unattended: false, ...auto },
      fakeIO([true]).io,
    );
    lines.push(out.line);
    return out.line;
  };
  const npm = new UpdateService(null, { version: '1.0.0' });
  const npmAuto = await t.thrownMessage(() => npm.setAuto(true));
  t.check(
    !npm.managed &&
      (await runU(npm, {})).includes('npm install -g windows-development-sandbox') &&
      lines.join('\n').includes('npm install -g windows-development-sandbox') &&
      npmAuto.includes('installed with npm'),
    'an npm install is not managed, is told the npm command, and cannot turn on automatic updates',
    npmAuto,
  );

  const root = t.dir('cmd', 'install');
  const feed = t.at('cmd', 'feed');
  const layout = await installFirst(t, root, 'machine', false);
  const task = new FakeTask();
  const machine = new UpdateService(layout, {
    source: new FolderFeed(feed),
    task,
    sandboxRunning: () => false,
    version: '1.0.0',
  });
  await runU(machine, { auto: 'on' });
  const afterOn = [...task.calls];
  await runU(machine, { auto: 'off' });
  t.check(
    afterOn.join() === 'register' && task.calls.join() === 'register,remove' && !machine.autoUpdateDue(),
    '--auto on/off creates and removes the scheduled task of an all-users install; it never updates from a CLI start',
  );
  task.fail = true;
  const noAdmin = await t.thrownMessage(() => machine.setAuto(true));
  t.check(
    noAdmin.includes('needs admin') && new InstallRecordFile(root).read()?.autoUpdate === false,
    'a task that cannot be created fails and the setting stays off',
    noAdmin,
  );

  publish(t, feed, '1.0.1', 'good');
  lines.length = 0;
  t.check(
    (await runU(machine, { check: true })).includes('Version 1.0.1 is available'),
    '--check names the newer version and exits 0',
  );

  const waiting = { kind: 'skipped', reason: 'sandbox-running', current: '1.0.0' } as const;
  t.check(
    describeResult(null, false).code === 0 &&
      describeResult(waiting, false).code === 1 &&
      describeResult(waiting, true).code === 0 &&
      describeResult({ kind: 'installed', version: '1.0.1', previous: '1.0.0' }, false).line.includes(
        'from 1.0.0 to 1.0.1',
      ) &&
      describeResult(
        { kind: 'failed', version: '1.0.1', reason: 'x', blocked: true, rolledBack: true, autoUpdateOff: true },
        false,
      ).code === 1,
    'exit codes: a running sandbox fails by hand but just waits unattended; a failed update exits 1',
  );
}

function script(t: Harness): void {
  t.section('set-update-task.ps1');
  const file = path.join(t.packageRoot, 'native', 'scripts', 'set-update-task.ps1');
  const parse = spawnSync(SYSTEM.powershell(), nativeScript('check-syntax.ps1', ['-Path', file]), {
    encoding: 'utf8',
    windowsHide: true,
  });
  const shim = path.join(t.dir('task'), 'sandbox.cmd');
  fs.writeFileSync(shim, '@echo off\r\n');
  const check = (args: string[]): number | null =>
    spawnSync(SYSTEM.powershell(), nativeScript('set-update-task.ps1', [...args, '-WhatIfOnly']), {
      encoding: 'utf8',
      windowsHide: true,
    }).status;
  const good = check(['-Command', shim]);
  t.check(
    parse.status === 0 &&
      (good === 0 || good === 2) &&
      (good !== 0 || check(['-Command', 'sandbox.cmd']) === 1) &&
      JSON.stringify(UpdateTask.registerArgs(InstallLayout.at(t.at('task', 'root'), 'machine'))) ===
        JSON.stringify(['-Command', path.join(t.at('task', 'root'), 'bin', 'sandbox.cmd')]),
    'it parses under PowerShell 5.1; a real sandbox.cmd is accepted (2 = not admin), a relative path refused; the task runs the shim',
    'parse ' + parse.status + (parse.stderr ? ': ' + parse.stderr : '') + ', exit ' + good,
  );
}

export const updateServiceSuite: Suite = {
  name: 'update-service',
  title: 'sandbox update, automatic updates, the update notice',
  run: async (t) => {
    await service(t);
    await failedInstall(t);
    pure(t);
    await command(t);
    script(t);
  },
};

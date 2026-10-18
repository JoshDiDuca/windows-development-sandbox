// Upgrade migrations: the record of what ran, backups and their restore, the runner's order and failure handling, and
// the first migration (unpinning old defaults). Everything works in temp folders the harness creates.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { DEFAULTS, loadConfig, machineConfigPath } from '../core/config/index.js';
import {
  MIGRATIONS,
  MigrationBackup,
  MigrationMarker,
  MigrationRunner,
  type Migration,
  type MigrationContext,
} from '../host/migrate/index.js';
import { DEFAULTS_SNAPSHOTS } from '../host/migrate/snapshots.js';
import { migrateWith } from '../app/features/updates/updates.run.js';
import { fakeIO } from '../app/kernel/index.js';
import { autoMigrates, continuesAfterFailedMigration, MigrateService } from '../cli/services/index.js';
import type { Suite } from './support/suite.js';

interface ConfigShape {
  sandbox: { memoryMb?: unknown };
  toolchains?: { python?: { enabled?: unknown } };
}

const readText = (file: string): string => fs.readFileSync(file, 'utf8');

export const migrateSuite: Suite = {
  name: 'migrate',
  title: 'upgrade migrations: record, backups, runner, unpinned defaults',
  run: async (t) => {
    t.section('the record of what ran');
    const userDir = t.dir('user');
    const marker = new MigrationMarker(userDir);
    const empty = marker.read();
    marker.record('first-change', null);
    marker.record('second-change', t.at('backups', 'one'));
    marker.setVersion('1.5.0');
    t.check(
      empty.lastVersion === '0.0.0' &&
        marker.has('first-change') &&
        !marker.has('third-change') &&
        marker
          .read()
          .applied.map((entry) => entry.id)
          .join() === 'first-change,second-change' &&
        marker.read().lastVersion === '1.5.0',
      'a missing record means nothing ran yet; the record keeps order and survives setVersion',
    );
    await t.throws(() => marker.record('Not Kebab', null), 'kebab-case', 'a change id must be kebab-case');
    t.write(marker.file, '{"lastVersion": 5}');
    await t.throws(() => marker.read(), 'not readable', 'an unreadable record stops the run instead of re-running');

    t.section('backups');
    const storage = t.dir('storage');
    const file = t.write(t.at('work', 'config.json'), '{ // keep\n  "a": 1 }\n');
    const folder = t.at('work', 'folder');
    t.write(path.join(folder, 'deep', 'b.bin'), 'nested file');
    t.write(path.join(folder, 'c.txt'), 'c');
    const fresh = t.at('work', 'new.txt');
    const backup = MigrationBackup.create(storage, '1.0.5', '1.5.0');
    backup.save([file, folder, fresh]);
    fs.writeFileSync(file, 'changed by the migration');
    fs.rmSync(folder, { recursive: true, force: true });
    fs.writeFileSync(fresh, 'made by the migration');
    backup.restore();
    t.check(
      readText(file) === '{ // keep\n  "a": 1 }\n' &&
        readText(path.join(folder, 'deep', 'b.bin')) === 'nested file' &&
        !fs.existsSync(fresh) &&
        backup.path.startsWith(path.join(storage, 'backups')),
      'restore brings back files and folders byte for byte and removes paths that did not exist before',
    );
    const second = MigrationBackup.create(storage, '1.0.5', '1.5.0');
    t.check(second.path !== backup.path, 'two backups in the same second get different folders');
    await t.throws(
      () => second.save([path.join(storage, 'data', 'set', 'x.db')]),
      'data sets are never copied',
      'a data set is refused, never copied',
    );
    const real = t.write(t.at('work2', 'real.txt'), 'real');
    const link = t.at('work2', 'link.txt');
    fs.symlinkSync(real, link, 'file');
    await t.throws(() => second.save([link]), 'is a link', 'a link planted in the way is refused');
    await t.throws(
      () => MigrationBackup.open(storage, t.at('elsewhere')),
      'not a backup folder',
      'restore only accepts folders under the storage root backups',
    );

    t.section('runner: order, failure, retry, postponed');
    let sandboxUp = false;
    const ctx = (userFolder: string, configPath: string | null = null): MigrationContext => ({
      storageRoot: storage,
      userDir: userFolder,
      configPath,
      sandboxRunning: () => sandboxUp,
    });
    const fake = (
      id: string,
      target: string,
      content: string,
      options: { fail?: boolean; needsIdleSandbox?: boolean } = {},
    ): Migration => ({
      id,
      introducedIn: '1.5.0',
      scope: 'user',
      needsIdleSandbox: options.needsIdleSandbox ?? false,
      summary: 'fake ' + id,
      applies: () => true,
      touches: () => [target],
      run: async (_ctx, note) => {
        fs.writeFileSync(target, content);
        note('changed ' + id);
        if (options.fail) throw new Error('disk full');
      },
    });

    const runDir = t.dir('user-runner');
    const target = t.write(t.at('run', 'a.txt'), 'a0');
    const other = t.write(t.at('run', 'b.txt'), 'b0');
    const first = fake('first-change', target, 'a1');
    const broken = fake('second-change', other, 'b1', { fail: true });
    const runner = new MigrationRunner([first, broken], ctx(runDir), new MigrationMarker(runDir));
    t.equal(
      runner.planText(),
      ['first-change: fake first-change', 'second-change: fake second-change'],
      'a dry run lists one line per pending change, in list order',
    );
    await t.throws(
      () => runner.run('1.5.0', () => undefined),
      'Updating your saved settings failed (second-change): disk full',
      'a failing change stops the run with the change named',
    );
    t.check(
      readText(target) === 'a1' &&
        readText(other) === 'b0' &&
        new MigrationMarker(runDir).has('first-change') &&
        !new MigrationMarker(runDir).has('second-change') &&
        new MigrationMarker(runDir).read().lastVersion === '0.0.0',
      "after a failure: earlier changes stay, the failing change's files are back, the version stays old",
    );
    const retry = new MigrationRunner(
      [first, fake('second-change', other, 'b2')],
      ctx(runDir),
      new MigrationMarker(runDir),
    );
    const retryPending = retry.pending().map((m) => m.id);
    const done = await retry.run('1.5.0', () => undefined);
    t.check(
      retryPending.join() === 'second-change' &&
        done.applied.join() === 'second-change' &&
        new MigrationMarker(runDir).read().lastVersion === '1.5.0',
      'a retry runs only what did not work, and the version moves on',
    );

    const idleDir = t.dir('user-idle');
    const cPath = t.at('run', 'c.txt');
    sandboxUp = true;
    const idleRunner = new MigrationRunner(
      [fake('idle-only', cPath, 'c1', { needsIdleSandbox: true })],
      ctx(idleDir),
      new MigrationMarker(idleDir),
    );
    const waited = await idleRunner.run('1.5.0', () => undefined);
    const stillWaiting = !fs.existsSync(cPath);
    sandboxUp = false;
    const later = await idleRunner.run('1.5.0', () => undefined);
    t.check(
      waited.postponed.join() === 'idle-only' && stillWaiting && later.applied.join() === 'idle-only',
      'a change that needs an idle sandbox waits (changing nothing) while one runs, and runs when none does',
    );

    t.section('unpin-config-defaults');
    const unpin = MIGRATIONS.find((m) => m.id === '2026-10-unpin-config-defaults');
    const old = DEFAULTS_SNAPSHOTS.find((s) => s.version === '1.0.0');
    t.check(unpin !== undefined && old !== undefined, 'the first migration and the 1.0.0 defaults snapshot exist');
    if (!unpin || !old) return;

    const configPath = t.at('home', 'config.json');
    const mine = JSON.parse(JSON.stringify(old.defaults)) as { sandbox: Record<string, unknown> };
    mine.sandbox.memoryMb = 8192;
    t.write(configPath, '// my config, written by an old config init\n' + JSON.stringify(mine, null, 2) + '\n');
    const unpinCtx = ctx(t.at('home'), configPath);
    const partial = t.write(t.at('partial', 'config.json'), '{"toolchains":{"python":{"enabled":true}}}');
    const current = t.write(t.at('current', 'config.json'), JSON.stringify(DEFAULTS, null, 2));
    t.check(
      unpin.applies(unpinCtx) &&
        !unpin.applies(ctx(t.at('home'), null)) &&
        !unpin.applies(ctx(t.at('partial'), partial)) &&
        !unpin.applies(ctx(t.at('current'), current)),
      'only an old full config.json that pins defaults needs it (not a missing, partial or current file)',
    );

    const notesUnpin: string[] = [];
    await unpin.run(unpinCtx, (line) => notesUnpin.push(line));
    const after = readText(configPath);
    const obj = parse(after) as ConfigShape;
    t.check(
      obj.toolchains?.python?.enabled === undefined &&
        obj.sandbox.memoryMb === 8192 &&
        after.includes('// my config') &&
        notesUnpin.join('\n').includes('Now follows the default: toolchains.python.enabled') &&
        loadConfig(configPath).config.toolchains.python.enabled === 'auto' &&
        !unpin.applies(unpinCtx),
      "a pinned old default is removed, the user's own value and comments stay, the result loads, and it is idempotent",
    );

    t.section('follow-machine-storage');
    const follow = MIGRATIONS.find((m) => m.id === '2026-10-follow-machine-storage');
    if (!follow) return t.check(false, 'the follow-machine-storage migration exists');
    const machineFile = machineConfigPath();
    const pinned = t.write(
      t.at('follow', 'pinned.json'),
      '// mine\n' + JSON.stringify({ storage: { root: DEFAULTS.storage.root, warnDataGb: 9 } }),
    );
    const chosen = t.write(t.at('follow', 'chosen.json'), JSON.stringify({ storage: { root: 'D:\\Sandbox' } }));
    const alone = follow.applies(ctx(t.at('follow'), pinned));
    t.write(machineFile, JSON.stringify({ storage: { root: 'C:\\ProgramData\\AgentSandbox\\users' } }));
    try {
      const notesFollow: string[] = [];
      const wanted = follow.applies(ctx(t.at('follow'), pinned)) && !follow.applies(ctx(t.at('follow'), chosen));
      await follow.run(ctx(t.at('follow'), pinned), (line) => notesFollow.push(line));
      const kept = parse(readText(pinned)) as { storage: { root?: string; warnDataGb?: number } };
      t.check(
        !alone &&
          wanted &&
          kept.storage.root === undefined &&
          kept.storage.warnDataGb === 9 &&
          readText(pinned).includes('// mine') &&
          notesFollow.join().includes('Now follows the all-users install: storage.root'),
        'with a machine config, an old pinned default storage folder is removed (a chosen one stays; no machine config: nothing)',
      );
    } finally {
      fs.rmSync(machineFile);
    }

    t.section('sandbox migrate');
    const cmdUser = t.dir('cmd-user');
    const cmdConfig = t.write(
      t.at('cmd-user', 'config.json'),
      JSON.stringify({ ...JSON.parse(JSON.stringify(old.defaults)), sandbox: { memoryMb: 4096 } }, null, 2),
    );
    const service = new MigrateService(
      { storageRoot: t.dir('cmd-storage'), userDir: cmdUser, configPath: cmdConfig },
      '9.9.9',
      MIGRATIONS,
      () => false,
    );
    const noticed = service.versionChanged();
    // sandbox migrate's work through the feature: the logged lines, then the line it returns.
    const runM = async (input: { dryRun: boolean; restore?: string; answers?: boolean[] }): Promise<string> => {
      const { io, seen } = fakeIO(input.answers ?? []);
      const restore = input.restore ? { restore: input.restore } : {};
      const out = await migrateWith(service, { dryRun: input.dryRun, ...restore }, io);
      return [...seen.logs.map((l) => l.text), out.line].join('\n');
    };
    const dry = await runM({ dryRun: true });
    const untouched = readText(cmdConfig).includes('"toolchains"');
    const ran = await runM({ dryRun: false });
    const again = await runM({ dryRun: true });
    t.check(
      noticed &&
        dry.includes('2026-10-unpin-config-defaults') &&
        untouched &&
        ran.includes('Updated: 2026-10-unpin-config-defaults.') &&
        !service.versionChanged() &&
        again === 'Nothing to update.',
      'a dry run lists the pending change and changes nothing; a run applies it and moves the record on',
    );
    const backups = t.at('cmd-storage', 'backups');
    const made = fs.readdirSync(backups);
    fs.writeFileSync(cmdConfig, 'broken by hand');
    await runM({ dryRun: false, restore: path.join(backups, made[0]), answers: [true] });
    t.check(
      made.length === 1 && readText(cmdConfig).includes('"toolchains"'),
      'the run kept one backup and --restore puts the saved files back',
    );
    t.check(
      !autoMigrates('self-test', false) &&
        !autoMigrates('migrate', false) &&
        !autoMigrates('doctor', true) &&
        autoMigrates('launch', false) &&
        continuesAfterFailedMigration('doctor') &&
        !continuesAfterFailedMigration('launch'),
      'self-test, migrate and anything inside a sandbox skip the automatic update; only doctor goes on after a failure',
    );
  },
};

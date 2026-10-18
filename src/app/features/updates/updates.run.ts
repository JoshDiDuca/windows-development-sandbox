// The updates area's work: checking, installing and going back for the program (UpdateService), automatic updates, and
// your saved settings (MigrateService). Talks only through io. The installer's own safety (no install while a sandbox
// runs, rollback on failure) stays in host/update.
import { userDir } from '../../../core/config/index.js';
import { errMsg, fail } from '../../../core/util/index.js';
import { MigrateService, NPM_UPDATE_COMMAND, UpdateService } from '../../../cli/services/index.js';
import { implement } from '../../context.js';
import { cancelled, type InputOf, type OperationIO, type OutputOf } from '../../kernel/index.js';
import { describeResult, whereOf } from './update-lines.js';
import { migrateSettings, runUpdate, updatesStatus, type UpdatesStatus } from './updates.def.js';

/** sandbox update's work, given the service (tests pass their own). */
export async function updateWith(
  service: UpdateService,
  input: InputOf<typeof runUpdate>,
  io: OperationIO,
): Promise<OutputOf<typeof runUpdate>> {
  if (!service.managed)
    return { line: 'This copy was installed with npm. Update it with: ' + NPM_UPDATE_COMMAND, latest: null };
  // The scheduled task (it may outlive a removal that needed admin) and background starts only run when updates are on.
  if (input.unattended && !input.auto && !service.status().autoUpdate) return { line: '', latest: null };
  if (input.auto) {
    io.progress('Turning automatic updates ' + input.auto);
    service.setAuto(input.auto === 'on');
    return { line: 'Automatic updates are ' + input.auto + '.', latest: null };
  }
  if (input.rollback) {
    const { version, state } = service.status();
    const target = state.previous ? 'version ' + state.previous : 'the version before the last update';
    const yes = await io.confirm({
      title: 'Go back from version ' + version + ' to ' + target + '?',
      lines: ['Takes effect the next time you start it.'],
      yes: 'Go back',
      danger: true,
      noTerminal: { message: 'Cannot ask here (no terminal).', fix: 'Add --yes to go back without asking.' },
    });
    if (!yes) cancelled('Nothing was changed.');
    return { line: 'Went back to version ' + service.rollback() + '.', latest: null };
  }
  if (input.check) {
    io.progress('Looking for a newer version');
    const found = await service.check();
    if (found.available && found.latest)
      return {
        line: 'Version ' + found.latest.version + ' is available (you have ' + found.current + '). Run: sandbox update',
        latest: found.latest.version,
      };
    if (found.blocked)
      return {
        line: 'A newer version exists but failed to install before; you have ' + found.current + '.',
        latest: null,
      };
    return { line: 'You have the newest version (' + found.current + ').', latest: null };
  }
  // Implied: the command line never asks (typing it was the decision, and --unattended runs from a task); the menu and
  // the web ask, because they replace the program from a click.
  const go = await io.confirm({
    title: 'Install the newest version if there is one?',
    lines: [
      'The program files are replaced. Open a new terminal afterwards to use it.',
      'Nothing is installed while a Windows Sandbox runs.',
    ],
    yes: 'Install',
    danger: true,
    implied: true,
  });
  if (!go) cancelled();
  io.progress('Installing the newest version');
  const done = describeResult(await service.run(), input.unattended);
  if (done.code !== 0) fail(done.line);
  return { line: done.line, latest: null };
}

export const runUpdateRun = implement(runUpdate, async (ctx, input, io) => {
  // A folder of the user's choosing is installed from only on the command line (the web and the menu send no feed).
  if (input.feed !== undefined && input.feed !== ctx.options.feed) fail('--feed works only on the command line.');
  return updateWith(UpdateService.forPackage(ctx.packageRoot, input.feed, { userDir: userDir() }), input, io);
});

/** sandbox migrate's work, given the service (tests pass their own). */
export async function migrateWith(
  service: MigrateService,
  input: InputOf<typeof migrateSettings>,
  io: OperationIO,
): Promise<OutputOf<typeof migrateSettings>> {
  if (input.restore) {
    const restore = input.restore;
    const yes = await io.confirm({
      title: 'Put back the files saved in ' + restore + '? Your current settings files are replaced.',
      yes: 'Put back',
      danger: true,
      noTerminal: { message: 'Cannot ask here (no terminal).', fix: 'Add --yes to put them back without asking.' },
    });
    if (!yes) cancelled('Nothing was changed.');
    service.restore(restore);
    return { line: 'Put back the files saved in ' + restore + '.' };
  }
  if (input.dryRun) {
    const plan = service.plan();
    if (!plan.length) return { line: 'Nothing to update.' };
    io.log('Would update:');
    for (const line of plan) io.log('  ' + line);
    return { line: '' };
  }
  const result = await service.run((line) => io.log(line, 'muted'));
  const sentences: string[] = [];
  if (result.applied.length) sentences.push('Updated: ' + result.applied.join(', ') + '.');
  else if (!result.postponed.length) sentences.push('Nothing to update.');
  if (result.postponed.length) sentences.push('Waiting for no sandbox to run: ' + result.postponed.join(', ') + '.');
  const last = sentences.pop() ?? 'Nothing to update.';
  for (const s of sentences) io.log(s);
  return { line: last };
}

export const migrateSettingsRun = implement(migrateSettings, (ctx, input, io) =>
  migrateWith(new MigrateService(whereOf(ctx)), input, io),
);

/** What the page shows: the program's state and saved settings, each read on its own (one failure keeps the rest). */
export const updatesStatusRun = implement(updatesStatus, (ctx): UpdatesStatus => {
  let program: Omit<UpdatesStatus, 'settings'>;
  try {
    const s = UpdateService.forPackage(ctx.packageRoot, undefined, { userDir: userDir() }).status();
    program = {
      managed: s.managed,
      version: s.version,
      scope: s.scope,
      autoUpdate: s.autoUpdate,
      autoOffText: s.autoOffText ?? null,
      previous: s.state.previous ?? null,
      failed: s.state.failed ? { version: s.state.failed.version, reason: s.state.failed.reason } : null,
      npmCommand: NPM_UPDATE_COMMAND,
      error: null,
    };
  } catch (e) {
    program = {
      managed: false,
      version: '',
      scope: null,
      autoUpdate: false,
      autoOffText: null,
      previous: null,
      failed: null,
      npmCommand: NPM_UPDATE_COMMAND,
      error: errMsg(e),
    };
  }
  let settings: UpdatesStatus['settings'];
  try {
    settings = { pending: new MigrateService(whereOf(ctx)).plan(), error: null };
  } catch (e) {
    settings = { pending: [], error: errMsg(e) };
  }
  return { ...program, settings };
});

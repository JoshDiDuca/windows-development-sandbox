// The sentences an update run can end with, and where a settings backup goes. Node-side (UpdateResult comes from
// host/update), used by updates.run.ts and by the startup migration of the command line (cli/commands/maintenance).
import { userDir } from '../../../core/config/index.js';
import type { Context } from '../../../cli/commands/context.js';
import type { MigrateContext } from '../../../cli/services/index.js';
import { holdsData, oldDefaultRoot } from '../../../host/storage/index.js';
import type { UpdateResult } from '../../../host/update/index.js';

/** One sentence for what an update run did, and whether it counts as done (1: it failed, or is waiting by hand). */
export function describeResult(result: UpdateResult | null, unattended: boolean): { line: string; code: number } {
  if (!result) return { line: 'Another update is running right now.', code: 0 };
  if (result.kind === 'installed')
    return {
      line:
        'Updated ' +
        (result.previous ? 'from ' + result.previous + ' ' : '') +
        'to ' +
        result.version +
        '. Open a new terminal to use it.',
      code: 0,
    };
  if (result.kind === 'failed')
    return {
      line:
        'Update to ' +
        result.version +
        ' failed: ' +
        result.reason.replace(/\.?\s*$/, '.') +
        (result.rolledBack
          ? ' The change was undone: you are on the version you had.'
          : ' Going back to your previous version did not fully work: run sandbox update --rollback or the installer.') +
        (result.autoUpdateOff
          ? ' Automatic updates are off; turn them back on in Maintenance > Updates or with sandbox update --auto on.'
          : result.blocked
            ? ' It is not tried again; the next release is.'
            : ' It is tried again later.'),
      code: 1,
    };
  switch (result.reason) {
    case 'up-to-date':
      return { line: 'You have the newest version (' + result.current + ').', code: 0 };
    case 'sandbox-running':
      return {
        line: 'A Windows Sandbox is running, so nothing was installed. Close it (sandbox stop), then update again.',
        code: unattended ? 0 : 1,
      };
    case 'failed-before':
      return {
        line: 'The newest version failed to install before. It is not tried again until a newer one is released.',
        code: 0,
      };
    case 'no-release':
      return { line: 'No release was found.', code: 0 };
    case 'too-soon':
      return { line: 'Looked a short while ago; nothing to do yet.', code: 0 };
  }
}

/**
 * Where this context keeps the saved settings. Backups go where the data is: an upgrade that has not pinned the old
 * folder yet would otherwise fill the new, empty default folder with them.
 */
export function whereOf(ctx: Context): MigrateContext {
  const old = oldDefaultRoot();
  const unpinned = old !== null && !holdsData(ctx.storageRoot) && holdsData(old) && !ctx.loaded.layers?.machine;
  return { storageRoot: unpinned ? old : ctx.storageRoot, userDir: userDir(), configPath: ctx.loaded.configPath };
}

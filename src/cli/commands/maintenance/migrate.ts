import { autoMigrates, continuesAfterFailedMigration, MigrateService } from '../../services/index.js';
import { c } from '../../output/index.js';
import { errMsg, UserError } from '../../../core/util/index.js';
import { insideSandbox } from '../../../host/sandbox/index.js';
import { whereOf } from '../../../app/features/updates/index.js';
import { refreshStorage, type Context } from '../context.js';

/**
 * Before a command: brings the settings up to date when the version changed (one small file is read otherwise).
 * A failure stops the command (throws), except for doctor, which prints it and goes on.
 */
export async function migrateBeforeCommand(ctx: Context, command: string): Promise<void> {
  if (!autoMigrates(command, insideSandbox())) return;
  const service = new MigrateService(whereOf(ctx));
  try {
    if (!service.versionChanged()) return;
    const result = await service.run((line) => console.error(c.dim(line)));
    if (result.applied.length) refreshStorage(ctx);
  } catch (e) {
    if (!continuesAfterFailedMigration(command)) throw e;
    const fix = e instanceof UserError && e.fix ? ' ' + e.fix : '';
    console.error(c.red('Error: ') + errMsg(e) + fix);
  }
}

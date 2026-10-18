import { userDir } from '../../../core/config/index.js';
import { errMsg } from '../../../core/util/index.js';
import { PACKAGE_ROOT } from '../../../core/package-info.js';
import { insideSandbox, spawnDetached } from '../../../host/sandbox/index.js';
import { c } from '../../output/index.js';
import { UpdateService } from '../../services/index.js';

/** Commands that never look for updates first: they are how updates run, or they must stay quiet. */
const NO_STARTUP_UPDATE: readonly string[] = ['self-test', 'update', '_watch', '_web'];

/**
 * At the start of a command: tells this user once about an update that ran without them, and (current-user installs
 * with automatic updates on) starts the daily check in the background. Never stops the command.
 */
export function updatesBeforeCommand(entry: string, command: string): void {
  if (insideSandbox() || NO_STARTUP_UPDATE.includes(command)) return;
  try {
    const service = UpdateService.forPackage(PACKAGE_ROOT, undefined, { userDir: userDir() });
    if (!service.managed) return;
    const notice = service.notice();
    if (notice) {
      console.error(c.dim(notice.text));
      service.markNoticeSeen(notice);
    }
    if (service.autoUpdateDue()) spawnDetached(entry, ['update', '--unattended']);
  } catch (e) {
    console.error(c.dim('Could not look for updates: ' + errMsg(e)));
  }
}

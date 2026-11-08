// One line, at most once a day, when this PC's Windows release no longer gets fixes: the sandbox's VM (vmwp.exe) is
// Windows' own code, so a crash there can only be fixed by Windows. Only the fact, nothing else.
import { windowsServicing, type WindowsVersion } from '../../../host/health/index.js';
import { takeDailyHint } from '../../../host/life/index.js';

const HINT_FILE = 'windows-release-hint.txt';

/** The line to print now, or null (the release is fine or ends later, it was said today, or the build is unknown). */
export function windowsReleaseHint(
  storageRoot: string,
  version: WindowsVersion | null,
  now: Date = new Date(),
): string | null {
  if (!version) return null;
  const servicing = windowsServicing(version.build, version.edition, now);
  if (servicing?.state !== 'out' || !servicing.line) return null;
  return takeDailyHint(storageRoot, HINT_FILE, now) ? servicing.line : null;
}

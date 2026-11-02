// The daemon's one watch over the service sign-ins this launch may hand back (session.json accountLeases), and its
// flush where claude-mem is saved (every 2 minutes, when a session ends, before an idle shutdown).
import { AccountWatch } from '../accounts/watch.js';
import { dataDir } from '../runtime/paths.js';
import { log, warn } from '../runtime/log.js';
import { session } from '../runtime/session.js';

let watch: AccountWatch | null = null;

export function startAccountWatch(): void {
  const kinds = session.accountLeases ?? [];
  if (!kinds.length) return;
  watch = new AccountWatch(kinds, { dataDir, launchId: session.launchId, warn });
  watch.start();
  if (watch.watched().length) log('Service sign-ins kept for the next sandbox: ' + watch.watched().join(', '));
}

/** Looks once more now; `final` (the sandbox stops) also lets go of what must not stay taken. Never throws. */
export async function flushAccounts(final = false): Promise<void> {
  try {
    await watch?.flush(final);
  } catch (e) {
    warn('service sign-ins: ' + String(e));
  }
}

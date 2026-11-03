// Comet: the saved perplexity.ai sign-in cookies wait in secretDir('comet') (the sandbox's own disk) until the apps
// step has Comet ready, which writes them into its profile over DevTools and deletes the file. While the sandbox runs,
// the watch asks the running Comet for its perplexity.ai cookies, so a sign-in made here (or renewed) is kept for the
// next sandbox. When Comet is not running, the last sign-in seen stands.
import fs from 'node:fs';
import path from 'node:path';
import { cometSummary, PAYLOADS, type CometPayload } from '../../../shared/accounts/index.js';
import { readBoundedFile } from '../../../shared/io/bounded.js';
import { readCometSignIn } from '../../browser/comet.js';
import { secretDir, type GuestAdapter } from '../adapter.js';

/** Where the sign-in waits for Comet. */
export function cometPendingFile(root: string = secretDir('comet')): string {
  return path.join(root, 'restore.json');
}

/** The sign-in waiting for Comet, or null (none, or not the expected shape). */
export function takePendingComet(root?: string): CometPayload | null {
  const file = cometPendingFile(root);
  const bytes = readBoundedFile(file, 512 * 1024);
  fs.rmSync(file, { force: true });
  if (!bytes) return null;
  try {
    const parsed = PAYLOADS.comet.safeParse(JSON.parse(bytes.toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // Not JSON: nothing to restore.
  }
}

/** The last sign-in seen in this process (the daemon's watch). */
let held: CometPayload | null = null;

export const cometAdapter: GuestAdapter<'comet'> = {
  kind: 'comet',
  apply(p: CometPayload) {
    const file = cometPendingFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(p), { encoding: 'utf8', mode: 0o600 });
    held = p;
    return { summary: 'Comet: your saved sign-in (' + cometSummary(p) + ') goes into its profile once it is ready' };
  },
  async refresh() {
    const now = await readCometSignIn();
    if (now) held = now;
  },
  current() {
    return held;
  },
  checkMs: 120_000,
};

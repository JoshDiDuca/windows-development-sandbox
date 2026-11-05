// Perplexity desktop app: the saved perplexity.ai sign-in cookies wait in secretDir('perplexityapp') (the sandbox's own
// disk) until the app runs; the watch then writes them into it over its DevTools port and deletes the file. While the
// sandbox runs, the watch asks the running app for its perplexity.ai cookies, so a sign-in made here (or renewed) is
// kept for the next sandbox. When the app is not running, the last sign-in seen stands.
import fs from 'node:fs';
import path from 'node:path';
import { cometSummary, PAYLOADS, type CometPayload } from '../../../shared/accounts/index.js';
import { readBoundedFile } from '../../../shared/io/bounded.js';
import { readAppSignIn, restoreAppSignIn } from '../../browser/perplexity-app.js';
import { secretDir, type GuestAdapter } from '../adapter.js';

/** Where the sign-in waits for the app. */
export function perplexityAppPendingFile(root: string = secretDir('perplexityapp')): string {
  return path.join(root, 'restore.json');
}

/** The sign-in waiting for the app (left in place), or null (none, or not the expected shape). */
export function peekPendingPerplexityApp(root?: string): CometPayload | null {
  const bytes = readBoundedFile(perplexityAppPendingFile(root), 512 * 1024);
  if (!bytes) return null;
  try {
    const parsed = PAYLOADS.perplexityapp.safeParse(JSON.parse(bytes.toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // Not JSON: nothing to restore.
  }
}

/** The last sign-in seen in this process (the daemon's watch). */
let held: CometPayload | null = null;

export const perplexityAppAdapter: GuestAdapter<'perplexityapp'> = {
  kind: 'perplexityapp',
  apply(p: CometPayload) {
    const file = perplexityAppPendingFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(p), { encoding: 'utf8', mode: 0o600 });
    held = p;
    return {
      summary:
        'Perplexity app: your saved sign-in (' + cometSummary(p) + ') goes into it once it runs (reload its window)',
    };
  },
  async refresh() {
    const pending = peekPendingPerplexityApp();
    if (pending && (await restoreAppSignIn(pending).catch(() => false)))
      fs.rmSync(perplexityAppPendingFile(), { force: true });
    const now = await readAppSignIn();
    if (now) held = now;
  },
  current() {
    return held;
  },
  checkMs: 30_000,
};

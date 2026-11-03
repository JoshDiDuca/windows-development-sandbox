// A launch that finds Windows Sandbox programs left behind by a sandbox that is gone (a crash, a kill from outside):
// Windows then says "already running" or that the sandbox was signed out. Asks to close them and goes on.
import { askYesNo } from '../../../core/prompt.js';
import { fail } from '../../../core/util/index.js';
import { readSandboxFacts } from '../../../host/health/index.js';
import {
  cleanUpLeftovers,
  endSandboxPrograms,
  isSandboxRunning,
  restartSandboxService,
} from '../../../host/sandbox/index.js';
import { c } from '../../output/index.js';
import type { Context } from '../context.js';

/** Does nothing unless leftovers are found; then asks (needs a terminal) and fails with the way out when declined. */
export async function offerLeftoverCleanup(ctx: Context): Promise<void> {
  if (!isSandboxRunning()) return;
  const { storageRoot, dataPath } = ctx;
  const outcome = await cleanUpLeftovers({
    facts: () => readSandboxFacts(storageRoot, dataPath, true),
    end: endSandboxPrograms,
    restartService: restartSandboxService,
    confirm: (q) => {
      for (const line of q.lines) console.log(c.yellow(line));
      return askYesNo(q.title, true);
    },
    say: (line) => console.log(line),
  });
  if (outcome === 'declined' || outcome === 'failed')
    fail(
      'Windows Sandbox programs from a sandbox that is gone are still there, so a new one cannot start.',
      'Run sandbox cleanup (it asks first), or end the WindowsSandbox programs in Task Manager.',
    );
}

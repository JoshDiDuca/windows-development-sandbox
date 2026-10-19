// A headless sandbox with nothing running (or starting) only wastes RAM, so it shuts itself down. Every open session
// counts, a plain shell as much as an agent: whether it is busy cannot be told from outside, and closing it says so.
import { spawnSync } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
import { saveClaudeMem } from '../setup/claude-mem.js';
import { saveLocalState } from '../agents/local-state.js';
import { isWin, run } from '../runtime/paths.js';
import { log } from '../runtime/log.js';
import { session } from '../runtime/session.js';
import { safely } from './state.js';

/** How long the sandbox must stay idle before it shuts down. */
const GRACE_MS = 15000;

export class IdleShutdown {
  /** `busy`: a session runs or is starting. */
  constructor(private readonly busy: () => boolean) {}

  /** After a session ended or failed: shuts a headless sandbox down if it stays idle for a moment. */
  check(): void {
    if (!session.headless || !isWin) return;
    if (!this.idle()) return;
    setTimeout(() => {
      if (!this.idle()) return;
      log('Headless sandbox has no sessions left; shutting down.');
      safely('claude-mem save', saveClaudeMem);
      safely('agent databases save', saveLocalState);
      spawnSync(SYSTEM.shutdown(), ['/s', '/t', '5'], { windowsHide: true });
    }, GRACE_MS);
  }

  private idle(): boolean {
    return !this.busy() && run.scanRequests().valid.length === 0;
  }
}

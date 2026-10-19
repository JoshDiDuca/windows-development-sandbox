// The session daemon's polling loop: claims each valid request in run\requests and hands it to its handler.
import fs from 'node:fs';
import type { GuestRequest } from '../../core/types.js';
import { saveClaudeMem } from '../setup/claude-mem.js';
import { saveLocalState } from '../agents/local-state.js';
import { execCommand } from './exec.js';
import { sessions } from './sessions.js';
import { governor } from '../governor/index.js';
import { respond, safely } from './state.js';
import { run } from '../runtime/paths.js';
import { withRequestSecrets } from '../runtime/secrets.js';
import { warn } from '../runtime/log.js';
import { errMsg } from '../../core/util/errors.js';

const POLL_MS = 400;
const MEM_SAVE_MS = 120000;

export class Daemon {
  private lastMemSave = Date.now();

  /** Polls for requests for the rest of the sandbox's life; one failing iteration never stops it. */
  start(): void {
    try {
      this.tick();
    } catch (e) {
      warn('daemon loop: ' + errMsg(e));
    } finally {
      setTimeout(() => this.start(), POLL_MS);
    }
  }

  private tick(): void {
    const { valid, invalid } = run.scanRequests();
    // Anything in requests/ that is not a valid request (wrong kind, bad id, junk) is deleted unread.
    for (const file of invalid)
      safely('removing an invalid request', () => fs.rmSync(file, { recursive: true, force: true }));
    for (const req of valid) {
      safely('claiming a request', () => fs.rmSync(run.requestFile(req.id), { force: true }));
      if (run.readSession(req.id)) continue;
      // Not awaited: starting a session or running a command must not hold up other requests.
      void Promise.resolve(this.handle(withRequestSecrets(req))).catch((e: unknown) =>
        respond(req.id, { ok: false, message: errMsg(e) }),
      );
    }
    if (Date.now() - this.lastMemSave > MEM_SAVE_MS) {
      this.lastMemSave = Date.now();
      safely('claude-mem save', saveClaudeMem);
      safely('agent databases save', saveLocalState);
    }
  }

  private handle(req: GuestRequest): Promise<void> | void {
    switch (req.kind) {
      case 'session':
        return sessions.start(req);
      case 'project':
        return sessions.prepare(req);
      case 'exec':
        return execCommand(req);
      case 'restart':
        return sessions.restart(req);
      case 'close':
        return sessions.close(req);
      case 'pressure':
        // No response: the host repeats it every few seconds while its memory stays low.
        return governor.hostPressure(req.seconds, req.reason, req.level ?? 'slow');
      case 'ping':
        return respond(req.id, { ok: true, message: 'pong (' + sessions.count + ' session(s) running)' });
    }
  }
}

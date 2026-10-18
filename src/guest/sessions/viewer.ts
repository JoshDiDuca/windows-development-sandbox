import { connect, runTerminalClient } from '../../shared/pty/index.js';
import type { SessionStatus } from '../../shared/channel/schema.js';
import { run } from '../runtime/paths.js';
import { session as sandboxSession } from '../runtime/session.js';

/**
 * A session that is still being set up (its project provisioning, its agent installing): show the progress until it
 * runs.
 */
const waitUntilStarted = async (id: string): Promise<SessionStatus | null> => {
  let last = '';
  for (let i = 0; i < 3600; i++) {
    const s = run.readSession(id);
    if (s && s.phase !== 'starting') return s;
    if (s && s.message !== last) {
      console.log('  ' + s.message);
      last = s.message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return run.readSession(id);
};

export async function viewSession(id: string): Promise<number> {
  const session = await waitUntilStarted(id);
  if (session?.phase === 'failed') {
    console.error('Session ' + id + ' could not start: ' + session.message);
    await new Promise((r) => setTimeout(r, 30000));
    return 1;
  }
  if (!session?.attach) {
    console.error('Session ' + id + ' is not running.');
    return 1;
  }
  const socket = await connect({ ...session.attach, addresses: ['127.0.0.1'] });
  // The sandbox's own terminal: a copy in the agent reaches the sandbox's clipboard (and yours only through
  // sandbox.clipboard, which already shares it).
  const result = await runTerminalClient(socket, session.attach.token, {
    clipboardWrites: true,
    confirmCtrlC: sandboxSession.attach.confirmCtrlC !== false,
  });
  if (result.reason === 'exit') console.log(session.harness + ' exited with code ' + result.exitCode + '.');
  else if (result.reason === 'error') console.log('Session error: ' + result.message);
  return result.reason === 'exit' ? result.exitCode : 1;
}

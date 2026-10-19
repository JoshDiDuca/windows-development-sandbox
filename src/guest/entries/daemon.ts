// Session daemon (runs detached inside the sandbox for its whole life). It is the only thing that acts on host
// requests, and it only knows four request kinds: start a session, run a command, restart sessions, ping.
// It must never die quietly: every iteration is guarded, and anything unexpected is written to its log.
// The handlers live in daemon/ (session, exec); this file is the polling loop.
import { startRelays } from '../daemon/relays.js';
import { startProcessCollector } from '../audit/process-audit.js';
import { safely } from '../daemon/state.js';
import { log, warn } from '../runtime/log.js';
import { adoptBootSecrets } from '../runtime/secrets.js';
import { errMsg } from '../../core/util/errors.js';
import { Daemon } from '../daemon/daemon.js';
import { sessions } from '../daemon/sessions.js';
import { governor } from '../governor/index.js';

process.on('uncaughtException', (e) => warn('daemon: unexpected error (continuing): ' + (e.stack ?? errMsg(e))));
process.on('unhandledRejection', (e) => warn('daemon: unexpected error (continuing): ' + errMsg(e)));

adoptBootSecrets();
log('Session daemon started (pid ' + process.pid + ').');
safely('port forwards', startRelays);
safely('audit', () => startProcessCollector(() => sessions.roots()));
safely('memory governor', () => governor.start());
log('Memory governor: ' + governor.describe());
new Daemon().start();

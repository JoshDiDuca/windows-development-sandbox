// `sandbox remote [user] [--browser]`: another Windows user's program, used from here (docs/design/remote-access.md).
// Windows sign-in through the owner's pipe gives a one-time token; the menu then runs over the owner's web UI (every
// action checked against the role the owner gave, and written to their audit log), or --browser opens it signed in.
import { allows, type Caller } from '../../app/kernel/index.js';
import { fail, safeText } from '../../core/util/index.js';
import { knockOnDoor } from '../../host/remote/index.js';
import { currentUserName, runningOwner } from '../../host/sharing/index.js';
import { openBrowser } from '../../host/web/index.js';
import { RemoteMenu } from '../menu/remote-menu.js';
import { remoteClient } from '../services/remote-client.js';
import { App } from '../tui/index.js';
import { requireOnPc, type Context } from './context.js';

/** Whose program: the user named, else the owner of the running sandbox when it is someone else's. */
function ownerOf(ctx: Context): { name: string; id: string } {
  const named = ctx.options.positionals[0];
  if (named) return { name: named, id: named };
  const owner = runningOwner();
  if (owner.kind === 'other') return { name: owner.user, id: owner.record.sid };
  return fail(
    'Whose web UI? No sandbox of another user is running.',
    'Name them: sandbox remote <their Windows user name>',
  );
}

export async function remote(ctx: Context): Promise<number> {
  requireOnPc('remote');
  const owner = ownerOf(ctx);
  const answer = await knockOnDoor(ctx.storageRoot, owner.id);
  if (!answer.ok)
    return fail(
      safeText(answer.reason),
      'Ask ' +
        safeText(owner.name) +
        ' to turn on web.remote.windowsSignIn, add you to web.remote.users and start the web UI.',
    );
  if (ctx.options.raw.browser === true) {
    openBrowser('http://127.0.0.1:' + answer.port + '/#w=' + answer.token);
    console.log(
      'Opened ' + safeText(owner.name) + "'s web UI in your browser (" + answer.role + '). It runs as them, not you.',
    );
    return 0;
  }
  const client = await remoteClient(answer.port, answer.token);
  const caller: Caller = { kind: 'windows', user: currentUserName(), role: answer.role };
  const app = new App();
  try {
    await new RemoteMenu(app, ctx, client, owner.name, caller).start();
  } finally {
    app.close();
    client.close();
  }
  if (!allows(caller, 'control')) console.log('You had view access: nothing was changed.');
  return 0;
}

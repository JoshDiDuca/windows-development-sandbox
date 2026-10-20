// The sessions feature's work: the list (as this user may see it under the sharing rules), restarting the agents,
// opening a shell in a project of the running sandbox and closing a session.
import { fail, safeText } from '../../../core/util/index.js';
import { RunDir } from '../../../shared/channel/index.js';
import { hostEndpoint } from '../../../host/channel/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { requireOnPc, requireRunning, type Context } from '../../../cli/commands/context.js';
import { locateHere } from '../../../cli/commands/projects/here.js';
import { lookAtSandbox, useSharedSandbox } from '../../../cli/commands/shared-use.js';
import { SessionsService, type ListedSession } from '../../../cli/services/index.js';
import { runningProjects } from '../../../cli/services/web-service.js';
import { implement, typedConfirm } from '../../context.js';
import { cancelled, type OperationIO } from '../../kernel/index.js';
import { closeSession, listSessions, restartSessions, startShell, type SessionRow } from './sessions.def.js';

/** A listed session as the surfaces see it: no attach address or token, text from the sandbox made safe. */
function sessionRow(s: ListedSession): SessionRow {
  const { attach: _attach, ...rest } = s;
  return {
    ...rest,
    harness: safeText(s.harness),
    cwd: safeText(s.cwd),
    ...(s.project !== undefined ? { project: safeText(s.project) } : {}),
    message: safeText(s.message).slice(0, 300),
    ...(s.conversation !== undefined ? { conversation: safeText(s.conversation) } : {}),
    ...(s.projectName !== undefined ? { projectName: safeText(s.projectName) } : {}),
    canOpen: s.phase === 'running' && hostEndpoint(s) !== null,
  };
}

export const listSessionsRun = implement(listSessions, async (asked, input) => {
  // Another user's sandbox: shared, its sessions are listed from their folders; not shared, only whose it is.
  const view = lookAtSandbox(asked);
  const base = {
    sandboxRunning: isSandboxRunning(),
    defaultAgent: asked.loaded.config.defaultHarness,
    wide: input.wide,
    ...(view.line ? { owner: view.line } : {}),
  };
  if (view.limited) return { ...base, sessions: [] };
  const list = await new SessionsService(view.ctx).list();
  return { ...base, sessions: list.map(sessionRow) };
});

export const restartSessionsRun = implement(restartSessions, async (ctx, input, io) => {
  requireOnPc('restart');
  requireRunning();
  await useSharedSandbox(ctx, { kind: 'owner-only', what: 'restart the agents' }, typedConfirm(io));
  const service = new SessionsService(ctx);
  const scope = service.restartScope(input.all);
  if (scope.notAProject)
    io.log(scope.folder + ' is not a project of the running sandbox: restarting every session.', 'muted');
  const what = scope.guest ? 'the agents of ' + scope.projectName : 'every agent';
  const yes = await io.confirm({
    title: 'Restart ' + what + '?',
    lines: ['The agents are started again and continue their conversations where they can.'],
    yes: 'Restart',
    implied: true,
  });
  if (!yes) cancelled();
  io.progress('Restarting the agents' + (scope.guest ? ' of ' + scope.projectName : ''));
  return { message: safeText(await service.restart(input.harness ?? null, scope.guest)) };
});

/** Where a new shell opens: the project named, else the one of the current folder, else the only one, else asked. */
async function shellPlace(
  ctx: Context,
  project: string | undefined,
  io: OperationIO,
): Promise<{ name: string | undefined; guest: string }> {
  const projects = runningProjects({ ctx, line: null, limited: false, owner: null });
  if (project !== undefined) {
    const named = projects.find((p) => p.name.toLowerCase() === project.toLowerCase());
    if (!named) fail('The running sandbox has no project "' + project + '".', 'sandbox status lists its projects.');
    return { name: named.name, guest: named.guest };
  }
  const here = locateHere(ctx, new RunDir(ctx.dataPath).readSandboxStatus());
  if (here.guestDir) return { name: here.project?.name, guest: here.guestDir };
  if (!projects.length) fail('The running sandbox has no projects.');
  if (projects.length === 1) return projects[0];
  const chosen = await io.choose({
    title: 'Which project?',
    choices: projects.map((p) => ({ value: p.name, label: p.name, description: p.guest })),
  });
  const picked = projects.find((p) => p.name === chosen);
  if (!picked) cancelled();
  return picked;
}

export const startShellRun = implement(startShell, async (asked, input, io) => {
  requireOnPc('shell');
  requireRunning();
  const ctx = await useSharedSandbox(asked, { kind: 'use' }, typedConfirm(io));
  const place = await shellPlace(ctx, input.project, io);
  io.progress('Opening ' + (input.shell === 'auto' ? 'a shell' : input.shell) + ' in ' + (place.name ?? place.guest));
  const session = await new SessionsService(ctx).openShell(input.shell, place.guest);
  const shell = safeText(session.harness);
  return {
    session: safeText(session.id),
    shell,
    message:
      'Opened ' + shell + ' in ' + safeText(place.name ?? place.guest) + ' (session ' + safeText(session.id) + ').',
  };
});

export const closeSessionRun = implement(closeSession, async (asked, input, io) => {
  requireOnPc('close');
  requireRunning();
  const find = (ctx: Context): ListedSession | undefined =>
    new SessionsService(ctx).running(null).find((s) => s.id === input.session);
  // Anyone the sandbox is shared with may close a shell; an agent session is its owner's to end.
  const ctx = await useSharedSandbox(
    asked,
    (shared) =>
      find(shared)?.kind === 'shell' ? { kind: 'use' } : { kind: 'owner-only', what: 'close an agent session' },
    typedConfirm(io),
  );
  const session = find(ctx);
  if (!session) fail('No running session ' + input.session + '.', 'sandbox sessions lists the running ones.');
  const what = safeText(session.harness) + (session.kind === 'shell' ? ' (shell)' : '');
  const yes = await io.confirm({
    title: 'Close ' + what + ' session ' + input.session + '?',
    lines: [
      'It ends, with every program it started.' +
        (session.kind === 'shell' ? '' : ' The agent can pick its conversation up again in a new session.'),
    ],
    yes: 'Close',
    danger: true,
    implied: true,
  });
  if (!yes) cancelled();
  io.progress('Closing session ' + input.session);
  return { message: safeText(await new SessionsService(ctx).close(input.session)) };
});

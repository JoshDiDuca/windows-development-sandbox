// The accounts feature's work: the saved logins of each agent, and saving, using, defaulting, renaming and removing
// them (through AccountsService). Talks only through io; prints nothing. Emails and the sandbox's own words go through
// safeText. Logins are never read here: the store keeps them sealed, and outputs hold names, emails and dates only.
import { fail, safeText } from '../../../core/util/index.js';
import { AccountsService, type AccountRef } from '../../../cli/services/index.js';
import { implement } from '../../context.js';
import { cancelled, type OperationIO } from '../../kernel/index.js';
import {
  defaultAccount,
  listAccounts,
  NAME_RULE,
  removeAccount,
  renameAccount,
  saveAccount,
  useAccount,
  type AccountRow,
  type AgentAccounts,
} from './accounts.def.js';

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const validName = (v: string): true | string => NAME.test(v.trim()) || NAME_RULE;

/** "work" (me@example.com) as the notices and the command line have always said it. */
function label(a: AccountRef): string {
  return safeText('"' + a.name + '"' + (a.email ? ' (' + a.email + ')' : ''));
}

/** The saved logins of a kept agent; none when its folder cannot be read (the other agents still list). */
function savedLogins(service: AccountsService, agent: string): AccountRow[] {
  try {
    return service.list(agent).map((r) => ({
      name: r.name,
      email: r.email === null ? null : safeText(r.email),
      isDefault: r.isDefault,
      isActive: r.isActive,
      savedAt: r.savedAt,
    }));
  } catch {
    // The menu has always shown such an agent with no logins; the command line says so too.
    return [];
  }
}

/**
 * The account an operation is about: the name given, else asked. Saving asks for a new name; the others pick one of
 * the saved logins (none saved: the fix is to save one).
 */
async function accountName(
  io: OperationIO,
  service: AccountsService,
  verb: 'save' | 'use' | 'default' | 'rename' | 'remove',
  agent: string,
  given: string | undefined,
): Promise<string> {
  if (given !== undefined) return verb === 'save' ? given.trim() : given;
  if (verb === 'save') {
    const typed = await io.text({ title: 'Name for this login:', validate: validName });
    if (typed === undefined) cancelled();
    return typed.trim();
  }
  const rows = service.list(agent);
  if (!rows.length) fail('No saved accounts.', 'Sign in inside the sandbox, then run: sandbox account save <name>');
  const picked = await io.choose({
    title: 'Which account?',
    choices: rows.map((a) => ({ value: a.name, label: label(a) })),
  });
  if (picked === undefined) cancelled();
  return picked;
}

export const listAccountsRun = implement(listAccounts, async (ctx, input) => {
  const service = new AccountsService(ctx);
  const agents: AgentAccounts[] = service.agents().map((a) => ({
    name: a.name,
    kept: a.kept,
    canSavePc: a.canSavePc,
    accounts: a.kept ? savedLogins(service, a.name) : [],
  }));
  // An agent that keeps no login, or no such agent: the command line says why (the store's own message).
  if (!agents.some((a) => a.name === input.agent && a.kept)) service.list(input.agent);
  return { agent: input.agent, agents };
});

export const saveAccountRun = implement(saveAccount, async (ctx, input, io) => {
  const service = new AccountsService(ctx);
  const name = await accountName(io, service, 'save', input.agent, input.name);
  const saved = service.save(name, input.fromHost, input.agent);
  return { name: saved.name, message: 'Saved account ' + label(saved) + '.' };
});

export const useAccountRun = implement(useAccount, async (ctx, input, io) => {
  const service = new AccountsService(ctx);
  const name = await accountName(io, service, 'use', input.agent, input.name);
  // The switch is done before the question: a "no" to the restart keeps the new login and only skips the restart.
  const used = service.activate(name, input.agent);
  const lines = ['Sandbox now uses ' + label(used) + '.'];
  if (used.note) lines.push(safeText(used.note));
  if (service.hasRunningSessions(input.agent) && !input.noRestart) {
    const restart = await io.confirm({
      title: 'Restart the running ' + input.agent + ' sessions?',
      lines: ['They restart and continue their conversation where the agent can, now under the new login.'],
      yes: 'Restart',
      implied: true,
    });
    if (restart)
      lines.push(
        safeText(await service.restart(input.agent)) +
          ' with --continue; the conversation carries on under the new account.',
      );
  }
  return { lines };
});

export const defaultAccountRun = implement(defaultAccount, async (ctx, input, io) => {
  const service = new AccountsService(ctx);
  const name = await accountName(io, service, 'default', input.agent, input.name);
  service.setDefault(name, input.agent);
  return { message: 'Default account: ' + name };
});

export const renameAccountRun = implement(renameAccount, async (ctx, input, io) => {
  const service = new AccountsService(ctx);
  const name = await accountName(io, service, 'rename', input.agent, input.name);
  const typed =
    input.to ?? (await io.text({ title: 'New name for "' + name + '":', initial: name, validate: validName }));
  const to = typed?.trim();
  if (to === undefined || to === name) cancelled();
  service.rename(name, to, input.agent);
  return { message: 'Renamed account ' + name + ' to ' + to + '.' };
});

export const removeAccountRun = implement(removeAccount, async (ctx, input, io) => {
  const service = new AccountsService(ctx);
  const name = await accountName(io, service, 'remove', input.agent, input.name);
  const yes = await io.confirm({
    title: 'Remove the saved account "' + name + '"?',
    lines: ['Its login cannot be recovered; you would sign in again.'],
    yes: 'Remove',
    danger: true,
    noTerminal: { message: 'Cannot ask here (no terminal).', fix: 'Add --yes to remove it without asking.' },
  });
  if (!yes) cancelled('Nothing removed.');
  service.remove(name, input.agent);
  return { message: 'Removed account ' + name + '.' };
});

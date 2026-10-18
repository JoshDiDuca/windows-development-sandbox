import type { CommandName } from '../manifest.js';
import { requireOnPc, type Context } from './context.js';
import { launch } from './launch/index.js';
import { setup } from './setup/index.js';
import { cleanData, showData } from '../../app/features/data/index.js';
import { attach, db, exec } from './sessions/index.js';
import { listAccounts } from '../../app/features/accounts/index.js';
import { containedStatus, showStorage } from '../../app/features/storage/index.js';
import { listProjects } from '../../app/features/projects/index.js';
import { definitionHandler } from '../operations/index.js';
import { fail } from '../../core/util/index.js';
import { audit, claudeHost, config, doctor, hostCommand, logs, sync, watcher } from './maintenance/index.js';
import { engine } from './engine.js';
import { resume } from './resume.js';
import { agentCommandsCommand } from './agent-commands.js';
import { vpn } from './vpn.js';
import { web, webServer } from './web.js';

export type Handler = (ctx: Context) => number | Promise<number | void>;

export const HANDLERS: Readonly<Partial<Record<string, Handler>>> = {
  launch: (ctx) => launch(ctx),
  generate: (ctx) => launch(ctx, true),
  attach: attach,
  exec: exec,
  'agent-commands': agentCommandsCommand,
  db: db,
  resume: resume,
  // The bare command lists; its actions (save, use ...) are the operations' hints.
  account: definitionHandler(listAccounts),
  // The bare command lists; its actions (add, remove, roots ...) are the operations' hints.
  projects: definitionHandler(listProjects),
  sync: sync,
  logs: logs,
  audit: audit,
  config: config,
  doctor: doctor,
  setup: setup,
  // `data`, `data info` and `data list` show; `data remove` is `data clean` (its actions are the operations' hints).
  data: (ctx) =>
    ctx.options.positionals[0] === 'remove' ? definitionHandler(cleanData)(ctx) : definitionHandler(showData)(ctx),
  // The bare command and `info` show; `contained` alone shows the beta status (the other actions are the operations'
  // hints in src/app/features/storage).
  storage: (ctx) => {
    requireOnPc('storage');
    const [action = 'show', mode] = ctx.options.positionals;
    if (action === 'show' || action === 'info') return definitionHandler(showStorage)(ctx);
    if (action === 'contained' && mode === undefined) return definitionHandler(containedStatus)(ctx);
    if (action === 'contained')
      return fail(
        'Unknown action "' + mode + '" for contained storage.',
        'Use: sandbox storage contained on, off or status',
      );
    return fail(
      'Unknown storage action "' + action + '".',
      'Use: sandbox storage, sandbox storage move <folder>, sandbox storage use <folder> or sandbox storage contained on|off|status',
    );
  },
  engine: engine,
  'host-claude': claudeHost,
  host: hostCommand,
  _watch: watcher,
  vpn: vpn,
  web: web,
  _web: webServer,
} satisfies Partial<Record<CommandName, Handler>>;

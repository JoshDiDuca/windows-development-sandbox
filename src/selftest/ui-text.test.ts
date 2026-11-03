// What the menu and the web say never tells the user to type a command ("we don't develop a menu to tell people to run
// commands"): every page of every view, built from sample data, is read for command lines, banned words and command
// links, and so is every message an operation can fail with (the *.run.ts sources). Text for the command line only
// is marked (`only: 'cli'` notes, `Empty.cliText`, `next`) and is not read. An exemption names the text and the reason.
import fs from 'node:fs';
import path from 'node:path';
import { sandboxPage } from '../app/features/sandbox/index.js';
import { sessionsPage } from '../app/features/sessions/index.js';
import { agentsPage } from '../app/features/agents/index.js';
import { accountsPage, servicePage, type ServicesList, type ServiceRow } from '../app/features/accounts/index.js';
import { projectsPage } from '../app/features/projects/index.js';
import { healthPage } from '../app/features/health/index.js';
import { dataPage } from '../app/features/data/index.js';
import { storagePage } from '../app/features/storage/index.js';
import { logsPage } from '../app/features/logs/index.js';
import { auditPage, auditListing, listAudit } from '../app/features/audit/index.js';
import { updatesPage } from '../app/features/updates/index.js';
import { enginePage } from '../app/features/engine/index.js';
import { webPage } from '../app/features/web/index.js';
import { vpnPage } from '../app/features/vpn/index.js';
import { githubPage } from '../app/features/github/index.js';
import { accessPage } from '../app/features/access/index.js';
import { appsPage, listApps, type AppsList } from '../app/features/apps/index.js';
import { settingsPage } from '../app/features/settings/index.js';
import { QUERIES } from '../app/features/defs.js';
import type { AppContext } from '../app/context.js';
import { pageActions, type Action, type Page } from '../app/kernel/index.js';
import { readQuery } from '../app/registry.js';
import { COMMANDS } from '../cli/manifest.js';
import type { Suite } from './support/suite.js';
import { renderScreens } from './menu-screens.js';
import {
  sampleAccess,
  sampleAccounts,
  sampleAgents,
  sampleAuditLog,
  sampleContained,
  sampleData,
  sampleEngines,
  sampleHealth,
  sampleLogs,
  sampleLogTail,
  sampleProjects,
  sampleSessions,
  sampleStatus,
  sampleStorage,
  sampleUpdates,
} from './support/web-preview.js';

/**
 * Words the menu and the web never show (the glossary fills this in during the wording pass). "(Beta)" is on the
 * list from the plan but waits for round 3: it is in about twenty setting titles that wording pass renames at once.
 */
const BANNED: readonly RegExp[] = [/\bnot available yet\b/i];

/** Text that is allowed to name a command: where, which text, and why. Keep this list short. */
const EXEMPT: readonly { readonly where: string; readonly text: string; readonly why: string }[] = [];

/** Every visible string of a page: what a person reads in the menu or the web (CLI-only text is left out). */
export function visibleText(page: Page): string[] {
  const out: string[] = [page.title];
  const add = (...texts: (string | undefined)[]): void => {
    for (const t of texts) if (t) out.push(t);
  };
  const act = (a: Action): void => add(a.label, a.verb, a.description);
  if (page.notice && page.notice.only !== 'cli') add(page.notice.text);
  if (page.empty) {
    add(page.empty.title, page.empty.text);
    if (page.empty.action) act(page.empty.action);
  }
  for (const a of page.actions ?? []) act(a);
  for (const s of page.sections) {
    add(s.title, s.summary, s.description, ...(s.text ?? []));
    for (const f of s.facts ?? []) add(f.label, f.value, f.description, ...(f.details ?? []));
    for (const n of s.notes ?? []) if (n.only !== 'cli') add(n.text);
    for (const a of s.actions ?? []) act(a);
    for (const i of s.items ?? []) {
      add(
        i.label,
        i.hint,
        i.description,
        i.keys,
        i.disabled,
        i.group,
        ...(i.details ?? []),
        ...(i.badges ?? []).map((b) => b.text),
      );
      for (const a of [...(i.primary ? [i.primary] : []), ...(i.actions ?? [])]) act(a);
    }
  }
  return out;
}

/** The commands a person could be told to type: `sandbox <name>` for every command, and the internal `_web`. */
function commandPattern(): RegExp {
  const names = new Set(COMMANDS.map((c) => c.name));
  const words = [...names].filter((n) => /^[a-z_][a-z0-9-]*$/.test(n)).map((n) => n.replace(/-/g, '\\-'));
  return new RegExp('\\bsandbox (?:' + words.join('|') + ')\\b');
}

/** What is wrong with a text, or undefined. */
export function textProblem(text: string, where: string, command: RegExp = commandPattern()): string | undefined {
  if (EXEMPT.some((e) => e.where === where && text.includes(e.text))) return undefined;
  const hit = command.exec(text);
  if (hit) return 'names a command (' + hit[0] + ')';
  const banned = BANNED.find((b) => b.test(text));
  if (banned) return 'uses ' + banned;
  return undefined;
}

function serviceRow(over: Partial<ServiceRow>): ServiceRow {
  return {
    kind: 'steam',
    label: 'Steam',
    share: false,
    state: 'none',
    source: null,
    savedAt: null,
    summary: null,
    heldBy: null,
    usedBy: ['fivem'],
    warnings: ['Steam allows one sign-in at a time.'],
    canImport: true,
    canLogin: true,
    needsFile: false,
    ready: true,
    ...over,
  };
}

/** Every page the shared core builds, in the states that print the most text. */
async function samplePages(dir: string): Promise<{ name: string; page: Page }[]> {
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, '{}\n');
  fs.mkdirSync(path.join(dir, 'project'), { recursive: true });
  const ctx = {
    loaded: { configPath },
    options: { workspace: path.join(dir, 'project') },
    storageRoot: path.join(dir, 'storage'),
    dataPath: path.join(dir, 'data'),
  } as unknown as AppContext;
  const query = (id: string): (typeof QUERIES)[number] => QUERIES.find((q) => q.id === id)!;
  const settings = await readQuery(query('settings.list'), ctx, { scope: 'user' });
  const apps = (await readQuery(listApps, ctx, { scope: 'user' })) as AppsList;
  const audit = sampleAuditLog(path.join(dir, 'audit'));
  const listing = (enabled: boolean): unknown =>
    auditListing(audit, { enabled, days: 7, maxMb: 100 }, listAudit.input.parse({}), path.join(dir, 'audit'));
  const services = (state: ServiceRow['state'], share: boolean): ServicesList => ({
    services: [
      serviceRow({ state, share, source: state === 'saved' ? 'pc' : null, summary: state === 'saved' ? 'josh' : null }),
    ],
  });
  const health = sampleHealth() as { last: unknown };
  const accounts = sampleAccounts() as Parameters<typeof accountsPage>[0];
  const vpn = (login: 'none' | 'saved' | 'unreadable', enabled: boolean): Parameters<typeof vpnPage>[0] => ({
    enabled,
    provider: 'nordvpn',
    protocol: 'udp',
    country: 'Netherlands',
    killSwitch: true,
    login,
    loginSavedAt: login === 'saved' ? '2026-10-14T09:30:00.000Z' : null,
    running: null,
  });
  const github = (token: 'none' | 'saved' | 'unreadable', shareToken: boolean): Parameters<typeof githubPage>[0] =>
    ({
      shareToken,
      gitAccess: 'full',
      token,
      kind: token === 'saved' ? 'fine-grained' : null,
      savedAt: token === 'saved' ? '2026-10-14T09:30:00.000Z' : null,
    }) as Parameters<typeof githubPage>[0];
  const pages: { name: string; page: Page }[] = [];
  const add = (name: string, page: Page): number => pages.push({ name, page });
  for (const running of [true, false]) {
    add('sandbox ' + running, sandboxPage(sampleStatus(running) as Parameters<typeof sandboxPage>[0]));
    add('sessions ' + running, sessionsPage(sampleSessions(running) as Parameters<typeof sessionsPage>[0]));
    add('projects ' + running, projectsPage(sampleProjects(running) as Parameters<typeof projectsPage>[0]));
  }
  const status = sampleStatus(false) as Parameters<typeof sandboxPage>[0];
  add('sandbox leftover', sandboxPage({ ...status, leftover: { text: 'Windows Sandbox programs are left over.' } }));
  add(
    'sandbox ended',
    sandboxPage({ ...status, lastEnd: { text: 'It ended without being closed.', at: '2026-11-01T10:00:00.000Z' } }),
  );
  add(
    'sandbox no account',
    sandboxPage({
      ...(sampleStatus(true) as typeof status),
      sandbox: { ...status.sandbox, running: true, account: null, headless: true },
    }),
  );
  add('agents', agentsPage(sampleAgents() as Parameters<typeof agentsPage>[0]));
  add('accounts', accountsPage(accounts, services('saved', true)));
  add(
    'accounts none',
    accountsPage(
      { ...accounts, agents: accounts.agents.map((a) => ({ ...a, accounts: [] })) },
      services('none', false),
    ),
  );
  for (const state of ['none', 'saved', 'unreadable'] as const)
    for (const share of [false, true]) add('service ' + state + share, servicePage(services(state, share).services[0]));
  add('health', healthPage(health as Parameters<typeof healthPage>[0]));
  add('health none', healthPage({ last: null }));
  add('data', dataPage(sampleData() as Parameters<typeof dataPage>[0]));
  add(
    'storage',
    storagePage(
      sampleStorage() as Parameters<typeof storagePage>[0],
      sampleContained() as Parameters<typeof storagePage>[1],
    ),
  );
  add(
    'storage unavailable',
    storagePage(sampleStorage() as Parameters<typeof storagePage>[0], {
      ...(sampleContained() as Parameters<typeof storagePage>[1]),
      available: false,
      reasons: ['No.'],
      fixes: ['Do this.'],
    }),
  );
  const logs = sampleLogs() as Parameters<typeof logsPage>[0];
  add('logs', logsPage(logs, sampleLogTail({}) as Parameters<typeof logsPage>[1]));
  add('logs none', logsPage({ ...logs, files: [], crash: false }));
  add('audit', auditPage(listing(true) as Parameters<typeof auditPage>[0]));
  add('audit off', auditPage(listing(false) as Parameters<typeof auditPage>[0]));
  const updates = sampleUpdates() as Parameters<typeof updatesPage>[0];
  add('updates', updatesPage(updates, '1.5.0'));
  add('updates current', updatesPage({ ...updates, failed: null, previous: null, autoUpdate: false }, null));
  add('updates unmanaged', updatesPage({ ...updates, managed: false }, null));
  add('engine', enginePage(sampleEngines() as Parameters<typeof enginePage>[0]));
  add('web off', webPage({ running: false, port: null, address: null }));
  add('web on', webPage({ running: true, port: 47800, address: 'http://127.0.0.1:47800/' }));
  add(
    'web lan problem',
    webPage({ running: true, port: 47800, address: 'http://127.0.0.1:47800/', lanProblem: 'No network.' }),
  );
  add('access', accessPage(sampleAccess() as Parameters<typeof accessPage>[0]));
  add(
    'access off',
    accessPage({
      ...(sampleAccess() as Parameters<typeof accessPage>[0]),
      lan: { enabled: false, running: false, address: null, fingerprint: null, problem: null, network: null },
      devices: [],
      windows: [],
      users: [],
      pending: null,
    }),
  );
  for (const login of ['none', 'saved', 'unreadable'] as const)
    add('vpn ' + login, vpnPage(vpn(login, login === 'saved')));
  for (const token of ['none', 'saved', 'unreadable'] as const)
    for (const share of [false, true]) add('github ' + token + share, githubPage(github(token, share)));
  add('settings', settingsPage(settings as Parameters<typeof settingsPage>[0]));
  add('apps', appsPage(apps));
  return pages;
}

/** Message and fix strings of the operations: lines of *.run.ts files that quote a command. */
function runSourceLines(root: string): { where: string; line: number; text: string }[] {
  const found: { where: string; line: number; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.run.ts')) {
        fs.readFileSync(full, 'utf8')
          .split(/\r?\n/)
          .forEach((text, i) => {
            if (!/^\s*(\/\/|\*|\/\*)/.test(text))
              found.push({ where: path.relative(root, full).replace(/\\/g, '/'), line: i + 1, text });
          });
      }
    }
  };
  walk(root);
  return found;
}

/** Lines of the run files that may name a command, because only the command line shows them. */
const CLI_ONLY_LINES: readonly { readonly where: string; readonly text: string; readonly why: string }[] = [];

export const uiTextSuite: Suite = {
  name: 'ui-text',
  title: 'menu and web text: no page, message or fix tells the user to run a command',
  run: async (t) => {
    const command = commandPattern();
    t.section('pages');
    const dir = t.dir('ui-text', 'pages');
    const pages = await samplePages(dir);
    const problems = pages.flatMap(({ name, page }) =>
      visibleText(page).flatMap((text) => {
        const why = textProblem(text, name, command);
        return why ? [name + ': "' + text.slice(0, 140) + '" ' + why] : [];
      }),
    );
    if (process.env.UI_TEXT_DUMP) fs.writeFileSync(process.env.UI_TEXT_DUMP, problems.join('\n'));
    t.equal(problems, [], 'no page of any view names a command or uses a banned word');
    const commandLinks = pages.flatMap(({ name, page }) =>
      pageActions(page).flatMap((a) => (a.kind === 'link' && a.target.kind === 'command' ? [name] : [])),
    );
    t.equal(commandLinks, [], 'no page links to a command line');

    t.section('messages');
    const lines = runSourceLines(path.join(process.cwd(), 'src', 'app', 'features'));
    const loose = lines
      .filter(
        (l) => command.test(l.text) && !CLI_ONLY_LINES.some((e) => e.where === l.where && l.text.includes(e.text)),
      )
      .map((l) => l.where + ':' + l.line + ' ' + l.text.trim().slice(0, 140));
    t.equal(loose, [], 'no operation message or fix names a command (use failWith, an action or a CLI-only field)');

    t.section('menu screens');
    const screens = renderScreens(t.dir('ui-text', 'screens'));
    const screenProblems = screens
      .split('\n')
      .filter((l) => !l.startsWith('==='))
      .flatMap((l) => {
        const why = textProblem(l, 'menu', command);
        return why ? [l.trim().slice(0, 140) + ' ' + why] : [];
      });
    t.equal(screenProblems, [], 'no menu screen names a command');
  },
};

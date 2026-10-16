// Draws every menu screen with made-up data through the same pure functions the menu uses, at two terminal sizes, as
// plain text for reading (the menu-screens review file). No terminal, no sandbox, no services.
import fs from 'node:fs';
import path from 'node:path';
import { Draft } from '../cli/menu/settings/draft.js';
import { ConfigFile } from '../app/features/settings/index.js';
import { accountsOptions, type AccountsModel } from '../cli/menu/pages/accounts-page.js';
import { appsOptions, stageTicks } from '../cli/menu/pages/apps-page.js';
import { maintenanceOptions, type MaintenanceModel } from '../cli/menu/pages/maintenance-page.js';
import { sandboxOptions, type SandboxModel } from '../cli/menu/pages/sandbox-page.js';
import { sessionsOptions } from '../cli/menu/pages/sessions-page.js';
import { settingsOf, settingsOptions } from '../cli/menu/pages/settings-page.js';
import { CATEGORIES } from '../app/features/settings/index.js';
import { agentsOptions } from '../cli/menu/pages/agents-page.js';
import { SECTION_LABELS } from '../cli/menu/shell.js';
import type { SessionRow } from '../app/features/sessions/index.js';
import { Frame, ListScreen, OverlayScreen, Text, type ListOptions, type NavState } from '../cli/tui/index.js';

export const SIZES = [
  { width: 200, height: 60 },
  { width: 100, height: 30 },
  { width: 80, height: 24 },
  { width: 60, height: 20 },
];

const NOW = Date.now();
const API_FOLDER = 'C:\\Projects\\api';

/** The Data folder row of General (in the menu it comes from data-folder.ts). */
const DATA_FOLDER_ROW = [
  {
    value: '@data-folder',
    category: 'general',
    label: 'Data folder',
    hint: 'C:\\ProgramData\\AgentSandbox\\users\\me',
    description: 'Where the sandbox keeps its data. Enter changes it.',
  },
];

const ACCOUNTS: AccountsModel = {
  agent: 'claude',
  agents: [
    {
      name: 'claude',
      kept: true,
      canSavePc: true,
      accounts: [
        { name: 'work', email: 'me@work.example', isDefault: true, isActive: true, savedAt: '2026-10-13T09:30:00Z' },
        { name: 'home', email: null, isDefault: false, isActive: false, savedAt: '2026-10-01T18:00:00Z' },
      ],
    },
    {
      name: 'codex',
      kept: true,
      canSavePc: true,
      accounts: [{ name: 'main', email: null, isDefault: true, isActive: false, savedAt: '2026-10-12T08:00:00Z' }],
    },
    { name: 'opencode', kept: false, canSavePc: false, accounts: [] },
  ],
};

const SESSIONS = [
  {
    id: '1791927991435-aa11bb',
    harness: 'claude',
    cwd: 'C:\\Projects\\api',
    phase: 'running',
    startedAt: new Date(NOW - 12 * 60000).toISOString(),
    projectName: 'api',
    here: true,
    viewers: { remote: 1, viewers: 1 },
    canOpen: true,
  },
  {
    id: '1791927991436-cc22dd',
    harness: 'codex',
    cwd: 'C:\\Projects\\web',
    phase: 'running',
    startedAt: new Date(NOW - 95 * 60000).toISOString(),
    projectName: 'web',
    here: false,
    viewers: { remote: 0, viewers: 0 },
    canOpen: true,
  },
] as unknown as SessionRow[];

/** The navigation the shell would show: every section, the open one with the categories of `options`. */
export function navFor(
  active: number,
  options: ListOptions<string>,
  focused: boolean,
  unsaved = 0,
  dimmed = false,
): NavState {
  const list = new ListScreen({ ...options, categoryNav: 'external' });
  return {
    sections: SECTION_LABELS.map((label, i) => ({
      label,
      marked: unsaved > 0 && (label === 'Settings' || label === 'Apps'),
      categories:
        i === active ? list.categories.map((c) => ({ label: c.label, current: c.id === list.currentCategory })) : [],
    })),
    active,
    focused,
    dimmed,
  };
}

/** Frame for one screen: the navigation, a status line, the list, the keys. */
function draw(
  active: number,
  options: ListOptions<string>,
  size: { width: number; height: number },
  status = '',
  unsaved = 0,
  focusNav = false,
): string[] {
  const nav = navFor(active, options, focusNav, unsaved);
  const body = { width: Frame.bodyWidth(size.width, nav), height: Frame.bodyHeight(size.height) };
  const parts = new ListScreen({ ...options, categoryNav: 'external', escapeLabel: 'sections' }).render(body);
  return Frame.render(
    {
      ...parts,
      keys: unsaved ? [['ctrl+s', 'save (' + unsaved + ')', 0], ...parts.keys] : parts.keys,
      status: (unsaved ? 'unsaved: ' + unsaved + '   ' : '') + (parts.status ?? status),
      nav,
    },
    size.width,
    size.height,
  ).map((l) => Text.strip(l).replace(/\s+$/, ''));
}

function block(title: string, lines: string[], size: { width: number; height: number }): string {
  return ['=== ' + title + ' (' + size.width + 'x' + size.height + ') ===', ...lines, ''].join('\n');
}

/** All screens, at both sizes, as one text. `dir` is a scratch folder for the made-up config files. */
export function renderScreens(dir: string): string {
  const user = ConfigFile.user(path.join(dir, 'config.json'));
  fs.mkdirSync(path.join(dir, 'project'), { recursive: true });
  const project = ConfigFile.project(path.join(dir, 'project'));
  const files = { user, project };
  const draft = new Draft();
  const status = 'Sandbox running · 2 sessions   C:\\Projects\\api';
  const sandbox: SandboxModel = {
    report: {
      sandbox: {
        running: true,
        phase: 'ready',
        message: undefined,
        headless: true,
        startedAt: NOW - 3 * 3600000,
        daemon: 'pong',
        account: 'work',
        syncWatcher: true,
      },
      here: { folder: 'C:\\Projects\\api', project: 'api', guest: 'C:\\Projects\\api' },
      roots: [],
      projects: [],
      otherSessions: [],
      repoGuard: { guarded: 2, findings: [] },
    },
    projects: {
      all: true,
      roots: ['C:\\Projects'],
      exclude: [],
      projects: [
        {
          folder: 'C:\\Projects\\api',
          here: true,
          known: true,
          root: 'C:\\Projects',
          excluded: false,
          mappedAtStart: true,
          running: 'api (root)',
        },
        {
          folder: 'F:\\Code\\scratch',
          here: false,
          known: true,
          root: null,
          excluded: false,
          mappedAtStart: true,
          running: null,
        },
      ],
    },
    databases: [
      { name: 'postgres', running: true, port: 5432, title: 'PostgreSQL 18' },
      { name: 'redis', running: false, port: 6379, title: 'Redis' },
    ],
    defaultAgent: 'claude',
  };
  const stopped: SandboxModel = {
    ...sandbox,
    report: { ...sandbox.report, sandbox: { ...sandbox.report.sandbox, running: false, phase: 'stopped' } },
    databases: null,
  };
  const maintenance: MaintenanceModel = {
    data: {
      dataPath: 'C:\\AgentData',
      storageRoot: 'C:\\ProgramData\\AgentSandbox\\users\\me',
      totalBytes: 8.9e9,
      total: '8.9 GB',
      storageShare: '<- sandbox storage (8.9 GB of it)',
      areaTotals: { tools: '7.1 GB', state: '1.8 GB', host: '4.0 KB' },
      entries: [
        {
          area: 'tools',
          name: 'rust',
          path: 'C:\\AgentData\\tools\\rust',
          bytes: 4.6e9,
          size: '4.6 GB',
          target: 'tools/rust',
        },
        {
          area: 'tools',
          name: 'vscode',
          path: 'C:\\AgentData\\tools\\vscode',
          bytes: 2.5e9,
          size: '2.5 GB',
          target: 'tools/vscode',
        },
        {
          area: 'state',
          name: 'state/claude',
          path: 'C:\\AgentData\\state\\claude',
          bytes: 1.8e9,
          size: '1.8 GB',
          target: 'state/claude',
        },
        {
          area: 'host',
          name: 'accounts',
          path: 'C:\\Users\\me\\AppData\\Local\\AgentSandbox\\accounts',
          bytes: 4096,
          size: '4.0 KB',
          target: null,
        },
      ],
      disks: [
        {
          drive: 'C:\\',
          totalBytes: 40e9,
          freeBytes: 22e9,
          usedBytes: 18e9,
          holdsStorage: true,
          used: '18 GB',
          usedPercent: 45,
          free: '22 GB',
          total: '40 GB',
        },
      ],
    },
    logs: {
      folder: 'C:\\AgentData\\logs',
      files: [
        {
          name: 'guest-2026-10-14.log',
          path: 'C:\\AgentData\\logs\\guest-2026-10-14.log',
          bytes: 120000,
          modified: NOW - 60000,
        },
        {
          name: 'daemon-2026-10-14.log',
          path: 'C:\\AgentData\\logs\\daemon-2026-10-14.log',
          bytes: 8000,
          modified: NOW - 600000,
        },
      ],
      crash: true,
    },
    health: {
      last: {
        at: new Date(NOW - 180000).toISOString(),
        mode: 'check',
        checks: [
          { id: 'config', group: 'Settings', name: 'Config file', status: 'ok', detail: 'valid', fixable: false },
          {
            id: 'stale',
            group: 'Data folder',
            name: 'Stale run folders',
            status: 'fixed',
            detail: 'removed 2',
            fixable: false,
          },
          {
            id: 'cache',
            group: 'Sandbox',
            name: 'Toolchain cache',
            status: 'needs-you',
            detail: 'close the sandbox first',
            fixable: false,
          },
        ],
        summary: { total: 3, ok: 1, fixed: 1, warn: 0, needsYou: 1, skipped: 0, fixable: 0 },
        details: [
          ['Windows Sandbox', 'available'],
          ['Config file', 'C:\\Users\\me\\.agent-sandbox\\config.json'],
        ],
        setup: {
          checks: [
            { name: 'Windows edition', status: 'ok', detail: 'Pro' },
            { name: 'Windows Sandbox feature', status: 'action', detail: 'turned off' },
          ],
          canEnable: true,
          error: null,
        },
        log: null,
      },
    },
    dataFolder: {
      label: 'Data folder',
      hint: 'C:\\ProgramData\\AgentSandbox\\users\\me',
      description: 'Where the sandbox keeps its tools, databases and agent state. Enter changes it.',
    },
    updates: {
      status: {
        managed: true,
        version: '1.4.3',
        scope: 'user',
        autoUpdate: true,
        autoOffText: null,
        previous: '1.4.2',
        failed: { version: '1.4.4', reason: 'it did not start' },
        npmCommand: 'npm install -g windows-development-sandbox',
        error: null,
        settings: {
          pending: ['2026-10-unpin-config-defaults: stop pinning old defaults in your config.json'],
          error: null,
        },
      },
      latest: '1.5.0',
    },
    web: { running: true, port: 47800, address: 'http://127.0.0.1:47800/' },
    more: [
      { name: 'sync', summary: 'sync history now' },
      { name: 'audit', summary: 'show what the sandbox did' },
    ],
  };
  // Two unsaved changes in Settings.
  const settings = settingsOf(user);
  const harness = settings.find((s) => s.key.join('.') === 'defaultHarness');
  const flag = settings.find((s) => s.node.editor === 'boolean');
  if (harness) draft.stage(user, harness.key, 'codex');
  if (flag) draft.stage(user, flag.key, !(user.userConfig() as unknown as Record<string, unknown>)[flag.key[0]]);
  const appsData = path.join(dir, 'data');
  const appsDraft = new Draft();
  stageTicks(user, appsDraft, ['git-gui']);

  const out: string[] = [];
  for (const size of SIZES) {
    const agentsModel = {
      folder: API_FOLDER,
      defaultAgent: 'claude',
      agents: [
        { name: 'claude', ready: true },
        { name: 'codex', ready: false },
        { name: 'gemini', ready: false },
      ],
      last: ['launch', '--harness', 'claude', '--terminal'],
      attach: true,
      window: 'config' as const,
      hostAgents: ['codex'],
      removable: ['gemini'],
    };
    out.push(
      block(
        '1 Agents · Start',
        draw(0, { ...agentsOptions(agentsModel, API_FOLDER), startCategory: 'start' }, size, status),
        size,
      ),
      block(
        '1 Agents · Options (navigation focused)',
        draw(0, { ...agentsOptions(agentsModel, API_FOLDER), startCategory: 'options' }, size, status, 0, true),
        size,
      ),
      block(
        '1 Agents · On this PC',
        draw(0, { ...agentsOptions(agentsModel, API_FOLDER), startCategory: 'host' }, size, status),
        size,
      ),
      block(
        '2 Sessions',
        draw(1, sessionsOptions({ sandboxRunning: true, sessions: SESSIONS, defaultAgent: 'claude' }), size, status),
        size,
      ),
      block(
        '2 Sessions (no sandbox)',
        draw(1, sessionsOptions({ sandboxRunning: false, sessions: [], defaultAgent: 'claude' }), size),
        size,
      ),
    );
    for (const category of ['status', 'databases'])
      out.push(
        block(
          '3 Sandbox (stopped) · ' + category,
          draw(2, { ...sandboxOptions(stopped), startCategory: category }, size),
          size,
        ),
      );
    for (const category of ['status', 'projects', 'databases'])
      out.push(
        block(
          '3 Sandbox · ' + category,
          draw(2, { ...sandboxOptions(sandbox), startCategory: category }, size, status),
          size,
        ),
      );
    out.push(
      block(
        '4 Apps (1 unsaved)',
        draw(3, appsOptions(user, appsData, appsDraft, 'user'), size, status, appsDraft.count()),
        size,
      ),
    );
    for (const category of CATEGORIES)
      out.push(
        block(
          '5 Settings · ' + category.label + ' (2 unsaved)',
          draw(
            4,
            { ...settingsOptions(files, 'user', draft, DATA_FOLDER_ROW), startCategory: category.id },
            size,
            status,
            draft.count(),
          ),
          size,
        ),
      );
    // The leave dialog over the settings screen.
    const settingsList = settingsOptions(files, 'user', draft, DATA_FOLDER_ROW);
    const nav = navFor(4, settingsList, false, draft.count(), true);
    const background = new ListScreen({ ...settingsList, categoryNav: 'external' });
    const bodySize = { width: Frame.bodyWidth(size.width, nav), height: Frame.bodyHeight(size.height) };
    const dialog = new OverlayScreen(background, {
      title: 'Unsaved changes',
      lines: ['You have 2 unsaved changes in Settings and Apps.'],
      choices: [
        { value: 'save', label: 'Save', key: 's' },
        { value: 'discard', label: 'Discard', key: 'd', danger: true },
        { value: 'cancel', label: 'Cancel', key: 'c' },
      ],
      escape: 'cancel',
    });
    out.push(
      block(
        '5 Settings: Save / Discard / Cancel',
        Frame.render({ ...dialog.render(bodySize), nav }, size.width, size.height).map((l) =>
          Text.strip(l).replace(/\s+$/, ''),
        ),
        size,
      ),
      block('6 Accounts', draw(5, accountsOptions(ACCOUNTS), size, status), size),
      block(
        '6 Accounts · codex',
        draw(5, { ...accountsOptions(ACCOUNTS), startCategory: 'codex' }, size, status),
        size,
      ),
      block(
        '6 Accounts · opencode (login not kept)',
        draw(5, { ...accountsOptions(ACCOUNTS), startCategory: 'opencode' }, size, status),
        size,
      ),
    );
    for (const category of ['updates', 'data', 'health', 'logs', 'more'])
      out.push(
        block(
          '7 Maintenance · ' + category,
          draw(6, { ...maintenanceOptions(maintenance), startCategory: category }, size, status),
          size,
        ),
      );
  }
  return out.join('\n');
}

// Where every feature of the command line is in the menu ("all features and config need to be in the menu"). The
// menu-coverage self-test fails when a command, an operation exempt from the menu or a setting has no place here.
// `place` names the menu section and tab; `exempt` is the reason a command cannot be in the menu.
import type { SECTION_LABELS } from './shell.js';

type Section = (typeof SECTION_LABELS)[number];

export type CommandPlace = { readonly place: `${Section}${string}` } | { readonly exempt: string };

/** Every command of cli/manifest.ts (hand-written and from the shared core's CLI hints). */
export const COMMAND_PLACES: Readonly<Record<string, CommandPlace>> = {
  launch: { place: 'Agents > Start (with the options of the tab)' },
  start: { place: 'Agents > Start several' },
  generate: { place: 'Maintenance > More commands' },
  attach: { place: 'Sessions (Enter on a session)' },
  resume: { place: 'Sessions (key o: reopen last sessions)' },
  db: { place: 'Sandbox > Databases' },
  exec: { place: 'Maintenance > More commands' },
  projects: { place: 'Sandbox > Projects' },
  account: { place: 'Accounts' },
  data: { place: 'Maintenance > Data' },
  storage: { place: 'Maintenance > Storage' },
  engine: { place: 'Maintenance > Engine' },
  unreal: { place: 'Sandbox > Unreal Engine' },
  unity: { place: 'Sandbox > Unity' },
  sync: { place: 'Maintenance > More commands' },
  logs: { place: 'Maintenance > Logs (key f follows)' },
  setup: { place: 'Maintenance > Health' },
  doctor: { place: 'Maintenance > Health' },
  repair: { place: 'Maintenance > Health' },
  'self-test': { exempt: 'a developer check that refuses to run outside a throwaway machine' },
  config: { place: 'Settings (every setting) and Maintenance > More commands' },
  'agent-commands': { place: 'Agents > Agent commands' },
  vpn: { place: 'Settings > Network > VPN' },
  github: { place: 'Accounts > GitHub (and Settings > Security)' },
  'host-claude': { place: 'Agents > On this PC' },
  host: { place: 'Agents > On this PC' },
  menu: { exempt: 'it is the menu' },
  web: { place: 'Maintenance > Web UI' },
  remote: { exempt: "it opens this menu on another Windows user's web UI: the menu cannot start itself inside itself" },
  _watch: { exempt: 'internal: the background history sync' },
  _web: { exempt: 'internal: the web server process' },
  show: { place: 'Sandbox > Status' },
  hide: { place: 'Sandbox > Status' },
  stop: { place: 'Sandbox > Status' },
  'vm-dumps': { place: 'Sandbox > Status (after a crash) and Maintenance > Health' },
  cleanup: { place: 'Sandbox > Status (when a dead sandbox left programs behind)' },
  restart: { place: 'Sessions (key r)' },
  shell: { place: 'Sessions (key s)' },
  close: { place: 'Sessions' },
  clean: { place: 'Maintenance > Data' },
  update: { place: 'Maintenance > Updates' },
  migrate: { place: 'Maintenance > Updates' },
  status: { place: 'Sandbox > Status' },
  sessions: { place: 'Sessions' },
  audit: { place: 'Maintenance > Activity' },
};

/**
 * Operations and queries that declare `surfaces.except.menu`: the id and why the menu does without them. A definition
 * with a menu exemption that is not here fails the coverage test.
 */
export const MENU_EXEMPT: Readonly<Record<string, string>> = {
  'agents.start': 'the menu starts agents with launch, which can boot the sandbox and attach this terminal',
  'engine.check': 'the Engine category shows every engine and its check with the fixes (engine.status)',
  'files.browse': 'the menu asks for a path as text and checks it',
  'settings.get': 'Settings shows every value',
};

/** Setting keys (or key prefixes ending in a dot) the menu's Settings page does not list as a row. */
export const SETTING_PLACES: Readonly<Record<string, string>> = {
  'apps.install': 'the Apps section (a tick per app)',
  'apps.custom': 'the Apps section (your own apps)',
  $schema: 'not a setting: the JSON schema address of the file',
};

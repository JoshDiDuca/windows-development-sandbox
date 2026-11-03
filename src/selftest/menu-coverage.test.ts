// "All features and config need to be in the cli menu": every command has a place in the menu (or a reason it cannot),
// every operation and query that skips the menu says why in cli/menu/coverage-exempt.ts, and every setting of the config
// schema is a row of the menu's Settings page.
import path from 'node:path';
import { DEFINITIONS } from '../app/features/defs.js';
import { ConfigFile, settingsOf } from '../app/features/settings/index.js';
import { exemption } from '../app/kernel/index.js';
import { COMMANDS } from '../cli/manifest.js';
import { COMMAND_PLACES, MENU_EXEMPT, SETTING_PLACES } from '../cli/menu/coverage-exempt.js';
import { SECTION_LABELS } from '../cli/menu/shell.js';
import { isToolchainReady } from '../shared/readiness.js';
import type { Suite } from './support/suite.js';

export const menuCoverageSuite: Suite = {
  name: 'menu-coverage',
  title: 'menu coverage: every command, operation and setting has a place in the menu, or a written reason',
  run: (t) => {
    t.section('commands');
    const names = COMMANDS.map((c) => c.name);
    t.equal(
      names.filter((n) => !(n in COMMAND_PLACES)),
      [],
      'every command has a menu place or an exemption in cli/menu/coverage-exempt.ts',
    );
    t.equal(
      Object.keys(COMMAND_PLACES).filter((n) => !names.includes(n)),
      [],
      'the list names no command that is gone',
    );
    const badPlaces = Object.entries(COMMAND_PLACES).flatMap(([name, p]) =>
      'place' in p
        ? SECTION_LABELS.some((s) => p.place.startsWith(s))
          ? []
          : [name + ': ' + p.place + ' is not a menu section']
        : p.exempt.trim().length >= 10
          ? []
          : [name + ': the reason is too short'],
    );
    t.equal(badPlaces, [], 'a place starts with a menu section, an exemption gives a reason');

    t.section('operations and queries');
    const exempt = DEFINITIONS.filter((d) => exemption(d, 'menu')?.trim()).map((d) => d.id);
    t.equal(
      exempt.filter((id) => !(id in MENU_EXEMPT)),
      [],
      'every definition that skips the menu is on the allow-list with its reason',
    );
    t.equal(
      Object.keys(MENU_EXEMPT).filter((id) => !exempt.includes(id)),
      [],
      'the allow-list names no definition that is in the menu or gone',
    );

    t.section('settings');
    const file = ConfigFile.user(path.join(t.dir('menu-coverage'), 'config.json'));
    const rows = new Set(settingsOf(file).map((s) => s.key.join('.')));
    const placed = (key: string): boolean =>
      rows.has(key) ||
      [...rows].some((r) => key.startsWith(r + '.')) ||
      Object.keys(SETTING_PLACES).some((p) => key === p || (p.endsWith('.') && key.startsWith(p)));
    const missing = file.schema
      .leaves()
      .map((l) => l.key.join('.'))
      // A toolchain that is not finished is hidden everywhere (shared/readiness.ts), the Settings page included.
      .filter((key) => !(key.startsWith('toolchains.') && !isToolchainReady(key.split('.')[1])))
      .filter((key) => !placed(key));
    t.equal(missing, [], 'every setting of the config schema is a row of the Settings page (or on the allow-list)');
  },
};

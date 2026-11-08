// Things written for Windows itself on this PC: the registry personalisation (.reg file) and the Windows Terminal
// PowerShell 7 profile. The Windows Terminal part is only tried on temp copies.
import fs from 'node:fs';
import path from 'node:path';
import { toRegFile } from '../host/profile/index.js';
import { PWSH_PROFILE_GUID, syncPwshProfile, withPwshProfile } from '../host/tools/index.js';
import type { Suite } from './support/suite.js';

interface TerminalSettings {
  theme: string;
  profiles: { list: { guid: string; hidden?: boolean; name?: string; fontSize?: number }[] };
}

export const personalizationSuite: Suite = {
  name: 'personalization',
  title: 'registry personalisation (.reg) and the Windows Terminal PowerShell 7 profile',
  run: (t) => {
    t.section('registry values');
    const reg = toRegFile([
      { key: 'Control Panel\\Desktop', name: 'WallpaperStyle', kind: 'String', value: '10' },
      { key: 'X', name: 'D', kind: 'DWord', value: 4294967295 },
      { key: 'X', name: 'B', kind: 'Binary', value: Buffer.from([1, 255]).toString('base64') },
    ]);
    t.check(
      reg.includes('[HKEY_CURRENT_USER\\Control Panel\\Desktop]') &&
        reg.includes('"WallpaperStyle"="10"') &&
        reg.includes('"D"=dword:ffffffff') &&
        reg.includes('"B"=hex:01,ff'),
      'the .reg file only writes under HKCU: strings as strings, DWORDs and binary as hex',
    );

    t.section('Windows Terminal profile');
    const shown = withPwshProfile({ theme: 'dark', profiles: { defaults: { font: {} } } }, true);
    const shownProfiles = shown?.profiles as { list: Record<string, unknown>[]; defaults?: unknown } | undefined;
    const oldForm = withPwshProfile({ profiles: [{ guid: 'a' }] }, true)?.profiles as { list: unknown[] };
    t.check(
      shownProfiles?.list.length === 1 &&
        shownProfiles.list[0].guid === PWSH_PROFILE_GUID &&
        String(shownProfiles.list[0].commandline).includes('pwsh.exe') &&
        Boolean(shownProfiles.defaults) &&
        shown?.theme === 'dark' &&
        oldForm.list.length === 2,
      'a PowerShell 7 profile (our GUID, starts pwsh.exe) is added once pwsh is installed; settings kept; old array form works',
    );
    t.check(
      withPwshProfile(shown!, true) === null && withPwshProfile({ profiles: { defaults: {} } }, false) === null,
      'nothing is rewritten when the profile is already there or pwsh was never wanted',
    );

    const edited = {
      profiles: { list: [{ guid: 'other' }, { guid: PWSH_PROFILE_GUID.toUpperCase(), name: 'My pwsh', fontSize: 14 }] },
    };
    const hidden = withPwshProfile(edited, false)?.profiles as { list: Record<string, unknown>[] } | undefined;
    t.equal(
      {
        hidden: hidden?.list[1].hidden,
        name: hidden?.list[1].name,
        fontSize: hidden?.list[1].fontSize,
        count: hidden?.list.length,
      },
      { hidden: true, name: 'My pwsh', fontSize: 14, count: 2 },
      "turning pwsh off hides the profile and keeps the user's edits",
    );

    t.section('Windows Terminal settings.json on disk (JSONC, temp copy)');
    const data = t.at('wt-data');
    const settings = t.write(
      path.join(data, 'tools', 'terminal', 'settings', 'settings.json'),
      '// edited in the sandbox\n{ "theme": "light", "profiles": { "list": [{ "guid": "{x}", }] } }',
    );
    const read = (): TerminalSettings => JSON.parse(fs.readFileSync(settings, 'utf8')) as TerminalSettings;
    syncPwshProfile(data, true);
    const untouched = fs.readFileSync(settings, 'utf8');
    t.check(
      untouched.startsWith('// edited') &&
        /"guid": "\{x\}",\s*\}/.test(untouched) &&
        /"reloadEnvironmentVariables":\s*true/.test(untouched) &&
        /"copyOnSelect":\s*true/.test(untouched),
      'until pwsh is installed only the default switches are added (comments and trailing commas survive)',
    );
    t.write(path.join(data, 'tools', 'pwsh', 'pwsh.exe'), 'MZ');
    syncPwshProfile(data, true);
    const added = read();
    t.equal(
      { theme: added.theme, guids: added.profiles.list.map((p) => p.guid) },
      { theme: 'light', guids: ['{x}', PWSH_PROFILE_GUID] },
      "once pwsh is installed the profile is added after the existing ones and the user's settings are kept",
    );
    syncPwshProfile(data, false);
    const hiddenAfter = read().profiles.list[1].hidden;
    t.write(settings, '{ not json');
    syncPwshProfile(data, true);
    t.check(
      hiddenAfter === true && fs.readFileSync(settings, 'utf8') === '{ not json',
      'the profile is hidden when pwsh is turned off; an unreadable settings file is left alone',
    );
  },
};

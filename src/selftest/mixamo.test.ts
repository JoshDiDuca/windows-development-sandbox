// Mixamo: the browser policy table (downloads folder, no GPU) and the guide's Mixamo lines and editor names.
import { browserPolicies } from '../shared/browser-policy.js';
import { unrealGuideLines } from '../shared/unreal/guide.js';
import type { UnrealStatus } from '../shared/unreal/status.js';
import type { Suite } from './support/suite.js';

const DOWNLOADS = 'C:\\AgentData\\downloads';
const PROJECT = { workspace: 'C:\\P\\Game', uproject: 'C:\\P\\Game\\Game.uproject' };

function statusWith(version: string): UnrealStatus {
  return {
    updatedAt: 'now',
    engines: [
      {
        id: 'UE_' + version,
        dir: 'C:\\E',
        version,
        build: 'installed',
        origin: 'pc',
        writable: true,
        sizeBytes: null,
      },
    ],
    projects: [{ workspace: PROJECT.workspace, engine: 'C:\\E', reason: 'test' }],
    launcher: { installed: false, exe: null, installLocation: null, problem: null, freeBytes: null, needBytes: 1 },
    visualStudio: { version: '17.14', path: 'C:/VS', how: 'kept', check: 'ok', ok: true },
    debugger: null,
    ddc: { mode: 'persisted', dir: null },
    vaults: [],
    mcpUrl: null,
  };
}

export const mixamoSuite: Suite = {
  name: 'mixamo',
  title: 'Mixamo: browser downloads folder and the guide lines for bringing characters into Unreal',
  run: async (t) => {
    t.section('browser policies');
    const four = browserPolicies({ downloads: DOWNLOADS });
    t.equal(four.length, 4, 'two browsers, two policies each');
    t.equal(
      four.filter((p) => p.name === 'DefaultDownloadDirectory').map((p) => p.data),
      [DOWNLOADS, DOWNLOADS],
      'both browsers download to the data disk',
    );
    t.equal(browserPolicies({ downloads: null }).length, 2, 'no folder: only the GPU policy');
    await t.throws(() => browserPolicies({ downloads: 'C:\\a"b' }), 'not a folder', 'a quote in the folder is refused');
    await t.throws(() => browserPolicies({ downloads: 'downloads' }), 'not a folder', 'a relative folder is refused');

    t.section('the guide');
    const on = { mixamo: { downloads: DOWNLOADS, script: null } };
    const guide = unrealGuideLines(statusWith('5.4.4'), [PROJECT], on).join('\n');
    t.includes(guide, 'https://www.mixamo.com', 'the Mixamo line is there');
    t.includes(guide, DOWNLOADS, 'it names the downloads folder');
    t.includes(guide, 'Mixamo into Unreal', 'and the import line');
    t.excludes(guide, 'Mixamo import script', 'no script line without a script');
    const withScript = unrealGuideLines(statusWith('5.4.4'), [PROJECT], {
      mixamo: { downloads: DOWNLOADS, script: 'C:\\x\\import_mixamo.py' },
    }).join('\n');
    t.includes(withScript, 'Mixamo import script', 'a script adds its line');
    t.excludes(unrealGuideLines(statusWith('5.4.4'), [PROJECT]).join('\n'), 'Mixamo', 'off by default');
    const noEngine = { ...statusWith('5.4.4'), engines: [] };
    t.excludes(unrealGuideLines(noEngine, [PROJECT], on).join('\n'), 'Mixamo', 'no engine: no Mixamo lines');

    t.section('UE4 names');
    const ue4 = unrealGuideLines(statusWith('4.27.2'), [PROJECT]).join('\n');
    t.includes(ue4, 'UE4Editor-Cmd.exe', 'a UE4 engine uses UE4Editor-Cmd.exe');
    t.excludes(ue4, 'UnrealEditor', 'and not the UE5 names');
    t.includes(
      unrealGuideLines(statusWith('5.4.4'), [PROJECT]).join('\n'),
      'UnrealEditor-Cmd.exe',
      'UE5 keeps its names',
    );
  },
};

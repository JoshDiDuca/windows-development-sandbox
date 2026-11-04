// A made-up Unreal overview (a PC engine read-only, a launcher engine on the data disk, a registered source build, the
// vault's packs), for the menu screens, the ui-text checks and the Unreal page tests.
import type { UnrealOverview } from '../../app/features/unreal/index.js';

export const UNREAL_SAMPLE: UnrealOverview = {
  setUp: true,
  checkedAt: '2026-11-04T12:00:00.000Z',
  engines: [
    {
      id: 'UE_5.6',
      version: '5.6.1',
      dir: 'C:\\PcInstalls\\unreal\\UE_5.6',
      where: 'this PC, read-only',
      writable: false,
      build: 'installed',
      sizeBytes: null,
      projects: ['ShooterGame'],
    },
    {
      id: 'UE_5.4',
      version: '5.4.4',
      dir: 'C:\\AgentData\\tools\\unreal\\engines\\UE_5.4',
      where: 'Epic Games Launcher, data disk',
      writable: true,
      build: 'installed',
      sizeBytes: 48 * 1024 ** 3,
      projects: [],
    },
  ],
  projects: [{ project: 'ShooterGame', engine: 'UE_5.6', reason: 'the project asks for 5.6' }],
  launcher: {
    installed: true,
    installLocation: 'C:\\AgentData\\tools\\unreal\\engines',
    problem: null,
    free: '812 GB',
  },
  visualStudio: {
    version: '17.14.37827.9',
    path: 'C:\\AgentData\\tools\\visualstudio\\persist\\Community',
    how: 'kept on the data disk',
    check: 'Visual Studio 17.14.37827.9, MSVC 14.44.35207, Windows SDK 10.0.22621.0',
    ok: true,
  },
  debugger: 'C:\\AgentData\\tools\\visualstudio\\persist\\WindowsKits10\\Debuggers\\x64\\cdb.exe',
  ddc: 'C:\\AgentData\\tools\\unreal\\ddc',
  mcpUrl: null,
  pc: {
    setting: 'auto',
    engines: [
      { id: 'UE_5.6', name: 'Unreal Engine 5.6.1', folder: 'C:\\Program Files\\Epic Games\\UE_5.6', writable: false },
      {
        id: 'dir-UnrealEngine',
        name: 'Unreal Engine 5.7.0 (UnrealEngine)',
        folder: 'D:\\Src\\UnrealEngine',
        writable: true,
      },
    ],
    problem: null,
  },
  vault: {
    setting: 'auto',
    folders: [
      {
        folder: 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\VaultCache',
        packs: [
          { name: 'CityParkEnvironment', size: '2.1 GB', kind: 'content' },
          { name: 'ToolkitPlugin', size: '45 MB', kind: 'plugin' },
        ],
        more: 0,
      },
    ],
  },
  settings: {
    enabled: 'auto',
    acceptLicense: true,
    persistEngines: true,
    derivedDataCache: 'persisted',
    visualStudio: 'full',
  },
};

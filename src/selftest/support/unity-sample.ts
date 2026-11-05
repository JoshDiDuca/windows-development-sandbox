// A made-up Unity overview (a PC editor read-only, a data-disk editor, a project with the bridge, the licence, the
// Asset Store packages), for the menu screens and the Unity page tests.
import type { UnityOverview } from '../../app/features/unity/index.js';

export const UNITY_SAMPLE: UnityOverview = {
  setUp: true,
  checkedAt: '2026-11-05T12:00:00.000Z',
  cli: { version: '1.0.0-beta.16', path: 'C:\\AgentData\\tools\\unity\\cli\\1.0.0-beta.16\\unity.exe' },
  editors: [
    {
      version: '6000.0.58f2',
      dir: 'C:\\PcInstalls\\unity\\6000.0.58f2',
      where: 'this PC, read-only',
      writable: false,
      modules: ['android'],
      sizeBytes: null,
      projects: ['Platformer'],
    },
    {
      version: '2022.3.20f1',
      dir: 'C:\\AgentData\\tools\\unity\\editors\\2022.3.20f1',
      where: 'the data disk, kept between sandboxes',
      writable: true,
      modules: [],
      sizeBytes: 9 * 1024 ** 3,
      projects: ['OldGame'],
    },
  ],
  projects: [
    {
      project: 'Platformer',
      folder: 'F:\\Code\\Platformer',
      version: '6000.0.58f2',
      editor: 'Unity 6000.0.58f2',
      reason: 'the project asks for 6000.0.58f2',
      bridge: 'pipeline',
      pipeline: true,
    },
    {
      project: 'OldGame',
      folder: 'F:\\Code\\OldGame',
      version: '2022.3.20f1',
      editor: 'Unity 2022.3.20f1',
      reason: 'the project asks for 2022.3.20f1',
      bridge: null,
      pipeline: false,
    },
  ],
  licence: { state: 'active', kind: 'Personal', detail: 'Unity Personal', user: 'dev@example.com' },
  hub: { installed: false, setting: false },
  assetCache: { mode: 'persisted', dir: 'C:\\AgentData\\tools\\unity\\asset-store' },
  agentTools: { cliVersion: '1.0.0-beta.16', mcp: 'sbx-unity', mcpSetting: true, skills: true, skillsSetting: true },
  pc: {
    setting: 'auto',
    editors: [{ version: '6000.0.58f2', folder: 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.0.58f2' }],
    problem: null,
  },
  assets: {
    setting: 'auto',
    folders: [
      {
        folder: 'C:\\Users\\dev\\AppData\\Roaming\\Unity\\Asset Store-5.x',
        packages: [
          { publisher: 'Kenney', category: '2D', name: 'Platformer Pack', size: '120 MB' },
          { publisher: 'Synty Studios', category: '3D Models', name: 'POLYGON Fantasy', size: '1.4 GB' },
        ],
        more: 0,
      },
    ],
  },
  problem: null,
  settings: {
    enabled: 'auto',
    acceptLicense: true,
    version: 'project',
    modules: 'none',
    hub: false,
    keepVersions: 2,
    mcp: true,
    agentSkills: true,
    cliVersion: '1.0.0-beta.16',
    assetCache: 'persisted',
  },
};

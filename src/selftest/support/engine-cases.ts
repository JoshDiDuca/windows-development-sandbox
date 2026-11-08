// Representative sandbox settings and mappings for the engine tests: the .wsb each produces is compared with the text
// the code before the engine layer wrote (engine-golden.ts).
import type { Config, ResolvedMapping } from '../../core/types.js';
import { DEFAULTS } from '../../core/config/index.js';

export interface EngineCase {
  readonly name: string;
  readonly config: Config;
  readonly memoryMb: number;
  readonly mappings: readonly ResolvedMapping[];
}

const BASE: readonly ResolvedMapping[] = [
  { host: 'C:\\L\\launches\\1', guest: 'C:\\AgentLaunch', readOnly: true },
  { host: 'C:\\S\\data\\default', guest: 'C:\\AgentData', readOnly: false },
  { host: 'C:\\Work\\app', guest: 'C:\\Workspace\\app', readOnly: false },
];

function withSandbox(change: Partial<Config['sandbox']>): Config {
  const config = structuredClone(DEFAULTS);
  Object.assign(config.sandbox, change);
  return config;
}

export const ENGINE_CASES: readonly EngineCase[] = [
  { name: 'default', config: withSandbox({}), memoryMb: 8192, mappings: BASE },
  { name: 'vGpu on', config: withSandbox({ vGpu: true }), memoryMb: 8192, mappings: BASE },
  { name: 'networking off', config: withSandbox({ networking: false }), memoryMb: 4096, mappings: BASE },
  {
    name: 'several projects and roots',
    config: withSandbox({}),
    memoryMb: 16384,
    mappings: [
      ...BASE,
      { host: 'C:\\Work\\one', guest: 'C:\\Projects\\Work\\one', readOnly: false },
      { host: 'C:\\Work\\two', guest: 'C:\\Projects\\Work\\two', readOnly: false },
      { host: 'D:\\Roots\\r', guest: 'C:\\Projects\\r', readOnly: false },
    ],
  },
  {
    name: 'read-only workspace and extra folders',
    config: withSandbox({}),
    memoryMb: 8192,
    mappings: [
      BASE[0],
      BASE[1],
      { host: 'C:\\Work\\app', guest: 'C:\\Workspace\\app', readOnly: true },
      { host: 'C:\\Data', guest: 'C:\\Assets', readOnly: true, label: 'outside the project, allowed' },
    ],
  },
  {
    name: 'mirror paths on another drive and escaped characters',
    config: withSandbox({}),
    memoryMb: 6144,
    mappings: [
      ...BASE,
      { host: 'F:\\Games\\a&b <x>', guest: 'F:\\SteamLibrary\\steamapps\\common\\Game', readOnly: true },
    ],
  },
  {
    name: 'memory 2048 and protectedClient off',
    config: withSandbox({ protectedClient: false }),
    memoryMb: 2048,
    mappings: BASE,
  },
  {
    name: 'every device on',
    config: withSandbox({
      vGpu: true,
      clipboard: 'shared',
      audioInput: true,
      videoInput: true,
      printerRedirection: true,
    }),
    memoryMb: 12288,
    mappings: BASE,
  },
  {
    name: 'clipboard text with protectedClient off',
    config: withSandbox({ clipboard: 'text', protectedClient: false }),
    memoryMb: 8192,
    mappings: BASE,
  },
  {
    name: 'every device off',
    config: withSandbox({ clipboard: 'off', networking: false, protectedClient: false }),
    memoryMb: 8192,
    mappings: [BASE[0], BASE[1]],
  },
];

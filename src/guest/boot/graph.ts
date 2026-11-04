// The boot as a graph of tasks (docs/design/parallel-boot.md): what each does, which stage of the nine it shows under,
// what it must wait for, and which shared boot state it writes or reads (each field has exactly one writer, and a
// reader waits for it, directly or through other tasks). Pure: the graph test and the web bundle may import it.
import type { BootTaskDef } from './runner.js';

export const STAGES = 9;

/** Who the stage titles name. */
export interface StageWho {
  readonly vpnServer?: string;
  readonly agent?: string;
}

/** The titles of the nine stages, with a note where one helps (the host's status message). */
export function stageTitle(stage: number, who: StageWho = {}): string {
  return stage === 3
    ? stageName(stage, who) + ' (the first start downloads them once; later starts are quick)'
    : stageName(stage, who);
}

/** The short titles of the nine stages: the console's stage rows and the host's progress line. */
export function stageName(stage: number, who: StageWho = {}): string {
  switch (stage) {
    case 1:
      return 'Network and session host';
    case 2:
      return 'Pre-provision hooks and desktop';
    case 3:
      return 'Developer tools';
    case 4:
      return who.vpnServer ? 'VPN (' + who.vpnServer + ')' : 'VPN (off)';
    case 5:
      return 'Git identity';
    case 6:
      return 'Claude settings, history and claude-mem';
    case 7:
      return 'Agent: ' + (who.agent ?? 'none');
    case 8:
      return 'Pre-agent hooks';
    default:
      return 'Starting ' + (who.agent ?? 'the agent');
  }
}

/** The boot state the tasks share. */
export type BootStateKey =
  | 'ptyHost'
  | 'lan'
  | 'tools'
  | 'dbBin'
  | 'allowSummary'
  | 'vscodeSummary'
  | 'env'
  | 'toolVars'
  | 'summary'
  | 'headroom'
  | 'later';

export interface BootTaskInfo {
  readonly writes: readonly BootStateKey[];
  readonly reads: readonly BootStateKey[];
}

export const BOOT_TASKS = [
  // Stage 1 - network and session host
  { id: 'ptyhost', stage: 1, title: 'Session host', after: [], critical: false, writes: ['ptyHost'], reads: [] },
  {
    id: 'network',
    stage: 1,
    title: 'Private-network blocking',
    after: ['ptyhost'],
    critical: false,
    writes: ['lan'],
    reads: ['ptyHost'],
  },
  { id: 'audit', stage: 1, title: 'Process audit', after: [], critical: false, writes: [], reads: [] },
  // Stage 2 - pre-provision hooks and desktop
  {
    id: 'hooksPreProvision',
    stage: 2,
    title: 'Pre-provision hooks',
    after: ['network'],
    critical: true,
    writes: [],
    reads: [],
  },
  { id: 'desktop', stage: 2, title: 'Personalisation', after: [], critical: false, writes: [], reads: [] },
  { id: 'browserGpu', stage: 2, title: 'Browsers without the GPU', after: [], critical: false, writes: [], reads: [] },
  // Stage 3 - developer tools
  {
    id: 'toolchains',
    stage: 3,
    title: 'Developer tools',
    after: ['network', 'hooksPreProvision'],
    critical: true,
    writes: ['tools'],
    reads: [],
  },
  { id: 'dbCommands', stage: 3, title: 'Tool commands', after: [], critical: true, writes: ['dbBin'], reads: [] },
  {
    id: 'allowOnly',
    stage: 3,
    title: 'Network: allow only some hosts',
    after: ['toolchains'],
    critical: false,
    writes: ['allowSummary'],
    reads: [],
  },
  {
    id: 'vscode',
    stage: 3,
    title: 'VS Code setup',
    after: ['toolchains', 'allowOnly'],
    critical: false,
    writes: ['vscodeSummary'],
    reads: ['tools'],
  },
  {
    id: 'env',
    stage: 3,
    title: 'Environment',
    after: ['toolchains', 'dbCommands', 'allowOnly'],
    critical: true,
    writes: ['env', 'toolVars'],
    reads: ['tools', 'dbBin'],
  },
  {
    id: 'bootEnv',
    stage: 3,
    title: 'Boot summary files',
    after: ['env', 'vscode'],
    critical: false,
    writes: ['summary'],
    reads: ['tools', 'toolVars', 'lan', 'allowSummary', 'vscodeSummary'],
  },
  // Stage 4 - VPN
  {
    id: 'vpn',
    stage: 4,
    title: 'VPN',
    after: ['toolchains', 'allowOnly', 'ptyhost'],
    critical: false,
    writes: [],
    reads: ['ptyHost'],
  },
  // Stage 5 - git
  {
    id: 'gitConfig',
    stage: 5,
    title: 'Git config',
    after: ['env'],
    critical: false,
    writes: [],
    reads: ['env'],
  },
  {
    id: 'githubLogin',
    stage: 5,
    title: 'GitHub token',
    after: ['vpn', 'gitConfig'],
    critical: false,
    writes: [],
    reads: ['env'],
  },
  // Stage 6 - Claude settings
  { id: 'claudeProfile', stage: 6, title: 'Claude settings', after: [], critical: false, writes: [], reads: [] },
  { id: 'claudeMem', stage: 6, title: 'claude-mem restore', after: [], critical: false, writes: [], reads: [] },
  { id: 'agentState', stage: 6, title: 'Agent state', after: [], critical: false, writes: [], reads: [] },
  {
    id: 'headroomSpawn',
    stage: 6,
    title: 'Headroom start',
    after: ['network'],
    critical: false,
    writes: [],
    reads: [],
  },
  {
    id: 'mcpServers',
    stage: 6,
    title: 'MCP servers from Apps',
    after: ['toolchains', 'claudeProfile'],
    critical: false,
    writes: [],
    reads: [],
  },
  {
    id: 'headroomReady',
    stage: 6,
    title: 'Headroom proxy',
    after: ['headroomSpawn', 'toolchains'],
    critical: false,
    writes: ['headroom'],
    reads: [],
  },
  {
    id: 'managedSettings',
    stage: 6,
    title: 'Claude managed settings',
    after: ['headroomReady', 'toolchains'],
    critical: false,
    writes: [],
    reads: ['headroom'],
  },
  {
    id: 'guide',
    stage: 6,
    title: 'Sandbox guide for the agent',
    after: ['bootEnv', 'managedSettings', 'mcpServers', 'network', 'vscode'],
    critical: false,
    writes: [],
    reads: ['summary', 'lan'],
  },
  // Stage 7 - agent
  // After the agent state is restored (both work in the persistent state folders).
  { id: 'profileLinks', stage: 7, title: 'Agent logins', after: ['agentState'], critical: true, writes: [], reads: [] },
  {
    id: 'agentProvision',
    stage: 7,
    title: 'Agent install',
    after: ['env', 'vpn', 'profileLinks'],
    critical: true,
    writes: [],
    reads: ['env'],
  },
  // Stage 8 - pre-agent hooks: after every foreground task (the hooks inherit the terminal)
  {
    id: 'hooksPreAgent',
    stage: 8,
    title: 'Pre-agent hooks',
    after: [
      'ptyhost',
      'network',
      'audit',
      'hooksPreProvision',
      'desktop',
      'browserGpu',
      'toolchains',
      'dbCommands',
      'allowOnly',
      'vscode',
      'env',
      'bootEnv',
      'vpn',
      'gitConfig',
      'githubLogin',
      'claudeProfile',
      'claudeMem',
      'agentState',
      'headroomSpawn',
      'mcpServers',
      'headroomReady',
      'managedSettings',
      'guide',
      'profileLinks',
      'agentProvision',
    ],
    critical: true,
    exclusive: true,
    writes: [],
    reads: ['env'],
  },
  // Stage 9 - start
  {
    id: 'session',
    stage: 9,
    title: 'Session',
    after: ['hooksPreAgent'],
    critical: true,
    writes: [],
    reads: ['env'],
  },
  // Background: after the first session runs
  {
    id: 'toolchainsLater',
    stage: 3,
    title: 'Visual Studio and what needs it',
    after: ['session'],
    critical: false,
    background: true,
    writes: ['later'],
    reads: ['tools', 'env', 'toolVars', 'lan'],
  },
  {
    id: 'prune',
    stage: 3,
    title: 'Cleaning old tool builds',
    after: ['session'],
    critical: false,
    background: true,
    writes: [],
    reads: [],
  },
] as const satisfies readonly (BootTaskDef & BootTaskInfo)[];

export type BootTaskId = (typeof BOOT_TASKS)[number]['id'];

/** The graph as the runner takes it (mutable arrays, ids widened). */
export const BOOT_DEFS: readonly BootTaskDef<BootTaskId>[] = BOOT_TASKS;

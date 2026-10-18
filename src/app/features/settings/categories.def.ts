// How the settings are grouped on every surface: categories (the menu's navigation, the web's tabs), readable names for
// sections and toolchains, and plain words for settings whose key is jargon. Every top-level setting of both files must
// belong to a category or be covered by another section (a self-test checks it), so nothing is ever hidden. Pure.
import { humanize } from '../../kernel/index.js';

export interface SettingsCategory {
  id: string;
  label: string;
  description: string;
  keys: string[];
}

export const CATEGORIES: SettingsCategory[] = [
  {
    id: 'general',
    label: 'General',
    description:
      'Which agent starts, where the project appears in the sandbox, extra folders from this PC, and where the sandbox keeps its data.',
    keys: ['defaultHarness', 'harness', 'guestWorkspace', 'readOnly', 'mappings', 'scripts'],
  },
  {
    id: 'machine',
    label: 'Sandbox machine',
    description:
      'Memory, CPU, window, GPU, clipboard, audio and networking of the sandbox itself, and its desktop look (theme, accent colour, taskbar, wallpaper).',
    keys: ['sandbox', 'personalization'],
  },
  {
    id: 'languages',
    label: 'Languages & tools',
    description: 'Toolchains installed in the sandbox. "auto" follows the files of your project and what this PC has.',
    keys: ['toolchains'],
  },
  {
    id: 'databases',
    label: 'Databases',
    description: 'Databases that run inside the sandbox. Their data persists between sandboxes.',
    keys: ['databases'],
  },
  {
    id: 'agents',
    label: 'Agents & sessions',
    description:
      'The agents you can start (also: Agents section), attaching your terminal to them, the (Beta) web UI and agent commands, which of your Claude settings are copied in, and reopening sessions.',
    keys: ['harnesses', 'attach', 'web', 'agentCommands', 'claudeProfile', 'resume'],
  },
  {
    id: 'network',
    label: 'Network',
    description:
      'What the sandbox can reach: your LAN, only some hosts, blocked hosts, DNS, a proxy, ports forwarded from this PC to servers inside, and a VPN (with a login set here). (No network at all: Sandbox machine > Networking.)',
    keys: ['network', 'vpn'],
  },
  {
    id: 'security',
    label: 'Security & privacy',
    description:
      'Git-ignored files kept out, secrets kept out of the sandbox, download checks, what is kept on this PC, and sharing your sandbox with other Windows users.',
    keys: ['workspaceFilter', 'audit', 'secrets', 'downloads', 'storage', 'sharing'],
  },
  {
    id: 'projects',
    label: 'Projects & setup',
    description:
      'Several projects in one sandbox (roots mapped at every start, adding folders while it runs), how tools get into the sandbox (copied from this PC or downloaded), Git, the terminal, and hook scripts.',
    keys: ['projects', 'provisioning', 'hooks'],
  },
];

/** Settings not listed here because their own section covers them (Apps: the catalogue and your own programs). */
export const SETTINGS_ELSEWHERE: readonly string[] = ['apps'];

/** Readable names for sections and toolchains (anything missing gets a name made from its key). */
const NAMES: Record<string, string> = {
  sandbox: 'Sandbox machine',
  attach: 'Attaching your terminal',
  agentCommands: 'Agent commands (Beta)',
  web: 'Web UI (Beta)',
  provisioning: 'Provisioning',
  downloads: 'Downloads',
  secrets: 'Secrets',
  claudeProfile: 'Claude profile',
  storage: 'Storage on this PC',
  network: 'Network',
  vpn: 'VPN',
  hooks: 'Hooks',
  personalization: 'Desktop look',
  projects: 'Projects',
  resume: 'Reopening sessions',
  harnesses: 'Agents',
  databases: 'Databases',
  toolchains: 'Toolchains',
  git: 'Git',
  terminal: 'Windows Terminal',
  conpty: 'Pseudo console',
  node: 'Node.js',
  python: 'Python',
  java: 'Java (JDK)',
  dotnet: '.NET',
  go: 'Go',
  rust: 'Rust',
  cpp: 'C / C++ (MinGW)',
  msvc: 'Visual C++ (MSVC)',
  ruby: 'Ruby',
  php: 'PHP',
  deno: 'Deno',
  bun: 'Bun',
  pwsh: 'PowerShell 7',
  vscode: 'VS Code',
  mesa: 'OpenGL (Mesa)',
  uv: 'uv',
  pnpm: 'pnpm',
  yarn: 'Yarn',
  cli: 'Command-line tools',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mongodb: 'MongoDB',
  redis: 'Redis',
  dynamodb: 'DynamoDB Local',
  environment: 'Environment variables',
  workspaceFilter: 'Git-ignored files',
  audit: 'Audit log',
};

export function nameOf(key: string): string {
  return NAMES[key] ?? humanize(key);
}

export function categoryOf(topKey: string): SettingsCategory | undefined {
  return CATEGORIES.find((c) => c.keys.includes(topKey));
}

/** Plain words for settings whose key is jargon (the key itself stays in the details). */
const LABELS: Readonly<Record<string, string>> = {
  mappings: 'Extra folders from this PC',
  'sandbox.vGpu': 'Graphics acceleration',
  'sandbox.headless': 'Hide the sandbox window',
  'sandbox.memoryMb': 'Memory (MB)',
  'sandbox.pageFileMb': 'Swap file (MB)',
  'sandbox.agentMemoryHeadroomMb': 'Memory kept free from agents (MB)',
  'sandbox.pressureResponse': 'Slow builds down when memory runs low',
  'network.dns': 'DNS servers',
  'projects.wsbShare': 'Add folders while the sandbox runs',
  'projects.all': 'Map all known projects at start',
  'claudeProfile.hostDir': 'Claude folder on this PC',
  'claudeProfile.globalStateFile': 'Claude state file on this PC',
};

/** The label of a setting. */
export function labelOf(key: readonly string[]): string {
  return LABELS[key.join('.')] ?? humanize(key[key.length - 1]);
}

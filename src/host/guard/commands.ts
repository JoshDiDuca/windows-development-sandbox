import { filesIn } from './file-hash.js';
import { quarantine } from './quarantine.js';
import type { GuardRule, RepoFinding, RepoSnapshot } from './types.js';

/** What cmd runs from the current folder: a fixed list plus this PC's PATHEXT (the Python installer adds .PY, .PYW). */
const EXTENSIONS = [
  ...new Set([
    ...['exe', 'com', 'bat', 'cmd', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'msc', 'ps1', 'cpl'],
    ...(process.env.PATHEXT ?? '')
      .split(';')
      .map((e) => e.replace(/^\./, '').toLowerCase())
      .filter((e) => /^[a-z0-9]{1,8}$/.test(e)),
  ]),
];

/** Names you are likely to run in a project folder; with any of these extensions Windows would pick the local copy. */
export const COMMANDS = new RegExp(
  '^(' +
    [
      // this tool's own commands (package.json "bin")
      'sandbox',
      'windows-development-sandbox',
      'agent-sandbox',
      'claude-sbx',
      'claude-sandbox',
      'codex-sbx',
      'codex-sandbox',
      'gemini-sbx',
      'gemini-sandbox',
      'claude-host',
      'sbx-show',
      'sbx-hide',
      // agents
      'claude',
      'codex',
      'gemini',
      'opencode',
      'qwen',
      'crush',
      'copilot',
      'kilo',
      'kilocode',
      'amp',
      'cline',
      'cn',
      'kimi',
      'reasonix',
      'codewhale',
      'aider',
      'cursor-agent',
      'agent',
      'goose',
      // toolchains and everyday tools
      'node',
      'npm',
      'npx',
      'pnpm',
      'pnpx',
      'yarn',
      'corepack',
      'volta',
      'nvm',
      'deno',
      'bun',
      'bunx',
      'tsc',
      'git',
      'gh',
      'code',
      'python',
      'python3',
      'py',
      'pip',
      'pip3',
      'uv',
      'uvx',
      'pyenv',
      'poetry',
      'cargo',
      'rustc',
      'rustup',
      'dotnet',
      'nuget',
      'msbuild',
      'go',
      'java',
      'javac',
      'mvn',
      'mvnw',
      'gradle',
      'gradlew',
      'ruby',
      'gem',
      'bundle',
      'rake',
      'rails',
      'php',
      'composer',
      'make',
      'cmake',
      'ninja',
      'gcc',
      'g\\+\\+',
      'clang',
      'psql',
      'mysql',
      'mariadb',
      'mongosh',
      'redis-cli',
      'docker',
      'kubectl',
      'terraform',
      'az',
      'aws',
      'powershell',
      'pwsh',
      'cmd',
      'where',
      'tasklist',
      'tar',
      'curl',
      'ssh',
      'scp',
    ].join('|') +
    ')\\.(' +
    EXTENSIONS.join('|') +
    ')$',
  'i',
);

/** Fingerprints of the files in the project root named like one of COMMANDS. */
export function plantedCommands(workspace: string): Record<string, string> {
  return filesIn(workspace, (n) => COMMANDS.test(n));
}

/** Executables dropped in the project root under the name of something you type there (Windows runs those first). */
export class PlantedCommandsRule implements GuardRule {
  readonly kind = 'commands';

  check(workspace: string, before: RepoSnapshot): RepoFinding[] {
    const now = plantedCommands(workspace);
    return quarantine(
      workspace,
      Object.keys(now).filter((n) => before.commands[n] !== now[n]),
      workspace,
      'command',
    );
  }
}

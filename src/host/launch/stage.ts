// What is copied into the launch folder (C:\AgentLaunch inside the sandbox): hooks, the bundled runtime, the git
// identity.
import fs from 'node:fs';
import path from 'node:path';
import { userDir } from '../../core/config/index.js';
import { dirExists, ensureDir, fail, fileExists, homeDir } from '../../core/util/index.js';

const HOOK_STAGES = ['pre-provision', 'pre-agent', 'post-agent'] as const;

/** Package hooks first, then ~/.agent-sandbox/hooks (same file name = user's wins), then --script / "scripts". */
export function stageHooks(packageRoot: string, launchPath: string, scripts: readonly string[]): void {
  for (const stage of HOOK_STAGES) {
    const target = path.join(launchPath, 'hooks', stage);
    ensureDir(target);
    for (const source of [path.join(packageRoot, 'hooks', stage), path.join(userDir(), 'hooks', stage)]) {
      if (dirExists(source)) fs.cpSync(source, target, { recursive: true, force: true });
    }
  }
  stageScripts(path.join(launchPath, 'hooks', 'pre-agent'), scripts);
}

const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;

/** --script / "scripts" files, run before the agent in this order. */
export function stageScripts(target: string, scripts: readonly string[]): void {
  ensureDir(target);
  scripts.forEach((script: string, index: number) => {
    if (!fileExists(script)) fail('Script file not found: ' + script, 'Check the --script path.');
    const stat = fs.statSync(script);
    if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES)
      fail('Script ' + script + ' is not a plain file of at most 4 MB.', 'Check the --script path.');
    fs.copyFileSync(script, path.join(target, '90-extra-' + index + '-' + path.basename(script)));
  });
}

export const RUNTIME_FILES = ['main.js', 'daemon.js', 'view.js', 'gitguard.js', 'db.js', 'netproxy.js', 'agent.js'];

/** The bundled sandbox runtime (dist/runtime: one self-contained file per entry point) and the sandbox/ scripts. */
export function copyRuntime(packageRoot: string, launchPath: string): void {
  const runtime = path.join(packageRoot, 'dist', 'runtime');
  const missing = RUNTIME_FILES.filter((f) => !fileExists(path.join(runtime, f)));
  if (missing.length)
    fail(
      'The sandbox runtime is missing from ' + runtime + ' (' + missing.join(', ') + ').',
      'Rebuild it: npm run build (or reinstall the package).',
    );
  ensureDir(path.join(launchPath, 'runtime'));
  for (const file of RUNTIME_FILES) fs.copyFileSync(path.join(runtime, file), path.join(launchPath, 'runtime', file));
  fs.writeFileSync(path.join(launchPath, 'package.json'), '{ "type": "module" }\n', 'utf8');
  fs.cpSync(path.join(packageRoot, 'sandbox'), path.join(launchPath, 'sandbox'), { recursive: true });
}

/** Only the identity from ~/.gitconfig: the rest can hold credentials (helpers, tokens in insteadOf URLs). */
export function gitIdentity(gitconfig: string): string {
  const values: Record<string, string> = {};
  let section = '';
  for (const line of gitconfig.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      section = header[1].trim().toLowerCase();
      continue;
    }
    const pair = /^\s*(name|email)\s*=\s*(.*?)\s*$/i.exec(line);
    if (section === 'user' && pair && !/[\r\n]/.test(pair[2]))
      values[pair[1].toLowerCase()] = pair[2].replace(/^"(.*)"$/, '$1');
  }
  const lines = Object.entries(values).map(([k, v]) => '\t' + k + ' = ' + v);
  return lines.length ? '[user]\n' + lines.join('\n') + '\n' : '';
}

/** Writes this PC's git name and email to home\.gitconfig in the launch folder (nothing when there are none). */
export function stageGitIdentity(launchPath: string): void {
  const gitconfig = path.join(homeDir(), '.gitconfig');
  const identity = fileExists(gitconfig) ? gitIdentity(fs.readFileSync(gitconfig, 'utf8')) : '';
  if (!identity) return;
  ensureDir(path.join(launchPath, 'home'));
  fs.writeFileSync(path.join(launchPath, 'home', '.gitconfig'), identity, 'utf8');
}

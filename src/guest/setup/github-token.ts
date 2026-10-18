// The GitHub token the host handed over (github.shareToken, only with git access "full"): gh logs in with it in a
// folder on the sandbox's own disk (gone with the sandbox, never in the persistent state), and https git asks gh. The
// token goes to gh on stdin, never in an argument, a file of ours or a log line.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ghLoginCommand, ghOutputText, ghSetupGitCommand, type GhCommand } from '../../shared/github/index.js';
import { deliveredGhConfigDir, ghExePath } from '../toolchains/tools/cli.js';
import { dryRun } from '../runtime/paths.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { log } from '../runtime/log.js';

const GH_TIMEOUT_MS = 60_000;

/**
 * Before the tools are set up: the folder gh uses for a handed-over token exists only when one arrived (gh's setup
 * points GH_CONFIG_DIR at it while it exists). Without one, gh keeps the login you made in the sandbox.
 */
export function prepareGithubFolder(token: string | undefined): boolean {
  const dir = deliveredGhConfigDir();
  fs.rmSync(dir, { recursive: true, force: true });
  if (!token) return false;
  mkdirp(dir);
  return true;
}

function runGh(command: GhCommand, token: string, what: string): void {
  const result = spawnSync(command.file, [...command.args], {
    env: command.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: GH_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(command.input !== undefined ? { input: command.input } : {}),
  });
  if (result.error) throw new Error(what + ' could not run: ' + ghOutputText(result.error.message, token));
  if (result.status !== 0)
    throw new Error(
      what + ' failed: ' + ghOutputText(String(result.stderr ?? '') || String(result.stdout ?? ''), token),
    );
}

/** gh logs in with the token (stdin) in the sandbox-only folder, then https git to github.com asks gh. */
export function loginGithub(token: string, env: NodeJS.ProcessEnv): void {
  if (dryRun) {
    log('(dry run) would log gh in with the GitHub token from your PC');
    return;
  }
  const gh = ghExePath();
  const dir = deliveredGhConfigDir();
  if (!exists(gh) || env.GH_CONFIG_DIR !== dir) {
    log('A GitHub token arrived, but gh is not set up in this sandbox (toolchains.cli.gh), so it is not used.');
    return;
  }
  runGh(ghLoginCommand(gh, dir, token, env), token, 'gh auth login');
  runGh(ghSetupGitCommand(gh, dir, env), token, 'gh auth setup-git');
  log('gh and https git to github.com use the GitHub token from your PC (github.shareToken); the agent can read it.');
}

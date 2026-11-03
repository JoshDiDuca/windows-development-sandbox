// Full Git for Windows (with bash: Claude Code on Windows needs Git Bash). Copied from the host when installed there.
// provisioning.git.access decides what the agent gets: 'full' git, a 'readonly' guarded git, or 'none' (bash only).
import fs from 'node:fs';
import path from 'node:path';
import type { GitAccess } from '../../../core/types.js';
import { downloader, githubAsset, moveIntoPlace, stagingFolder } from '../../../shared/download/index.js';
import { safeRemove } from '../../../shared/io/safe-remove.js';
import { dataDir, dryRun, hostToolsDir, launchDir, toolsDir } from '../../runtime/paths.js';
import { execAsync, execOutput, robocopy } from '../../runtime/process.js';
import { exists, mkdirp } from '../../runtime/fs.js';
import { log, warn } from '../../runtime/log.js';
import { errMsg } from '../../../core/util/errors.js';
import { ensureCompiled } from '../../runtime/csc.js';
import { arch, tool, type ToolEnv } from '../tool-env.js';
import { duringSession } from '../../runtime/project-context.js';

const BLOCKED_HOOKS = [
  'pre-commit',
  'commit-msg',
  'pre-merge-commit',
  'pre-push',
  'pre-rebase',
  'pre-applypatch',
  'applypatch-msg',
] as const;
const posix = (p: string): string => p.replace(/\\/g, '/');

const installPortableGit = async (root: string): Promise<void> => {
  const asset = await githubAsset(
    'git-for-windows/git',
    arch === 'arm64' ? /^PortableGit-[\d.]+-arm64\.7z\.exe$/ : /^PortableGit-[\d.]+-64-bit\.7z\.exe$/,
  );
  const sfx = tool(asset.name);
  log('Downloading Git for Windows (' + asset.name + ', ~60 MB once) ...');
  try {
    await downloader.file(asset.url, sfx, asset.sha256);
    await execAsync(sfx, ['-o' + root, '-y'], { stdio: 'ignore' });
  } finally {
    fs.rmSync(sfx, { force: true });
  }
};

/**
 * readonly / none: a `git` wrapper first on PATH and as a bash function (Git Bash would otherwise find the real
 * git.exe), plus git config from the environment (which repository config cannot override).
 */
const installGuard = (env: ToolEnv, access: Exclude<GitAccess, 'full'>, realGit: string): void => {
  const dir = mkdirp(tool('gitguard'));
  const guard = path.join(launchDir, 'runtime', 'gitguard.js');
  // A real git.exe (programs like Claude Code only look for .exe); a .cmd only if the C# compiler is unavailable.
  // A project added later reuses the boot's: sessions may be running it, and Windows cannot replace a running exe.
  if (duringSession() && (exists(path.join(dir, 'git.exe')) || exists(path.join(dir, 'git.cmd')))) {
    /* keep it */
  } else
    try {
      fs.copyFileSync(ensureCompiled('gitshim'), path.join(dir, 'git.exe'));
      fs.rmSync(path.join(dir, 'git.cmd'), { force: true });
    } catch (e) {
      warn('git guard: falling back to git.cmd (' + errMsg(e) + ')');
      fs.writeFileSync(path.join(dir, 'git.cmd'), '@"' + process.execPath + '" "' + guard + '" %*\r\n');
    }
  fs.writeFileSync(
    path.join(dir, 'bashenv.sh'),
    'git() { "' + posix(process.execPath) + '" "' + posix(guard) + '" "$@"; }\nexport -f git\n',
  );
  env.prepend.unshift(dir);
  Object.assign(env.vars, {
    AGENT_GIT_ACCESS: access,
    AGENT_REAL_GIT: access === 'readonly' ? realGit : '',
    AGENT_GUARD_NODE: process.execPath,
    AGENT_GUARD_SCRIPT: guard,
    BASH_ENV: posix(path.join(dir, 'bashenv.sh')),
  });
  if (access === 'readonly') {
    const hooks = mkdirp(path.join(dir, 'hooks'));
    for (const hook of BLOCKED_HOOKS)
      fs.writeFileSync(
        path.join(hooks, hook),
        '#!/bin/sh\necho "git is read-only in this sandbox: ' + hook + ' refused." >&2\nexit 1\n',
      );
    Object.assign(env.vars, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: posix(hooks),
    });
  } else {
    // Even a git.exe found some other way sees no repository.
    env.vars.GIT_DIR = path.join(dataDir, 'git-disabled');
  }
};

/**
 * Git copied from this PC keeps its installer's absolute paths in etc\gitconfig, e.g. http.sslCAInfo =
 * C:/Program Files/Git/mingw64/etc/ssl/certs/ca-bundle.crt, which does not exist here: every HTTPS clone/fetch failed
 * with "error setting certificate file". Point it at the bundle inside this copy.
 */
const pointAtOwnCertificates = (root: string): void => {
  const config = path.join(root, 'etc', 'gitconfig');
  const bundle = path.join(root, 'mingw64', 'etc', 'ssl', 'certs', 'ca-bundle.crt');
  if (!exists(config) || !exists(bundle)) return;
  const text = fs.readFileSync(config, 'utf8');
  const fixed = text.replace(/^(\s*sslCAInfo\s*=\s*).*$/gim, (_m, key: string) => key + posix(bundle));
  if (fixed !== text) fs.writeFileSync(config, fixed);
};

/**
 * Coreutils' link.exe (hard links) next to MSVC's linker: Git Bash puts its own /usr/bin first on PATH, whatever the
 * Windows PATH says, so a msvc Rust build ran the wrong `link` (os error 1392). Renamed; nobody needs it here.
 */
const hideCoreutilsLink = (usrBin: string): void => {
  const link = path.join(usrBin, 'link.exe');
  if (!exists(link)) return;
  try {
    fs.rmSync(path.join(usrBin, 'link-coreutils.exe'), { force: true });
    fs.renameSync(link, path.join(usrBin, 'link-coreutils.exe'));
  } catch (e) {
    warn("Could not rename Git's coreutils link.exe (MSVC link may be shadowed in Git Bash): " + errMsg(e));
  }
};

export async function setupGit(env: ToolEnv, hostCopy: boolean, refresh: boolean, access: GitAccess): Promise<void> {
  const root = tool('git');
  const bash = path.join(root, 'bin', 'bash.exe');
  const gitExe = path.join(root, 'cmd', 'git.exe');
  const hostGit = path.join(hostToolsDir, 'git');
  if (exists(root) && !exists(bash)) {
    log('Replacing the old MinGit (no bash) with full Git for Windows.');
    safeRemove(root, toolsDir);
  }
  if (!exists(bash) || refresh) {
    if (dryRun) {
      log(
        '(dry run) would provision Git for Windows' + (hostCopy ? ' from this PC' : '') + ' (access: ' + access + ')',
      );
      return;
    }
    // Into a staging folder, then renamed: an interrupted copy/extraction must not leave a tools\git that has bash.exe
    // (so looks installed) but is missing the rest.
    const work = stagingFolder(root);
    try {
      if (hostCopy && exists(path.join(hostGit, 'bin', 'bash.exe'))) {
        log('Copying Git for Windows from this PC ...');
        robocopy(hostGit, work);
      } else await installPortableGit(work);
      if (!exists(path.join(work, 'bin', 'bash.exe'))) throw new Error('bash.exe missing after installing Git');
      moveIntoPlace(work, root);
    } finally {
      safeRemove(work, toolsDir);
    }
  }
  if (!exists(bash)) throw new Error('bash.exe missing after installing Git');
  pointAtOwnCertificates(root);
  env.vars.CLAUDE_CODE_GIT_BASH_PATH = bash;
  // usr\bin is on PATH for Git's tools in cmd and PowerShell, last (path-plan.ts keeps MSVC before it).
  hideCoreutilsLink(path.join(root, 'usr', 'bin'));
  env.append.push(path.join(root, 'usr', 'bin'));
  const version = execOutput(gitExe, ['--version']).replace(/^git version /, '');
  if (access === 'full') {
    env.prepend.push(path.join(root, 'cmd'));
    env.summary.push('git: ' + version);
    return;
  }
  installGuard(env, access, gitExe);
  env.summary.push(
    access === 'readonly'
      ? 'git: ' + version + ' READ-ONLY (status/log/diff/show/blame; no commit, push, checkout, ...)'
      : 'git: DISABLED (bash only; the agent cannot use git)',
  );
}

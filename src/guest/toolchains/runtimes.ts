// Bun, uv and Deno: single-binary tools from GitHub releases (claude-mem needs Bun and uv).
import path from 'node:path';
import { dryRun, localDir } from '../runtime/paths.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { log } from '../runtime/log.js';
import { arch, tool, versionOf, type ToolEnv } from './tool-env.js';
import { installFromGithub } from './install.js';

export interface SingleExeOptions {
  /** Download again even when installed (provisioning.refresh). */
  refresh?: boolean;
  /** Keep the whole archive and put this folder inside it on PATH (default: keep only the folder holding the exe). */
  subdir?: string;
  versionArgs?: string[];
  /** Appended to the summary line, e.g. " (PowerShell 7)". */
  note?: string;
  /** Rough download size for the progress line, e.g. "35 MB". */
  size?: string;
}

/** A tool from one GitHub release archive, into `dir` (atomically), on PATH. */
export async function setupSingleExe(
  env: ToolEnv,
  name: string,
  repo: string,
  pattern: RegExp,
  exeName: string,
  dir: string,
  options: SingleExeOptions = {},
): Promise<void> {
  if (dryRun) {
    log('(dry run) would provision ' + name);
    return;
  }
  const bin = options.subdir ? path.join(dir, options.subdir) : dir;
  const exe = path.join(bin, exeName);
  if (!exists(exe) || options.refresh) {
    const size = options.size ? ', ~' + options.size : '';
    await installFromGithub(repo, pattern, {
      dest: dir,
      what: (a) => name + ' (' + a.name + size + ' once)',
      ...(options.subdir ? {} : { locate: exeName }),
    });
  }
  if (!exists(exe)) throw new Error(exeName + ' missing after installing ' + name);
  env.prepend.push(bin);
  env.summary.push(name + ': ' + versionOf(exe, options.versionArgs) + (options.note ?? ''));
}

export async function setupBun(env: ToolEnv): Promise<void> {
  await setupSingleExe(
    env,
    'bun',
    'oven-sh/bun',
    arch === 'arm64' ? /^bun-windows-aarch64\.zip$/ : /^bun-windows-x64\.zip$/,
    'bun.exe',
    tool('bun', 'bin'),
    { size: '35 MB' },
  );
  // Bun cannot keep its cache or temp files on a mapped folder (EINVAL); they go to the sandbox's own disk. The temp
  // folder must exist: programs compiled with Bun (opencode) unpack their DLLs there and fail when it is missing.
  const cache = path.join(localDir, 'bun-cache');
  const temp = path.join(localDir, 'bun-tmp');
  if (!dryRun) [cache, temp].forEach((dir) => mkdirp(dir));
  Object.assign(env.vars, { BUN_INSTALL: tool('bun'), BUN_INSTALL_CACHE_DIR: cache, BUN_TMPDIR: temp });
}

export async function setupDeno(env: ToolEnv): Promise<void> {
  await setupSingleExe(
    env,
    'deno',
    'denoland/deno',
    arch === 'arm64' ? /^deno-aarch64-pc-windows-msvc[.]zip$/ : /^deno-x86_64-pc-windows-msvc[.]zip$/,
    'deno.exe',
    tool('deno', 'bin'),
    { size: '40 MB' },
  );
  // `deno install` puts commands in DENO_INSTALL_ROOT/bin: the folder deno.exe is in, already on PATH.
  Object.assign(env.vars, { DENO_DIR: tool('deno-cache'), DENO_INSTALL_ROOT: tool('deno'), DENO_NO_UPDATE_CHECK: '1' });
}

/** Where uv keeps its cache, Pythons and tools (persistent). */
export function uvVars(): Record<string, string> {
  return {
    UV_CACHE_DIR: tool('uv-cache'),
    UV_PYTHON_INSTALL_DIR: tool('uv-python'),
    UV_TOOL_DIR: tool('uv-tools'),
    UV_TOOL_BIN_DIR: tool('uv-bin'),
  };
}

export async function setupUv(env: ToolEnv): Promise<void> {
  await setupSingleExe(
    env,
    'uv',
    'astral-sh/uv',
    arch === 'arm64' ? /^uv-aarch64-pc-windows-msvc\.zip$/ : /^uv-x86_64-pc-windows-msvc\.zip$/,
    'uv.exe',
    tool('uv'),
    { size: '20 MB' },
  );
  Object.assign(env.vars, uvVars());
  env.prepend.push(mkdirp(tool('uv-bin')));
}

// What every command receives, plus the small helpers they share.
import fs from 'node:fs';
import path from 'node:path';
import type { CliOptions } from '../args.js';
import type { LoadedConfig } from '../../core/types.js';
import { DEFAULTS, loadConfig, userDir } from '../../core/config/index.js';
import { expandPath, fail, isInsideOrEqual, UserError } from '../../core/util/index.js';
import { GUEST_DATA_DIR, insideSandbox, isSandboxRunning } from '../../host/sandbox/index.js';
import type { Borrowed } from '../../host/sharing/index.js';

export interface Context {
  packageRoot: string;
  entry: string;
  options: CliOptions;
  loaded: LoadedConfig;
  storageRoot: string;
  dataPath: string;
  /**
   * Set when the running sandbox is another user's and shared with this one: dataPath is then their data folder, and
   * its projects come from their record. Only the commands in shared-use.ts make such a context.
   */
  borrowed?: Borrowed;
}

/** Keeps ~/.agent-sandbox/*.schema.json in step with the installed version (local schema paths editors trust). */
function refreshSchemas(packageRoot: string): void {
  const source = path.join(packageRoot, 'schemas');
  if (!fs.existsSync(source)) return;
  try {
    fs.mkdirSync(userDir(), { recursive: true });
    for (const name of fs.readdirSync(source)) {
      const target = path.join(userDir(), name);
      const text = fs.readFileSync(path.join(source, name), 'utf8');
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) fs.writeFileSync(target, text, 'utf8');
    }
  } catch {
    /* editor help only; never block a command over it */
  }
}

export function createContext(packageRoot: string, entry: string, options: CliOptions): Context {
  refreshSchemas(packageRoot);
  const loaded = loadConfig(options.config);
  const storageRoot = expandPath(loaded.config.storage.root, loaded.base);
  // Inside a sandbox, the sandbox's own data folder is the one to talk to.
  return {
    packageRoot,
    entry,
    options,
    loaded,
    storageRoot,
    dataPath: insideSandbox() ? GUEST_DATA_DIR : path.join(storageRoot, 'data', loaded.config.storage.dataName),
  };
}

/**
 * The built-in defaults as a context, for a command that must run even when the settings file is broken (the
 * settings problem is then the command's own to report).
 */
export function defaultsContext(packageRoot: string, entry: string, options: CliOptions): Context {
  const loaded = { config: structuredClone(DEFAULTS), configPath: null, base: userDir() };
  const storageRoot = expandPath(loaded.config.storage.root, loaded.base);
  return {
    packageRoot,
    entry,
    options,
    loaded,
    storageRoot,
    dataPath: path.join(storageRoot, 'data', loaded.config.storage.dataName),
  };
}

/** The context of a command that must not stop on a broken settings file: the defaults when createContext refuses. */
export function contextOrDefaults(packageRoot: string, entry: string, options: CliOptions): Context {
  try {
    return createContext(packageRoot, entry, options);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    return defaultsContext(packageRoot, entry, options);
  }
}

/** Reads the config again and takes the storage folder from it (after a migration or a move changed it). */
export function refreshStorage(ctx: Context): void {
  ctx.loaded = loadConfig(ctx.options.config);
  ctx.storageRoot = expandPath(ctx.loaded.config.storage.root, ctx.loaded.base);
  if (!insideSandbox()) ctx.dataPath = path.join(ctx.storageRoot, 'data', ctx.loaded.config.storage.dataName);
}

/** For commands that control the sandbox from your PC: inside the sandbox they make no sense. */
export function requireOnPc(what: string): void {
  if (insideSandbox())
    fail(
      'You are inside the sandbox already, so "sandbox ' + what + '" has nothing to control.',
      'Run it from a terminal on your PC. Inside the sandbox these work: sandbox status, sessions, config, data, db, doctor, logs.',
    );
}

export function requireRunning(hint = ''): void {
  if (!isSandboxRunning())
    fail('No Windows Sandbox is running.', hint || 'Start one: sandbox start (no agent) or sandbox claude.');
}

/**
 * Maps a folder on this PC to its path inside the running sandbox (only folders inside the mapped workspace exist
 * there).
 */
export function guestPathFor(hostDir: string, workspaceHost: string, guestWorkspace: string): string {
  if (!isInsideOrEqual(workspaceHost, hostDir))
    fail(
      'The running sandbox works on ' + workspaceHost + ', and Windows Sandbox cannot add folders while it runs.',
      'Run from inside that folder, or stop the sandbox (sandbox stop) and launch again from ' + hostDir + '.',
    );
  const rel = path.relative(workspaceHost, hostDir);
  return rel ? path.win32.join(guestWorkspace, rel) : guestWorkspace;
}

/** The guest folder for the current directory (or --workspace) in the running sandbox. */
export function currentGuestDir(ctx: Context, workspaceHost: string, guestWorkspace: string): string {
  return guestPathFor(path.resolve(ctx.options.workspace ?? process.cwd()), workspaceHost, guestWorkspace);
}

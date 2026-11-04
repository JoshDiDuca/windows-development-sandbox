// Agents that keep SQLite databases (codex ...): SQLite cannot map its shared memory in a mapped folder (error 8714,
// "disk I/O error"), so they run from a copy on the sandbox's own disk. The copy comes from persistent storage at boot
// and goes back when no agent process holds the files, so the data lives on between sandboxes.
import fs from 'node:fs';
import path from 'node:path';
import { SYSTEM } from '../../shared/system.js';
import { dryRun, isWin, localDir } from '../runtime/paths.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { execOutput } from '../runtime/process.js';
import { log, warn } from '../runtime/log.js';
import { session, stateDir } from '../runtime/session.js';
import { errMsg } from '../../core/util/errors.js';
import {
  bootResetPaths,
  codexConfigOwned,
  MAX_CODEX_CONFIG_BYTES,
  isCopyableDatabaseFile,
  isDatabaseFile,
  localStateEntries,
  type LocalState,
} from './agent-files.js';

const SQLITE_HEADER = 'SQLite format 3\0';

/** The sandbox-disk folder that holds the working copies. */
const localRoot = (): string => path.join(localDir, 'agent-state');

/** Every SQLite folder of every configured agent (none in launch folders that predate the agents list). */
export function agentLocalStates(): LocalState[] {
  return localStateEntries(session.agents ?? {}, stateDir, localRoot());
}

/** Variable -> working folder, for the agent environment (and the machine environment of new terminal tabs). */
export function localStateVars(): Record<string, string> {
  return Object.fromEntries(agentLocalStates().map((s) => [s.env, s.local]));
}

const databaseFiles = (dir: string, keep: (name: string) => boolean): string[] =>
  exists(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isFile() && keep(e.name) ? [e.name] : []))
    : [];

/** A database file that starts like SQLite (an empty or cut-off file must never replace a saved copy). */
const looksLikeSqlite = (file: string): boolean => {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    return fs.readSync(fd, head, 0, 16, 0) === 16 && head.toString('latin1') === SQLITE_HEADER;
  } finally {
    fs.closeSync(fd);
  }
};

const copyFiles = (from: string, to: string, names: readonly string[]): void => {
  fs.rmSync(to, { recursive: true, force: true });
  mkdirp(to);
  for (const name of names) fs.copyFileSync(path.join(from, name), path.join(to, name));
};

/** Replaces the folder `store` with the staged `incoming` folder; the old one is only removed once the new is in. */
const swapIn = (incoming: string, store: string): void => {
  const previous = store + '.previous';
  fs.rmSync(previous, { recursive: true, force: true });
  if (exists(store)) fs.renameSync(store, previous);
  try {
    fs.renameSync(incoming, store);
  } catch (e) {
    if (exists(previous)) fs.renameSync(previous, store);
    throw e;
  }
  fs.rmSync(previous, { recursive: true, force: true });
};

/**
 * Databases an agent kept in its state folder before (codex: state_5.sqlite ...) move into the saved copy. The
 * originals
 * go only after the copy is in place and has the same sizes.
 */
function adoptLegacy(s: LocalState): void {
  if (exists(s.store)) return;
  const names = databaseFiles(s.legacy, isDatabaseFile);
  if (!names.length) return;
  const copyable = names.filter(isCopyableDatabaseFile);
  const incoming = s.store + '.incoming';
  copyFiles(s.legacy, incoming, copyable);
  swapIn(incoming, s.store);
  const same = copyable.every(
    (n) => fs.statSync(path.join(s.store, n)).size === fs.statSync(path.join(s.legacy, n)).size,
  );
  if (!same) {
    warn(s.agent + ': the copied databases differ in size from the originals; the originals were kept.');
    return;
  }
  for (const n of names) fs.rmSync(path.join(s.legacy, n), { force: true });
  log(s.agent + ': moved ' + copyable.length + ' database file(s) to ' + s.store + '.');
}

/** Boot: what an agent sealed to the last sandbox (bootReset) is deleted, so it sets it up again. Links are left. */
export function resetMachineBound(): void {
  if (dryRun) return;
  for (const { agent, path: target } of bootResetPaths(session.agents ?? {}, stateDir)) {
    try {
      const stat = fs.lstatSync(target, { throwIfNoEntry: false });
      if (!stat || stat.isSymbolicLink()) continue;
      fs.rmSync(target, { recursive: true, force: true });
      log(
        agent +
          ': removed ' +
          path.relative(path.join(stateDir, agent), target) +
          ' (it only worked in the last sandbox).',
      );
    } catch (e) {
      warn(agent + ': could not remove ' + target + ' (' + errMsg(e) + ').');
    }
  }
}

/**
 * Boot: Codex's config.toml follows the codex settings (codexConfigOwned): no Windows sandbox setup of its own, its MCP
 * logins in a file, the sandbox mode and approval policy for a start without the launch flags (codexArguments, which
 * beat this file and still go on every start through the sandbox).
 */
export function codexBootConfig(): void {
  if (dryRun || !session.agents?.codex || !session.codex) return;
  const file = path.join(stateDir, 'codex', 'config.toml');
  try {
    const size = exists(file) ? fs.statSync(file).size : 0;
    if (size > MAX_CODEX_CONFIG_BYTES) {
      warn('codex: config.toml is over 1 MB; left as it is.');
      return;
    }
    const before = size ? fs.readFileSync(file, 'utf8') : '';
    const after = codexConfigOwned(before, session.codex);
    if (after === before) return;
    mkdirp(path.dirname(file));
    fs.writeFileSync(file, after, 'utf8');
    log('codex: config.toml updated (Windows sandbox "' + session.codex.windowsSandbox + '").');
  } catch (e) {
    warn('codex: could not update config.toml (' + errMsg(e) + ').');
  }
}

/** Boot: the saved databases of every configured agent are copied to the sandbox's disk, where the agent runs them. */
export function restoreLocalState(): void {
  if (dryRun) return;
  for (const s of agentLocalStates()) {
    try {
      adoptLegacy(s);
      mkdirp(s.local);
      const names = databaseFiles(s.store, isCopyableDatabaseFile);
      for (const n of names) fs.copyFileSync(path.join(s.store, n), path.join(s.local, n));
      if (names.length) log(s.agent + ': databases restored to ' + s.local + '.');
    } catch (e) {
      warn(s.agent + ': could not restore its databases (' + errMsg(e) + '); it starts with empty ones.');
    }
  }
}

/** True while one of the programs that open the databases runs. */
function held(s: LocalState): boolean {
  if (!isWin) return false;
  return s.processes.some((image) =>
    execOutput(SYSTEM.tasklist(), ['/FI', 'IMAGENAME eq ' + image, '/NH', '/FO', 'CSV'])
      .toLowerCase()
      .includes(image.toLowerCase()),
  );
}

const fingerprint = (dir: string): string =>
  databaseFiles(dir, isCopyableDatabaseFile)
    .sort()
    .map((n) => {
      const st = fs.statSync(path.join(dir, n));
      return n + ':' + st.size + ':' + st.mtimeMs;
    })
    .join('|');

/** The working copies as of the last save by this process. */
const saved = new Map<string, string>();

/** Snapshots in progress (one per working folder) and whether the missing online backup was said already. */
const snapshotting = new Set<string>();
let saidNoBackup = false;

/**
 * While the agent runs its databases are never copied as files (the -wal and the database would not match): SQLite's
 * online backup writes a consistent snapshot into the staging folder, which is then swapped in. Needs node:sqlite
 * (newer Node); without it the save waits until the agent has exited.
 */
function snapshotWhileRunning(s: LocalState, print: string): void {
  if (snapshotting.has(s.local)) return;
  snapshotting.add(s.local);
  void (async () => {
    try {
      const sqlite = await import('node:sqlite').catch(() => null);
      if (!sqlite || typeof sqlite.backup !== 'function') {
        if (!saidNoBackup)
          log(s.agent + ': this Node has no SQLite online backup; its databases are saved when it exits.');
        saidNoBackup = true;
        return;
      }
      const incoming = s.store + '.incoming';
      fs.rmSync(incoming, { recursive: true, force: true });
      mkdirp(incoming);
      for (const name of databaseFiles(s.local, (n) => isCopyableDatabaseFile(n) && !/-wal$/i.test(n))) {
        const db = new sqlite.DatabaseSync(path.join(s.local, name), { readOnly: true });
        try {
          await sqlite.backup(db, path.join(incoming, name));
        } finally {
          db.close();
        }
      }
      swapIn(incoming, s.store);
      saved.set(s.local, print);
    } catch (e) {
      warn(s.agent + ': could not snapshot its running databases: ' + errMsg(e));
    } finally {
      snapshotting.delete(s.local);
    }
  })();
}

/**
 * Copies the working databases back to persistent storage (staging folder + swap). While the agent runs they are
 * snapshotted with SQLite's online backup instead (see snapshotWhileRunning); nothing is done when nothing changed.
 */
export function saveLocalState(): void {
  if (dryRun) return;
  for (const s of agentLocalStates()) {
    try {
      if (!exists(s.local)) continue;
      const print = fingerprint(s.local);
      if (!print || (saved.get(s.local) === print && exists(s.store))) continue;
      if (held(s)) {
        snapshotWhileRunning(s, print);
        continue;
      }
      const names = databaseFiles(s.local, isCopyableDatabaseFile);
      const bad = names.filter((n) => !/-wal$/i.test(n) && !looksLikeSqlite(path.join(s.local, n)));
      if (bad.length) {
        warn(s.agent + ': ' + bad.join(', ') + ' do not look like SQLite databases, so they were not saved.');
        continue;
      }
      const incoming = s.store + '.incoming';
      copyFiles(s.local, incoming, names);
      swapIn(incoming, s.store);
      saved.set(s.local, print);
    } catch (e) {
      warn(s.agent + ': could not save its databases: ' + errMsg(e));
    }
  }
}

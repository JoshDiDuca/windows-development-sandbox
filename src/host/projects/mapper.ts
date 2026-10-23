import fs from 'node:fs';
import path from 'node:path';
import { assertSafeWorkspace } from '../../core/safe-paths.js';
import { dirExists, fail } from '../../core/util/index.js';
import type { Missing } from '../../core/local-config/index.js';
import {
  guestDirFor,
  hubName,
  liveGuestFolder,
  ownGuestFolder,
  projectForHostDir,
  type Mechanism,
} from '../../shared/paths/index.js';
import { detectWsb, runningSandboxId, shareFolder, type Wsb } from '../sandbox/index.js';
import { runningOwner } from '../sharing/index.js';
import { LIVE_FOLDERS_WARNING, realLiveFolders, type LiveFolders } from '../engines/index.js';
import { ProjectRegistry, type Registry, type RegistryEntry } from './registry.js';

/**
 * Why a folder cannot join the running sandbox without a restart (the caller offers one). With `missing`: it could
 * join, but you chose to restart for what it wants at boot (core/local-config/boot-wants.ts).
 */
export class NeedsRestart extends Error {
  constructor(
    public readonly hostDir: string,
    public readonly reason: string,
    public readonly missing?: Missing,
  ) {
    super(reason);
  }
}

export interface ProjectMapper {
  /** The projects of the running sandbox (the launch folder first). */
  list(): RegistryEntry[];
  /**
   * Makes a folder of this PC a project of the running sandbox; throws NeedsRestart when that needs a restart.
   * `readOnly`: how the project's own settings would map it (a live folder is read-only when this is not known).
   */
  register(hostDir: string, o?: { readOnly?: boolean; onNote?: (note: string) => void }): Promise<RegistryEntry>;
  /**
   * Forgets a project (never the launch folder). A live folder (hcs) is hidden in the sandbox and its share removed;
   * any other mapped folder stays visible until the next start.
   */
  unregister(name: string): Promise<void>;
}

/** The parts of LiveFolders the mapper uses (a test hands in a fake). */
export type LivePort = Pick<LiveFolders, 'add' | 'remove' | 'unavailable' | 'shareOf'>;

export interface MapperOptions {
  storageRoot: string;
  packageRoot: string;
  wsbShare: boolean;
  /** projects.liveFolders: "hcs" adds folders through HCS where wsb share is missing (alpha). */
  liveFolders?: 'off' | 'hcs';
  /** The data folder of the running sandbox (needed for live folders). */
  dataPath?: string;
  detect?: () => Wsb | null;
  live?: () => LivePort;
  /** This Windows user started the running sandbox (not another user's, shared or not). */
  isMine?: () => boolean;
}

/** Roots first (instant), then `wsb share` where Windows has it, then HCS (opt-in), else NeedsRestart. */
export function projectMapper(o: MapperOptions): ProjectMapper {
  const store = new ProjectRegistry(o.storageRoot);
  const registry = (): Registry =>
    store.read() ??
    fail(
      'The running sandbox was started by an older version, so it cannot take another folder.',
      'Stop it (sandbox stop) and start it again.',
    );
  const add = (reg: Registry, host: string, guest: string, mechanism: Mechanism, name: string): RegistryEntry => {
    const entry: RegistryEntry = {
      name,
      host,
      guest,
      primary: false,
      mechanism,
      registeredAt: new Date().toISOString(),
    };
    // Re-read right before writing: another terminal may have registered something meanwhile.
    const latest = store.read() ?? reg;
    const same = latest.projects.find((p) => p.host.toLowerCase() === host.toLowerCase());
    if (same) return same;
    store.save({ ...latest, projects: [...latest.projects, entry] });
    return entry;
  };
  const live = (): LivePort =>
    o.live
      ? o.live()
      : realLiveFolders(o.storageRoot, o.dataPath ?? fail('Live folders need the data folder of the running sandbox.'));
  const taken = (reg: Registry): string[] => [...reg.projects.map((p) => p.guest), ...reg.roots.map((r) => r.guest)];

  /** Through HCS (projects.liveFolders "hcs", alpha): any refusal or failure is a NeedsRestart with the reason. */
  const addLive = async (
    reg: Registry,
    host: string,
    name: string,
    readOnly: boolean,
    note?: (n: string) => void,
  ): Promise<RegistryEntry> => {
    if (!(o.isMine ?? (() => runningOwner().kind === 'mine'))())
      throw new NeedsRestart(
        host,
        'the running sandbox was not started by you, so no folder is added to it through HCS',
      );
    const port = live();
    const why = port.unavailable(reg.launchId);
    if (why) throw new NeedsRestart(host, 'live folders through HCS cannot be used: ' + why);
    // The real path (a subst drive is resolved here: the elevated helper does not see this session's drives).
    let real: string;
    try {
      real = fs.realpathSync.native(host);
    } catch {
      throw new NeedsRestart(host, 'the folder cannot be read');
    }
    assertSafeWorkspace(real, o.packageRoot, o.storageRoot);
    const guest = liveGuestFolder(host, taken(reg));
    note?.(LIVE_FOLDERS_WARNING);
    try {
      await port.add({ launchId: reg.launchId, host: real, guest, folder: path.win32.basename(guest), readOnly });
    } catch (e) {
      throw new NeedsRestart(
        host,
        'adding it through HCS failed (alpha): ' + (e instanceof Error ? e.message : String(e)),
      );
    }
    return add(reg, host, guest, 'hcs', name);
  };

  return {
    list: () => store.read()?.projects ?? [],
    register: async (hostDir, opts = {}) => {
      const host = path.resolve(hostDir);
      const reg = registry();
      const known = reg.projects.find((p) => p.host.toLowerCase() === host.toLowerCase());
      if (known) return known;
      assertSafeWorkspace(host, o.packageRoot, o.storageRoot);
      if (!dirExists(host)) fail('The folder does not exist: ' + host);
      const name = hubName(
        host,
        reg.projects.map((p) => p.name),
      );
      // Inside a root: visible already (also a project created after the sandbox started).
      const root = projectForHostDir(reg.roots, host);
      if (root) return add(reg, host, guestDirFor(root, host), 'root', name);
      const hcs = o.liveFolders === 'hcs';
      const wsb = o.wsbShare || hcs ? (o.detect ?? detectWsb)() : null;
      // The official way wins wherever it exists: HCS only where wsb share is missing.
      if (o.wsbShare && wsb?.has('share')) {
        const sandbox = runningSandboxId(wsb);
        if (!sandbox.id) throw new NeedsRestart(host, 'wsb share could not find the running sandbox: ' + sandbox.error);
        // Where it is as a launch folder too (C:\Workspace\<name>), unless another project already uses that place.
        const guest = ownGuestFolder(host, false, taken(reg));
        const shared = shareFolder(wsb, sandbox.id, host, guest);
        if (!shared.ok) throw new NeedsRestart(host, 'wsb share failed (untested on this Windows): ' + shared.error);
        return add(reg, host, guest, 'wsb', name);
      }
      if (hcs && !wsb?.has('share')) return addLive(reg, host, name, opts.readOnly ?? true, opts.onNote);
      if (!o.wsbShare)
        throw new NeedsRestart(
          host,
          'it is not inside a project root (projects.roots), and adding folders with wsb share is off (projects.wsbShare)',
        );
      throw new NeedsRestart(
        host,
        'it is not inside a project root (projects.roots), and this Windows has no Windows Sandbox command line (wsb share needs Windows 11 24H2+ with the updated Windows Sandbox; projects.liveFolders "hcs" is an untested alpha for older Windows)',
      );
    },
    unregister: async (name) => {
      const reg = registry();
      const entry = reg.projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (!entry) fail('No project "' + name + '" in the running sandbox.', 'sandbox projects lists them.');
      if (entry.primary)
        fail(entry.host + ' is the folder the sandbox started from; it stays until the sandbox stops.');
      // A live folder: hidden in the sandbox first, then its share removed (one permission prompt); kept on failure.
      if (entry.mechanism === 'hcs') {
        const port = live();
        let real = entry.host;
        try {
          real = fs.realpathSync.native(entry.host);
        } catch {
          // Gone from this PC: its record still names the real path it had.
        }
        const share = port.shareOf(real) ?? port.shareOf(entry.host);
        if (share) await port.remove(reg.launchId, share.host);
      }
      const latest = store.read() ?? reg;
      store.save({ ...latest, projects: latest.projects.filter((p) => p.name !== entry.name) });
    },
  };
}

/**
 * The doctor's "Add folders while the sandbox runs": which way a folder outside every root would get in (wsb share, HCS
 * or a restart) and why. `liveUnavailable`: why the running sandbox cannot take live folders (null: it can).
 */
export function addFoldersRow(o: {
  wsbShare: boolean;
  liveFolders: 'off' | 'hcs';
  wsbHasShare: boolean;
  liveUnavailable: string | null;
}): string {
  if (o.wsbHasShare && o.wsbShare) return 'wsb share (untested; a failure offers a restart instead)';
  if (o.liveFolders === 'hcs') {
    if (o.wsbHasShare)
      return 'restart: wsb share is on this Windows but switched off (projects.wsbShare); HCS is not used where wsb share exists';
    return (
      'HCS (alpha, untested on a real PC): needs an administrator prompt each time' +
      (o.liveUnavailable ? '; not for the running sandbox: ' + o.liveUnavailable : '')
    );
  }
  return o.wsbHasShare
    ? 'restart (wsb share is switched off: projects.wsbShare)'
    : 'restart (no wsb share on this Windows; projects.liveFolders "hcs" is an untested alpha that adds folders without one)';
}

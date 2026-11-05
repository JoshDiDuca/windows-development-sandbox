// The Unity editors a sandbox has (this PC's, read-only, and the data disk's) and which one a project opens with. An
// editor is never swapped for another version: opening a project in another Unity upgrades its files. Pure apart from
// the file reads it is given.
import path from 'node:path';
import { UNITY_VERSION } from './version.js';

const win = path.win32;

export interface UnityFs {
  exists(file: string): boolean;
  list(dir: string): string[];
}

export interface UnityEditor {
  readonly version: string;
  /** The folder that holds Editor\Unity.exe. */
  readonly root: string;
  readonly exe: string;
  readonly origin: 'pc' | 'data';
  readonly writable: boolean;
  /** Module ids found installed (android, webgl, ios, windows-il2cpp). */
  readonly modules: readonly string[];
}

export const ORIGIN_LABELS = {
  pc: 'this PC, read-only',
  data: 'the data disk, kept between sandboxes',
} as const satisfies Record<UnityEditor['origin'], string>;

/** Folders under Editor\Data\PlaybackEngines that tell a module is installed (windows-il2cpp: verify on a real editor). */
const MODULE_FOLDERS: Readonly<Record<string, readonly string[]>> = {
  android: ['AndroidPlayer'],
  webgl: ['WebGLSupport'],
  ios: ['iOSSupport'],
  'windows-il2cpp': [
    'windowsstandalonesupport\\Variations\\win64_player_development_il2cpp',
    'windowsstandalonesupport\\Variations\\win64_development_il2cpp',
  ],
};

/** The modules installed in an editor folder. */
export function editorModules(root: string, fs: UnityFs): string[] {
  const engines = win.join(root, 'Editor', 'Data', 'PlaybackEngines');
  return Object.entries(MODULE_FOLDERS)
    .filter(([, folders]) => folders.some((f) => fs.exists(win.join(engines, f))))
    .map(([id]) => id);
}

export interface EditorSearch {
  /** This PC's editors as mapped read-only (id = the version). */
  readonly mapped: readonly { readonly guest: string; readonly id: string }[];
  /** tools\unity\editors on the data disk. */
  readonly dataRoot: string;
}

/** A data editor counts once its install finished: .complete.json (ours) or a Hub/CLI modules.json. */
function isComplete(root: string, fs: UnityFs): boolean {
  return fs.exists(win.join(root, '.complete.json')) || fs.exists(win.join(root, 'modules.json'));
}

export function findEditors(search: EditorSearch, fs: UnityFs): UnityEditor[] {
  const found: UnityEditor[] = [];
  for (const m of search.mapped) {
    const exe = win.join(m.guest, 'Editor', 'Unity.exe');
    if (UNITY_VERSION.test(m.id) && fs.exists(exe))
      found.push({
        version: m.id,
        root: m.guest,
        exe,
        origin: 'pc',
        writable: false,
        modules: editorModules(m.guest, fs),
      });
  }
  for (const name of fs.list(search.dataRoot)) {
    if (name.startsWith('.staging-') || !UNITY_VERSION.test(name)) continue;
    const root = win.join(search.dataRoot, name);
    const exe = win.join(root, 'Editor', 'Unity.exe');
    if (isComplete(root, fs) && fs.exists(exe))
      found.push({ version: name, root, exe, origin: 'data', writable: true, modules: editorModules(root, fs) });
  }
  return found;
}

export interface WantedEditor {
  readonly version: string;
  readonly changeset: string | null;
}

export interface EditorChoice {
  readonly editor: UnityEditor | null;
  /** What to install on the data disk, when nothing usable is there. */
  readonly install: WantedEditor | null;
  readonly reason: string;
}

/**
 * The editor for a project: exactly the version it asks for. This PC's (read-only) when it has every module, then the
 * data disk's, else install it when the licence is accepted. A PC editor that lacks modules is still used when nothing
 * can be installed.
 */
export function chooseEditor(
  editors: readonly UnityEditor[],
  wanted: WantedEditor | null,
  modules: readonly string[],
  canInstall: boolean,
): EditorChoice {
  if (!wanted) return { editor: null, install: null, reason: 'no ProjectSettings/ProjectVersion.txt' };
  const v = wanted.version;
  const same = editors.filter((e) => e.version === v);
  const pc = same.find((e) => e.origin === 'pc');
  const data = same.find((e) => e.origin === 'data');
  const missing = (e: UnityEditor | undefined): string | undefined => modules.find((m) => !e?.modules.includes(m));
  const asks = 'the project asks for ' + v;
  if (pc && missing(pc) === undefined) return { editor: pc, install: null, reason: asks };
  if (data) {
    const lack = pc ? missing(pc) : undefined;
    return {
      editor: data,
      install: null,
      reason: lack === undefined ? asks : v + ' from this PC lacks ' + lack + '; using the data disk copy',
    };
  }
  if (canInstall)
    return { editor: null, install: wanted, reason: v + ' is not here yet; installing it on the data disk' };
  if (pc) return { editor: pc, install: null, reason: asks };
  return {
    editor: null,
    install: null,
    reason: v + ' is not on this PC or the data disk; accept the Unity licence (Unity set-up settings) to install it',
  };
}

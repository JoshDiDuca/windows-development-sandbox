// The folder picker's listing: names in one folder (folders first), read once with a cap, and the places to start
// from. Only names and paths of this PC go to the signed-in browser of this PC's user; nothing is opened or followed.
import fs from 'node:fs';
import path from 'node:path';
import { fail } from '../../../core/util/index.js';
import { hereDir } from '../../../cli/commands/projects/here.js';
import { implement, type AppContext } from '../../context.js';
import { browseFolder, MAX_ENTRIES, type FolderEntry, type FolderListing } from './files.def.js';

const DRIVES = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function places(ctx: AppContext): FolderListing['places'] {
  const drives = DRIVES.filter((d) => {
    try {
      return fs.statSync(d + ':\\').isDirectory();
    } catch {
      return false; // no such drive, or an empty card reader
    }
  }).map((d) => ({ label: d + ':', path: d + ':\\' }));
  const folders = [
    { label: "This folder's project", path: hereDir(ctx) },
    { label: 'Data folder', path: ctx.storageRoot },
  ].filter((p) => p.path && fs.existsSync(p.path));
  return [...folders, ...drives];
}

function listing(folder: string, files: boolean): Pick<FolderListing, 'entries' | 'truncated'> {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return fail('Cannot open ' + folder + '.', 'Pick another folder, or check that you may read this one.');
  }
  const entries: FolderEntry[] = [];
  for (const d of dirents) {
    // A link to a folder is offered as a folder (it is still a path you can type); system folders like $Recycle.Bin
    // are left out.
    const dir = d.isDirectory() || d.isSymbolicLink();
    if (d.name.startsWith('$') || (!dir && !files)) continue;
    entries.push({ name: d.name, path: path.join(folder, d.name), kind: dir ? 'dir' : 'file' });
  }
  entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.kind === 'dir' ? -1 : 1,
  );
  return { entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
}

export const browseFolderRun = implement(browseFolder, (ctx, input) => {
  const start = places(ctx);
  if (!input.path) return { path: '', parent: null, entries: [], truncated: false, places: start };
  if (!path.isAbsolute(input.path) || input.path.includes('\0'))
    fail('"' + input.path + '" is not a full path.', 'Use a path like C:\\Projects.');
  const folder = path.resolve(input.path);
  const parent = path.dirname(folder);
  return {
    path: folder,
    parent: parent === folder ? null : parent,
    ...listing(folder, input.files),
    places: start,
  };
});

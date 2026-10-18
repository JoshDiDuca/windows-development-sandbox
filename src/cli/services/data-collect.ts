// What `sandbox data` lists: the data folder by area, then what this PC keeps for the sandbox.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { sizeOf } from '../../core/disk.js';
import { dirExists, isLink } from '../../core/util/index.js';

export type DataArea = 'tools' | 'databases' | 'state' | 'logs' | 'data' | 'host';
export interface DataEntry {
  area: DataArea;
  name: string;
  path: string;
  bytes: number;
}

const AREA_ORDER: DataArea[] = ['tools', 'databases', 'state', 'logs', 'data', 'host'];
/** Folders of the data folder that get one row per child; anything else at the top level is listed as itself. */
const PER_CHILD: DataArea[] = ['tools', 'databases', 'state'];

/** Real (non-link) children of a real folder; a link in place of the folder yields nothing. */
function entriesOf(dir: string): fs.Dirent[] {
  return dirExists(dir) && !isLink(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => !d.isSymbolicLink())
    : [];
}

function toolRows(toolsDir: string): DataEntry[] {
  const entries = entriesOf(toolsDir);
  const folders = entries.filter((d) => d.isDirectory());
  const files = entries.filter((d) => !d.isDirectory());
  const row = (name: string, p: string): DataEntry => ({ area: 'tools', name, path: p, bytes: sizeOf(p) });
  return [
    ...folders.flatMap((d) =>
      d.name.toLowerCase() === 'agents'
        ? entriesOf(path.join(toolsDir, d.name)).map((a) =>
            row('agents/' + a.name, path.join(toolsDir, d.name, a.name)),
          )
        : [row(d.name, path.join(toolsDir, d.name))],
    ),
    ...(files.length
      ? [
          {
            area: 'tools' as const,
            name: '(files in tools)',
            path: toolsDir,
            bytes: _.sumBy(files, (f) => sizeOf(path.join(toolsDir, f.name))),
          },
        ]
      : []),
  ];
}

/** Every row of `sandbox data`: the sandbox's data folder by area, then what this PC keeps for it. */
export function collectDataEntries(dataPath: string, storageRoot: string): DataEntry[] {
  const inData = entriesOf(dataPath);
  const rows: DataEntry[] = inData.flatMap((d): DataEntry[] => {
    const p = path.join(dataPath, d.name);
    const area = d.name.toLowerCase() as DataArea;
    if (area === 'tools') return toolRows(p);
    if (PER_CHILD.includes(area))
      return entriesOf(p).map((c) => ({
        area,
        name: area + '/' + c.name,
        path: path.join(p, c.name),
        bytes: sizeOf(path.join(p, c.name)),
      }));
    return [{ area: area === 'logs' ? 'logs' : 'data', name: d.name, path: p, bytes: sizeOf(p) }];
  });
  const otherData = entriesOf(path.join(storageRoot, 'data')).filter(
    (d) =>
      d.isDirectory() && path.join(storageRoot, 'data', d.name).toLowerCase() !== path.resolve(dataPath).toLowerCase(),
  );
  const host: DataEntry[] = [
    ...['launches', 'views', 'accounts', 'sync', 'logs', 'run', 'host'].map((name) => ({
      area: 'host' as const,
      name,
      path: path.join(storageRoot, name),
      bytes: sizeOf(path.join(storageRoot, name)),
    })),
    ...otherData.map((d) => ({
      area: 'host' as const,
      name: 'other data folder: ' + d.name,
      path: path.join(storageRoot, 'data', d.name),
      bytes: sizeOf(path.join(storageRoot, 'data', d.name)),
    })),
  ].filter((r) => fs.existsSync(r.path));
  return _.sortBy(
    [...rows, ...host],
    (r) => AREA_ORDER.indexOf(r.area),
    (r) => -r.bytes,
    (r) => r.name.toLowerCase(),
  );
}

/**
 * The `sandbox data clean` target for a listed row, or null when that row is not removable (kept on this PC on
 * purpose).
 */
export function cleanTargetOf(entry: DataEntry): string | null {
  if (entry.area === 'tools') return entry.name.startsWith('(') ? null : 'tools/' + entry.name;
  if (entry.area === 'databases' || entry.area === 'state') return entry.name;
  if (entry.area === 'logs') return 'logs';
  if (entry.area === 'host' && (entry.name === 'launches' || entry.name === 'views')) return entry.name;
  return null;
}

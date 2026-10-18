// Deleting inside the data folder. The sandbox can write there, so links are removed themselves and never followed.
import fs from 'node:fs';
import path from 'node:path';
import { dirExists, isLink, removeLink } from '../../core/util/index.js';
import { removeRefusal, safeRemove } from '../../shared/io/index.js';

/** Deletes p (strictly inside root): links inside are removed first and never followed; see shared/safe-remove.ts. */
export function removeTree(p: string, root: string): void {
  const unlinkInside = (dir: string): void => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, d.name);
      if (d.isSymbolicLink() || isLink(child)) removeLink(child);
      else if (d.isDirectory()) unlinkInside(child);
    }
  };
  if (isLink(p)) {
    removeLink(p);
    return;
  }
  if (!fs.existsSync(p)) return;
  // Refused before anything is touched (safeRemove below checks again).
  const refusal = removeRefusal(p, root);
  if (refusal) throw new Error('Refusing to delete ' + p + ': ' + refusal);
  if (dirExists(p)) unlinkInside(p);
  safeRemove(p, root);
}

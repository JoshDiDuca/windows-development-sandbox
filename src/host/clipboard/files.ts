// The bridge's folder in the data folder (<data>\clipboard): cleared at launch and when the sandbox ends, so no copy
// outlives its sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { assertNoLinks } from '../../core/util/index.js';
import { RunDir } from '../../shared/channel/run-dir.js';

export function clearClipboardFiles(dataPath: string): void {
  const run = new RunDir(dataPath);
  try {
    assertNoLinks(dataPath, run.clipboardDir);
    for (const name of fs.readdirSync(run.clipboardDir)) {
      if (name === 'to-pc.json' || name === 'to-sandbox.json' || name.endsWith('.tmp'))
        fs.rmSync(path.join(run.clipboardDir, name), { force: true });
    }
  } catch {
    // No folder yet, or a planted link: nothing to remove.
  }
}

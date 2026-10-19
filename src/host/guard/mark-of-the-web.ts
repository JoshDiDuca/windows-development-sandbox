// storage.markSandboxFiles: programs and scripts that appear or change in a project while a sandbox runs get Windows'
// "downloaded from the internet" mark (Zone.Identifier, zone 3), so SmartScreen and PowerShell's RemoteSigned policy
// stop a planted file from running on a double-click or a habit. Runs in the watcher; only the mark is written.
import fs from 'node:fs';
import path from 'node:path';

/** What Windows runs when you open it (not source files such as .js or .py: those need a program you choose). */
export const RISKY =
  /\.(exe|dll|com|scr|pif|msi|msix|msp|appx|appxbundle|bat|cmd|ps1|psm1|psd1|vbs|vbe|wsf|wsh|hta|lnk|url|jar|reg|cpl|application|gadget|chm)$/i;
const MARK = '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=about:windows-development-sandbox\r\n';
/** Folders not worth watching closely (git's own files; dependency and build folders are still marked). */
const SKIP = /(^|[\\/])\.git([\\/]|$)/i;
const MAX_NAMED = 10;

/** Marks one file if it is a program or script (and a plain file, not a link). Returns true when it marked it. */
export function markFromSandbox(file: string): boolean {
  if (!RISKY.test(file) || SKIP.test(file)) return false;
  try {
    const stat = fs.lstatSync(file);
    // Already marked: writing the mark again would fire another change event for this file, so every marked file was
    // marked (and reported) again every second for as long as the sandbox ran.
    if (!stat.isFile() || isMarked(file)) return false;
    fs.writeFileSync(file + ':Zone.Identifier', MARK);
    return true;
  } catch {
    return false;
  }
}

/** Has this file the mark? */
export function isMarked(file: string): boolean {
  try {
    return fs.readFileSync(file + ':Zone.Identifier', 'utf8').includes('ZoneId=3');
  } catch {
    return false;
  }
}

/** Watches the projects while the sandbox runs and marks what appears or changes; returns a function that stops it. */
export function watchAndMark(
  projects: readonly string[],
  note: (message: string) => void = () => undefined,
): () => void {
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const flush = (): void => {
    timer = undefined;
    const marked = [...pending].filter(markFromSandbox);
    pending.clear();
    if (marked.length)
      note(
        'marked as from the sandbox (SmartScreen asks before they run here): ' +
          marked
            .slice(0, MAX_NAMED)
            .map((f) => path.basename(f))
            .join(', ') +
          (marked.length > MAX_NAMED ? ' and ' + (marked.length - MAX_NAMED) + ' more' : ''),
      );
  };
  const watchers = projects.flatMap((project) => {
    try {
      return [
        fs.watch(project, { recursive: true }, (_event, file) => {
          const rel = file ? String(file) : '';
          if (!rel || !RISKY.test(rel) || SKIP.test(rel)) return;
          pending.add(path.join(project, rel));
          timer ??= setTimeout(flush, 1000);
        }),
      ];
    } catch {
      return [];
    }
  });
  return () => {
    watchers.forEach((w) => w.close());
    clearTimeout(timer);
    if (pending.size) flush();
  };
}

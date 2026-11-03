// A Chromium browser's Windows installer (Comet's) opened with 7-Zip instead of run: installer exe -> UPDATER.PACKED.7Z
// -> mini_installer.exe -> CHROME.PACKED.7Z -> chrome.7z -> Chrome-bin, whose contents run portable from
// tools\apps\<id> (nothing registered, no updater, no per-boot reinstall). When the layout is not that (a new
// installer), the signed installer is kept instead and run with --install --silent at every boot, after its signer is
// checked again (the data folder is shared with the sandbox, so the file is never trusted from last time).
import fs from 'node:fs';
import path from 'node:path';
import type { AppSigner } from '../../shared/signer.js';
import { installedCometExe } from '../browser/comet.js';
import { execAsync } from '../runtime/process.js';
import { mkdirp } from '../runtime/fs.js';
import { signedBy } from '../toolchains/signature.js';

/** The archives inside, last stage first: the first one found is opened next. */
const INNER: readonly RegExp[] = [
  /^chrome\.7z$/i,
  /^chrome\.packed\.7z$/i,
  /^mini_installer\.exe$/i,
  /^updater\.packed\.7z$/i,
];
const MAX_LEVELS = 6;
const MAX_DEPTH = 4;
const MAX_ENTRIES = 20000;
/** Where the installer is kept when it could not be unpacked (below the app's folder). */
export const KEPT_INSTALLER_DIR = 'installer';

/** Every file and folder below `root`, breadth first and bounded (no links followed). */
function walk(root: string): { dirs: string[]; files: string[] } {
  const dirs: string[] = [];
  const files: string[] = [];
  let queue = [root];
  for (let depth = 0; depth < MAX_DEPTH && queue.length && dirs.length + files.length < MAX_ENTRIES; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // Unreadable: skipped.
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.isSymbolicLink()) {
          dirs.push(full);
          next.push(full);
        } else if (e.isFile()) files.push(full);
      }
    }
    queue = next;
  }
  return { dirs, files };
}

/** The browser's own folder (Chrome-bin, holding `exe`) among what one stage unpacked, or null. */
export function chromiumBin(root: string, exe: string): string | null {
  return (
    walk(root).dirs.find((d) => path.basename(d).toLowerCase() === 'chrome-bin' && fs.existsSync(path.join(d, exe))) ??
    null
  );
}

/** The next archive to open among what one stage unpacked (the latest stage wins), or null. */
export function nextInner(root: string): string | null {
  const { files } = walk(root);
  for (const pattern of INNER) {
    const hit = files.find((f) => pattern.test(path.basename(f)));
    if (hit) return hit;
  }
  return null;
}

/**
 * Unpacks a Chromium installer into `out` with 7-Zip ("portable"); when no stage holds the browser, keeps the
 * installer in out\installer instead ("installer").
 */
export async function unpackChromium(
  sevenZip: string,
  file: string,
  out: string,
  work: string,
  exe: string,
): Promise<'portable' | 'installer'> {
  let current = file;
  for (let level = 0; level < MAX_LEVELS; level++) {
    const dir = path.join(work, 'stage' + level);
    try {
      await execAsync(sevenZip, ['x', '-y', '-o' + dir, current], { stdio: 'ignore' });
    } catch {
      break; // Not an archive 7-Zip opens: keep the installer.
    }
    const bin = chromiumBin(dir, exe);
    if (bin) {
      fs.renameSync(bin, out);
      return 'portable';
    }
    const inner = nextInner(dir);
    if (!inner) break;
    current = inner;
  }
  const kept = path.join(mkdirp(path.join(out, KEPT_INSTALLER_DIR)), path.basename(file));
  fs.copyFileSync(file, kept);
  return 'installer';
}

/** The installer kept in an app's folder, or null when it was unpacked. */
export function keptInstaller(dest: string): string | null {
  const dir = path.join(dest, KEPT_INSTALLER_DIR);
  try {
    const exe = fs.readdirSync(dir).find((n) => /\.exe$/i.test(n));
    return exe ? path.join(dir, exe) : null;
  } catch {
    return null;
  }
}

/**
 * Comet from its kept installer: installed into this sandbox (--install --silent) once per boot, only while the
 * installer is still signed by `signer` (else it is deleted, and downloaded again next boot). Null when there is no
 * kept installer.
 */
export async function installFromKept(dest: string, signer: AppSigner, what: string): Promise<string | null> {
  const installer = keptInstaller(dest);
  if (!installer) return null;
  const installed = installedCometExe();
  if (fs.existsSync(installed)) return installed;
  if (!signedBy(installer, signer)) {
    fs.rmSync(path.join(dest, '.agent-sandbox-app'), { force: true });
    fs.rmSync(installer, { force: true });
    throw new Error(what + "'s installer is not signed by its vendor; deleted it (it is downloaded again next boot)");
  }
  await execAsync(installer, ['--install', '--silent', '--do-not-launch-chrome'], { stdio: 'ignore' });
  return fs.existsSync(installed) ? installed : null;
}

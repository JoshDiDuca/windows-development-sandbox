import fs from 'node:fs';
import path from 'node:path';
import { type AppEntry } from '../../shared/apps/index.js';
import { downloader, extractArchive, githubAsset } from '../../shared/download/index.js';
import { SYSTEM } from '../../shared/system.js';
import { execAsync } from '../runtime/process.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { tool } from '../toolchains/tool-env.js';
import { type Download } from './resolvers.js';
import { unpackChromium } from './comet-unpack.js';
import { findExe } from './find-exe.js';

const sevenZip = (): string => tool('apps', '7zip', '7z.exe');

export async function unpack(entry: AppEntry, file: string, out: string, d: Download): Promise<void> {
  if (entry.id === '7zip') {
    // 7zr.exe (the small standalone 7-Zip) opens the full 7-Zip's installer.
    const sevenZr = path.join(path.dirname(file), '7zr.exe');
    const zr = await githubAsset('ip7z/7zip', /^7zr\.exe$/);
    await downloader.file(zr.url, sevenZr, zr.sha256);
    await execAsync(sevenZr, ['x', '-y', '-o' + out, file], { stdio: 'ignore' });
    return;
  }
  switch (entry.unpack ?? 'archive') {
    case 'file': {
      mkdirp(out);
      fs.renameSync(file, path.join(out, /^\//.test(entry.exe) ? path.basename(file) : entry.exe));
      return;
    }
    case 'nsis': {
      if (!exists(sevenZip()))
        throw new Error('7-Zip is needed to unpack ' + entry.name + ' and could not be installed');
      const raw = path.join(path.dirname(out), 'raw');
      await execAsync(sevenZip(), ['x', '-y', '-o' + raw, file], { stdio: 'ignore' });
      // electron-builder installers carry the app as one more archive inside.
      const inner = findExe(raw, '/^app-64\\.7z$/');
      if (inner) await execAsync(sevenZip(), ['x', '-y', '-o' + out, inner], { stdio: 'ignore' });
      else fs.renameSync(raw, out);
      return;
    }
    case 'chromium': {
      // A Chromium browser's installer (Comet), opened stage by stage; kept as an installer when that fails.
      if (!exists(sevenZip()))
        throw new Error('7-Zip is needed to unpack ' + entry.name + ' and could not be installed');
      await unpackChromium(sevenZip(), file, out, path.join(path.dirname(out), 'chromium'), entry.exe);
      return;
    }
    case 'msi': {
      // An administrative install only extracts the files: nothing is registered with Windows.
      mkdirp(out);
      await execAsync(SYSTEM.msiexec(), ['/a', file, '/qn', 'TARGETDIR=' + out], { stdio: 'ignore' });
      return;
    }
    default:
      await extractArchive(file, out, d.members);
  }
}

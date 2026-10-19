// Installs the chosen apps into tools\apps, a few at a time, each once (a marker file says it is complete). One app
// failing is reported and never stops the others.
import fs from 'node:fs';
import path from 'node:path';
import type { Config, GitAccess } from '../../core/types.js';
import { appsToInstall, type AppEntry } from '../../shared/apps/index.js';
import { downloader, moveIntoPlace, stagingFolder } from '../../shared/download/index.js';
import { safeRemove } from '../../shared/io/safe-remove.js';
import { dryRun, launchDir } from '../runtime/paths.js';
import { execAsync } from '../runtime/process.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { log, warn } from '../runtime/log.js';
import { errMsg } from '../../core/util/errors.js';
import { tool, type ToolEnv } from '../toolchains/tool-env.js';
import { uvVars } from '../toolchains/runtimes.js';
import { afterInstall } from './after-install.js';
import { findExe } from './find-exe.js';
import { shortcuts, type Shortcut } from './shortcuts.js';
import { resolve } from './sources.js';
import { unpack } from './unpack.js';

export interface AppsOptions {
  gitAccess: GitAccess;
  refresh: boolean;
}

const MARKER = '.agent-sandbox-app';
/** How many apps download and unpack at once (they are big: a few at a time keeps the disk and network busy). */
const PARALLEL = 3;

export class AppInstaller {
  private readonly gui: Shortcut[] = [];
  private readonly installed: string[] = [];

  constructor(
    private readonly env: ToolEnv,
    private readonly options: AppsOptions,
    private readonly parallel = PARALLEL,
  ) {}

  /** Installs the entries (7-Zip first: the NSIS apps need it to unpack), then their shortcuts. */
  async installAll(entries: readonly AppEntry[]): Promise<void> {
    const [first, rest] = entries[0]?.id === '7zip' ? [[entries[0]], entries.slice(1)] : [[], entries];
    for (const e of first) await this.installOne(e);
    const queue = [...rest];
    await Promise.all(
      Array.from({ length: Math.min(this.parallel, queue.length) }, async () => {
        for (let e = queue.shift(); e; e = queue.shift()) await this.installOne(e);
      }),
    );
    try {
      shortcuts(this.gui);
    } catch (e) {
      warn('App shortcuts could not be created: ' + errMsg(e));
    }
    if (this.installed.length)
      this.env.summary.push(
        'apps: ' + this.installed.join(', ') + ' (shortcuts on the desktop and in Start > Sandbox apps)',
      );
  }

  private async installOne(entry: AppEntry): Promise<void> {
    try {
      const dest = tool('apps', ...entry.id.split('/'));
      if (!exists(path.join(dest, MARKER)) || this.options.refresh) await this.download(entry, dest);
      const exe = findExe(dest, entry.exe);
      if (!exe) throw new Error(entry.exe + ' not found in the download');
      await afterInstall(entry, exe);
      // A proxy or MCP server (agent add-ons) is started by the sandbox or the agent: no PATH entry, no shortcut.
      if (!entry.service && (entry.cli || entry.id === 'sysinternals')) this.env.prepend.push(path.dirname(exe));
      if (!entry.cli && !entry.service) this.gui.push({ name: entry.name, exe });
      this.installed.push(entry.name);
    } catch (e) {
      warn(
        entry.name + ' could not be installed and is skipped; the other apps are not affected. Reason: ' + errMsg(e),
      );
      this.env.summary.push(entry.name + ': FAILED');
    }
  }

  /** Downloads and unpacks one entry into its folder (replaced in one step: never half there). */
  private async download(entry: AppEntry, dest: string): Promise<void> {
    const work = stagingFolder(dest);
    const out = path.join(work, 'out');
    try {
      if ('locked' in entry.source) {
        log('Installing ' + entry.name + ' ' + entry.source.version + ' (pinned, every file checked) ...');
        await installLocked(entry.id, entry.source.locked, mkdirp(out));
      } else if ('npm' in entry.source) {
        const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
        log('Installing ' + entry.name + ' (npm) ...');
        await execAsync(process.execPath, [
          npmCli,
          'install',
          '--prefix',
          mkdirp(out),
          '--no-audit',
          '--no-fund',
          '--loglevel=error',
          entry.source.npm,
        ]);
      } else {
        const d = await resolve(entry);
        log('Downloading ' + entry.name + ' (' + d.fileName + ', ~' + entry.size + ' once) ...');
        const file = path.join(mkdirp(work), d.fileName.replace(/[\\/:*?"<>|]/g, '_'));
        await downloader.file(d.url, file, { sha256: d.sha256 ?? null });
        await unpack(entry, file, out, d);
      }
      fs.writeFileSync(path.join(out, MARKER), JSON.stringify({ id: entry.id, at: new Date().toISOString() }));
      moveIntoPlace(out, dest);
    } finally {
      safeRemove(work, path.dirname(work));
    }
  }
}

/** The Python the uv lock files were made for (sandbox\addons\<id>\requirements.txt). */
const LOCKED_PYTHON = '3.13';

/**
 * Installs a pinned package from its lock file in the launch folder (sandbox\addons\<id>) into `out`. npm: `npm ci`
 * checks every tarball against the lock file's integrity, and runs no install scripts. uv: a relocatable venv (the
 * folder moves into place afterwards) and `--require-hashes`, so every wheel must match its SHA-256 in the file; no
 * source builds.
 */
async function installLocked(id: string, kind: 'npm' | 'uv', out: string): Promise<void> {
  const lock = path.join(launchDir, 'sandbox', 'addons', id);
  if (kind === 'npm') {
    for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(lock, f), path.join(out, f));
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await execAsync(
      process.execPath,
      [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
      { cwd: out },
    );
    return;
  }
  const uv = findExe(tool('uv'), 'uv.exe');
  if (!uv) throw new Error('uv is not installed (the uv step failed)');
  const env = { ...process.env, ...uvVars() };
  const venv = path.join(out, 'venv');
  await execAsync(
    uv,
    ['venv', '--relocatable', '--python', LOCKED_PYTHON, '--python-preference', 'only-managed', venv],
    {
      env,
    },
  );
  await execAsync(
    uv,
    [
      'pip',
      'install',
      '--python',
      path.join(venv, 'Scripts', 'python.exe'),
      '--require-hashes',
      '--no-deps',
      '--only-binary',
      ':all:',
      '--link-mode',
      'copy',
      '-r',
      path.join(lock, 'requirements.txt'),
    ],
    { env },
  );
}

/** Installs apps.install and apps.custom (skipped ones are listed in the summary). */
export async function setupApps(env: ToolEnv, apps: Config['apps'], o: AppsOptions): Promise<void> {
  const { entries, skipped } = appsToInstall(apps, o.gitAccess);
  for (const s of skipped) env.summary.push('app skipped: ' + s);
  if (dryRun) {
    log('(dry run) would install apps: ' + entries.map((e) => e.name).join(', '));
    return;
  }
  await new AppInstaller(env, o).installAll(entries);
}

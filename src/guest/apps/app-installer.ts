// Installs the chosen apps into tools\apps, a few at a time, each once (a marker file says it is complete). One app
// failing is reported and never stops the others.
import fs from 'node:fs';
import path from 'node:path';
import type { Config, GitAccess } from '../../core/types.js';
import { appsToInstall, previewGuideLine, type AppEntry } from '../../shared/apps/index.js';
import { downloader, moveIntoPlace, stagingFolder } from '../../shared/download/index.js';
import { safeRemove } from '../../shared/io/safe-remove.js';
import { dryRun, launchDir } from '../runtime/paths.js';
import { execHeavy as execAsync } from '../runtime/pools.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { log, warn } from '../runtime/log.js';
import { errMsg } from '../../core/util/errors.js';
import { emptyEnv, tool, type ToolEnv } from '../toolchains/tool-env.js';
import { uvVars } from '../toolchains/runtimes.js';
import { COMET_MCP_PORT, cometShortcutArgs } from '../browser/comet.js';
import { perplexityAppShortcutArgs } from '../browser/perplexity-app.js';
import { afterInstall } from './after-install.js';
import { installFromKept } from './comet-unpack.js';
import { findExe } from './find-exe.js';
import { installStoreApp } from './store-app.js';
import { shortcuts, type Shortcut } from './shortcuts.js';
import { SYSTEM } from '../../shared/system.js';
import { signatureCheck } from '../toolchains/installers.js';
import { resolve } from './sources.js';
import { unpack } from './unpack.js';

export interface AppsOptions {
  gitAccess: GitAccess;
  refresh: boolean;
  /** Every app chosen (apps.install): one app's start-up can depend on another (Comet's port for comet-mcp). */
  chosen?: readonly string[];
}

const MARKER = '.agent-sandbox-app';

/** Where `prefetch` keeps an app's download until `download()` takes it (next to the app's folder, never inside). */
function prefetchedFile(entry: AppEntry, fileName: string): string {
  return path.join(tool('apps', ...entry.id.split('/')) + '.download', fileName.replace(/[\\/:*?"<>|]/g, '_'));
}
/** How many apps download and unpack at once (they are big: a few at a time keeps the disk and network busy). */
const PARALLEL = 3;

export class AppInstaller {
  private readonly gui: Shortcut[] = [];
  private readonly installed: string[] = [];
  private readonly installedIds: string[] = [];

  constructor(
    private readonly env: ToolEnv,
    private readonly options: AppsOptions,
    private readonly parallel = PARALLEL,
  ) {}

  /**
   * Downloads the plain downloads (not pinned, not npm, not remote) of the apps that are not installed yet, into
   * `<app folder>.download`, which `download()` uses instead of downloading again. A failure is left for the install.
   */
  async prefetch(entries: readonly AppEntry[]): Promise<void> {
    const todo = entries.filter(
      (e) =>
        !('remote' in e.source) &&
        !('locked' in e.source) &&
        !('store' in e.source) &&
        !('npm' in e.source) &&
        e.id !== '7zip' &&
        (this.options.refresh || !exists(path.join(tool('apps', ...e.id.split('/')), MARKER))),
    );
    await Promise.all(
      todo.map(async (entry) => {
        try {
          const d = await resolve(entry);
          const file = prefetchedFile(entry, d.fileName);
          if (exists(file)) return;
          await downloader.file(d.url, file, {
            sha256: d.sha256 ?? null,
            ...(entry.signer ? { verify: signatureCheck(entry.signer, d.fileName) } : {}),
          });
        } catch {
          /* the install resolves and downloads again, and reports the reason if it fails too */
        }
      }),
    );
  }

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
    const preview = previewGuideLine(this.installedIds);
    if (preview) this.env.summary.push(preview);
  }

  private async installOne(entry: AppEntry): Promise<void> {
    try {
      const dest = tool('apps', ...entry.id.split('/'));
      if ('remote' in entry.source) {
        // A remote MCP server: nothing to download, the marker only says it is set up.
        if (!exists(path.join(dest, MARKER)))
          fs.writeFileSync(
            path.join(mkdirp(dest), MARKER),
            JSON.stringify({ id: entry.id, at: new Date().toISOString() }),
          );
        this.installed.push(entry.name);
        return;
      }
      if ('store' in entry.source) {
        // A Store app: Windows in the sandbox is new on every boot, so it is installed again from the PC's package.
        log('Installing ' + entry.name + ' (Microsoft Store package) ...');
        await installStoreApp(entry.id, entry.source.store.packageName);
        fs.writeFileSync(
          path.join(mkdirp(dest), MARKER),
          JSON.stringify({ id: entry.id, at: new Date().toISOString() }),
        );
        this.gui.push({
          name: entry.name,
          exe: SYSTEM.powershell(),
          args: perplexityAppShortcutArgs(path.join(launchDir, 'sandbox', 'scripts', 'start-store-app.ps1')),
        });
        this.installed.push(entry.name);
        this.installedIds.push(entry.id);
        return;
      }
      if (!exists(path.join(dest, MARKER)) || this.options.refresh) await this.download(entry, dest);
      // A Chromium installer that could not be unpacked is kept and installed into the sandbox each boot instead.
      const exe =
        findExe(dest, entry.exe) ??
        (entry.unpack === 'chromium' && entry.signer ? await installFromKept(dest, entry.signer, entry.name) : null);
      if (!exe) throw new Error(entry.exe + ' not found in the download');
      await afterInstall(entry, exe);
      // A proxy or MCP server (agent add-ons) is started by the sandbox or the agent: no PATH entry, no shortcut.
      if (!entry.service && (entry.cli || entry.onPath || entry.id === 'sysinternals')) {
        // rustup's rust-analyzer proxy (in cargo's bin folder) only errors until its component is added.
        if (entry.id === 'rust-analyzer') this.env.prepend.unshift(path.dirname(exe));
        else this.env.prepend.push(path.dirname(exe));
      }
      if (!entry.cli && !entry.service) this.gui.push({ name: entry.name, exe, ...this.launchArgs(entry) });
      this.installed.push(entry.name);
      this.installedIds.push(entry.id);
    } catch (e) {
      warn(
        entry.name + ' could not be installed and is skipped; the other apps are not affected. Reason: ' + errMsg(e),
      );
      this.env.summary.push(entry.name + ': FAILED');
    }
  }

  /** The command line an app's shortcut starts it with (Comet: its own profile, DevTools on 127.0.0.1). */
  private launchArgs(entry: AppEntry): { args?: string } {
    if (entry.id !== 'comet') return {};
    return { args: cometShortcutArgs((this.options.chosen ?? []).includes('comet-mcp') ? COMET_MCP_PORT : 0) };
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
        const ahead = prefetchedFile(entry, d.fileName);
        if (exists(ahead)) fs.copyFileSync(ahead, file);
        else
          await downloader.file(d.url, file, {
            sha256: d.sha256 ?? null,
            ...(entry.signer ? { verify: signatureCheck(entry.signer, d.fileName) } : {}),
          });
        fs.rmSync(ahead, { force: true });
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
  await new AppInstaller(env, { ...o, chosen: apps.install }).installAll(entries);
}

/** Downloads the apps ahead of their install (the Apps step waits for Mesa, uv and the runtime first). */
export async function prefetchApps(apps: Config['apps'], o: AppsOptions): Promise<void> {
  const { entries } = appsToInstall(apps, o.gitAccess);
  if (dryRun) return;
  await new AppInstaller(emptyEnv(), { ...o, chosen: apps.install }).prefetch(entries);
}

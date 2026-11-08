// Microsoft Store apps for the sandbox (the Perplexity desktop app): this PC fetches the package files with its own
// Store tooling (native\scripts\get-store-package.ps1: winget download --source msstore, with your own Windows access;
// no account token is ever held here), keeps them in <storage>\store-packages\<product id>, and copies them into the
// data folder (tools\apps\<id>.package) where the sandbox installs them with Add-AppxPackage. The package keeps the
// publisher's signature: nothing is repacked. The files are hashed here, never trusted from the script's word.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { assertNoLinks, errMsg } from '../../core/util/index.js';
import { readValid } from '../../shared/io/index.js';
import {
  isStorePackageFile,
  STORE_PACKAGE_MANIFEST,
  StorePackageManifestSchema,
  assignStoreRoles,
  storePackageFitsX64,
  type StorePackageFile,
  type StorePackageManifest,
} from '../../shared/apps/index.js';
import { SYSTEM } from '../../shared/system.js';
import { nativeScript } from '../native.js';
import { hostDataFolder } from '../storage/contained/index.js';
import { refuseInSelfTest } from '../test-guard.js';

/** How long a fetched package is used before a launch looks for a newer one (a failed look keeps the old one). */
export const STORE_PACKAGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** The download is about 300 MB and Store servers can be slow. */
const FETCH_TIMEOUT_MS = 20 * 60 * 1000;
const READ_CHUNK = 1024 * 1024;

const ScriptResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().max(2000),
  files: z.array(z.string().max(300)).max(64),
  /** The files that came from winget's Dependencies folder (the frameworks); the rest is the app. */
  dependencies: z.array(z.string().max(300)).max(64).default([]),
});

export interface ScriptRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
/** Runs a program and collects its output; the self-test passes a fake. */
export type StoreRunner = (exe: string, args: readonly string[], timeoutMs: number) => Promise<ScriptRun>;

export const spawnStoreRunner: StoreRunner = (exe, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(exe, [...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout = (stdout + d.toString('utf8')).slice(-64 * 1024)));
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-64 * 1024)));
    child.on('error', (e) => resolve({ status: null, stdout, stderr: stderr + e.message }));
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });

/** What an app needs fetched (catalogue source.store). */
export interface StoreApp {
  readonly id: string;
  /** The name the notes use (the catalogue's); the id when not given. */
  readonly name?: string;
  readonly productId: string;
  readonly packageName: string;
}

export interface StoreStaging {
  readonly storageRoot: string;
  readonly dataPath: string;
  readonly run?: StoreRunner;
  readonly now?: () => number;
}

function sha256Of(file: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(READ_CHUNK);
    for (
      let n = fs.readSync(fd, chunk, 0, chunk.length, null);
      n > 0;
      n = fs.readSync(fd, chunk, 0, chunk.length, null)
    )
      hash.update(chunk.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Where the data folder keeps an app's package for the sandbox. */
export function stagedPackageDir(dataPath: string, appId: string): string {
  return path.join(hostDataFolder(dataPath, 'tools'), 'apps', appId + '.package');
}

export class StorePackages {
  constructor(private readonly o: StoreStaging) {}

  cacheDir(productId: string): string {
    return path.join(this.o.storageRoot, 'store-packages', productId);
  }

  /** The cached package when its files are all there at the size hashed; null otherwise. */
  cached(productId: string): StorePackageManifest | null {
    const dir = this.cacheDir(productId);
    const manifest = readValid(StorePackageManifestSchema, path.join(dir, STORE_PACKAGE_MANIFEST));
    if (!manifest || manifest.productId !== productId) return null;
    const complete = manifest.files.every((f) => {
      try {
        return fs.statSync(path.join(dir, f.name)).size === f.bytes;
      } catch {
        return false; // A file is gone: fetch again.
      }
    });
    return complete ? manifest : null;
  }

  private fresh(m: StorePackageManifest): boolean {
    const at = Date.parse(m.fetchedAt);
    return Number.isFinite(at) && (this.o.now?.() ?? Date.now()) - at < STORE_PACKAGE_MAX_AGE_MS;
  }

  /** Fetches the package into the cache with this PC's Store tooling and returns what was kept. */
  async fetch(app: StoreApp): Promise<StorePackageManifest> {
    const run = this.o.run ?? spawnStoreRunner;
    if (!this.o.run) refuseInSelfTest('download from the Microsoft Store');
    const work = this.cacheDir(app.productId) + '.new';
    fs.rmSync(work, { recursive: true, force: true });
    const out = await run(
      SYSTEM.powershell(),
      nativeScript('get-store-package.ps1', [
        '-ProductId',
        app.productId,
        '-PackageName',
        app.packageName,
        '-OutDir',
        work,
      ]),
      FETCH_TIMEOUT_MS,
    );
    try {
      return this.keep(app, work, out);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  /** Checks what the script fetched into `work`, hashes it and moves it into the cache. */
  private keep(app: StoreApp, work: string, out: ScriptRun): StorePackageManifest {
    const line = out.stdout.trim().split(/\r?\n/).pop() ?? '';
    let parsed: z.output<typeof ScriptResultSchema>;
    try {
      parsed = ScriptResultSchema.parse(JSON.parse(line));
    } catch {
      throw new Error('the Store tooling gave no answer' + (out.stderr ? ': ' + out.stderr.trim().slice(0, 200) : ''));
    }
    if (!parsed.ok) throw new Error(parsed.message);
    const frameworks = new Set(parsed.dependencies.map((n) => n.toLowerCase()));
    // Only the builds that run on this sandbox (64-bit): the 32-bit and ARM frameworks winget may add are left out.
    const names = parsed.files.filter(
      (n) =>
        isStorePackageFile(n) &&
        n === path.basename(n) &&
        fs.existsSync(path.join(work, n)) &&
        !(frameworks.has(n.toLowerCase()) && !storePackageFitsX64(n)),
    );
    const files: StorePackageFile[] = assignStoreRoles(names, app.packageName, parsed.dependencies).map(
      ({ name, role }) => {
        const full = path.join(work, name);
        return { name, role, sha256: sha256Of(full), bytes: fs.statSync(full).size };
      },
    );
    const manifest = StorePackageManifestSchema.parse({
      productId: app.productId,
      fetchedAt: new Date(this.o.now?.() ?? Date.now()).toISOString(),
      files,
    });
    fs.writeFileSync(path.join(work, STORE_PACKAGE_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
    const dest = this.cacheDir(app.productId);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(work, dest);
    return manifest;
  }

  /** The package to use: the cache when fresh, else a new fetch (the old one stands when that fails). */
  async ensure(app: StoreApp): Promise<{ manifest: StorePackageManifest; note: string }> {
    const have = this.cached(app.productId);
    if (have && this.fresh(have)) return { manifest: have, note: 'kept from ' + have.fetchedAt.slice(0, 10) };
    try {
      return { manifest: await this.fetch(app), note: 'downloaded' };
    } catch (e) {
      if (have) return { manifest: have, note: 'kept (a newer one could not be fetched: ' + errMsg(e) + ')' };
      throw e;
    }
  }

  /** Copies the cached package into the data folder for the sandbox (files already there at the same size stay). */
  stage(app: StoreApp, manifest: StorePackageManifest): string {
    const tools = hostDataFolder(this.o.dataPath, 'tools');
    const dest = stagedPackageDir(this.o.dataPath, app.id);
    fs.mkdirSync(path.join(tools, 'apps'), { recursive: true });
    assertNoLinks(tools, dest);
    fs.mkdirSync(dest, { recursive: true });
    const wanted = new Set(manifest.files.map((f) => f.name.toLowerCase()));
    for (const name of fs.readdirSync(dest)) {
      if (name !== STORE_PACKAGE_MANIFEST && !wanted.has(name.toLowerCase()))
        fs.rmSync(path.join(dest, name), { recursive: true, force: true });
    }
    const source = this.cacheDir(manifest.productId);
    for (const f of manifest.files) {
      const target = path.join(dest, f.name);
      assertNoLinks(tools, target);
      let same = false;
      try {
        same = fs.statSync(target).size === f.bytes;
      } catch {
        same = false; // Not there yet.
      }
      if (!same) fs.copyFileSync(path.join(source, f.name), target);
    }
    fs.writeFileSync(path.join(dest, STORE_PACKAGE_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
    return dest;
  }
}

/**
 * For a launch: every Store app chosen gets its package fetched (or kept) and staged. A failure never stops the launch:
 * it is a note, and the sandbox skips that app.
 */
export async function prepareStorePackages(
  apps: readonly StoreApp[],
  o: StoreStaging,
): Promise<{ readonly notes: readonly string[] }> {
  const notes: string[] = [];
  const packages = new StorePackages(o);
  for (const app of apps) {
    try {
      const { manifest, note } = await packages.ensure(app);
      packages.stage(app, manifest);
      notes.push(app.id + ': package ' + note + ' (' + manifest.files.length + ' files)');
    } catch (e) {
      notes.push(
        (app.name ?? app.id) +
          ': NOT installed in this sandbox. ' +
          errMsg(e).replace(/\.$/, '') +
          '. Fix: sign in to the Microsoft Store on this PC and check that winget works (winget download --id ' +
          app.productId +
          ' --source msstore --architecture x64 --download-directory <an empty folder>), then launch again.',
      );
    }
  }
  return { notes };
}

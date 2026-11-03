// Go from go.dev (checksum-verified zip). Modules, build cache and `go install` binaries live in persistent storage;
// GOTOOLCHAIN=auto lets a go.mod that needs a newer Go fetch it itself.
import fs from 'node:fs';
import path from 'node:path';
import type { Toolchains } from '../../../core/types.js';
import { downloader, fetchJson } from '../../../shared/download/index.js';
import { dryRun } from '../../runtime/paths.js';
import { execHeavy as execAsync } from '../../runtime/pools.js';
import { exists } from '../../runtime/fs.js';
import { log } from '../../runtime/log.js';
import { arch, tool, versionOf, type ToolEnv } from '../tool-env.js';
import { installOnce } from '../package-ledger.js';
import { resolveCached } from '../version-cache.js';
import { pickGoRelease, type GoRelease } from '../../../core/detect/versions.js';

const findRelease = async (spec: string): Promise<GoRelease> =>
  pickGoRelease(await fetchJson<GoRelease[]>('https://go.dev/dl/?mode=json&include=all'), spec) ??
  Promise.reject(new Error('No Go release matches "' + spec + '"'));

export async function setupGo(env: ToolEnv, config: Toolchains['go']): Promise<void> {
  if (dryRun) {
    log('(dry run) would provision Go ' + config.version);
    return;
  }
  const version = await resolveCached('go:' + config.version, async () => (await findRelease(config.version)).version);
  const root = tool('go', version);
  if (!exists(path.join(root, 'bin', 'go.exe'))) {
    const goArch = arch === 'arm64' ? 'arm64' : 'amd64';
    const file = (await findRelease(version)).files.find(
      (f) => f.os === 'windows' && f.arch === goArch && f.kind === 'archive',
    );
    if (!file) throw new Error(version + ' has no Windows ' + goArch + ' zip');
    log('Downloading Go ' + version.replace(/^go/, '') + ' (~80 MB once) ...');
    await downloader.archive('https://go.dev/dl/' + file.filename, root, {
      sha256: file.sha256,
      locate: 'VERSION',
      fileName: file.filename,
    });
  }
  const GOPATH = tool('go-path');
  const vars = {
    GOROOT: root,
    GOPATH,
    GOBIN: path.join(GOPATH, 'bin'),
    GOMODCACHE: path.join(GOPATH, 'pkg', 'mod'),
    GOCACHE: tool('go-cache'),
    GOTOOLCHAIN: 'auto',
    GOTELEMETRY: 'off',
  };
  fs.mkdirSync(vars.GOBIN, { recursive: true });
  Object.assign(env.vars, vars);
  env.prepend.push(path.join(root, 'bin'), vars.GOBIN);
  const go = path.join(root, 'bin', 'go.exe');
  env.summary.push('go: ' + versionOf(go, ['version']));
  await installOnce(env, 'go', config.tools, (pkg) =>
    execAsync(go, ['install', pkg.includes('@') ? pkg : pkg + '@latest'], { env: { ...process.env, ...vars } }),
  );
}

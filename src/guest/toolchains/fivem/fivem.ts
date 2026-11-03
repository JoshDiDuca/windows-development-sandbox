// FiveM / RedM (toolchains.fivem): FXServer (txAdmin is bundled) into tools\fivem\artifacts\<build>, kept between
// sandboxes (keepVersions of them), txData in state\fivem, and sbx-fivem to run it. Installs only once you accept the
// Cfx.re terms (acceptLicense). The build comes from toolchains.fivem.artifact, or from `sbx-fivem artifact use`
// (remembered in state\fivem\artifact.json). The artifacts have no checksums: see artifacts.ts for the signature rule.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Toolchains } from '../../../core/types.js';
import { downloader, extractArchive } from '../../../shared/download/index.js';
import { readValid, writeJsonAtomic } from '../../../shared/io/json.js';
import { safeRemove } from '../../../shared/io/safe-remove.js';
import { dryRun, toolsDir } from '../../runtime/paths.js';
import { errMsg } from '../../../core/util/errors.js';
import { log, warn } from '../../runtime/log.js';
import { stateDir } from '../../runtime/session.js';
import { signatureOf } from '../signature.js';
import { ensurePersisted, installRecords, type Installed } from '../persisted.js';
import type { ToolCtx } from '../step.js';
import type { ToolEnv } from '../tool-env.js';
import { resolveCached } from '../version-cache.js';
import { cfxSecretsFile } from '../../accounts/kinds/cfx.js';
import { artifactSetting, artifactTrust, pickArtifact, type FivemArtifact } from './artifacts.js';

export const ARTIFACTS_NAME = 'fivem/artifacts';
const MB = 1024 * 1024;
/** Room a build needs while installing: the zip (~65 MB) and its unpacked copy (~200 MB). */
const NEED_BYTES = 600 * MB;
const LICENCE =
  'The FiveM server is installed only with toolchains.fivem.acceptLicense = true: FXServer comes under the Cfx.re platform terms (https://fivem.net/terms) and its licence';

const ArtifactSchema = z.strictObject({
  build: z.number().int().positive(),
  url: z.string().url().startsWith('https://runtime.fivem.net/'),
  channel: z.enum(['recommended', 'optional', 'latest', 'critical']).optional(),
  txAdmin: z.string().max(32).optional(),
});
const SelectionSchema = z.strictObject({
  artifact: z.string().regex(/^(recommended|optional|latest|critical|\d{1,7})$/),
  build: z.number().int().positive(),
});

/** state\fivem: txData and the build chosen with sbx-fivem artifact use. */
export function fivemStateDir(): string {
  return path.join(stateDir, 'fivem');
}
export function txDataDir(): string {
  return path.join(fivemStateDir(), 'txData');
}
const selectionFile = (): string => path.join(fivemStateDir(), 'artifact.json');

export function artifactDir(build: number): string {
  return path.join(toolsDir, ...ARTIFACTS_NAME.split('/'), String(build));
}

/** The secrets cfg FXServer +execs, when this boot handed a Cfx.re key over. */
export function secretsCfg(): string | null {
  const file = cfxSecretsFile();
  return fs.existsSync(file) ? file : null;
}

/** The build chosen with `sbx-fivem artifact use` (and the one it was then), or the setting. */
export function chosenArtifact(setting: string): { setting: string; chosen: boolean; build: number | null } {
  const picked = readValid(SelectionSchema, selectionFile());
  return picked
    ? { setting: picked.artifact, chosen: true, build: picked.build }
    : { setting, chosen: false, build: null };
}

/** Remembers a choice for sbx-fivem serve and the next boots (null: back to toolchains.fivem.artifact). */
export function rememberArtifact(choice: { artifact: string; build: number } | null): void {
  if (choice === null) {
    fs.rmSync(selectionFile(), { force: true });
    return;
  }
  fs.mkdirSync(fivemStateDir(), { recursive: true });
  writeJsonAtomic(selectionFile(), SelectionSchema.parse(choice));
}

/** The build sbx-fivem serve runs: the one chosen last, this boot's, or the newest installed. */
export function servingBuildDir(): string | null {
  const chosen = chosenArtifact('recommended').build;
  const candidates = [
    chosen === null ? null : artifactDir(chosen),
    process.env.FXSERVER_DIR ?? null,
    ...installedBuilds().map(artifactDir),
  ];
  return candidates.find((d): d is string => d !== null && fs.existsSync(path.join(d, 'FXServer.exe'))) ?? null;
}

/** Builds installed in tools\fivem\artifacts (newest first). */
export function installedBuilds(): number[] {
  return installRecords()
    .filter((r) => r.name === ARTIFACTS_NAME && /^\d+$/.test(r.version))
    .map((r) => Number(r.version))
    .filter((b) => fs.existsSync(path.join(artifactDir(b), 'FXServer.exe')))
    .sort((a, b) => b - a);
}

/**
 * The build a setting names: looked up online at most once a day (offline: the one remembered, else the newest
 * installed for a channel, the installed one for a number).
 */
export async function resolveArtifact(setting: string, live = false): Promise<FivemArtifact> {
  const want = artifactSetting(setting);
  if (want === null)
    throw new Error('"' + setting + '" is not a server build (recommended, optional, latest or a number)');
  const lookup = async (): Promise<string> => {
    const found = await pickArtifact(setting);
    if (!found) throw new Error('there is no FXServer build ' + setting + ' for Windows');
    return JSON.stringify(found);
  };
  try {
    return ArtifactSchema.parse(JSON.parse(live ? await lookup() : await resolveCached('fivem:' + setting, lookup)));
  } catch (e) {
    const installed = installedBuilds();
    const fallback = typeof want === 'number' ? installed.find((b) => b === want) : installed[0];
    if (fallback === undefined) throw e;
    warn('Could not look up FXServer ' + setting + ' (' + errMsg(e) + '); using installed build ' + fallback);
    return { build: fallback, url: 'https://runtime.fivem.net/' };
  }
}

/** Downloads and unpacks a build into `staging`; refuses it per artifactTrust. */
async function installBuild(a: FivemArtifact, staging: string, temp: string): Promise<void> {
  const zip = path.join(temp, 'server.zip');
  const check = path.join(temp, 'check');
  // requireChecksum: the signature on FXServer.exe stands in for the checksum Cfx.re does not publish.
  const verify = async (file: string): Promise<void> => {
    await extractArchive(file, check, ['FXServer.exe']);
    const exe = path.join(check, 'FXServer.exe');
    if (artifactTrust(true, fs.existsSync(exe) ? (signatureOf(exe)?.subject ?? '') : '') !== 'signed')
      throw new Error(
        'FXServer build ' +
          a.build +
          ': FXServer.exe is not validly signed by Rockstar Games, and downloads.requireChecksum is on (Cfx.re publishes no checksums)',
      );
    safeRemove(check, temp);
  };
  log('Downloading FXServer build ' + a.build + ' (~65 MB once) ...');
  await downloader.file(a.url, zip, downloader.requireChecksum ? { verify } : null);
  await extractArchive(zip, staging);
  fs.rmSync(zip, { force: true });
  const exe = path.join(staging, 'FXServer.exe');
  const trust = artifactTrust(downloader.requireChecksum, fs.existsSync(exe) ? (signatureOf(exe)?.subject ?? '') : '');
  if (trust === 'refused') throw new Error('FXServer build ' + a.build + ' is not validly signed; not using it');
  if (trust === 'unsigned-allowed')
    warn(
      'FXServer build ' +
        a.build +
        ': FXServer.exe has no valid Rockstar Games signature (used anyway: downloads.requireChecksum is off)',
    );
}

/** The build's folder, installed when it is not there yet. */
export async function installArtifact(a: FivemArtifact, keepVersions: number): Promise<Installed> {
  return ensurePersisted(
    {
      name: ARTIFACTS_NAME,
      version: String(a.build),
      needBytes: NEED_BYTES,
      marker: 'FXServer.exe',
      what: 'FXServer build ' + a.build,
      keepVersions,
    },
    (staging, temp) => installBuild(a, staging, temp),
    { log },
  );
}

export async function setupFivem(env: ToolEnv, config: Toolchains['fivem'], _ctx: ToolCtx): Promise<void> {
  if (!config.acceptLicense) throw new Error(LICENCE);
  const { setting, chosen } = chosenArtifact(config.artifact);
  if (dryRun) {
    log('(dry run) would install FXServer ' + setting + ' into tools\\fivem\\artifacts');
    return;
  }
  const artifact = await resolveArtifact(setting);
  const installed = await installArtifact(artifact, config.keepVersions);
  fs.mkdirSync(txDataDir(), { recursive: true });
  env.vars.FXSERVER_DIR = installed.dir;
  env.vars.FIVEM_GAME = config.game;
  env.summary.push(
    'fivem: FXServer build ' +
      artifact.build +
      ' (' +
      (chosen ? setting + ', chosen with sbx-fivem artifact use' : setting) +
      (config.game === 'rdr3' ? ', RedM' : '') +
      '); start it with sbx-fivem serve' +
      (secretsCfg() ? '' : ' (no Cfx.re key: sandbox account login cfx on your PC)'),
  );
}

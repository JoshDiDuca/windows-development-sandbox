// Real installers and signed downloads: a vendor's installer is kept in tools\ (downloaded once) and run only when its
// Authenticode signature names the vendor; a file with a bad signature is deleted, and fetched again next boot.
import fs from 'node:fs';
import path from 'node:path';
import { downloader } from '../../shared/download/index.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { log } from '../runtime/log.js';
import { MICROSOFT_SIGNER, signerOf } from './native/vcruntime.js';

/** Who signs the installers the toolchains run (the subject of the signature). */
export const SIGNERS = {
  microsoft: MICROSOFT_SIGNER,
  valve: /^CN="?Valve(,| Corp)/,
  unity: /^CN="?Unity Technologies/,
} as const;

/** Whether a file's signature is the expected signer's. */
export function signedBy(file: string, signer: string | RegExp): boolean {
  const subject = signerOf(file);
  return typeof signer === 'string' ? subject === signer : signer.test(subject);
}

/** A downloader `verify` hook: refuses a file not signed by `signer` (it counts as integrity for requireChecksum). */
export function signatureCheck(signer: string | RegExp, what: string): (file: string) => void {
  return (file) => {
    if (!signedBy(file, signer)) throw new Error(what + ' is not signed by its vendor');
  };
}

/** The installer at `file` (downloaded once from `url`), checked against its signer and, when given, its SHA-256. */
export async function signedInstaller(
  url: string,
  file: string,
  what: string,
  signer: string | RegExp,
  sha256: string | null = null,
): Promise<string> {
  if (!exists(file)) {
    log('Downloading ' + what + ' ...');
    mkdirp(path.dirname(file));
    await downloader.file(url, file, { sha256, verify: signatureCheck(signer, path.basename(file)) });
  }
  if (!signedBy(file, signer)) {
    fs.rmSync(file, { force: true });
    throw new Error(
      path.basename(file) + ' is not signed by its vendor; deleted it (it is downloaded again next boot)',
    );
  }
  return file;
}

// The package files of a Store app the PC left in the data folder, checked against the SHA-256 in store-package.json.
// No runtime imports: the self-test loads this file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STORE_PACKAGE_MANIFEST, StorePackageManifestSchema } from '../../shared/apps/store-package.js';
import { readValid } from '../../shared/io/json.js';

const READ_CHUNK = 1024 * 1024;

/** The SHA-256 of a file, read in pieces (the package is hundreds of MB). */
export function fileSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file, { highWaterMark: READ_CHUNK });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export interface CheckedPackage {
  readonly main: string;
  readonly dependencies: string[];
}

/** Why a Store app has no package here, and what to do (the PC's launch notes say what went wrong there). */
export const MISSING_PACKAGE =
  'this PC did not hand over its package (it could not fetch it: see the launch notes). Fix: on this PC run "winget download --id <product id> --source msstore", then launch again';

/** The package in `dir` when its manifest is valid and every file is there as hashed; throws otherwise. */
export async function checkedPackage(dir: string): Promise<CheckedPackage> {
  const manifest = readValid(StorePackageManifestSchema, path.join(dir, STORE_PACKAGE_MANIFEST));
  if (!manifest) throw new Error(MISSING_PACKAGE);
  for (const f of manifest.files) {
    if ((await fileSha256(path.join(dir, f.name)).catch(() => '')) !== f.sha256)
      throw new Error(f.name + ' is missing or changed');
  }
  const full = (name: string): string => path.join(dir, name);
  return {
    main: full(manifest.files.find((f) => f.role === 'main')!.name),
    dependencies: manifest.files.filter((f) => f.role === 'dependency').map((f) => full(f.name)),
  };
}

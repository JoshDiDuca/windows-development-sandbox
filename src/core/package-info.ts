// Where this package is installed and its version. This file is dist/core/package-info.js, two folders below
// package.json, or bundled into a chunk in dist/bin (scripts/bundle.mjs), also two folders below.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { tryReadJson } from './util/index.js';

/** The package folder (the one with package.json, dist/, sandbox/ and schemas/). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** This package's version. */
export function packageVersion(): string {
  const file = path.join(PACKAGE_ROOT, 'package.json');
  return z.object({ version: z.string() }).safeParse(tryReadJson(file)).data?.version ?? 'unknown';
}

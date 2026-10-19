import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LocalConfigFile } from '../types.js';
import { fail, fileExists, parseJsonc } from '../util/index.js';

export const LOCAL_CONFIG_NAME = '.sandbox-config.json';
const MAX_LOCAL_CONFIG_BYTES = 1024 * 1024;

export function readLocalConfig(dir: string): LocalConfigFile | null {
  const file = path.join(dir, LOCAL_CONFIG_NAME);
  if (!fileExists(file)) return null;
  // One handle for the size check and the read (the hash covers exactly the bytes parsed); a repo's file over 1 MB is
  // refused, not loaded.
  const fd = fs.openSync(file, 'r');
  let raw: Buffer;
  try {
    const size = fs.fstatSync(fd).size;
    if (size > MAX_LOCAL_CONFIG_BYTES)
      fail(file + ' is over 1 MB, so it is not read.', 'Make it smaller, or start with --no-local-config.');
    raw = Buffer.alloc(size);
    fs.readSync(fd, raw, 0, size, 0);
  } finally {
    fs.closeSync(fd);
  }
  return {
    path: file,
    hash: crypto.createHash('sha256').update(raw).digest('hex'),
    data: parseJsonc<unknown>(raw.toString('utf8'), file),
  };
}

import fs from 'node:fs';
import { writeJsonAtomic } from '../../shared/io/index.js';

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}
export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
export function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
/** fileExists without blocking the program (the menu looks for programs while it stays responsive). */
export async function fileExistsAsync(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}
/**
 * A file the sandbox or a repo may have written, read through one handle and only if that handle is a regular file of
 * at most `maxBytes` (null otherwise): a multi-gigabyte .nvmrc must not stop a launch.
 */
export function readSmallFile(file: string, maxBytes = 256 * 1024): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(stat.size);
    fs.readSync(fd, buffer, 0, stat.size, 0);
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
export function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as T;
}
export function tryReadJson<T>(p: string): T | null {
  try {
    return readJson<T>(p);
  } catch {
    return null;
  }
}
/** Atomic (a crash or a second command never leaves half a file); refused outside temp during the self-test. */
export function writeJson(p: string, value: unknown): void {
  return writeJsonAtomic(p, value);
}
export function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

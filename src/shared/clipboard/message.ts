// The text clipboard bridge's file format (sandbox.clipboard "text"): one small JSON file per direction, holding the
// text as base64 and its hash. Whatever the other side wrote is checked here before it is used: shape, base64, UTF-8,
// size and hash. Built-ins, zod and shared/io only (the guest bundles this).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { readBoundedFile } from '../io/index.js';

export const CLIPBOARD_MAX_BYTES = 1024 * 1024;
export const CLIPBOARD_BASE64_MAX = 4 * Math.ceil(CLIPBOARD_MAX_BYTES / 3);
export const CLIPBOARD_FILE_MAX_BYTES = 1_500_000;
/** The longest line a helper may print. */
export const CLIPBOARD_LINE_MAX = 1_500_000;

export const ClipboardFileSchema = z.strictObject({
  v: z.literal(1),
  text: z
    .string()
    .max(CLIPBOARD_BASE64_MAX)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ClipboardFile = z.output<typeof ClipboardFileSchema>;

/** sha256 (hex) of the text's UTF-8 bytes. */
export function textHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The text as base64, or null when it is over the limit or holds a NUL. */
export function toBase64Text(text: string): string | null {
  if (text.includes('\0')) return null;
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length > CLIPBOARD_MAX_BYTES ? null : bytes.toString('base64');
}

/** The text of canonical base64 holding valid UTF-8 within the limit and no NUL; null otherwise. */
export function fromBase64Text(b64: string): string | null {
  if (b64.length > CLIPBOARD_BASE64_MAX || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.toString('base64') !== b64 || bytes.length > CLIPBOARD_MAX_BYTES) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\0') ? null : text;
  } catch {
    // Not UTF-8: not text.
    return null;
  }
}

export function clipboardFile(text: string): ClipboardFile | null {
  const b64 = toBase64Text(text);
  return b64 === null ? null : { v: 1, text: b64, sha256: textHash(text) };
}

/** The text of a file the other side wrote: shape, base64, UTF-8, size and hash checked; null otherwise. */
export function openClipboardFile(value: unknown): { text: string; hash: string } | null {
  const parsed = ClipboardFileSchema.safeParse(value);
  if (!parsed.success) return null;
  const text = fromBase64Text(parsed.data.text);
  if (text === null) return null;
  const hash = textHash(text);
  return hash === parsed.data.sha256 ? { text, hash } : null;
}

/** Reads (bounded, never through a link) and deletes the file; the checked text or null. */
export function takeClipboardFile(file: string): { text: string; hash: string } | null {
  try {
    const bytes = readBoundedFile(file, CLIPBOARD_FILE_MAX_BYTES);
    if (!bytes) return null;
    try {
      const text = bytes.toString('utf8');
      return openClipboardFile(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
    } catch {
      // Not JSON: dropped.
      return null;
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
}

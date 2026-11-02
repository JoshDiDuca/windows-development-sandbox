// An app download's Authenticode signature (sandbox\scripts\get-signature.ps1), checked against the signer its
// catalogue entry names (AppEntry.signer): for vendors that publish no checksum, the signature is the integrity.
import { z } from 'zod';
import { signerMatches, type AppSigner, type Signature } from '../../shared/apps/index.js';
import { scriptOutput } from '../runtime/process.js';

const SignatureSchema = z.object({ subject: z.string().max(4096), issuer: z.string().max(4096) });

/** The names on a file's valid signature, or null when it is unsigned, tampered with, or cannot be read. */
export function signatureOf(file: string): Signature | null {
  const text = scriptOutput('get-signature.ps1', ['-Path', file]).trim();
  if (!text) return null;
  try {
    const parsed = SignatureSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // Not the script's JSON: treated as unsigned.
  }
}

/** A downloader `verify` hook: refuses a file `signer` did not sign (it counts as integrity for requireChecksum). */
export function signerCheck(signer: AppSigner, what: string): (file: string) => void {
  return (file) => {
    if (!signerMatches(signatureOf(file), signer)) throw new Error(what + ' is not signed by its vendor');
  };
}

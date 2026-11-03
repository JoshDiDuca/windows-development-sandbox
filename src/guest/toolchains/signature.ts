// A file's Authenticode signature (sandbox\scripts\get-signature.ps1) checked against the signer a download names.
import { z } from 'zod';
import { signerMatches, type AppSigner, type Signature } from '../../shared/signer.js';
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

/** Whether a file's valid signature is the expected signer's. */
export function signedBy(file: string, signer: AppSigner): boolean {
  return signerMatches(signatureOf(file), signer);
}

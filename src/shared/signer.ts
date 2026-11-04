// Who must sign an app's download (AppEntry.signer), for vendors that publish no checksum: the Authenticode subject
// and issuer as patterns, checked against what sandbox\scripts\get-signature.ps1 reports for a valid signature. Pure.

/** Patterns (regex sources, case-insensitive) the signature's subject and issuer must match; every one of them. */
export interface AppSigner {
  readonly subject: readonly string[];
  readonly issuer?: readonly string[];
}

/** A valid Authenticode signature's certificate names (an invalid or missing one is reported as null). */
export interface Signature {
  readonly subject: string;
  readonly issuer: string;
}

/** Whether a signature is the expected signer's: every subject and issuer pattern matches. */
export function signerMatches(signature: Signature | null, signer: AppSigner): boolean {
  if (!signature || !signature.subject) return false;
  const all = (text: string, patterns: readonly string[]): boolean =>
    patterns.every((p) => new RegExp(p, 'i').test(text));
  return all(signature.subject, signer.subject) && all(signature.issuer, signer.issuer ?? []);
}

/** Who signs the installers the toolchains run (the patterns the signature's subject must match). */
export const SIGNERS = {
  microsoft: { subject: ['^CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US$'] },
  valve: { subject: ['^CN="?Valve(,| Corp)'] },
  unity: { subject: ['^CN="?Unity Technologies'] },
  /** The Epic Games Launcher's MSI (checked on EpicInstaller-20.3.3.msi). */
  epic: { subject: ['^CN=Epic Games Inc\\., O=Epic Games Inc\\., L=Cary, S=North Carolina, C=US'] },
} as const satisfies Record<string, AppSigner>;

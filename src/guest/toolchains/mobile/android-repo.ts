// The Android SDK repository (repository2-3.xml): each package's archive for Windows with its SHA-1, and the packages
// the sandbox refuses (the emulator and system images: Windows Sandbox cannot run them). Not available yet.

export interface RepoPackage {
  /** The sdkmanager path: platforms;android-35, build-tools;35.0.0 ... */
  readonly path: string;
  readonly url: string;
  readonly sha1: string;
  readonly sizeBytes: number;
}

/** The packages of a repository XML text (bounded); none when it cannot be read. */
export function parseRepository(_xml: string): RepoPackage[] {
  return [];
}

/** Why a package is refused, or null when it may be installed. */
export function refusedPackage(path: string): string | null {
  return /^(emulator|system-images;)/.test(path) ? 'Windows Sandbox cannot run the Android emulator' : null;
}

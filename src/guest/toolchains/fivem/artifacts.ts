// FXServer builds (the Cfx.re artifacts): which build "recommended", "optional", "latest" or a number means, from
// changelogs-live.fivem.net/api/changelog/versions/win32/server. No checksums are published: the download is refused
// under downloads.requireChecksum unless FXServer.exe is signed. Not available yet.

export interface FivemArtifact {
  readonly build: number;
  readonly url: string;
}

/** The build an artifact setting names, or null when it cannot be told. */
export async function pickArtifact(_setting: string): Promise<FivemArtifact | null> {
  return null;
}

// FXServer builds (the Cfx.re artifacts): which build "recommended", "optional", "latest" or a number means, from
// changelogs-live.fivem.net/api/changelog/versions/win32/server (a pinned build that is no channel's is looked up on
// the artifacts page). No checksums are published: under downloads.requireChecksum a build is used only when its
// FXServer.exe carries a valid Authenticode signature from Rockstar Games (Cfx.re's owner); without that setting an
// unsigned one is used with a warning. No runtime imports: the self-test loads this file.
import { z } from 'zod';
import { fetchJson, fetchText } from '../../../shared/download/index.js';

export const VERSIONS_URL = 'https://changelogs-live.fivem.net/api/changelog/versions/win32/server';
export const ARTIFACTS_PAGE = 'https://runtime.fivem.net/artifacts/fivem/build_server_windows/master/';
/** The subject of the signature on FXServer.exe (checked on build 35245, 2026-11). */
export const FXSERVER_SIGNER = /^CN="?Rockstar Games, Inc\.?"?, O="?Rockstar Games, Inc\.?"?,/;

export const CHANNELS = ['recommended', 'optional', 'latest', 'critical'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface FivemArtifact {
  readonly build: number;
  readonly url: string;
  /** The channel that names it, when one does. */
  readonly channel?: Channel;
  /** The txAdmin version it bundles, when the versions API says. */
  readonly txAdmin?: string;
}

const BUILD = z.string().regex(/^\d{1,7}$/);
const DOWNLOAD = z
  .string()
  .max(512)
  .regex(/^https:\/\/runtime\.fivem\.net\/artifacts\/fivem\/build_server_windows\/[A-Za-z0-9_./-]+\.(zip|7z)$/);
const TXADMIN = z.string().max(32).optional();

/** The versions API's answer (its other fields, such as support_policy, are not needed). */
export const VersionsSchema = z.object({
  recommended: BUILD,
  recommended_download: DOWNLOAD,
  recommended_txadmin: TXADMIN,
  optional: BUILD,
  optional_download: DOWNLOAD,
  optional_txadmin: TXADMIN,
  latest: BUILD,
  latest_download: DOWNLOAD,
  latest_txadmin: TXADMIN,
  critical: BUILD,
  critical_download: DOWNLOAD,
  critical_txadmin: TXADMIN,
});

/** Every channel's build, from the versions API's JSON (throws on any other shape). */
export function parseVersions(json: unknown): Record<Channel, FivemArtifact> {
  const v = VersionsSchema.parse(json);
  const one = (channel: Channel, build: string, url: string, txAdmin: string | undefined): FivemArtifact => ({
    build: Number(build),
    url,
    channel,
    ...(txAdmin ? { txAdmin } : {}),
  });
  return {
    recommended: one('recommended', v.recommended, v.recommended_download, v.recommended_txadmin),
    optional: one('optional', v.optional, v.optional_download, v.optional_txadmin),
    latest: one('latest', v.latest, v.latest_download, v.latest_txadmin),
    critical: one('critical', v.critical, v.critical_download, v.critical_txadmin),
  };
}

const MAX_PAGE = 4 * 1024 * 1024;

/** The builds the artifacts page links to (newest first), as server.zip downloads. Reads at most 4 MB of it. */
export function parseArtifactsPage(html: string): FivemArtifact[] {
  const seen = new Map<number, FivemArtifact>();
  for (const m of html.slice(0, MAX_PAGE).matchAll(/\b(\d{3,7})-([0-9a-f]{40})\/server\.(?:zip|7z)\b/g)) {
    const build = Number(m[1]);
    if (!seen.has(build)) seen.set(build, { build, url: ARTIFACTS_PAGE + m[1] + '-' + m[2] + '/server.zip' });
  }
  return [...seen.values()].sort((a, b) => b.build - a.build);
}

/** What a setting names: a channel, or a build number. */
export function artifactSetting(setting: string): Channel | number | null {
  if ((CHANNELS as readonly string[]).includes(setting)) return setting as Channel;
  return /^\d{1,7}$/.test(setting) ? Number(setting) : null;
}

/** The build a setting names among the channels and the page's builds, or null. */
export function chooseArtifact(
  setting: string,
  channels: Record<Channel, FivemArtifact>,
  page: readonly FivemArtifact[] = [],
): FivemArtifact | null {
  const want = artifactSetting(setting);
  if (want === null) return null;
  if (typeof want === 'string') return channels[want];
  return Object.values(channels).find((a) => a.build === want) ?? page.find((a) => a.build === want) ?? null;
}

export interface ArtifactSources {
  readonly versions?: () => Promise<unknown>;
  readonly page?: () => Promise<string>;
}

/** The channels from the versions API. */
export async function fetchChannels(src: ArtifactSources = {}): Promise<Record<Channel, FivemArtifact>> {
  return parseVersions(await (src.versions ?? (() => fetchJson<unknown>(VERSIONS_URL)))());
}

/** The build an artifact setting names, or null when it cannot be told. */
export async function pickArtifact(setting: string, src: ArtifactSources = {}): Promise<FivemArtifact | null> {
  const want = artifactSetting(setting);
  if (want === null) return null;
  const channels = await fetchChannels(src);
  const found = chooseArtifact(setting, channels);
  if (found || typeof want === 'string') return found;
  return chooseArtifact(setting, channels, parseArtifactsPage(await (src.page ?? (() => fetchText(ARTIFACTS_PAGE)))()));
}

export type ArtifactTrust = 'signed' | 'unsigned-allowed' | 'refused';

/**
 * Whether a downloaded build may be used. The artifacts have no checksums: the Authenticode signature on FXServer.exe
 * stands in for one, so downloads.requireChecksum refuses a build whose FXServer.exe is not validly signed by Rockstar
 * Games; without that setting an unsigned one is used (with a warning).
 */
export function artifactTrust(requireChecksum: boolean, signerSubject: string): ArtifactTrust {
  if (FXSERVER_SIGNER.test(signerSubject)) return 'signed';
  return requireChecksum ? 'refused' : 'unsigned-allowed';
}

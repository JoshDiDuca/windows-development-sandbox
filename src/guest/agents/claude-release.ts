// Claude Code's own releases (what `claude update` and Anthropic's install.ps1 use): the latest version, and its
// claude.exe checked against the SHA-256 in the release manifest.
import { z } from 'zod';
import { downloader, fetchRetry } from '../../shared/download/index.js';
import { versionOf } from './agent-files.js';

const RELEASES = 'https://downloads.claude.ai/claude-code-releases';

const ManifestSchema = z.object({
  platforms: z.record(z.string(), z.object({ checksum: z.string().regex(/^[0-9a-f]{64}$/i) })),
});

function platform(): string {
  return process.arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
}

/** The latest released version (a few seconds at most: it runs during the boot). */
export async function latestClaudeVersion(): Promise<string> {
  const text = (await (await fetchRetry(RELEASES + '/latest', {}, 2, 15000)).text()).trim();
  const version = versionOf(text.slice(0, 64));
  if (!version || !text.startsWith(version)) throw new Error('downloads.claude.ai did not answer with a version');
  return version;
}

/** Downloads claude.exe of `version` to `destination`, verified against the release manifest. */
export async function downloadClaude(version: string, destination: string): Promise<void> {
  const manifest = ManifestSchema.parse(await (await fetchRetry(RELEASES + '/' + version + '/manifest.json')).json());
  const entry = manifest.platforms[platform()];
  if (!entry) throw new Error('No Claude Code ' + version + ' for ' + platform());
  await downloader.file(RELEASES + '/' + version + '/' + platform() + '/claude.exe', destination, entry.checksum);
}

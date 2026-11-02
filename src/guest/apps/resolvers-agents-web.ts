// Where the latest version of the agents' web apps (catalogue-agents-web.ts) is, when it is not a pinned package or a
// remote server: Comet's installer, from Perplexity's own download address (a redirect to the current release).
// Perplexity publishes no checksum: the download is kept only when Perplexity AI, Inc. signed it (AppEntry.signer).
import { COMET_DOWNLOAD_URL } from '../../shared/apps/index.js';
import type { Download } from './resolvers.js';

export const AGENTS_WEB_RESOLVERS: Readonly<Record<string, () => Promise<Download>>> = {
  comet: () => Promise.resolve({ url: COMET_DOWNLOAD_URL, fileName: 'comet_installer.exe' }),
};

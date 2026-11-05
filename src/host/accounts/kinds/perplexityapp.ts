// Perplexity desktop app: nothing to take from this PC. The app is an Electron program in a Microsoft Store package;
// its cookies are sealed to your Windows account (Chromium's cookie key is protected by DPAPI), so they cannot open in
// a sandbox, and reading them would be what password stealers do. The sign-in only ever comes from a sandbox you
// signed in in (the same way as Comet's).
import { cometSummary } from '../../../shared/accounts/index.js';
import type { HostSource } from '../source.js';

export const perplexityAppSource: HostSource<'perplexityapp'> = {
  summary: (p) => cometSummary(p),
};

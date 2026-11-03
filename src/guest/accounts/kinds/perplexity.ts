// Perplexity: the API key becomes PERPLEXITY_API_KEY in the agent's environment, in memory only. Nothing is written
// to a file: the MCP servers read the variable (Claude Code passes its environment on; Codex is told its name).
import { PERPLEXITY_ENV, perplexitySummary, type PerplexityPayload } from '../../../shared/accounts/index.js';
import type { GuestAdapter } from '../adapter.js';

export const perplexityAdapter: GuestAdapter<'perplexity'> = {
  kind: 'perplexity',
  apply(p: PerplexityPayload) {
    return {
      env: { [PERPLEXITY_ENV]: p.apiKey },
      summary: 'Perplexity API key (' + perplexitySummary(p) + ') in ' + PERPLEXITY_ENV + ' for the agent',
    };
  },
};

// A Perplexity API key: typed, or taken from a file that holds it (a .env line PERPLEXITY_API_KEY=..., or the key
// alone). Pure text handling: only that one line is read, every other line of a .env file is ignored and never kept.
import { PerplexityPayloadSchema } from '../payloads.js';
import type { Payload } from '../payloads.js';

export type PerplexityPayload = Payload<'perplexity'>;

/** The variable the agent's sessions get, and the one the MCP servers read. */
export const PERPLEXITY_ENV = 'PERPLEXITY_API_KEY';
const ENV_LINE = /^\s*(?:export\s+)?PERPLEXITY_API_KEY\s*=\s*(.*)$/;
/** More lines than a file within the import bound (64 KB) can have. */
const MAX_LINES = 100_000;

/** A value as written in a .env line: quotes taken off, a trailing comment dropped. */
function unquote(raw: string): string {
  const v = raw.trim();
  const quoted = /^(["'])(.*)\1$/.exec(v);
  if (quoted) return quoted[2];
  return v.replace(/\s+#.*$/, '').trim();
}

/** The key in a file's text: its PERPLEXITY_API_KEY line (the last one wins, as in .env files), or the key alone. */
export function perplexityKeyFromText(text: string): PerplexityPayload | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/, MAX_LINES);
  let value: string | null = null;
  for (const line of lines) {
    const m = ENV_LINE.exec(line);
    if (m) value = unquote(m[1]);
  }
  if (value === null) {
    const words = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (words.length === 1) value = words[0];
  }
  const parsed = value === null ? null : PerplexityPayloadSchema.safeParse({ apiKey: value });
  return parsed?.success ? parsed.data : null;
}

/** pplx-... and the key's last 4 characters, for the status; never the key. */
export function perplexitySummary(p: PerplexityPayload): string {
  return 'pplx-...' + p.apiKey.slice(-4);
}

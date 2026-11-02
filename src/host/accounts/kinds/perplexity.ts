// Perplexity: an API key, taken from this PC (`sandbox account import perplexity`: PERPLEXITY_API_KEY of this
// terminal, else of your saved Windows user environment), from a file that holds it (`--from .env`: only its
// PERPLEXITY_API_KEY line is read), or typed (`sandbox account login perplexity`). The key is never printed.
import { fail } from '../../../core/util/index.js';
import {
  PERPLEXITY_ENV,
  PerplexityPayloadSchema,
  perplexityKeyFromText,
  perplexitySummary,
  type PerplexityPayload,
} from '../../../shared/accounts/index.js';
import { decodeText } from '../../../shared/io/index.js';
import type { HostSource, PcEnv } from '../source.js';

/** A key value as it may sit in a variable (quotes and spaces around it taken off). */
const keyFrom = (value: string | null | undefined): PerplexityPayload | null => {
  const parsed = PerplexityPayloadSchema.safeParse({ apiKey: (value ?? '').trim().replace(/^(["'])(.*)\1$/, '$2') });
  return parsed.success ? parsed.data : null;
};

export const perplexitySource: HostSource<'perplexity'> = {
  /** PERPLEXITY_API_KEY of this PC: this terminal's environment first, then your saved user environment. */
  fromPc(pc: PcEnv): PerplexityPayload | null {
    return keyFrom(pc.env?.[PERPLEXITY_ENV]) ?? keyFrom(pc.userVariable?.(PERPLEXITY_ENV));
  },
  fromFile(bytes: Buffer): PerplexityPayload {
    const key = perplexityKeyFromText(decodeText(bytes).text);
    if (!key)
      fail(
        'That file holds no Perplexity API key.',
        'Name a .env file with a line PERPLEXITY_API_KEY=pplx-..., or type the key: sandbox account login perplexity',
      );
    return key;
  },
  fromAnswers(answers: Readonly<Record<string, string>>): PerplexityPayload {
    const parsed = PerplexityPayloadSchema.safeParse({ apiKey: (answers.apiKey ?? '').trim() });
    if (!parsed.success)
      fail('That is not a Perplexity API key.', 'Copy it from perplexity.ai/account/api/keys: it starts with pplx-.');
    return parsed.data;
  },
  summary: (p) => perplexitySummary(p),
};

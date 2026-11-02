// Cfx.re: a FiveM / RedM server licence key from the keymaster (https://portal.cfx.re), and an optional Steam Web API
// key, typed with `sandbox account login cfx`. Only typed: there is nothing on this PC to take it from.
import { CfxPayloadSchema, type Payload } from '../../../shared/accounts/index.js';
import { fail } from '../../../core/util/index.js';
import type { HostSource } from '../source.js';

export const cfxSource: HostSource<'cfx'> = {
  fromAnswers(answers: Readonly<Record<string, string>>): Payload<'cfx'> {
    const licenseKey = (answers.licenseKey ?? '').trim();
    const steamWebApiKey = (answers.steamWebApiKey ?? '').trim().toUpperCase();
    const parsed = CfxPayloadSchema.safeParse({ licenseKey, ...(steamWebApiKey ? { steamWebApiKey } : {}) });
    if (!parsed.success)
      fail(
        'That is not a Cfx.re server key (cfxk_...) or a Steam Web API key (32 hex characters).',
        'Copy the key from https://portal.cfx.re (Server keys) and run: sandbox account login cfx',
      );
    return parsed.data;
  },
  summary: (p) => 'server key' + (p.steamWebApiKey ? ' and Steam Web API key' : ''),
};

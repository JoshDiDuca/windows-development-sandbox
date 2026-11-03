// Cfx.re: a FiveM / RedM server licence key from the keymaster (https://portal.cfx.re), and an optional Steam Web API
// key. Typed with `sandbox account login cfx`, or read from a server.cfg with `sandbox account import cfx --from`.
import { CfxPayloadSchema, type Payload } from '../../../shared/accounts/index.js';
import { fail } from '../../../core/util/index.js';
import { decodeText } from '../../../shared/io/index.js';
import type { HostSource } from '../source.js';

const MAX_LINES = 20_000;
const LICENSE_LINE = /^\s*(?:set[rs]?\s+)?sv_licenseKey\s+"?([^"\s]+)"?/i;
const STEAM_LINE = /^\s*set[rs]?\s+steam_webApiKey\s+"?([A-Fa-f0-9]{32})"?/i;

/** The line without a `#` or `//` comment (quotes are respected). */
function withoutComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '#' || (c === '/' && line[i + 1] === '/'))) return line.slice(0, i);
  }
  return line;
}

export const cfxSource: HostSource<'cfx'> = {
  fromFile(bytes: Buffer): Payload<'cfx'> {
    let licenseKey = '';
    let steamWebApiKey = '';
    for (const raw of decodeText(bytes).text.split(/\r?\n/, MAX_LINES)) {
      const line = withoutComment(raw);
      const key = LICENSE_LINE.exec(line);
      if (key) licenseKey = key[1];
      const steam = STEAM_LINE.exec(line);
      if (steam) steamWebApiKey = steam[1].toUpperCase();
    }
    if (!licenseKey) fail('That server.cfg has no sv_licenseKey.', 'Type the key instead: sandbox account login cfx');
    const parsed = CfxPayloadSchema.safeParse({ licenseKey, ...(steamWebApiKey ? { steamWebApiKey } : {}) });
    if (!parsed.success)
      fail(
        'The sv_licenseKey in that server.cfg is not a Cfx.re server key (cfxk_...).',
        'Copy the key from https://portal.cfx.re (Server keys) and run: sandbox account login cfx',
      );
    return parsed.data;
  },
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

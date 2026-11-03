// Cfx.re: the server licence key (and the optional Steam Web API key) go into one cfg on the sandbox's own disk
// (secretDir: %LOCALAPPDATA%\AgentSandbox\accounts\cfx, wiped with the sandbox) that `sbx-fivem serve` hands FXServer
// with +exec before the project's server.cfg. Never into the project, the data disk or the tools folder; not in the
// agent's environment either. It never comes back (the key does not change in the sandbox).
import fs from 'node:fs';
import path from 'node:path';
import type { Payload } from '../../../shared/accounts/index.js';
import { secretDir, type GuestAdapter } from '../adapter.js';

/** The cfg FXServer reads with +exec (forward slashes: FXServer's exec takes them). */
export function cfxSecretsFile(dir: string = secretDir('cfx')): string {
  return path.join(dir, 'server-secrets.cfg');
}

/** The cfg's text. The payload's patterns allow no quotes or line breaks, so the values cannot escape their line. */
export function cfxSecretsText(p: Payload<'cfx'>): string {
  return [
    '# Written by the sandbox at boot from your saved Cfx.re key (sandbox account login cfx). It lives on the',
    "# sandbox's own disk and goes when it closes: never copy these lines into a project or a server.cfg.",
    'sv_licenseKey "' + p.licenseKey + '"',
    ...(p.steamWebApiKey ? ['set steam_webApiKey "' + p.steamWebApiKey + '"'] : []),
    '',
  ].join('\r\n');
}

/** Writes the cfg into `dir` (only there); returns its path. */
export function writeCfxSecrets(p: Payload<'cfx'>, dir: string = secretDir('cfx')): string {
  const file = cfxSecretsFile(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, cfxSecretsText(p), { encoding: 'utf8', mode: 0o600 });
  return file;
}

export const cfxAdapter: GuestAdapter<'cfx'> = {
  kind: 'cfx',
  apply(p: Payload<'cfx'>) {
    writeCfxSecrets(p);
    return {
      summary:
        'Cfx.re: the server key is ready for sbx-fivem serve' + (p.steamWebApiKey ? ' (with a Steam Web API key)' : ''),
    };
  },
};

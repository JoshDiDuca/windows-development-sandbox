// The machine policy of the sandbox's browsers (Edge and Chrome), written under HKLM at every boot by the guest: no GPU
// and the folder downloads go to. Pure (no reads or writes here): the guest runs reg.exe with these entries and the
// self-test checks them.
import path from 'node:path';

export interface BrowserPolicy {
  readonly key: string;
  readonly name: string;
  readonly type: 'REG_DWORD' | 'REG_SZ';
  readonly data: string;
}

export const BROWSER_POLICY_KEYS = [
  'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge',
  'HKLM\\SOFTWARE\\Policies\\Google\\Chrome',
] as const;

/**
 * The policies for each browser: no hardware acceleration (today's behaviour) and, when a downloads folder is given,
 * DefaultDownloadDirectory (the default only: Playwright's download path and the user's own choice still win).
 */
export function browserPolicies(o: { readonly downloads: string | null }): BrowserPolicy[] {
  if (o.downloads !== null && (!path.win32.isAbsolute(o.downloads) || /["\r\n%]/.test(o.downloads)))
    throw new Error('not a folder');
  return BROWSER_POLICY_KEYS.flatMap((key) => [
    { key, name: 'HardwareAccelerationModeEnabled', type: 'REG_DWORD' as const, data: '0' },
    ...(o.downloads === null
      ? []
      : [{ key, name: 'DefaultDownloadDirectory', type: 'REG_SZ' as const, data: o.downloads }]),
  ]);
}

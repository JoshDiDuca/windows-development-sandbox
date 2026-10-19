// Opens an address in the default browser (through cmd's start; the address is one we built, hex and digits only).
import { spawn } from 'node:child_process';
import { SYSTEM, system32 } from '../../shared/system.js';
import { refuseInSelfTest } from '../test-guard.js';

export function openBrowser(url: string): void {
  refuseInSelfTest('open a browser');
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/(#[kw]=[0-9a-f]{64})?$/.test(url)) throw new Error('Not a web UI address.');
  spawn(SYSTEM.cmd(), ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** The one other page we open: a GitHub new-issue form (letters, digits and URL escapes only). */
const ISSUE_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/new\?[\w%.~&=+-]*$/;

/** Opens a GitHub new-issue address in the default browser (rundll32, so no shell reads the & in it). */
export function openIssuePage(url: string): void {
  refuseInSelfTest('open a browser');
  if (!ISSUE_URL.test(url) || url.length > 2000) throw new Error('Not a GitHub new-issue address.');
  spawn(system32('rundll32.exe'), ['url.dll,FileProtocolHandler', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

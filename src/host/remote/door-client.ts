// Another Windows user's side of Windows sign-in (docs/design/remote-access.md): their own HostTools connects to the
// owner's pipe, checks that its server runs in the owner's session (so nobody else can squat the name), and gets a
// one-time token for the owner's web UI, or the reason it was refused. Nothing secret is sent: Windows says who
// connected.
import { spawn } from 'node:child_process';
import { fail } from '../../core/util/index.js';
import { hostToolsExe } from '../native.js';

export type DoorAnswer =
  | { readonly ok: true; readonly token: string; readonly port: number; readonly role: 'view' | 'control' }
  | { readonly ok: false; readonly reason: string };

const NOT_OWNER = 3;
const NO_PIPE = 4;
const NO_USER = 5;

/** What the helper printed (and its exit code), as an answer. */
export function parseDoorAnswer(text: string, exitCode: number | null, owner: string): DoorAnswer {
  if (exitCode === NOT_OWNER)
    return {
      ok: false,
      reason: 'The sign-in point for ' + owner + ' is not theirs (another user made it). Nothing was sent.',
    };
  if (exitCode === NO_PIPE)
    return { ok: false, reason: owner + "'s web UI is not running, or it is from a version without Windows sign-in." };
  if (exitCode === NO_USER) return { ok: false, reason: 'There is no Windows user ' + owner + ' on this PC.' };
  if (exitCode !== 0) return { ok: false, reason: 'Windows sign-in did not work (exit ' + exitCode + ').' };
  const ok = /^ok ([0-9a-f]{64}) (\d{4,5}) (view|control)$/.exec(text.trim());
  if (ok) {
    const port = Number(ok[2]);
    if (port >= 1024 && port <= 65535) return { ok: true, token: ok[1], port, role: ok[3] as 'view' | 'control' };
  }
  const refused = /^refused (.{1,200})$/.exec(text.trim());
  return { ok: false, reason: refused ? 'Refused: ' + refused[1] + '.' : 'The web UI gave an answer that is not one.' };
}

/** Knocks on `owner`'s web UI (a name or a SID) as this Windows user. */
export async function knockOnDoor(storageRoot: string, owner: string): Promise<DoorAnswer> {
  if (!/^[^\0\r\n"]{1,140}$/.test(owner)) fail('That is not a Windows user name.');
  const exe = hostToolsExe(storageRoot);
  if (!exe) fail('Windows sign-in needs HostTools, which could not be built on this PC.', 'Run sandbox doctor.');
  return new Promise((resolve) => {
    const child = spawn(exe, ['door-client', '--owner', owner], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < 1024) out += d.toString('utf8');
    });
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('error', () => resolve({ ok: false, reason: 'HostTools could not be started.' }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(parseDoorAnswer(out, code, owner));
    });
  });
}

// Attaching this terminal to an agent session inside the sandbox. Only addresses on this PC's own Hyper-V network are
// trusted, and everything the sandbox reports is printed through safeText.
import net from 'node:net';
import os from 'node:os';
import type { SessionStatus } from '../../core/types.js';
import { fail, safeText, sleep } from '../../core/util/index.js';
import {
  connect,
  DETACH_KEY,
  queryViewers,
  runTerminalClient,
  type Endpoint,
  type Viewers,
} from '../../shared/pty/index.js';
import { SandboxChannel } from './channel.js';
import { insideSandbox } from '../sandbox/index.js';

const ipToInt = (ip: string): number => ip.split('.').reduce((n: number, part: string) => n * 256 + Number(part), 0);

/**
 * True only for IPv4 addresses inside the subnet of one of this PC's Hyper-V adapters ("vEthernet ..."), which is
 * where Windows Sandbox lives. Stops a compromised sandbox from pointing the host (and your keystrokes) anywhere else.
 */
export function isSandboxAddress(ip: string, interfaces = os.networkInterfaces()): boolean {
  if (!net.isIPv4(ip)) return false;
  // WSL's adapter is a Hyper-V adapter too, but no sandbox lives there: keystrokes must never go to a WSL VM.
  return Object.entries(interfaces).some(
    ([name, list]) =>
      /^vEthernet/i.test(name) &&
      !/WSL/i.test(name) &&
      (list ?? []).some((i) => {
        if (i.family !== 'IPv4' || i.internal) return false;
        const mask = ipToInt(i.netmask);
        return mask !== 0 && (ipToInt(i.address) & mask) === (ipToInt(ip) & mask) && i.address !== ip;
      }),
  );
}

/** Where this PC may connect for a session: only addresses on its own Hyper-V network (null if there are none). */
export const hostEndpoint = (session: SessionStatus): Endpoint | null => {
  // Inside the sandbox every session is on loopback; on the PC only addresses on its Hyper-V network are trusted.
  const addresses = insideSandbox()
    ? ['127.0.0.1']
    : (session.attach?.addresses.filter((a: string) => isSandboxAddress(a)) ?? []);
  return session.attach && addresses.length ? { ...session.attach, addresses } : null;
};

/** Who is watching a session right now (closed terminals do not count); null when it cannot be asked. */
export function sessionViewers(session: SessionStatus): Promise<Viewers | null> {
  const endpoint = hostEndpoint(session);
  return endpoint ? queryViewers(endpoint) : Promise.resolve(null);
}

/**
 * The newest running session of this agent in exactly this folder that no terminal on this PC is attached to, so
 * sandbox claude -t picks it back up instead of starting another. A session that cannot answer is never reused.
 */
export async function findUnwatchedSession(
  dataPath: string,
  harness: string,
  cwd: string,
): Promise<SessionStatus | null> {
  const candidates = new SandboxChannel(dataPath)
    .currentSessions()
    .filter((s) => s.harness === harness && s.cwd.toLowerCase() === cwd.toLowerCase())
    .reverse()
    .slice(0, 8);
  for (const session of candidates) if ((await sessionViewers(session))?.remote === 0) return session;
  return null;
}

/** Bridges this terminal to a session. Returns the agent's exit code, or 0 when the user detaches. */
export async function attachTerminal(
  session: SessionStatus,
  o: { clipboardWrites?: boolean; confirmCtrlC?: boolean } = {},
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    fail(
      '--terminal / attach needs an interactive terminal.',
      'Run it directly in Windows Terminal or PowerShell, not through a pipe or script.',
    );
  if (!session.attach)
    fail(
      'This session cannot be attached to: networking or attach is disabled for this sandbox.',
      'Set sandbox.networking and attach.enabled to true, then start a new sandbox.',
    );
  const endpoint =
    hostEndpoint(session) ??
    fail(
      "Refusing to connect: the sandbox reported no address on this PC's Hyper-V (vEthernet) network (" +
        session.attach.addresses.join(', ') +
        ').',
      'Use the sandbox window instead (sbx-show); if this keeps happening, run sandbox doctor.',
    );
  const socket = await connect(endpoint);
  console.log(
    'Attaching to ' +
      safeText(session.harness) +
      ' session ' +
      session.id +
      ' (' +
      safeText(session.cwd) +
      '). Detach any time with Ctrl+]',
  );
  await sleep(400);
  const result = await runTerminalClient(socket, session.attach.token, {
    detachKey: DETACH_KEY,
    clipboardWrites: o.clipboardWrites,
    confirmCtrlC: o.confirmCtrlC,
  });
  switch (result.reason) {
    case 'detach':
      console.log('Detached. The session keeps running; reattach with: sandbox attach ' + session.id);
      return 0;
    case 'exit':
      console.log(safeText(session.harness) + ' exited with code ' + result.exitCode + '.');
      return result.exitCode;
    case 'error':
      return fail(
        'The sandbox refused the connection: ' + result.message,
        'Try sandbox attach again; the session may have restarted.',
      );
    default:
      console.log('Connection to the sandbox closed.');
      return 1;
  }
}

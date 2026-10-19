// The web server's line to Windows for sign-in (docs/design/remote-access.md): one long-running `HostTools web-helper`
// that serves the named pipe other Windows users sign in through, tells who is at the other end of a loopback TCP
// connection, and turns account names into SIDs. Lines are tab-separated (WebHelper.cs); everything it prints is
// checked here. Tests use a fake WindowsHelper.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { hostToolsExe } from '../native.js';

/** A Windows account as the helper names it. */
export interface WindowsAccount {
  readonly sid: string;
  /** DOMAIN\name. */
  readonly user: string;
}

/** Someone connected to the pipe: who their token says they are. */
export interface Knock extends WindowsAccount {
  /** The token's integrity RID (0x2000 medium, 0x3000 high). */
  readonly integrity: number;
  readonly appContainer: boolean;
}

/** The two ends of a loopback TCP connection, our server's end being `local`. */
export interface Connection {
  readonly localAddress: string;
  readonly localPort: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
}

export interface WindowsHelper {
  /** The Windows user of the process at the other end, or null (unknown, a service, it changed while checking). */
  peer(c: Connection): Promise<WindowsAccount | null>;
  lookup(name: string): Promise<WindowsAccount | null>;
  /** Who answers knocks on the pipe: the text written back ("ok <token> <port>" or "refused <reason>"). */
  onKnock(answer: (k: Knock) => Promise<string>): void;
  /** Problems worth a log line (the pipe could not be made). */
  onProblem(listener: (text: string) => void): void;
  stop(): void;
}

const SID = /^S-1-[0-9-]{1,180}$/;
const MEDIUM_INTEGRITY = 0x2000;
/** Most requests waiting for the helper at once; more are answered "unknown" (a flood cannot pile up). */
const MAX_WAITING = 64;
const REQUEST_TIMEOUT_MS = 5000;

export type HelperLine =
  | { readonly kind: 'peer' | 'lookup'; readonly id: string; readonly account: WindowsAccount | null }
  | { readonly kind: 'door'; readonly number: number; readonly knock: Knock }
  | { readonly kind: 'problem'; readonly text: string };

const clip = (text: string): string =>
  [...text]
    .filter((c) => c >= ' ' && c !== '\u007f')
    .join('')
    .slice(0, 200);

/** One line from the helper, or null when it is not one of its lines. */
export function parseHelperLine(line: string): HelperLine | null {
  const f = line.split('\t');
  if ((f[0] === 'peer' || f[0] === 'lookup') && /^\d{1,9}$/.test(f[1] ?? '')) {
    const ok = f[2] === 'ok' && SID.test(f[3] ?? '') && (f[4] ?? '').length > 0;
    return { kind: f[0], id: f[1], account: ok ? { sid: f[3], user: clip(f[4]) } : null };
  }
  if (f[0] === 'door' && f.length === 6 && /^\d{1,9}$/.test(f[1]) && SID.test(f[2]) && /^\d{1,6}$/.test(f[3]))
    return {
      kind: 'door',
      number: Number(f[1]),
      knock: { sid: f[2], integrity: Number(f[3]), appContainer: f[4] !== '0', user: clip(f[5]) },
    };
  if (f[0] === 'door-failed' || f[0] === 'error') return { kind: 'problem', text: clip(f.slice(1).join(' ')) };
  return null;
}

/** Why a knock is refused before the settings are asked (low integrity, a sandboxed app, a service), or null. */
export function knockProblem(k: Knock, ownerSid: string): string | null {
  if (k.appContainer) return 'a sandboxed app (AppContainer)';
  if (k.integrity < MEDIUM_INTEGRITY) return 'a low-integrity process';
  if (/^S-1-5-(18|19|20)$/.test(k.sid)) return 'a Windows service account';
  if (k.sid.toUpperCase() === ownerSid.toUpperCase()) return 'the owner (use sandbox web open)';
  return null;
}

/** The pipe's name for an owner: agent-sandbox-web-<SID> (WebHelper.cs makes the same name on the client side). */
export function doorPipeName(ownerSid: string): string {
  return 'agent-sandbox-web-' + ownerSid;
}

/** The real helper process. */
export class HostToolsHelper implements WindowsHelper {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<string, (account: WindowsAccount | null) => void>();
  private next = 1;
  private answer: (k: Knock) => Promise<string> = async () => 'refused Windows sign-in is off.';
  private problem: (text: string) => void = () => undefined;

  private constructor(exe: string, pipe: string | null) {
    this.child = spawn(exe, ['web-helper', '--pipe', pipe ?? '', '--server-pid', String(process.pid)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.resume();
    this.child.on('error', () => this.failAll());
    this.child.on('exit', () => this.failAll());
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
  }

  /** Starts it (null when HostTools cannot be built here). `pipe` null: no Windows sign-in, only peer checks. */
  static start(storageRoot: string, pipe: string | null): HostToolsHelper | null {
    const exe = hostToolsExe(storageRoot);
    return exe ? new HostToolsHelper(exe, pipe) : null;
  }

  private failAll(): void {
    for (const resolve of this.waiting.values()) resolve(null);
    this.waiting.clear();
  }

  private receive(line: string): void {
    const parsed = parseHelperLine(line);
    if (!parsed) return;
    if (parsed.kind === 'problem') return this.problem(parsed.text);
    if (parsed.kind === 'door') {
      void this.answer(parsed.knock)
        .catch(() => 'refused Something went wrong.')
        .then((text) => this.send(['answer', String(parsed.number), text.replace(/[\t\r\n]/g, ' ')]));
      return;
    }
    const resolve = this.waiting.get(parsed.id);
    this.waiting.delete(parsed.id);
    resolve?.(parsed.account);
  }

  private send(fields: readonly string[]): void {
    if (this.child.stdin.writable) this.child.stdin.write(fields.join('\t') + '\n');
  }

  private ask(fields: readonly string[]): Promise<WindowsAccount | null> {
    if (this.waiting.size >= MAX_WAITING || fields.some((f) => /[\t\r\n]/.test(f))) return Promise.resolve(null);
    const id = String(this.next++);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, REQUEST_TIMEOUT_MS);
      this.waiting.set(id, (account) => {
        clearTimeout(timer);
        resolve(account);
      });
      this.send([fields[0], id, ...fields.slice(1)]);
    });
  }

  peer(c: Connection): Promise<WindowsAccount | null> {
    return this.ask(['peer', c.localAddress, String(c.localPort), c.remoteAddress, String(c.remotePort)]);
  }

  lookup(name: string): Promise<WindowsAccount | null> {
    return this.ask(['lookup', name]);
  }

  onKnock(answer: (k: Knock) => Promise<string>): void {
    this.answer = answer;
  }

  onProblem(listener: (text: string) => void): void {
    this.problem = listener;
  }

  stop(): void {
    this.child.stdin.end();
    this.failAll();
  }
}

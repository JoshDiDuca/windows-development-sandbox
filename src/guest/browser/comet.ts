// Comet (Perplexity's Chromium browser) in this sandbox: where it is, the profile it runs with, and its sign-in over
// the DevTools port. The profile is on the sandbox's own disk (%LOCALAPPDATA%\AgentSandbox\comet-profile): a profile
// on the data folder fails (rename-over is refused there, and its cookie key is sealed to this sandbox's Windows user).
// The sign-in travels instead as the allow-listed perplexity.ai cookies: read with Network.getCookies for those
// addresses only (other sites' cookies are never asked for), written back with Storage.setCookies. DevTools listen
// on 127.0.0.1 only. No runtime imports: the sign-in adapter and the self-test load this file.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cometPayloadFromCookies, cookiesToRestore, type CometPayload } from '../../shared/accounts/kinds/comet.js';
import { readBoundedFile } from '../../shared/io/bounded.js';
import { localAppData } from '../accounts/adapter.js';
import { findExe } from '../apps/find-exe.js';
import { tool } from '../toolchains/tool-env.js';
import { CdpConnection, parseDevToolsActivePort, type DevToolsEndpoint } from './cdp.js';

/** The port comet-mcp looks for (it connects to a Comet already listening there). */
export const COMET_MCP_PORT = 9222;
/** The addresses whose cookies are read back (their cookies and the parent domain's). */
export const COMET_COOKIE_URLS: readonly string[] = ['https://www.perplexity.ai/', 'https://perplexity.ai/'];
const START_MS = 30_000;
const STOP_MS = 15_000;

/** Comet's profile: on the sandbox's own disk, wiped with it. */
export function cometProfileDir(): string {
  return path.join(localAppData(), 'AgentSandbox', 'comet-profile');
}

/** Where `--install --silent` puts Comet (the fallback when the installer cannot be unpacked). */
export function installedCometExe(): string {
  return path.join(localAppData(), 'Perplexity', 'Comet', 'Application', 'comet.exe');
}

/** comet.exe: the portable copy in tools\apps\comet, else the installed one, else null. */
export function cometExe(): string | null {
  const portable = findExe(tool('apps', 'comet'), 'comet.exe');
  if (portable) return portable;
  return fs.existsSync(installedCometExe()) ? installedCometExe() : null;
}

/** How Comet is started here: this profile, DevTools on 127.0.0.1 (`port` 0: any free port, written to the profile). */
export function cometLaunchArgs(port: number, profile: string = cometProfileDir()): string[] {
  return [
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + port,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
  ];
}

/** The same as one command line for a shortcut (quoted where it has spaces). */
export function cometShortcutArgs(port: number, profile: string = cometProfileDir()): string {
  return cometLaunchArgs(port, profile)
    .map((a) => (/\s/.test(a) ? '"' + a + '"' : a))
    .join(' ');
}

/** Where a Comet running with this profile listens, from its DevToolsActivePort file; null when there is none. */
export function devToolsEndpoint(profile: string = cometProfileDir()): DevToolsEndpoint | null {
  const bytes = readBoundedFile(path.join(profile, 'DevToolsActivePort'), 512);
  return bytes ? parseDevToolsActivePort(bytes.toString('utf8')) : null;
}

/** A connection to the Comet running with this profile, or null when none answers. */
export async function connect(profile: string): Promise<CdpConnection | null> {
  const endpoint = devToolsEndpoint(profile);
  if (!endpoint) return null;
  try {
    return await CdpConnection.open(endpoint, 5000);
  } catch {
    return null; // Not running (a file left by the last start), or not Comet.
  }
}

interface TargetInfo {
  readonly targetId?: unknown;
  readonly type?: unknown;
}

/**
 * The sign-in the running Comet holds now (perplexity.ai's own cookies, asked of one of its pages), or null when
 * Comet is not running with this profile, has no page open, or holds no sign-in. Never asks for another site's cookies.
 */
export async function readCometSignIn(profile: string = cometProfileDir()): Promise<CometPayload | null> {
  const cdp = await connect(profile);
  if (!cdp) return null;
  try {
    const { targetInfos = [] } = await cdp.call<{ targetInfos?: TargetInfo[] }>('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page' && typeof t.targetId === 'string');
    if (!page) return null;
    const { sessionId } = await cdp.call<{ sessionId: string }>('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    });
    try {
      const { cookies = [] } = await cdp.call<{ cookies?: unknown[] }>(
        'Network.getCookies',
        { urls: [...COMET_COOKIE_URLS] },
        { sessionId },
      );
      return cometPayloadFromCookies(Array.isArray(cookies) ? cookies : [], Math.floor(Date.now() / 1000));
    } finally {
      await cdp.call('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    }
  } finally {
    cdp.close();
  }
}

/** Waits for a process to end (true), or gives up after `ms` (false). */
function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Comet started without a window on this profile, answering on its DevTools port; throws when it does not. */
async function startHidden(exe: string, profile: string): Promise<{ cdp: CdpConnection; child: ChildProcess }> {
  fs.mkdirSync(profile, { recursive: true });
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
  const child = spawn(exe, [...cometLaunchArgs(0, profile), '--headless=new', 'about:blank'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => undefined); // Reported below as "did not start".
  const deadline = Date.now() + START_MS;
  while (Date.now() < deadline && child.exitCode === null) {
    const cdp = await connect(profile);
    if (cdp) return { cdp, child };
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error('Comet did not start (no DevTools answer within ' + START_MS / 1000 + ' s)');
}

/**
 * Writes the sign-in into Comet's profile: into the Comet running with it, or into one started without a window for
 * this and closed again (Comet saves its cookies as it closes). Resolves with the number of cookies written.
 */
export async function restoreCometSignIn(
  exe: string,
  payload: CometPayload,
  profile: string = cometProfileDir(),
): Promise<number> {
  const cookies = cookiesToRestore(payload, Math.floor(Date.now() / 1000));
  if (!cookies.length) return 0;
  const running = await connect(profile);
  const started = running ? null : await startHidden(exe, profile);
  const cdp = running ?? started!.cdp;
  try {
    await cdp.call('Storage.setCookies', { cookies });
    if (started) {
      await cdp.call('Browser.close').catch(() => undefined);
      if (!(await exited(started.child, STOP_MS))) started.child.kill();
    }
    return cookies.length;
  } finally {
    cdp.close();
    if (started && started.child.exitCode === null) started.child.kill();
  }
}

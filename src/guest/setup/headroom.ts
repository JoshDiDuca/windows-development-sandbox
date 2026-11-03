// The Headroom agent add-on: its proxy runs detached on 127.0.0.1 for the sandbox's life, and Claude Code is pointed at
// it (managed-policy.ts) only once it answers as Headroom. It forwards only to Anthropic's API, starts without the
// agents' keys in its environment and with HEADROOM_OFFLINE (no telemetry, update checks or model downloads).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HEADROOM_PORT, headroomArgs, headroomEnv, headroomUrl } from '../../shared/apps/index.js';
import { logsDir } from '../runtime/paths.js';
import { portOpen, waitForPort } from '../runtime/ports.js';
import { log } from '../runtime/log.js';
import { installedAddon } from './agent-addons.js';

/** The proxy's log (it redacts keys and tokens in what it logs). */
export const HEADROOM_LOG = path.join(logsDir, 'headroom.log');

/** Whether Headroom's own health check answers on the port (not some other program that took it). */
function answersAsHeadroom(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/livez', timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (body.length < 4096) body += chunk;
      });
      res.on('end', () => resolve(res.statusCode === 200 && /"service"\s*:\s*"headroom-proxy"/.test(body)));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

/** The one start of the proxy in this process (the early start, the one after Apps and the wait share it). */
let starting: Promise<boolean> | null = null;

/** Whether the proxy is installed and may be used (the agent environment does not name another API address). */
function usable(env: NodeJS.ProcessEnv): string | null {
  const exe = installedAddon('headroom');
  return exe && !env.ANTHROPIC_BASE_URL ? exe : null;
}

/**
 * Starts the proxy process when Headroom is chosen and installed (nothing waits for it). True when the proxy is
 * running or starting; `awaitHeadroom` then waits until it answers. The environment is the agent's.
 */
export async function spawnHeadroom(env: NodeJS.ProcessEnv): Promise<boolean> {
  const attempt = (starting ??= startProxy(env));
  const started = await attempt;
  // Not installed (yet): a later call, after the Apps step, may still start it.
  if (!started && starting === attempt) starting = null;
  return started;
}

async function startProxy(env: NodeJS.ProcessEnv): Promise<boolean> {
  const exe = usable(env);
  if (!exe) return false;
  if (await portOpen(HEADROOM_PORT)) return true;
  const out = fs.openSync(HEADROOM_LOG, 'a');
  try {
    spawn(exe, headroomArgs(HEADROOM_PORT), {
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      env: headroomEnv(env),
    }).unref();
  } finally {
    fs.closeSync(out);
  }
  return true;
}

/**
 * Waits until the proxy answers as Headroom; its base URL, else null (Claude Code then talks to the API directly).
 * Starts it first when `spawnHeadroom` did not.
 */
export async function awaitHeadroom(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!installedAddon('headroom')) return null;
  if (env.ANTHROPIC_BASE_URL) {
    log('Headroom: not used, ANTHROPIC_BASE_URL is set in the agent environment (' + env.ANTHROPIC_BASE_URL + ')');
    return null;
  }
  const port = HEADROOM_PORT;
  await spawnHeadroom(env);
  if (!(await waitForPort(port, 90)))
    throw new Error('the Headroom proxy did not start on port ' + port + '; see ' + HEADROOM_LOG);
  if (!(await answersAsHeadroom(port)))
    throw new Error('port ' + port + ' is taken by another program; Claude Code talks to the API directly');
  log('Headroom: Claude Code reaches the API through ' + headroomUrl(port) + ' (log: ' + HEADROOM_LOG + ')');
  return headroomUrl(port);
}

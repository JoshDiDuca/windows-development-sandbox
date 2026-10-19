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

/**
 * Starts the proxy when Headroom is chosen and installed; its base URL once it answers, else null (Claude Code then
 * talks to the API directly).
 */
export async function startHeadroom(env: NodeJS.ProcessEnv): Promise<string | null> {
  const exe = installedAddon('headroom');
  if (!exe) return null;
  if (env.ANTHROPIC_BASE_URL) {
    log('Headroom: not used, ANTHROPIC_BASE_URL is set in the agent environment (' + env.ANTHROPIC_BASE_URL + ')');
    return null;
  }
  const port = HEADROOM_PORT;
  if (!(await portOpen(port))) {
    const out = fs.openSync(HEADROOM_LOG, 'a');
    spawn(exe, headroomArgs(port), {
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      env: headroomEnv(env),
    }).unref();
    fs.closeSync(out);
    if (!(await waitForPort(port, 90)))
      throw new Error('the Headroom proxy did not start on port ' + port + '; see ' + HEADROOM_LOG);
  }
  if (!(await answersAsHeadroom(port)))
    throw new Error('port ' + port + ' is taken by another program; Claude Code talks to the API directly');
  log('Headroom: Claude Code reaches the API through ' + headroomUrl(port) + ' (log: ' + HEADROOM_LOG + ')');
  return headroomUrl(port);
}

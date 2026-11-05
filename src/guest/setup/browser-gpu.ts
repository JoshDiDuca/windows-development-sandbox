// Browsers in the sandbox (Edge and Chrome machine policy, written every boot) draw without the GPU, and download to
// C:\AgentData\downloads, which is kept between sandboxes. With sandbox.vGpu the sandbox shares this PC's graphics card
// through one virtual GPU: a browser's GPU process starting next to a game or other Direct3D program there has taken
// the whole sandbox down. Pages still render, WebGL included, in software; programs that need the GPU keep it. Without
// vGPU there is no GPU to use, so only the download folder matters.
import path from 'node:path';
import { SYSTEM } from '../../shared/system.js';
import { browserPolicies } from '../../shared/browser-policy.js';
import { dataDir, dryRun, isWin } from '../runtime/paths.js';
import { exec } from '../runtime/process.js';
import { log } from '../runtime/log.js';
import { mkdirp } from '../runtime/fs.js';

export function keepBrowsersOffGpu(): void {
  if (dryRun || !isWin) return;
  const downloads = path.join(dataDir, 'downloads');
  mkdirp(downloads);
  for (const p of browserPolicies({ downloads }))
    exec(SYSTEM.reg(), ['add', p.key, '/v', p.name, '/t', p.type, '/d', p.data, '/f'], { stdio: 'ignore' });
  log('Browsers draw without the GPU and download to ' + downloads + '.');
}

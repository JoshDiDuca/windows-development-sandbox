// Browsers in the sandbox draw without the GPU (Edge and Chrome machine policy, written every boot). With sandbox.vGpu
// the sandbox shares this PC's graphics card through one virtual GPU: a browser's GPU process starting next to a game
// or other Direct3D program there has taken the whole sandbox down. Pages still render, WebGL included, in software;
// programs that need the GPU keep it. Without vGPU nothing changes (there is no GPU to use).
import { SYSTEM } from '../../shared/system.js';
import { dryRun, isWin } from '../runtime/paths.js';
import { exec } from '../runtime/process.js';
import { log } from '../runtime/log.js';

const POLICY_KEYS = ['HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome'] as const;

export function keepBrowsersOffGpu(): void {
  if (dryRun || !isWin) return;
  for (const key of POLICY_KEYS)
    exec(SYSTEM.reg(), ['add', key, '/v', 'HardwareAccelerationModeEnabled', '/t', 'REG_DWORD', '/d', '0', '/f'], {
      stdio: 'ignore',
    });
  log('Browsers draw without the GPU (Edge and Chrome policy).');
}

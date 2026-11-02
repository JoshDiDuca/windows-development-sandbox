// What a toolchain step whose module is not written yet does: says so in the log and the summary, installs nothing.
import { log } from '../runtime/log.js';
import type { ToolEnv } from './tool-env.js';

export function notAvailableYet(env: ToolEnv, what: string): void {
  log(what + ': not available yet (nothing installed)');
  env.summary.push(what + ': not available yet');
}

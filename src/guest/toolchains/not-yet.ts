// What a toolchain step whose module is not written yet does: says so in the log, installs nothing and adds no
// summary line.
import { log } from '../runtime/log.js';
import type { ToolEnv } from './tool-env.js';

export function notAvailableYet(_env: ToolEnv, what: string): void {
  log(what + ': not available yet (nothing installed)');
}

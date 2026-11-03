import { execHeavy as execAsync } from '../../runtime/pools.js';
import { exists } from '../../runtime/fs.js';
import { tool, type ToolEnv } from '../tool-env.js';
import { installOnce } from '../package-ledger.js';
import { uvVars } from '../runtimes.js';

/** Python command-line tools through uv (each in its own environment, commands in uv's bin folder on PATH). */
export async function setupPythonTools(env: ToolEnv, tools: string[]): Promise<void> {
  const uv = tool('uv', 'uv.exe');
  if (!exists(uv)) throw new Error('toolchains.python.tools needs uv (toolchains.uv.enabled)');
  await installOnce(env, 'uv tool', tools, (pkg) =>
    execAsync(uv, ['tool', 'install', pkg], { env: { ...process.env, ...uvVars() } }),
  );
}

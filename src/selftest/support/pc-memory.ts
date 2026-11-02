// A pretend PC's RAM for code that sizes the sandbox from os.totalmem() / os.freemem() (generateSandbox caps a fixed
// memoryMb at what the PC can keep resident), so launch tests decide the same on every machine they run on.
import os from 'node:os';

const MB = 1048576;

/** Runs `fn` (synchronous) as on a PC with this much RAM in total and free; the real os functions come back after. */
export function onFixedPc<T>(fn: () => T, totalMb = 64 * 1024, freeMb = 48 * 1024): T {
  const real = { totalmem: os.totalmem, freemem: os.freemem };
  os.totalmem = (): number => totalMb * MB;
  os.freemem = (): number => freeMb * MB;
  try {
    return fn();
  } finally {
    os.totalmem = real.totalmem;
    os.freemem = real.freemem;
  }
}

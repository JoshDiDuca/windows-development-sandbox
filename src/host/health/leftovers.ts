// Reads what is needed to judge "are the Windows Sandbox programs ours, alive, or left over?" (see judgeSandbox).
import { LifeRecord, readHeartbeat } from '../life/index.js';
import { SandboxChannel } from '../channel/index.js';
import { listProcesses, sessionOf } from '../sharing/index.js';
import { judgeSandbox, type SandboxFacts } from './stale.js';

const PING_WAIT_MS = 5000;

/** The facts for judgeSandbox, from the process list, our heartbeat and our life record. `ping`: ask the daemon too. */
export async function readSandboxFacts(storageRoot: string, dataPath: string, ping: boolean): Promise<SandboxFacts> {
  const rows = listProcesses();
  const life = new LifeRecord(storageRoot, dataPath).read();
  const heartbeat = readHeartbeat(dataPath);
  const nowMs = Date.now();
  // A heartbeat from before this launch belongs to an earlier sandbox.
  const mine = heartbeat && (!life || Date.parse(heartbeat.at) >= Date.parse(life.started) - 60000) ? heartbeat : null;
  const base: SandboxFacts = {
    rows,
    mySession: sessionOf(rows),
    heartbeatAgeMs: mine ? Math.max(0, nowMs - Date.parse(mine.at)) : null,
    lifeEnded: Boolean(life?.ended),
    startedAgeMs: life ? Math.max(0, nowMs - Date.parse(life.started)) : null,
    answers: null,
  };
  if (!ping || judgeSandbox(base).state !== 'leftover') return base;
  return { ...base, answers: await answers(dataPath) };
}

/** Does the sandbox's daemon answer a ping within a few seconds? */
async function answers(dataPath: string): Promise<boolean> {
  try {
    const reply = await Promise.race([
      new SandboxChannel(dataPath).ping().then((r) => r.ok),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PING_WAIT_MS).unref()),
    ]);
    return reply;
  } catch {
    // No answer, or a channel that cannot be used: it does not answer.
    return false;
  }
}

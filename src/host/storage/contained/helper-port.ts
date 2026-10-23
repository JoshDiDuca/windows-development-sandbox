// The storage helper (native\csharp\StorageHelper, the Windows service AgentSandboxStorage that an all-users install
// can add): mounting and dismounting go to its pipe instead of a Windows permission prompt. The request names only the
// data set; the service works out the folders itself from your settings, so the answer's paths must equal ours. When
// the helper is not installed, cannot be reached, or says to (an image it leaves alone), the permission-prompt scripts
// run as before. Looking (reality) never needs either.
import net from 'node:net';
import { z } from 'zod';
import type { ContainedPaths } from './layout.js';
import { SET_NAME_RULE } from './layout.js';
import type { DiskPort, DismountRequest, MountRequest, ScriptOutcome } from './disk-port.js';
import type { MountReality } from './state.js';
import { refuseInSelfTest } from '../../test-guard.js';

export const HELPER_PIPE = '\\\\.\\pipe\\AgentSandboxStorage';
export const HELPER_PROTOCOL = 1;
const MOUNT_TIMEOUT_MS = 10 * 60_000;
const MAX_ANSWER_BYTES = 64 * 1024;

/** What goes to the service: exactly the verb and the data set (the service refuses anything else). */
export const HelperRequestSchema = z
  .object({ verb: z.enum(['mount', 'dismount']), set: z.string().regex(SET_NAME_RULE) })
  .strict();
export type HelperRequest = z.infer<typeof HelperRequestSchema>;

/** The service's answer (Protocol.Answer in Protocol.cs). */
export const HelperAnswerSchema = z.object({
  protocol: z.number().int(),
  ok: z.boolean(),
  message: z.string().max(4000),
  created: z.boolean(),
  alreadyMounted: z.boolean(),
  fallback: z.boolean(),
  image: z.string().max(1000),
  mount: z.string().max(1000),
  notes: z.array(z.string().max(1000)).max(50),
});
export type HelperAnswer = z.infer<typeof HelperAnswerSchema>;

/** One call: the text of the answer, or why there was none. `absent`: no helper here (or not for you). */
export type PipeResult =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'absent'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };
export type PipeConnector = (pipe: string, line: string, timeoutMs: number) => Promise<PipeResult>;

/** Errors that mean "no helper to talk to": not installed (or stopped), or this user may not open it. */
const ABSENT_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ECONNREFUSED']);

export const pipeConnector: PipeConnector = (pipe, line, timeoutMs) =>
  new Promise((resolve) => {
    let text = '';
    let connected = false;
    let settled = false;
    const done = (result: PipeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const socket = net.connect(pipe);
    const timer = setTimeout(
      () => done({ kind: 'failed', reason: 'the storage helper did not answer in time' }),
      timeoutMs,
    );
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      connected = true;
      socket.write(line + '\n');
    });
    socket.on('data', (chunk: string) => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end >= 0) done({ kind: 'answer', text: text.slice(0, end) });
      else if (text.length > MAX_ANSWER_BYTES) done({ kind: 'failed', reason: 'the storage helper answered too much' });
    });
    socket.on('error', (e: NodeJS.ErrnoException) => {
      if (!connected && ABSENT_CODES.has(e.code ?? '')) done({ kind: 'absent', reason: e.code ?? 'no pipe' });
      else done({ kind: 'failed', reason: e.message });
    });
    socket.on('close', () => done({ kind: 'failed', reason: 'the storage helper closed the connection' }));
  });

/**
 * Whether the helper may be asked at all. It reads your settings from the usual place (your profile's
 * .agent-sandbox\config.json and the machine file), so a run with other settings (--config, AGENT_SANDBOX_CONFIG,
 * AGENT_SANDBOX_HOME) would get other folders: those use the permission prompt.
 */
export function helperApplies(env: NodeJS.ProcessEnv, configOverridden: boolean): boolean {
  if (configOverridden) return false;
  return !env.AGENT_SANDBOX_CONFIG && !env.AGENT_SANDBOX_HOME;
}

/** The answer's paths are ours (Windows paths: case does not matter, a trailing backslash neither). */
export function samePaths(answer: Pick<HelperAnswer, 'image' | 'mount'>, paths: ContainedPaths): boolean {
  const norm = (p: string): string => p.replace(/\\+$/, '').toLowerCase();
  return norm(answer.image) === norm(paths.image) && norm(answer.mount) === norm(paths.mount);
}

/** What one answer means: an outcome, or "use the permission prompt instead". */
export function readAnswer(
  result: PipeResult,
  paths: ContainedPaths,
): { readonly use: 'outcome'; readonly outcome: ScriptOutcome } | { readonly use: 'fallback'; readonly why: string } {
  if (result.kind === 'absent') return { use: 'fallback', why: 'no storage helper (' + result.reason + ')' };
  if (result.kind === 'failed')
    return { use: 'outcome', outcome: failed('The storage helper did not finish: ' + result.reason + '.') };
  let raw: unknown;
  try {
    raw = JSON.parse(result.text);
  } catch {
    return { use: 'fallback', why: 'the storage helper gave an answer that is not JSON' };
  }
  const parsed = HelperAnswerSchema.safeParse(raw);
  if (!parsed.success || parsed.data.protocol !== HELPER_PROTOCOL)
    return { use: 'fallback', why: 'the storage helper speaks another version' };
  const answer = parsed.data;
  if (answer.fallback) return { use: 'fallback', why: answer.message };
  if (answer.ok && !samePaths(answer, paths))
    return {
      use: 'outcome',
      outcome: failed(
        'The storage helper used other folders (' +
          answer.mount +
          ') than this command (' +
          paths.mount +
          '): your settings differ from what it reads. Run sandbox doctor.',
      ),
    };
  return {
    use: 'outcome',
    outcome: {
      ok: answer.ok,
      message: answer.message,
      created: answer.created,
      alreadyMounted: answer.alreadyMounted,
      notes: answer.notes,
    },
  };
}

function failed(message: string): ScriptOutcome {
  return { ok: false, message, created: false, alreadyMounted: false, notes: [] };
}

/** The helper when it is there and applies, else (and whenever it says so) the permission-prompt scripts. */
export class HelperDiskPort implements DiskPort {
  constructor(
    private readonly fallback: DiskPort,
    private readonly applies: boolean,
    private readonly connect: PipeConnector = pipeConnector,
    private readonly pipe: string = HELPER_PIPE,
  ) {}

  async mount(request: MountRequest): Promise<ScriptOutcome> {
    const answer = await this.ask({ verb: 'mount', set: request.paths.set }, request.paths);
    return answer ?? this.fallback.mount(request);
  }

  async dismount(request: DismountRequest): Promise<ScriptOutcome> {
    const answer = await this.ask({ verb: 'dismount', set: request.paths.set }, request.paths);
    return answer ?? this.fallback.dismount(request);
  }

  reality(paths: ContainedPaths): Promise<MountReality> {
    return this.fallback.reality(paths);
  }

  /** The helper's outcome, or null to use the permission prompt. */
  private async ask(request: HelperRequest, paths: ContainedPaths): Promise<ScriptOutcome | null> {
    if (!this.applies) return null;
    // A test talks to a helper of its own (another pipe name); the real one could mount a real disk.
    if (this.pipe === HELPER_PIPE) refuseInSelfTest('mount or dismount a disk image');
    const line = JSON.stringify(HelperRequestSchema.parse(request));
    const read = readAnswer(await this.connect(this.pipe, line, MOUNT_TIMEOUT_MS), paths);
    return read.use === 'outcome' ? read.outcome : null;
  }
}

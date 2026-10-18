// Runs HcsHost.exe (native\csharp\HcsHost, built on first use) with JSON files in a private temp folder. The answer
// is a file too: size-bounded and checked with zod, never trusted as it is. HcsHost only talks to the Windows Host
// Compute Service and virtdisk; it takes no guest data.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { fail, UserError } from '../../../core/util/index.js';
import { SYSTEM } from '../../../shared/system.js';
import { nativeFile } from '../../native.js';
import { refuseInSelfTest } from '../../test-guard.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CALL_TIMEOUT_MS = 240000;
/** Only ids this tool gives its compute systems (HcsHost.exe refuses any other, and checks the Owner too). */
const SAFE_ID = /^agent-sandbox-[A-Za-z0-9._-]{1,100}$/;

/** Whether an id has the shape of the ones this tool gives its compute systems. */
export function isOurSystemId(id: string): boolean {
  return SAFE_ID.test(id);
}

export const HcsReplySchema = z.object({
  ok: z.boolean(),
  hresult: z.string().max(16),
  message: z.string().max(4000),
  json: z.string().max(MAX_RESPONSE_BYTES),
  values: z.record(z.string().max(64), z.string().max(2000)),
});
export type HcsReply = z.infer<typeof HcsReplySchema>;

export interface RunResult {
  readonly status: number | null;
  readonly error?: string;
}

/** Starts the helper: replaceable in tests. */
export type HelperRunner = (exe: string, args: readonly string[], timeoutMs: number) => RunResult;

export const spawnRunner: HelperRunner = (exe, args, timeoutMs) => {
  const r = spawnSync(exe, [...args], {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    stdio: 'ignore',
  });
  return { status: r.status, error: r.error?.message };
};

/** Compiles the helper's sources to `exe` with the .NET Framework csc (C# 5). False when it cannot be built. */
export function buildHcsHostTo(exe: string): boolean {
  const dir = nativeFile('csharp', 'HcsHost');
  let sources: string[];
  try {
    sources = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.cs'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return false; // no sources next to this package
  }
  if (!fs.existsSync(SYSTEM.csc())) return false;
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  const r = spawnSync(
    SYSTEM.csc(),
    ['/nologo', '/optimize', '/target:exe', '/r:System.Web.Extensions.dll', '/out:' + exe, ...sources],
    { windowsHide: true, timeout: 120000 },
  );
  return r.status === 0 && fs.existsSync(exe);
}

/** HcsHost.exe when it was built already (never builds it): a PC that never used HCS has none. */
export function builtHcsHostExe(storageRoot: string): string | null {
  const exe = hcsHostPath(storageRoot);
  return exe && fs.existsSync(exe) ? exe : null;
}

/**
 * <storage>\bin\hcs\<hash of its sources>\HcsHost.exe, built the first time. Its own folder: HostTools' cleanup of old
 * builds only touches twelve-digit hash folders directly in bin. Null when it cannot be built.
 */
export function hcsHostExe(storageRoot: string): string | null {
  refuseInSelfTest('build HcsHost.exe');
  const exe = hcsHostPath(storageRoot);
  return exe && (fs.existsSync(exe) || buildHcsHostTo(exe)) ? exe : null;
}

/** Where HcsHost.exe is (or would be built): named by the hash of its sources. Null without the sources. */
function hcsHostPath(storageRoot: string): string | null {
  const dir = nativeFile('csharp', 'HcsHost');
  const hash = crypto.createHash('sha256');
  try {
    for (const f of fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.cs'))
      .sort())
      hash.update(fs.readFileSync(path.join(dir, f)));
  } catch {
    return null; // no sources
  }
  return path.join(storageRoot, 'bin', 'hcs', hash.digest('hex').slice(0, 12), 'HcsHost.exe');
}

/** A path argument: absolute, not an option. Nothing else reaches the helper's command line. */
function pathArg(value: string, what: string): string {
  if (!path.isAbsolute(value) || value.startsWith('-')) fail('Not a full path for ' + what + ': ' + value);
  return value;
}

function idArg(value: string): string {
  if (!SAFE_ID.test(value)) fail('Not a valid sandbox id: ' + value);
  return value;
}

export class HcsHelper {
  /** `exe`: where HcsHost.exe is (built when asked); `tempRoot`: where the private folders for one call go. */
  constructor(
    private readonly exe: () => string | null,
    private readonly run: HelperRunner = spawnRunner,
    private readonly tempRoot: string = os.tmpdir(),
  ) {}

  /** One helper call: `args` then `--out <response>`. Returns the checked answer, whatever it says. */
  call(args: readonly string[], request?: unknown): HcsReply {
    const exe = this.exe();
    if (!exe) fail('HcsHost.exe could not be built.', 'It needs the .NET Framework compiler that ships with Windows.');
    const dir = fs.mkdtempSync(path.join(this.tempRoot, 'agent-sandbox-hcs-'));
    try {
      const out = path.join(dir, 'response.json');
      const full = [...args];
      if (request !== undefined) {
        const file = path.join(dir, 'request.json');
        fs.writeFileSync(file, JSON.stringify(request), 'utf8');
        full.push(file);
      }
      const result = this.run(exe, [...full, '--out', out], CALL_TIMEOUT_MS);
      return readReply(out, result);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The same, but a failed answer stops with the helper's own message. */
  private must(args: readonly string[], request?: unknown): HcsReply {
    const reply = this.call(args, request);
    if (!reply.ok) fail('The Host Compute Service said: ' + reply.message + ' (' + reply.hresult + ')');
    return reply;
  }

  check(): HcsReply {
    return this.call(['check']);
  }

  enumerate(): HcsReply {
    return this.must(['enumerate']);
  }

  properties(id: string): HcsReply {
    return this.must(['properties', idArg(id)]);
  }

  /** `document` is the HCS JSON text; it travels as a string inside the request file. */
  create(id: string, document: string): HcsReply {
    return this.must(['create'], { id: idArg(id), document });
  }

  start(id: string): HcsReply {
    return this.must(['start', idArg(id)]);
  }

  terminate(id: string): HcsReply {
    return this.must(['terminate', idArg(id)]);
  }

  grantVmAccess(vmId: string, file: string): HcsReply {
    return this.must(['grant-vm-access', idArg(vmId), pathArg(file, 'the disk')]);
  }

  createVhdx(file: string, maxGb: number): HcsReply {
    if (!Number.isInteger(maxGb) || maxGb < 1 || maxGb > 4096) fail('The disk size must be 1 to 4096 GB.');
    return this.must(['create-vhdx', pathArg(file, 'the disk'), String(maxGb)]);
  }
}

function readReply(file: string, result: RunResult): HcsReply {
  let text: string;
  try {
    if (fs.statSync(file).size > MAX_RESPONSE_BYTES) fail('HcsHost.exe answered with too much text.');
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e instanceof UserError) throw e;
    fail('HcsHost.exe gave no answer' + (result.error ? ': ' + result.error : '') + '.');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail('HcsHost.exe answered with something that is not JSON.');
  }
  const parsed = HcsReplySchema.safeParse(json);
  return parsed.success ? parsed.data : fail('HcsHost.exe answered in a form this version does not know.');
}

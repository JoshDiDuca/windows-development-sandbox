// The last VPN result of a sandbox, kept in host storage (<storage>\vpn\last.json) when the sandbox closes, so "the
// login was refused" can still be shown after the sandbox is gone. Read from the sandbox's run\vpn.json (validated),
// never from anything else the guest wrote; the text is made safe before it is kept.
import path from 'node:path';
import { z } from 'zod';
import { RunDir } from '../../shared/channel/index.js';
import { JsonFile } from '../../shared/io/index.js';
import { FAILURE_TEXT } from '../../shared/vpn/failure.js';
import { safeText } from '../../core/util/index.js';

const LastSchema = z.object({
  state: z.enum(['up', 'failed']),
  code: z.enum(['auth', 'unreachable', 'driver', 'timeout', 'other']).optional(),
  message: z.string().max(400),
  at: z.string().max(64),
});
export type LastVpn = z.output<typeof LastSchema>;

/** What the page shows for a failure: the plain sentence, never the raw log. */
export interface VpnFailureInfo {
  readonly code: NonNullable<LastVpn['code']>;
  readonly text: string;
  readonly at: string;
}

function lastFile(storageRoot: string): JsonFile<LastVpn> {
  return new JsonFile(LastSchema, path.join(storageRoot, 'vpn', 'last.json'));
}

/** Copies the sandbox's final VPN state to host storage (nothing when the VPN was off). Never throws. */
export function recordLastVpn(storageRoot: string, dataPath: string): void {
  try {
    const status = new RunDir(dataPath).readVpnStatus();
    if (!status || (status.state !== 'up' && status.state !== 'failed')) return;
    lastFile(storageRoot).write({
      state: status.state,
      ...(status.code ? { code: status.code } : {}),
      message: safeText(status.message).slice(0, 400),
      at: status.updatedAt,
    });
  } catch {
    // Only a convenience for the page: a failure here must not hold the final sync up.
  }
}

/** The last attempt, when it failed (null when it worked or none is known). */
export function readLastFailure(storageRoot: string): VpnFailureInfo | null {
  const last = lastFile(storageRoot).read();
  if (!last || last.state !== 'failed') return null;
  const code = last.code ?? 'other';
  return { code, text: FAILURE_TEXT[code], at: last.at };
}

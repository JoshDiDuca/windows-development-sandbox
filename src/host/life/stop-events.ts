import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { SYSTEM } from '../../shared/system.js';
import { isWin } from '../../core/util/index.js';
import { refuseInSelfTest } from '../test-guard.js';
import { hostToolsExe, nativeScript } from '../native.js';

export const IsoSchema = z.string().max(40);

export interface StopEvent {
  at: string;
  id: number;
  provider: string;
  process: string;
}
const StopEventsSchema = z
  .array(
    z.object({
      at: IsoSchema,
      id: z.number().int(),
      provider: z.string().max(200),
      process: z
        .string()
        .max(1600)
        .nullable()
        .transform((p) => p ?? ''),
    }),
  )
  .max(100);

/** The ways a sandbox can end that nobody asked for (the life record stores one of these). */
export const STOP_KINDS = [
  'updates',
  'restart',
  'crash',
  'sleep',
  'memory',
  'sandboxCrash',
  /** The graphics driver reset (display 4101, a GPU LiveKernelEvent): vGPU and the GPU's shared memory. */
  'gpu',
  /** Hyper-V reported an error, or a program that holds the VM (vmwp.exe, vmmem) crashed. */
  'hyperv',
  /** Nothing was logged, but the sandbox was working and left no word of leaving. */
  'vanished',
] as const;
export type StopKind = (typeof STOP_KINDS)[number];
export interface StopCause {
  kind: StopKind;
  at: string;
  text: string;
}

/** Windows live kernel events that are a graphics driver (GPU) reset or timeout. */
const GPU_LIVE_KERNEL = ['117', '141', '1a8'];
const VM_PROGRAMS = /vmwp\.exe|vmmem\w*|vmcompute|windowssandbox\w*/i;

const UPDATERS =
  /^(trustedinstaller|mousocoreworker|musnotification(ux)?|usoclient|wuauclt|tiworker|updateorchestrator)\.exe$/i;

/** The stop code in Kernel-Power 41's detail ("BugcheckCode 209" -> "0xD1"); null for 0 (no blue screen). */
export function bugcheckCode(detail: string): string | null {
  const n = Number(/BugcheckCode\s+(\d+)/.exec(detail)?.[1] ?? 0);
  return n > 0 ? '0x' + n.toString(16).toUpperCase() : null;
}

/**
 * The first event that ends a running sandbox (pure): Windows inside the sandbox crashing (Hyper-V 18590; `process`
 * holds its message with the stop code), a restart or shutdown, a crash or power loss, sleep, low memory. Switching
 * user does not end it (seen on 13 Oct 2026: the sandbox ran on after a switch).
 */
export function explainStop(events: StopEvent[]): StopCause | null {
  const causes = events.flatMap((e): StopCause[] => {
    const p = e.provider.toLowerCase();
    if (e.id === 1074 && p.includes('user32')) {
      const exe =
        e.process
          .split(/[\\/]/)
          .pop()
          ?.replace(/\s*\(.*$/, '') ?? '';
      return UPDATERS.test(exe)
        ? [{ kind: 'updates', at: e.at, text: 'Windows restarted this PC to install updates' }]
        : [
            {
              kind: 'restart',
              at: e.at,
              text: 'this PC was restarted or shut down' + (exe ? ' (by ' + exe + ')' : ''),
            },
          ];
    }
    if (e.id === 41 && p.includes('kernel-power')) {
      const code = bugcheckCode(e.process);
      return [
        {
          kind: 'crash',
          at: e.at,
          text: code
            ? 'this PC blue-screened (stop code ' + code + ')'
            : 'Windows stopped unexpectedly (a freeze, a crash, a power cut, or the power button held down)',
        },
      ];
    }
    if (e.id === 6008 && p.includes('eventlog'))
      return [
        {
          kind: 'crash',
          at: e.at,
          text: 'Windows stopped unexpectedly (a freeze, a crash, a power cut, or the power button held down)',
        },
      ];
    if (e.id === 42 && p.includes('kernel-power'))
      return [{ kind: 'sleep', at: e.at, text: 'this PC went to sleep or hibernated' }];
    if (e.id === 2004 && p.includes('resource-exhaustion'))
      return [{ kind: 'memory', at: e.at, text: 'this PC ran out of memory' }];
    if (e.id === 1001 && p.includes('systemerrorreporting')) {
      const code = /bugcheck was:\s*(0x[0-9a-f]{1,8})/i.exec(e.process)?.[1];
      return [{ kind: 'crash', at: e.at, text: 'this PC blue-screened' + (code ? ' (stop code ' + code + ')' : '') }];
    }
    if (e.id === 18590 && p.includes('hyper-v-worker')) {
      const code = /ErrorCode0:\s*(0x[0-9a-f]{1,8})/i.exec(e.process)?.[1];
      const sub = /ErrorCode1:\s*(0x[0-9a-f]{1,16})/i.exec(e.process)?.[1];
      return [
        {
          kind: 'sandboxCrash',
          at: e.at,
          text:
            'Windows inside the sandbox crashed' + (code ? ' (stop code ' + code + (sub ? ', ' + sub : '') + ')' : ''),
        },
      ];
    }
    // The graphics driver stopped responding and was reset: with vGPU the sandbox shares the GPU, so the VM goes too.
    if (e.id === 4101 && p === 'display')
      return [
        {
          kind: 'gpu',
          at: e.at,
          text: 'the graphics driver stopped responding and was reset while the sandbox used the GPU (vGPU)',
        },
      ];
    const programs = VM_PROGRAMS.exec(e.process)?.[0];
    if (e.id === 1001 && p.includes('windows error reporting') && /LiveKernelEvent/i.test(e.process)) {
      const code = /\bP1:\s*([0-9a-f]{2,4})\b/i.exec(e.process)?.[1]?.toLowerCase();
      if (code && GPU_LIVE_KERNEL.includes(code))
        return [
          {
            kind: 'gpu',
            at: e.at,
            text:
              'the graphics driver reset (Windows live kernel event ' +
              code +
              ') while the sandbox used the GPU (vGPU)',
          },
        ];
    }
    if (
      (e.id === 1000 || e.id === 1001) &&
      programs &&
      /^(application error|windows error reporting)$/i.test(e.provider)
    )
      return [
        {
          kind: 'hyperv',
          at: e.at,
          text: 'a program that runs the sandbox VM (' + programs.toLowerCase() + ') crashed',
        },
      ];
    if (/^microsoft-windows-hyper-v-(worker|vmswitch|compute)/.test(p) && e.id !== 18590 && e.id !== 40001)
      return [
        {
          kind: 'hyperv',
          at: e.at,
          text: 'Hyper-V, which runs the sandbox VM, reported an error (event ' + e.id + ')',
        },
      ];
    return [];
  });
  return causes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] ?? null;
}

/**
 * System log and Hyper-V events since `since` that can end a sandbox (Windows only; empty when the logs cannot be
 * read). HostTools.exe reads them (built in <storageRoot>\bin), else native\scripts\stop-events.ps1.
 */
export function readStopEvents(since: Date, storageRoot: string): StopEvent[] {
  if (!isWin) return [];
  refuseInSelfTest('read the Windows event log');
  const tools = hostToolsExe(storageRoot);
  const options = { encoding: 'utf8' as const, windowsHide: true, timeout: 60000 };
  const result = tools
    ? spawnSync(tools, ['stop-events', '--since', since.toISOString()], options)
    : spawnSync(SYSTEM.powershell(), nativeScript('stop-events.ps1', ['-Since', since.toISOString()]), options);
  try {
    return StopEventsSchema.parse(JSON.parse(result.stdout || '[]'));
  } catch {
    return [];
  }
}

/** Looking back from the last time the sandbox was seen running (a minute between checks, plus margin). */
export function causeSince(lastSeen: string, storageRoot: string): StopCause | null {
  return explainStop(readStopEvents(new Date(Date.parse(lastSeen) - 2 * 60 * 1000), storageRoot));
}

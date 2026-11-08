// Evidence for the crash report that comes from this PC: what the dump of vmwp.exe shows (read by HostTools minidump,
// no debugger needed), the graphics adapter and driver, and when to offer keeping the dump. The dump is on the PC side
// and is only ever parsed, never run; its text goes through safeText.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isWin, safeText } from '../../core/util/index.js';
import { SYSTEM } from '../../shared/system.js';
import { hostToolsExe, nativeScript } from '../native.js';
import { selfTestRunning } from '../test-guard.js';
import type { StopCause } from './stop-events.js';

const MINIDUMP_TIMEOUT_MS = 30000;
const GRAPHICS_TIMEOUT_MS = 20000;
/** HostTools refuses larger files; this skips them before it starts a program. */
const MAX_DUMP_BYTES = 64 * 1024 * 1024;

const Name = z.string().max(260);
export const MiniDumpSchema = z.object({
  exceptionCode: z.string().max(20),
  exceptionAddress: z.string().max(24),
  faultingModule: Name.nullable(),
  faultingOffset: z.string().max(24).nullable(),
  faultingVersion: z.string().max(40).nullable().optional(),
  stackModules: z.array(Name).max(16),
  modules: z.number().int().min(0).max(100000),
});
export type MiniDumpInfo = z.output<typeof MiniDumpSchema>;

/** The parsed answer of `HostTools minidump`, or null (pure). */
export function parseMiniDump(text: string): MiniDumpInfo | null {
  try {
    const parsed = MiniDumpSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** What HostTools reads from a dump file, or null (no HostTools, a file that is not a sound dump, or the self-test). */
export function readMiniDump(storageRoot: string, file: string): MiniDumpInfo | null {
  if (!isWin || selfTestRunning()) return null;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_DUMP_BYTES) return null;
    const tools = hostToolsExe(storageRoot);
    if (!tools) return null;
    const result = spawnSync(tools, ['minidump', file], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: MINIDUMP_TIMEOUT_MS,
    });
    return result.status === 0 ? parseMiniDump(result.stdout ?? '') : null;
  } catch {
    // A dump that vanished or cannot be read: the report goes without it.
    return null;
  }
}

/** The newest vmwp.exe dump among these (the dump files WER LocalDumps writes are named vmwp.exe.<pid>.dmp). */
export function newestVmwpDump(dumps: readonly { name: string; at: string }[]): string | null {
  const mine = dumps.filter((d) => /^vmwp\.exe.*\.dmp$/i.test(path.win32.basename(d.name)));
  return mine.sort((a, b) => a.at.localeCompare(b.at)).pop()?.name ?? null;
}

const EXCEPTIONS: Readonly<Record<string, string>> = {
  '0xc0000005': 'access violation',
  '0xc0000374': 'heap corruption',
  '0xc0000409': 'stack buffer overrun',
  '0xc000001d': 'illegal instruction',
  '0x80000003': 'breakpoint',
  '0xc00000fd': 'stack overflow',
  '0xc0000094': 'integer divide by zero',
};

const GRAPHICS_MODULE =
  /^(vmuidevices|vrd\w*|dxg\w*|nvldumdx|nvwgf2\w*|nvd3dum\w*|amdxx64|amdxc64|atidxx64|aticfx64|ig(d|xel|9)\w*)\.dll$|gpu|dx/i;
const HYPERV_MODULE = /^(vmchipset|vmbus\w*|vmsmb\w*)/i;

export type DumpArea = 'graphics' | 'hyperv' | 'windows';

/** Which part of Windows the modules point at (pure): graphics first, since that is the one a setting can avoid. */
export function dumpArea(modules: readonly string[]): DumpArea {
  if (modules.some((m) => GRAPHICS_MODULE.test(m))) return 'graphics';
  if (modules.some((m) => HYPERV_MODULE.test(m))) return 'hyperv';
  return 'windows';
}

const AREA_TEXT: Readonly<Record<DumpArea, string>> = {
  graphics:
    'That is the graphics (vGPU) path: update the graphics driver, or keep vGPU off for unattended runs (sandbox config set sandbox.vGpu false).',
  hyperv: "Those are Hyper-V's own devices: update Windows.",
  windows: "Only Windows' VM worker code is involved: update Windows.",
};

/** The report's lines about a dump (pure): what it shows, and what that points at. */
export function dumpLines(info: MiniDumpInfo): string[] {
  const code = info.exceptionCode.toLowerCase();
  const what = EXCEPTIONS[code] ? EXCEPTIONS[code] + ' (' + code + ')' : 'exception ' + code;
  const where = info.faultingModule
    ? safeText(info.faultingModule) + (info.faultingOffset ? '+' + info.faultingOffset : '')
    : 'address ' + info.exceptionAddress;
  const stack = info.stackModules.map((m) => safeText(m));
  return [
    'What the dump shows: ' + what + ' in ' + where + (stack.length ? '; on its stack: ' + stack.join(', ') : '') + '.',
    AREA_TEXT[dumpArea([...(info.faultingModule ? [info.faultingModule] : []), ...info.stackModules])],
  ];
}

/** A graphics adapter as Windows reports it. */
const AdapterSchema = z.object({
  name: z.string().max(200),
  driverVersion: z.string().max(60).optional().catch(undefined),
  driverDate: z.string().max(20).nullable().optional().catch(undefined),
});
export type GraphicsAdapter = z.output<typeof AdapterSchema>;

/** The adapters in get-video-controllers.ps1's output (a JSON array; PowerShell prints one object bare), or []. */
export function parseAdapters(text: string): GraphicsAdapter[] {
  try {
    const json: unknown = JSON.parse(text);
    const list = Array.isArray(json) ? json : [json];
    return list.slice(0, 8).flatMap((item) => {
      const parsed = AdapterSchema.safeParse(item);
      return parsed.success && parsed.data.name ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}

/** "NVIDIA GeForce RTX 4070, driver 32.0.15.6094 of 2024-10-02" (pure). */
export function adapterLine(a: GraphicsAdapter): string {
  return (
    safeText(a.name) +
    (a.driverVersion ? ', driver ' + safeText(a.driverVersion) : '') +
    (a.driverDate ? ' of ' + safeText(a.driverDate) : '')
  );
}

/** The graphics adapters of this PC (name, driver, date), or [] when they cannot be read or during the self-test. */
export function readGraphicsAdapters(): GraphicsAdapter[] {
  if (!isWin || selfTestRunning()) return [];
  const result = spawnSync(SYSTEM.powershell(), nativeScript('get-video-controllers.ps1'), {
    encoding: 'utf8',
    windowsHide: true,
    timeout: GRAPHICS_TIMEOUT_MS,
  });
  return result.status === 0 ? parseAdapters(result.stdout ?? '') : [];
}

/** Whether this stop was the program that runs the VM (vmwp.exe) crashing. */
export function isVmwpCrash(cause: StopCause | null): boolean {
  return cause !== null && cause.kind === 'hyperv' && /vmwp\.exe/i.test(cause.text);
}

/** What decides whether the next launch offers to keep the VM's crash dump. */
export interface DumpOfferFacts {
  readonly cause: StopCause | null;
  /** The dump capture is already on. */
  readonly dumpsOn: boolean;
  /** The question was asked once already (whatever the answer). */
  readonly asked: boolean;
  /** A person is at a terminal: never in --auto, unattended or piped runs. */
  readonly interactive: boolean;
}

/** Offer to keep the dump only after a vmwp.exe crash, once, to a person who can answer (pure). */
export function shouldOfferVmDumps(f: DumpOfferFacts): boolean {
  return f.interactive && !f.dumpsOn && !f.asked && isVmwpCrash(f.cause);
}

const ASKED_FILE = 'vm-dumps-asked.txt';

/** Whether the question was asked before (<storage>\run\vm-dumps-asked.txt). */
export function vmDumpsAsked(storageRoot: string): boolean {
  return fs.existsSync(path.join(storageRoot, 'run', ASKED_FILE));
}

/** Records the answer, so the question is asked once. */
export function recordVmDumpsAnswer(storageRoot: string, yes: boolean): void {
  try {
    fs.mkdirSync(path.join(storageRoot, 'run'), { recursive: true });
    fs.writeFileSync(path.join(storageRoot, 'run', ASKED_FILE), (yes ? 'yes ' : 'no ') + new Date().toISOString());
  } catch {
    // Cannot record it: it may be asked again next time, which is harmless.
  }
}

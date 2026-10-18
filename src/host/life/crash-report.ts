// The crash report: what Windows logged when the sandbox ended and the last minutes of the sandbox's memory log, kept
// in <storage>\logs\crashes (the newest 20).
import fs from 'node:fs';
import path from 'node:path';
import { assertNoLinks, safeText } from '../../core/util/index.js';
import { vgpuWarning } from '../launch/risk-notes.js';
import { hostMemoryLine, readHostMemory } from './host-memory.js';
import { hostDataFolder, hostDataRoot } from '../storage/index.js';
import { bugcheckCode, explainStop, readStopEvents, type StopCause, type StopEvent } from './stop-events.js';

const KEEP_REPORTS = 20;
const MEMORY_TAIL_BYTES = 16 * 1024;

/** A gap longer than this between "last seen running" and the restart means the PC stopped responding first. */
const FREEZE_GAP_MS = 5 * 60 * 1000;

/** A crash dump Windows left (name and time only; never read). */
export interface DumpFile {
  readonly name: string;
  readonly at: string;
}

/** Extra evidence for the report (all optional): this PC's own memory log lines and the dumps found. */
export interface CrashExtra {
  readonly hostMemoryLog?: string;
  readonly dumps?: readonly DumpFile[];
  readonly hostMemoryNow?: string;
  /** The frozen sandbox's launch had vGPU on (read from its .wsb). */
  readonly vgpu?: boolean;
}

function crashDir(storageRoot: string): string {
  return path.join(storageRoot, 'logs', 'crashes');
}

/** "This PC stopped responding at X and was restarted at Y (n minutes later)", or null when there was no long gap. */
export function freezeLine(cause: StopCause, lastSeen: string): string | null {
  if (cause.kind !== 'crash') return null;
  const gap = Date.parse(cause.at) - Date.parse(lastSeen);
  if (!Number.isFinite(gap) || gap <= FREEZE_GAP_MS) return null;
  return (
    'This PC stopped responding at ' +
    lastSeen +
    ' (the last time anything was seen running) and was restarted at ' +
    cause.at +
    ' (' +
    Math.round(gap / 60000) +
    ' minutes later).'
  );
}

/** What each kind of event usually means, one line per kind that appears (pure). */
export function findingLines(events: readonly StopEvent[]): string[] {
  const lines: string[] = [];
  const has = (pred: (e: StopEvent) => boolean): StopEvent | undefined => events.find(pred);
  const lower = (e: StopEvent): string => e.provider.toLowerCase();
  const resource = has((e) => e.id === 2004 && lower(e).includes('resource-exhaustion'));
  if (resource)
    lines.push(
      'Resource-Exhaustion-Detector 2004: memory ran out (RAM plus paging file). Programs were using too much at once.',
    );
  const bug = has((e) => e.id === 1001 && lower(e).includes('systemerrorreporting'));
  const bugCode = bug ? /bugcheck was:\s*(0x[0-9a-f]{1,8})/i.exec(bug.process)?.[1] : undefined;
  const power = has((e) => e.id === 41 && lower(e).includes('kernel-power'));
  const powerCode = power ? bugcheckCode(power.process) : null;
  if (bug || powerCode)
    lines.push(
      'Blue screen with stop code ' +
        (bugCode ?? powerCode) +
        ': search that code on Microsoft Learn; drivers, memory or hardware are the usual causes.',
    );
  else if (power)
    lines.push(
      'Kernel-Power 41 without a stop code: the PC froze, lost power or was reset by hand, with no blue screen.',
    );
  if (has((e) => lower(e).includes('whea-logger')))
    lines.push(
      'WHEA-Logger: Windows reported a hardware error (CPU, memory, a bus or a disk): heat or failing hardware.',
    );
  if (has((e) => lower(e).startsWith('hyper-v')))
    lines.push("Hyper-V events: the sandbox's virtual machine (or the service that runs it) reported a problem.");
  if (has((e) => /^(application error|windows error reporting)$/i.test(e.provider)))
    lines.push("A crash report names vmwp.exe or vmmem, the programs that hold the sandbox's VM.");
  return lines;
}

/** Crash dumps in these folders newer than `since`: names and times only. */
export function findDumps(dirs: readonly string[], since: Date): DumpFile[] {
  const found: DumpFile[] = [];
  for (const dir of dirs) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!/\.dmp$/i.test(name)) continue;
        const stat = fs.lstatSync(path.join(dir, name));
        if (stat.isFile() && stat.mtime >= since)
          found.push({ name: path.join(dir, name), at: stat.mtime.toISOString() });
      }
    } catch {
      // No such folder, or no access: no dumps to list.
    }
  }
  return found.sort((a, b) => a.at.localeCompare(b.at)).slice(0, 10);
}

/** Whether the newest launch started at or before `lastSeen` had vGPU on (host-only .wsb in <storage>\launches). */
export function launchHadVgpu(storageRoot: string, lastSeen: string): boolean {
  try {
    const root = path.join(storageRoot, 'launches');
    const limit = Date.parse(lastSeen) + 60 * 1000;
    const newest = fs
      .readdirSync(root)
      .map((name) => ({ name, at: fs.lstatSync(path.join(root, name)).mtimeMs }))
      .filter((l) => l.at <= limit)
      .sort((a, b) => b.at - a.at)[0];
    if (!newest) return false;
    const dir = path.join(root, newest.name);
    const wsb = fs.readdirSync(dir).find((f) => f.endsWith('.wsb'));
    return wsb
      ? /<VGpu>\s*Enable\s*<\/VGpu>/i.test(fs.readFileSync(path.join(dir, wsb), 'utf8').slice(0, 65536))
      : false;
  } catch {
    // No launch folder to read: unknown, so nothing is claimed.
    return false;
  }
}

/** A tail of this PC's own memory log (written by the watcher), without following links. */
function hostMemoryTail(storageRoot: string, dataPath: string): string {
  try {
    const file = path.join(storageRoot, 'logs', 'host-memory-' + path.basename(dataPath) + '.log');
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return '';
    const length = Math.min(stat.size, MEMORY_TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, stat.size - length);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * The report text (pure): what happened (the sandbox's or this PC's stop code, where the dump is) and the memory log's
 * last lines. `memoryLog` is the sandbox's own file, so it is shown through safeText.
 */
export function crashReportText(
  cause: StopCause,
  events: readonly StopEvent[],
  memoryLog: string,
  lastSeen: string,
  extra: CrashExtra = {},
): string {
  const seen = new Set<string>();
  const unique = events.filter((e) => {
    const key = e.at + '|' + e.id + '|' + e.provider;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const eventLines = unique.length
    ? unique.map(
        (e) => '  ' + e.at + '  ' + e.provider + ' ' + e.id + (e.process ? ': ' + e.process.replace(/\s+/g, ' ') : ''),
      )
    : ['  (none)'];
  const memoryLines = memoryLog
    ? memoryLog
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-30)
        .map((l) => '  ' + safeText(l))
    : ['  (none found)'];
  const hostLines = (extra.hostMemoryLog ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-20)
    .map((l) => '  ' + safeText(l));
  const freeze = freezeLine(cause, lastSeen);
  const meaning = findingLines(unique);
  const dumps = extra.dumps ?? [];
  const vgpu = extra.vgpu ? ['vGPU was on for this sandbox. ' + vgpuWarning('its launch settings'), ''] : [];
  return [
    'Sandbox crash report, written ' + new Date().toISOString(),
    'What happened: ' + cause.text + ' at ' + cause.at + ' (the sandbox was last seen running at ' + lastSeen + ').',
    ...(freeze ? [freeze] : []),
    '',
    'Windows events around then:',
    ...eventLines,
    '',
    ...vgpu,
    'What that usually means:',
    ...(meaning.length ? meaning.map((l) => '  ' + l) : ['  (no memory, blue screen or hardware event was logged)']),
    '',
    'Crash dumps Windows left (C:\\Windows\\Minidump, MEMORY.DMP):',
    ...(dumps.length ? dumps.map((d) => '  ' + d.name + '  ' + d.at) : ['  (none from that time)']),
    '',
    "This PC's memory while the sandbox ran (host-memory log):",
    ...(hostLines.length ? hostLines : ['  (none: the background sync was not running)']),
    ...(extra.hostMemoryNow ? ['  after the restart: ' + extra.hostMemoryNow] : []),
    '',
    "The sandbox's memory log, last lines (C:\\AgentData\\logs\\memory-*.log inside it):",
    ...memoryLines,
    '',
  ].join('\n');
}

/** The newest crash report in <storage>\logs\crashes (at most 64 KB of it), or null. */
export function newestCrashReport(storageRoot: string): { file: string; text: string } | null {
  try {
    const dir = crashDir(storageRoot);
    const newest = fs
      .readdirSync(dir)
      .filter((f) => /^crash-.*\.txt$/.test(f))
      .sort()
      .pop();
    if (!newest) return null;
    const file = path.join(dir, newest);
    return { file, text: safeText(fs.readFileSync(file, 'utf8').slice(0, 64 * 1024)) };
  } catch {
    // No reports folder: none yet.
    return null;
  }
}

/** The newest memory log the sandbox wrote, last 16 KB at most, without following links in the data folder. */
function memoryLogTail(dataPath: string): string {
  try {
    const logs = hostDataFolder(dataPath, 'logs');
    assertNoLinks(hostDataRoot(dataPath), logs);
    const newest = fs
      .readdirSync(logs)
      .filter((f) => /^memory-\d{8}-\d{6}\.log$/.test(f))
      .sort()
      .pop();
    if (!newest) return '';
    const file = path.join(logs, newest);
    if (!fs.lstatSync(file).isFile()) return '';
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const length = Math.min(size, MEMORY_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * When the sandbox ended in a crash (its own, this PC's, power, low memory): writes the report and returns its path.
 */
export function saveCrashReport(storageRoot: string, dataPath: string, lastSeen: string): string | null {
  const events = readStopEvents(new Date(Date.parse(lastSeen) - 2 * 60 * 1000), storageRoot);
  const cause = explainStop(events);
  if (!cause || !['sandboxCrash', 'crash', 'memory'].includes(cause.kind)) return null;
  const dir = crashDir(storageRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'crash-' + cause.at.replace(/[:.]/g, '-') + '.txt');
  const since = new Date(Date.parse(lastSeen) - 10 * 60 * 1000);
  const windir = process.env.SystemRoot ?? 'C:\\Windows';
  const memoryNow = readHostMemory(storageRoot);
  fs.writeFileSync(
    file,
    crashReportText(cause, events, memoryLogTail(dataPath), lastSeen, {
      hostMemoryLog: hostMemoryTail(storageRoot, dataPath),
      vgpu: launchHadVgpu(storageRoot, lastSeen),
      dumps: findDumps([path.join(windir, 'Minidump'), windir], since),
      ...(memoryNow ? { hostMemoryNow: hostMemoryLine(memoryNow) } : {}),
    }),
  );
  for (const old of fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('crash-'))
    .sort()
    .slice(0, -KEEP_REPORTS))
    fs.rmSync(path.join(dir, old), { force: true });
  return file;
}

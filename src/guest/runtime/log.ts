// The guest's log: every line goes to the log file (timestamped, plain) and, unless it is quiet, to the console, or
// to the boot's progress view while that owns the console.
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { logsDir } from './paths.js';
import { fileLines } from './log-line.js';

fs.mkdirSync(logsDir, { recursive: true });
const logFile = path.join(
  logsDir,
  (process.env.AGENT_LOG_PREFIX ?? 'guest') + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log',
);

/** Who is logging: the boot task (its stage and title) and whether the console stays silent. */
export interface LogContext {
  readonly stage?: number;
  readonly task?: string;
  /** File only: nothing may print once the first session owns the console. */
  readonly quiet?: boolean;
}

/** Takes the console's lines while the boot draws its progress (boot/boot-console.ts). */
export interface ConsoleSink {
  /** An info line; `stage` is the stage of the task that logged it. */
  line(message: string, stage: number | undefined): void;
  warning(message: string): void;
  /** A line the user should read once the boot is ready (shown with the summary). */
  notice(message: string): void;
}

const context = new AsyncLocalStorage<LogContext>();
let sink: ConsoleSink | null = null;

/** Runs `work` so that everything it logs (also after awaits) carries `ctx`. */
export function withLogContext<T>(ctx: LogContext, work: () => T): T {
  return context.run(ctx, work);
}

/** Runs `work` logging to the file only. */
export function runQuiet<T>(work: () => T): T {
  return context.run({ ...context.getStore(), quiet: true }, work);
}

/** Sends the console's lines to `next` (null: straight to the console again). */
export function routeConsole(next: ConsoleSink | null): void {
  sink = next;
}

const append = (message: string, ctx: LogContext | undefined): void => {
  try {
    const lines = fileLines(message, new Date(), ctx?.task);
    if (lines.length) fs.appendFileSync(logFile, lines.join('\n') + '\n');
  } catch {
    /* logging must never break the run */
  }
};

export function log(message: string): void {
  const ctx = context.getStore();
  append(message, ctx);
  if (ctx?.quiet) return;
  if (sink) sink.line(message, ctx?.stage);
  else console.log(message);
}

export function warn(message: string): void {
  const ctx = context.getStore();
  append('WARNING: ' + message, ctx);
  if (ctx?.quiet) return;
  if (sink) sink.warning(message);
  else console.warn('\x1b[33mWARNING: ' + message + '\x1b[0m');
}

/** A line for the user once the boot is ready (printed at once outside the boot). */
export function notice(message: string): void {
  const ctx = context.getStore();
  append(message, ctx);
  if (ctx?.quiet) return;
  if (sink) sink.notice(message);
  else console.log(message);
}

/** A line for the log file only. */
export function record(message: string): void {
  append(message, context.getStore());
}

export const logPath = logFile;

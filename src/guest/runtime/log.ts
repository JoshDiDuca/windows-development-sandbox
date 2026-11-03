import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { logsDir } from './paths.js';

fs.mkdirSync(logsDir, { recursive: true });
const logFile = path.join(
  logsDir,
  (process.env.AGENT_LOG_PREFIX ?? 'guest') + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log',
);

/** Who is logging: the task title (a prefix while several tasks run) and whether the console stays silent. */
export interface LogContext {
  readonly prefix?: () => string;
  /** File only: nothing may print once the first session owns the console. */
  readonly quiet?: boolean;
}

const context = new AsyncLocalStorage<LogContext>();

/** Runs `work` so that everything it logs (also after awaits) carries `ctx`. */
export function withLogContext<T>(ctx: LogContext, work: () => T): T {
  return context.run(ctx, work);
}

/** Runs `work` logging to the file only. */
export function runQuiet<T>(work: () => T): T {
  return context.run({ ...context.getStore(), quiet: true }, work);
}

/** One line of the file: an ISO timestamp first (the console shows no times). */
export function fileLine(message: string, at: Date = new Date()): string {
  return at.toISOString() + ' ' + message;
}

const append = (line: string): void => {
  try {
    fs.appendFileSync(logFile, fileLine(line) + '\n');
  } catch {
    /* logging must never break the run */
  }
};

const tagged = (message: string, ctx: LogContext | undefined): string => {
  const prefix = ctx?.prefix?.();
  return prefix ? prefix + ' | ' + message : message;
};

export function log(message: string): void {
  const ctx = context.getStore();
  const line = tagged(message, ctx);
  if (!ctx?.quiet) console.log(line);
  append(line);
}
export function warn(message: string): void {
  const ctx = context.getStore();
  const line = tagged(message, ctx);
  if (!ctx?.quiet) console.warn('\x1b[33mWARNING: ' + line + '\x1b[0m');
  append('WARNING: ' + line);
}
export const logPath = logFile;

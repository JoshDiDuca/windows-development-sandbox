import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommanderError } from 'commander';
import { c } from './output/index.js';
import { UserError, errMsg, plainText } from '../core/util/index.js';

/** Where errors nobody caught are written in full (this user's temp folder; kept under 1 MB). */
export const UNEXPECTED_LOG = path.join(os.tmpdir(), 'windows-development-sandbox-errors.log');
const UNEXPECTED_LOG_MAX = 1024 * 1024;

/**
 * An error thrown by background work (a timer, a promise nobody awaited): written in full to UNEXPECTED_LOG and named
 * in one line, instead of ending the menu, the web server or a command half-way.
 */
export function recordUnexpected(e: unknown, kind: string): void {
  const text =
    new Date().toISOString() +
    ' ' +
    kind +
    ' (pid ' +
    process.pid +
    ', ' +
    process.argv.slice(2).join(' ') +
    ')\n' +
    (e instanceof Error && e.stack ? e.stack : errMsg(e)) +
    '\n\n';
  try {
    if (fs.existsSync(UNEXPECTED_LOG) && fs.statSync(UNEXPECTED_LOG).size > UNEXPECTED_LOG_MAX)
      fs.rmSync(UNEXPECTED_LOG, { force: true });
    fs.appendFileSync(UNEXPECTED_LOG, text);
  } catch {
    // Nowhere to write it: the line below still says what happened.
  }
  console.error(
    c.red('Unexpected error (kept running): ') + plainText(errMsg(e)) + c.dim('  Details: ' + UNEXPECTED_LOG),
  );
}

/** Prints a problem the way a user can act on it: what happened, how to fix it; stack traces only for real bugs. */
export function report(e: unknown): number {
  if (e instanceof CommanderError)
    return ['commander.helpDisplayed', 'commander.help', 'commander.version'].includes(e.code) ? 0 : e.exitCode || 1;
  if (e instanceof UserError) {
    // Messages can quote what the sandbox wrote (a session's status, an address): never with its control codes.
    console.error(c.red('Error: ') + plainText(e.message));
    if (e.fix) console.error('  Fix:  ' + plainText(e.fix));
    return 1;
  }
  console.error(c.red('Unexpected error: ') + errMsg(e));
  console.error(
    c.dim(
      'This is a bug in windows-development-sandbox. Details: ' +
        (e instanceof Error && e.stack ? e.stack.split('\n').slice(1, 4).join(' | ').trim() : 'none'),
    ),
  );
  console.error('  Please report it with the output of: sandbox doctor');
  return 1;
}

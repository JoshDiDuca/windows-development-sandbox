// The lines of the guest's log files: plain text (no colours), one timestamped line per line of the message. Pure.

/** Colour and cursor sequences (CSI ... letter), bounded so a hostile line costs linear time. */
const ESCAPES = /\x1b\[[0-9;?]{0,32}[A-Za-z]/g;

/** Text without its terminal colour and cursor sequences. */
export function plainText(text: string): string {
  return text.replace(ESCAPES, '');
}

/**
 * The file lines for one message: each line of it with an ISO timestamp (UTC, zero-padded:
 * `2026-11-04T12:07:27.930Z`) and the task that logged it, if any; blank lines are dropped.
 */
export function fileLines(message: string, at: Date = new Date(), task?: string): string[] {
  const stamp = at.toISOString() + ' ' + (task ? '[' + task + '] ' : '');
  return plainText(message)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => stamp + line.trimEnd());
}

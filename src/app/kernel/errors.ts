// How a failure crosses a surface: a UserError (fail(message, fix)) stays a message and a fix everywhere, a declined
// question is "cancelled" (nothing changed), a value that does not fit a schema is "invalid", and anything else is a
// bug whose details stay on this PC.
import { z } from 'zod';
import { UserError, type ErrorAction } from '../../core/util/errors.js';

export type { ErrorAction };

export const ErrorKindSchema = z.enum(['user', 'cancelled', 'invalid', 'bug']);
export type ErrorKind = z.output<typeof ErrorKindSchema>;

/** A failure as every surface shows it (and as the web receives it). */
export const WireErrorSchema = z.strictObject({
  kind: ErrorKindSchema,
  message: z.string().max(2000),
  fix: z.string().max(2000).optional(),
  /** A button that fixes it (the command line is not sent: only the CLI prints it). */
  action: z
    .strictObject({
      op: z.string().max(100),
      input: z.record(z.string(), z.unknown()).optional(),
      label: z.string().max(200),
    })
    .optional(),
});
export type WireError = z.output<typeof WireErrorSchema>;

/** The user said no to a question the operation needed: nothing changed. */
export class Cancelled extends Error {
  constructor(message = 'Nothing changed.') {
    super(message);
    this.name = 'Cancelled';
  }
}

/** Ends an operation because a question was declined. */
export function cancelled(message?: string): never {
  throw new Cancelled(message);
}

/** What the user is told about a bug (its stack never leaves this PC). */
export const BUG_MESSAGE = 'Something went wrong.';

/** Any thrown value as message + fix. */
export function toWireError(e: unknown): WireError {
  if (e instanceof Cancelled) return { kind: 'cancelled', message: e.message };
  if (e instanceof UserError) {
    const a = e.action;
    return {
      kind: 'user',
      message: e.message,
      ...(e.fix ? { fix: e.fix } : {}),
      ...(a ? { action: { op: a.op, ...(a.input ? { input: { ...a.input } } : {}), label: a.label } } : {}),
    };
  }
  if (e instanceof z.ZodError) return { kind: 'invalid', message: issuesText(e) };
  return { kind: 'bug', message: BUG_MESSAGE };
}

/** The error to throw on the receiving side (the web client, a test). */
export function fromWireError(w: WireError): Error {
  if (w.kind === 'cancelled') return new Cancelled(w.message);
  return new UserError(
    w.message,
    w.fix,
    w.action ? { op: w.action.op, input: w.action.input, label: w.action.label, cli: '' } : undefined,
  );
}

/** "key: problem; other: problem" for a value that did not fit its schema. */
export function issuesText(e: z.ZodError): string {
  return e.issues.map((i) => (i.path.length ? i.path.join('.') + ': ' : '') + i.message).join('; ');
}

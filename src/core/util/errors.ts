/** A step that fixes a problem: the menu and the web offer `op` as a button, the command line prints `cli`. */
export interface ErrorAction {
  readonly op: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly label: string;
  readonly cli: string;
}

/** An expected problem the user can act on: what went wrong, and (optionally) how to fix it. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly fix?: string,
    readonly action?: ErrorAction,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

/** Throws a UserError. Typed explicitly so TypeScript narrows after calls (arrow functions need it to act as never). */
export const fail: (message: string, fix?: string) => never = (message, fix) => {
  throw new UserError(message, fix);
};

/** Throws a UserError whose fix is also a button (menu, web) and a command line (CLI). */
export const failWith: (message: string, fix: string, action: ErrorAction) => never = (message, fix, action) => {
  throw new UserError(message, fix, action);
};

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

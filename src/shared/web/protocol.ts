// What the web UI's server and its browser app say to each other. Types and constants only (no Node, no DOM), so the
// server (src/host/web) and the app (web/) share one definition.

/** The header every state-changing call carries (a browser page of another site cannot add it without CORS). */
export const CSRF_HEADER = 'x-sandbox-web';
export const CSRF_VALUE = '1';
export const COOKIE_NAME = 'sbxweb';

export interface WebSession {
  readonly id: string;
  readonly harness: string;
  readonly project: string;
  readonly cwd: string;
  readonly phase: 'starting' | 'running' | 'exited' | 'failed';
  readonly message: string;
  readonly startedAt: string;
  /** Terminals attached right now (null: the session could not be asked). */
  readonly viewers: number | null;
  /** The session can be opened here (running, and reachable from this PC). */
  readonly canOpen: boolean;
}

export interface WebProject {
  readonly name: string;
  readonly guest: string;
}

export interface WebInfo {
  readonly sandbox: 'running' | 'stopped';
  /** "Running, started by alice (shared with you)" and the like; null for your own sandbox. */
  readonly owner: string | null;
  /** This user may open sessions and start new ones in the running sandbox. */
  readonly canUse: boolean;
  readonly harnesses: readonly string[];
  readonly defaultHarness: string;
  readonly projects: readonly WebProject[];
}

/** Browser -> server on the terminal socket: binary messages are keystrokes; text messages are these (JSON). */
export type ClientMessage = { readonly t: 'resize'; readonly cols: number; readonly rows: number };

/** Server -> browser: binary messages are terminal output; text messages are these (JSON). */
export type ServerMessage =
  | { readonly t: 'ready' }
  | { readonly t: 'restarting' }
  | { readonly t: 'exit'; readonly code: number }
  | { readonly t: 'error'; readonly message: string };

export const MIN_COLS = 10;
export const MAX_COLS = 500;
export const MIN_ROWS = 2;
export const MAX_ROWS = 300;
/** Biggest browser message the server accepts (a paste); more closes the socket. */
export const MAX_CLIENT_MESSAGE_BYTES = 256 * 1024;

/** A browser message that is JSON of a known shape and sane numbers, else null (the socket is then closed). */
export function parseClientMessage(text: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  if (m.t !== 'resize') return null;
  const { cols, rows } = m;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  const c = cols as number;
  const r = rows as number;
  if (c < MIN_COLS || c > MAX_COLS || r < MIN_ROWS || r > MAX_ROWS) return null;
  return { t: 'resize', cols: c, rows: r };
}

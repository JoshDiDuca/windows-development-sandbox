// What the web server needs from the rest of the program, so the server stays free of the CLI and testable with a
// fake. The real one (cli/services/web-service.ts) applies the sharing rules and talks to the running sandbox.
import type { Endpoint } from '../../shared/pty/index.js';
import type { WebInfo, WebSession } from '../../shared/web/index.js';

export interface WebBackend {
  info(): Promise<WebInfo>;
  /** Sessions as the browser may see them: never an attach token or address. */
  sessions(): Promise<WebSession[]>;
  /**
   * Where to connect to a session's terminal (with its token, which stays on this PC), or null when there is no such
   * running session, the sandbox is not shared with this user, or it has no address on this PC's sandbox network.
   */
  endpoint(sessionId: string): Endpoint | null;
}

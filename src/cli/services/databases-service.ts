// Databases of the running sandbox, through its own `sbx-db`. Returns data, never prints.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { GuestResponse } from '../../core/types.js';
import { fail, safeText } from '../../core/util/index.js';
import { SandboxChannel } from '../../host/channel/index.js';
import { insideSandbox } from '../../host/sandbox/index.js';
import type { Context } from '../commands/context.js';

export type DatabaseAction = 'list' | 'start' | 'stop';

/** One line of `sbx-db list`: name, state, port and the product's name. */
export interface DatabaseRow {
  readonly name: string;
  readonly running: boolean;
  readonly port: number;
  readonly title: string;
}

/** Reads `sbx-db list` output (text from the sandbox: only the shapes expected are kept). */
export function parseDatabaseList(stdout: string): DatabaseRow[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const m = /^([a-z0-9]+)\s+(running|stopped)\s+port (\d{1,5})\s+(.*)$/.exec(line.trim());
    return m ? [{ name: m[1], running: m[2] === 'running', port: Number(m[3]), title: safeText(m[4]) }] : [];
  });
}

/** How long an answer about the running databases' ports is reused (they change only when one starts or stops). */
const PORTS_FRESH_MS = 20_000;
const recentPorts = new Map<string, { at: number; ports: Set<number> | null }>();

export class DatabasesService {
  constructor(private readonly ctx: Pick<Context, 'dataPath' | 'packageRoot'>) {}

  /** Checks the action and database name from the command line. */
  validate(action: string, name: string | undefined): DatabaseAction {
    if (action !== 'list' && action !== 'start' && action !== 'stop')
      fail(
        'Unknown db action "' + action + '".',
        'Use: sandbox db  (list)  or  sandbox db start|stop <postgres|mysql|mongodb|redis|dynamodb>',
      );
    if (action !== 'list' && !name)
      fail('Which database?', 'Usage: sandbox db ' + action + ' <postgres|mysql|mongodb|redis|dynamodb>');
    return action;
  }

  /** Already inside the sandbox: runs the database tool here (its output goes to this terminal); its exit code. */
  runInside(action: DatabaseAction, name?: string): number {
    return (
      spawnSync(
        process.execPath,
        [path.join(this.ctx.packageRoot, 'dist', 'runtime', 'db.js'), action, ...(name ? [name] : [])],
        { stdio: 'inherit', windowsHide: true },
      ).status ?? 1
    );
  }

  isInsideSandbox(): boolean {
    return insideSandbox();
  }

  /** Asks the running sandbox to list, start or stop a database in the project folder `cwd` (guest path). */
  run(action: DatabaseAction, name: string | undefined, cwd: string): Promise<GuestResponse> {
    // Starting can download the database the first time.
    return new SandboxChannel(this.ctx.dataPath).exec(['sbx-db', action, ...(name ? [name] : [])], cwd, 1800);
  }

  /** The databases the sandbox can start and whether each runs now. */
  async list(cwd: string): Promise<DatabaseRow[]> {
    return parseDatabaseList((await this.run('list', undefined, cwd)).stdout ?? '');
  }

  /** Running databases by port, from `sbx-db list` (best effort: null when the sandbox does not answer). */
  /**
   * The ports of the databases running in the sandbox (null: it could not be asked). Asked inside the sandbox, so a
   * live page reading it every few seconds shares one answer for PORTS_FRESH_MS.
   */
  async runningPorts(cwd: string): Promise<Set<number> | null> {
    const known = recentPorts.get(cwd);
    if (known && Date.now() - known.at < PORTS_FRESH_MS) return known.ports;
    const ports = await this.askPorts(cwd);
    recentPorts.set(cwd, { at: Date.now(), ports });
    return ports;
  }

  private async askPorts(cwd: string): Promise<Set<number> | null> {
    try {
      const r = await new SandboxChannel(this.ctx.dataPath).exec(['sbx-db', 'list'], cwd, 30);
      return new Set(
        (r.stdout ?? '')
          .split(/\r?\n/)
          .filter((l) => /\brunning\b/.test(l))
          .map((l) => Number(/port (\d+)/.exec(l)?.[1]))
          .filter((n) => n > 0),
      );
    } catch {
      return null;
    }
  }
}

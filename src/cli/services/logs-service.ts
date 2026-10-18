// The sandbox's own logs (written inside the sandbox, so never read through links). Returns data, never prints.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { assertNoLinks, fail, safeText } from '../../core/util/index.js';
import { hostDataFolder, hostDataRoot } from '../../host/storage/index.js';
import type { Context } from '../commands/context.js';

export interface LogFile {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
  /** Last written (ms). */
  readonly modified: number;
}

const LOG_NAME = /^(guest|daemon|bootstrap)-.*\.log$/;
/** Only the end of a log is read: the sandbox writes it. */
const FIRST_READ_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

export class LogsService {
  constructor(private readonly ctx: Pick<Context, 'dataPath'>) {}

  private dir(): string {
    const dir = hostDataFolder(this.ctx.dataPath, 'logs');
    assertNoLinks(hostDataRoot(this.ctx.dataPath), dir);
    return dir;
  }

  /** Log files, newest first. */
  files(): LogFile[] {
    const dir = this.dir();
    if (!fs.existsSync(dir)) return [];
    const found = fs
      .readdirSync(dir)
      .filter((f) => LOG_NAME.test(f) && fs.lstatSync(path.join(dir, f)).isFile())
      .map((name) => {
        const stat = fs.statSync(path.join(dir, name));
        return { name, path: path.join(dir, name), bytes: stat.size, modified: stat.mtimeMs };
      });
    return _.orderBy(found, 'modified', 'desc');
  }

  /** The folder the logs are in (whether or not it exists yet). */
  folder(): string {
    return hostDataFolder(this.ctx.dataPath, 'logs');
  }

  /**
   * The path of the log called `name`: only an exact name from files() is accepted, so a name from outside (a browser)
   * can never become a path of its own.
   */
  byName(name: string): string {
    const found = this.files().find((f) => f.name === name);
    return (
      found?.path ??
      fail('There is no log called ' + safeText(name) + '.', 'Pick one from: sandbox logs, or the Logs page.')
    );
  }

  /** The newest log, or a UserError when there is none yet. */
  newest(): string {
    return (
      this.files()[0]?.path ??
      fail(
        'No sandbox logs yet in ' + hostDataFolder(this.ctx.dataPath, 'logs') + '.',
        'Logs appear after the first start (sandbox claude).',
      )
    );
  }

  /**
   * What was written to `file` since offset `from` (0 = the end of the log), as text safe for a terminal, and where
   * to continue from. Null when nothing new.
   */
  read(file: string, from: number): { text: string; next: number } | null {
    const size = fs.statSync(file).size;
    const start = from === 0 ? Math.max(0, size - FIRST_READ_BYTES) : from;
    if (size <= start) return null;
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(Math.min(size - start, MAX_CHUNK_BYTES));
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return { text: safeText(buffer.toString('utf8')), next: start + buffer.length };
  }
}

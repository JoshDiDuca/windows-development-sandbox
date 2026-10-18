// The server's state file: its process, port and token, in a folder only you can read (<storage>\web). It is not in a
// sandbox's data folder, so a sandbox can neither read the token nor plant a fake file.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { JsonFile } from '../../shared/io/index.js';
import { protectPrivateFolder } from '../sharing/index.js';

export const WebStateSchema = z.strictObject({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  startedAt: z.string().max(64),
  /** The version that started it (missing: an older one). Another version is replaced, never reused. */
  version: z.string().max(64).optional(),
});
export type WebState = z.output<typeof WebStateSchema>;

export class WebStore {
  private readonly file: JsonFile<WebState>;

  constructor(
    private readonly storageRoot: string,
    private readonly protect: (dir: string) => void = protectPrivateFolder,
  ) {
    this.file = new JsonFile(WebStateSchema, path.join(this.dir, 'server.json'));
  }

  get dir(): string {
    return path.join(this.storageRoot, 'web');
  }

  /** Creates the folder and makes it private (the token goes in it). */
  prepare(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    this.protect(this.dir);
  }

  read(): WebState | null {
    return this.file.read();
  }

  write(state: WebState): void {
    this.prepare();
    this.file.write(state);
  }

  clear(): void {
    fs.rmSync(this.file.file, { force: true });
  }
}

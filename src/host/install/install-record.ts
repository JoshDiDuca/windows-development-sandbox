// <root>\install.json: what the installer decided and the updater and the CLI read back: for whom this is installed,
// the group that may share sandboxes (all-users installs), whether new versions install themselves, and since when.
import path from 'node:path';
import { z } from 'zod';
import { JsonFile } from '../../shared/io/index.js';

export const InstallRecordSchema = z.object({
  scope: z.enum(['user', 'machine']),
  groupSid: z.string().nullable(),
  autoUpdate: z.boolean(),
  /** All-users installs: the storage helper service (AgentSandboxStorage) was installed. Older records have none. */
  storageHelper: z.boolean().optional(),
  installedAt: z.string(),
});

export type InstallRecord = z.infer<typeof InstallRecordSchema>;

export class InstallRecordFile {
  private readonly store: JsonFile<InstallRecord>;

  constructor(root: string) {
    this.store = new JsonFile(InstallRecordSchema, path.join(root, 'install.json'));
  }

  /** The record, or null when the install has none (or it cannot be read). */
  read(): InstallRecord | null {
    return this.store.read();
  }

  /** Switches automatic updates in the record. Without a record there is nothing to switch. */
  setAutoUpdate(on: boolean): InstallRecord | null {
    const current = this.store.read();
    if (!current) return null;
    return this.store.update(() => ({ ...current, autoUpdate: on }));
  }
}

// tools\installs.json: the large installs a sandbox keeps (engines, editors, SDKs), each with its size and last use.
// The sandbox writes it (guest/toolchains/persisted.ts); this PC reads it zod-checked, so `sandbox data` can show 60 GB
// of engines without walking them, and prints what it says through safeText.
import { z } from 'zod';

export const INSTALL_RECORDS_FILE = 'installs.json';

export const InstallRecordSchema = z.object({
  name: z.string().max(100),
  version: z.string().max(100),
  sizeBytes: z.number().nonnegative().nullable(),
  installedAt: z.string().max(64),
  usedAt: z.string().max(64),
});
export type InstallRecord = z.output<typeof InstallRecordSchema>;

export const InstallRecordsSchema = z.object({ installs: z.array(InstallRecordSchema).max(1000) });

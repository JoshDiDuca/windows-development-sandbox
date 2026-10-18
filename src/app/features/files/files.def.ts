// Picking a folder or a file of this PC: what is in a folder, and where to start (the drives, this folder's project,
// the data folder). The browser cannot see full paths, so the web's folder picker reads this. Pure: schemas only.
import { z } from 'zod';
import { defineQuery } from '../../kernel/index.js';

/** Folders show at most this many entries (a folder with more says so). */
export const MAX_ENTRIES = 2000;

const EntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['dir', 'file']),
});
export type FolderEntry = z.output<typeof EntrySchema>;

export const FolderListingSchema = z.object({
  /** The folder listed ('' when only the places are listed). */
  path: z.string(),
  /** The folder above it, or null at a drive (or with no folder). */
  parent: z.string().nullable(),
  entries: z.array(EntrySchema),
  /** More entries than MAX_ENTRIES: the rest are left out. */
  truncated: z.boolean(),
  /** Where to start: the drives and a few folders that matter here. */
  places: z.array(z.object({ label: z.string(), path: z.string() })),
});
export type FolderListing = z.output<typeof FolderListingSchema>;

export const browseFolder = defineQuery({
  id: 'files.browse',
  title: 'Browse folders',
  summary: 'list what is in a folder of this PC, to pick a folder or a file',
  input: z.object({
    path: z.string().max(1024).optional().describe('The folder (none: only the places to start from)'),
    files: z.boolean().default(false).describe('List files too, not only folders'),
  }),
  output: FolderListingSchema,
  surfaces: {
    except: {
      cli: 'a path is typed on the command line',
      menu: 'the menu asks for a path as text and checks it',
    },
  },
});

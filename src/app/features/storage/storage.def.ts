// Storage: where the saved data (tools, logins, history, logs) lives, moving it to another folder or switching to one
// without moving, and contained storage (beta: a disk image). Pure: schemas, labels and the view; storage.run.ts does
// the work. Sizes come as bytes and as words (the run measures; bytesText formats).
import { z } from 'zod';
import {
  action,
  bytesText,
  defineOperation,
  defineQuery,
  defineView,
  type Item,
  type Page,
  type Section,
} from '../../kernel/index.js';
import { browseFolder } from '../files/files.def.js';

const MeasuredSchema = z.object({
  bytes: z.number().describe('Bytes counted'),
  files: z.number().describe('Files counted'),
  partial: z.boolean().describe('The count stopped at its limit: there is at least this much'),
});

export const StorageShowSchema = z.object({
  root: z.string().describe('The folder your saved data is in'),
  exists: z.boolean().describe('It exists'),
  holdsData: z.boolean().describe('Something is in it'),
  measured: MeasuredSchema.nullable().describe('Its size; null when not measured'),
  size: z.string().describe('Its size in words; "nothing in it yet" when empty; "not measured yet" when not counted'),
  defaultRoot: z.string().describe('The default folder'),
  defaultInUse: z.boolean().describe('The default folder is the one in use'),
  otherFoldersWithData: z.array(z.string()).describe('Other folders that hold data'),
});
export type StorageShow = z.output<typeof StorageShowSchema>;

export const showStorage = defineQuery({
  id: 'storage.show',
  title: 'Data folder',
  summary: 'where your saved data lives',
  input: z.object({ measure: z.boolean().default(true).describe('add up its size (big folders take a moment)') }),
  output: StorageShowSchema,
  text: (o) =>
    [
      'Your saved data is in: ' + o.root,
      '  ' + o.size,
      'The default folder is: ' + o.defaultRoot + (o.defaultInUse ? ' (in use)' : ''),
      ...o.otherFoldersWithData.map((f) => 'Another folder with data: ' + f),
      '',
      'Move it with: sandbox storage move <folder>  (or switch without moving: sandbox storage use <folder>)',
      'What takes the space: sandbox data',
    ].join('\n'),
  cli: {
    name: 'storage',
    action: 'show',
    json: true,
    // The --json shape `sandbox storage` has always printed.
    shapeJson: (o) => ({
      root: o.root,
      exists: o.exists,
      ...(o.measured ?? { bytes: 0, files: 0, partial: false }),
      defaultRoot: o.defaultRoot,
      otherFoldersWithData: o.otherFoldersWithData,
    }),
  },
});

const MoveOutputSchema = z.object({
  from: z.string().describe('The old folder'),
  to: z.string().describe('The new folder'),
  copied: z.boolean().describe('It was copied (another drive)'),
  files: z.number().describe('Files moved'),
  bytes: z.number().describe('Bytes moved'),
  pinned: z.string().describe('What storage.root now says'),
  removedOld: z.boolean().describe('The old folder is gone'),
  notes: z.array(z.string()).describe('Extra notes'),
  message: z.string().describe('What happened'),
});

export const moveStorage = defineOperation({
  id: 'storage.move',
  title: 'Move the data…',
  summary: 'move your saved data to another folder',
  input: z.object({
    folder: z.string().optional().describe('the folder to move to'),
    keepOld: z.boolean().default(false).describe('copy instead of moving: the old folder stays (needs room for both)'),
  }),
  output: MoveOutputSchema,
  text: (o) => o.message,
  cli: {
    name: 'storage',
    action: 'move',
    positional: ['folder'],
    flags: { keepOld: { flag: '--keep-old' } },
    json: true,
    shapeJson: ({ message: _message, ...result }) => result,
  },
});

export const useStorage = defineOperation({
  id: 'storage.use',
  title: 'Use another folder…',
  summary: 'use another folder for your saved data, without moving it',
  input: z.object({ folder: z.string().optional().describe('the folder to use') }),
  output: z.object({ message: z.string().describe('What happened') }),
  text: (o) => o.message,
  cli: { name: 'storage', action: 'use', positional: ['folder'] },
});

export const changeDataFolder = defineOperation({
  id: 'storage.change',
  title: 'Data folder',
  summary: 'pick another folder for your saved data, then move it there or switch to it',
  input: z.object({}),
  output: z.object({ message: z.string().describe('What happened') }),
  text: (o) => o.message,
  surfaces: { except: { cli: 'the command line has storage move <folder> and storage use <folder>' } },
});

export const ContainedStatusSchema = z.object({
  setting: z.enum(['off', 'vhdx']).describe('storage.contained'),
  maxGb: z.number().describe('storage.containedMaxGb'),
  available: z.boolean().describe('This PC can use it'),
  reasons: z.array(z.string()).describe('Why not'),
  fixes: z.array(z.string()).describe('What would fix it'),
  image: z.string().describe('The disk image file'),
  imageExists: z.boolean().describe('It exists'),
  imageBytes: z.number().nullable().describe('Its size on disk'),
  mountFolder: z.string().describe('Where it is mounted'),
  recordedMounted: z.boolean().describe('The record says it is mounted'),
  holders: z.number().describe('Sandboxes using it'),
  mountedNow: z.boolean().nullable().describe('It is mounted now (null: not checked)'),
});
export type ContainedStatus = z.output<typeof ContainedStatusSchema>;

export const containedStatus = defineQuery({
  id: 'storage.containedStatus',
  title: 'Contained storage (beta)',
  summary: '(beta) the disk image for tools, state and logs',
  input: z.object({}),
  output: ContainedStatusSchema,
  text: (o) =>
    [
      'Contained storage (beta, untested on a real PC)',
      '  setting:      storage.contained = ' + o.setting + ' (limit ' + o.maxGb + ' GB)',
      '  this PC:      ' +
        (o.available ? 'can use it' : 'cannot use it: ' + o.reasons.join(' ') + ' ' + o.fixes.join(' ')),
      '  image:        ' +
        o.image +
        (o.imageExists ? ' (' + bytesText(o.imageBytes ?? 0) + ' on disk)' : ' (not made yet)'),
      '  mount folder: ' + o.mountFolder,
      ...(o.mountedNow === null
        ? []
        : [
            '  mounted now:  ' +
              (o.mountedNow ? 'yes' : 'no') +
              (o.recordedMounted !== o.mountedNow
                ? ' (the record says ' + (o.recordedMounted ? 'yes' : 'no') + '; sandbox doctor looks into it)'
                : ''),
          ]),
      '',
      'Turn it on with: sandbox storage contained on   Turn it off with: sandbox storage contained off',
    ].join('\n'),
  cli: { name: 'storage', action: 'contained status', json: true, shapeJson: ({ fixes: _fixes, ...rest }) => rest },
});

export const containedOn = defineOperation({
  id: 'storage.containedOn',
  title: 'Turn contained storage on…',
  summary: '(beta) keep tools, state and logs in a disk image',
  input: z.object({}),
  output: z.object({ message: z.string().describe('What happened') }),
  text: (o) => o.message,
  cli: { name: 'storage', action: 'contained on' },
});

export const containedOff = defineOperation({
  id: 'storage.containedOff',
  title: 'Turn contained storage off…',
  summary: '(beta) move tools, state and logs back into plain folders',
  danger: true,
  input: z.object({}),
  output: z.object({ message: z.string().describe('What happened') }),
  text: (o) => o.message,
  cli: { name: 'storage', action: 'contained off' },
});

/** The Storage page: the data folder (change, move, use another), then contained storage (beta). */
export function storagePage(o: StorageShow, c: ContainedStatus): Page {
  const folder: Item = {
    id: '@data-folder',
    label: 'Data folder',
    hint: o.root,
    description:
      'Where your tools, logins, history and logs are kept between sandboxes. Press Enter to move them to another folder or drive, or to use a different folder.',
    details: [
      o.size,
      'Default folder: ' + o.defaultRoot + (o.defaultInUse ? ' (in use)' : ''),
      ...o.otherFoldersWithData.map((f) => 'Another folder with data: ' + f),
    ],
    primary: action(changeDataFolder, {}, { label: 'Data folder', verb: 'change' }),
  };
  const data: Section = {
    id: 'folder',
    title: 'Data folder',
    items: [folder],
    actions: [action(moveStorage, {}), action(useStorage, {})],
  };
  const contained: Section = {
    id: 'contained',
    title: 'Contained storage (beta)',
    description:
      'Beta, and not yet tested on a real PC: keeps the sandbox tools, state and logs in one disk image file.',
    facts: [
      {
        id: 'setting',
        label: 'Turned on',
        value: c.setting === 'vhdx' ? 'yes' : 'no',
        tone: c.setting === 'vhdx' ? 'ok' : 'muted',
      },
      {
        id: 'pc',
        label: 'This PC',
        value: c.available ? 'can use it' : 'cannot use it',
        tone: c.available ? 'ok' : 'warn',
        ...(c.available ? {} : { description: [...c.reasons, ...c.fixes].join(' ') }),
      },
      {
        id: 'image',
        label: 'Image',
        value: c.imageExists ? bytesText(c.imageBytes ?? 0) + ' on disk' : 'not made yet',
        description: c.image,
      },
      { id: 'mount', label: 'Mount folder', value: c.mountFolder },
      {
        id: 'mounted',
        label: 'Mounted now',
        value: c.mountedNow === null ? 'not checked' : c.mountedNow ? 'yes' : 'no',
      },
    ],
    actions: c.setting === 'off' ? [action(containedOn, {})] : [action(containedOff, {})],
  };
  return { title: 'Storage', sections: [data, contained] };
}

export const storageView = defineView({
  id: 'storage',
  title: 'Storage',
  summary: 'Where your saved data lives: move it, switch folders, (beta) a disk image.',
  queries: { storage: showStorage, contained: containedStatus },
  operations: [changeDataFolder, moveStorage, useStorage, containedOn, containedOff],
  pickers: [browseFolder],
  inputs: () => ({ storage: { measure: true } }),
  build: ({ storage, contained }) => storagePage(storage, contained),
});

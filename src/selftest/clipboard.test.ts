// sandbox.clipboard and sandbox.clipboardDirection: modes, directions, the bridge and its files.
import {
  asDirection,
  clipboardLine,
  compareDirection,
  directionOf,
  HCS_CLIPBOARD_NOTE,
  narrowDirection,
  resolveClipboard,
  SHARED_PC_NOTE,
  sharedDirectionNote,
  sidesOf,
  type ClipboardDirection,
  type ClipboardMode,
  type ClipboardPlan,
} from '../core/clipboard.js';
import { DEFAULTS } from '../core/config/index.js';
import type { Config } from '../core/types.js';
import type { Suite } from './support/suite.js';

type Engine = Config['sandbox']['engine'];

const plan = (
  clipboard: ClipboardMode,
  clipboardDirection: ClipboardDirection,
  engine: Engine,
  protectedClient = true,
): ClipboardPlan => resolveClipboard({ ...DEFAULTS.sandbox, clipboard, clipboardDirection, engine, protectedClient });

const summary = (p: ClipboardPlan): unknown[] => [
  p.mode,
  p.sharedClipboard,
  p.protectedClient,
  p.bridge,
  p.toPc,
  p.toSandbox,
  p.note,
];

export const clipboardSuite: Suite = {
  name: 'clipboard',
  title: 'clipboard: modes, directions, the bridge and its files',
  run: async (t) => {
    t.section('modes');
    t.equal(
      [
        summary(plan('off', 'both', 'windows-sandbox')),
        summary(plan('off', 'toPc', 'hcs', false)),
        summary(plan('text', 'both', 'windows-sandbox')),
        summary(plan('text', 'toPc', 'windows-sandbox', false)),
        summary(plan('text', 'toSandbox', 'hcs')),
        summary(plan('shared', 'both', 'windows-sandbox')),
        summary(plan('shared', 'both', 'windows-sandbox', false)),
        summary(plan('shared', 'toPc', 'windows-sandbox')),
        summary(plan('shared', 'toSandbox', 'windows-sandbox', false)),
        summary(plan('shared', 'both', 'hcs')),
      ],
      [
        ['off', false, true, false, false, false, null],
        ['off', false, false, false, false, false, null],
        ['text', false, true, true, true, true, null],
        ['text', false, false, true, true, false, null],
        ['text', false, true, false, false, true, null],
        ['shared', true, false, false, true, true, SHARED_PC_NOTE],
        ['shared', true, false, false, true, true, null],
        ['text', false, true, true, true, false, sharedDirectionNote('toPc')],
        ['text', false, false, true, false, true, sharedDirectionNote('toSandbox')],
        ['text', false, true, false, true, true, HCS_CLIPBOARD_NOTE],
      ],
      'every row of the behaviour table',
    );
    t.equal(
      [plan('shared', 'toPc', 'windows-sandbox').direction, plan('shared', 'both', 'hcs').direction],
      ['toPc', 'both'],
      'the plan keeps your direction',
    );

    t.section('the one-line texts');
    t.equal(
      [
        clipboardLine(plan('off', 'both', 'windows-sandbox'), 'windows-sandbox'),
        clipboardLine(plan('text', 'both', 'windows-sandbox'), 'windows-sandbox'),
        clipboardLine(plan('text', 'toPc', 'windows-sandbox', false), 'windows-sandbox'),
        clipboardLine(plan('text', 'toSandbox', 'windows-sandbox'), 'windows-sandbox'),
        clipboardLine(plan('text', 'both', 'hcs'), 'hcs'),
        clipboardLine(plan('shared', 'both', 'windows-sandbox'), 'windows-sandbox'),
      ],
      [
        'off',
        'text both ways (Protected Client on)',
        'text from the sandbox to this PC only (Protected Client off)',
        'text from this PC into the sandbox only (Protected Client on)',
        'text through attached terminals',
        'shared: text, images and files both ways (Protected Client off)',
      ],
      'what each mode says about itself',
    );

    t.section('directions');
    t.equal(
      [sidesOf('both'), sidesOf('toPc'), sidesOf('toSandbox')],
      [
        { toPc: true, toSandbox: true },
        { toPc: true, toSandbox: false },
        { toPc: false, toSandbox: true },
      ],
      'sidesOf',
    );
    t.equal(
      [
        directionOf({ toPc: true, toSandbox: true }),
        directionOf({ toPc: true, toSandbox: false }),
        directionOf({ toPc: false, toSandbox: true }),
        directionOf({ toPc: false, toSandbox: false }),
      ],
      ['both', 'toPc', 'toSandbox', null],
      'directionOf',
    );
    t.equal(
      [
        narrowDirection('both', 'toPc'),
        narrowDirection('toSandbox', 'both'),
        narrowDirection('toPc', 'toPc'),
        narrowDirection('toPc', 'toSandbox'),
      ],
      ['toPc', 'toSandbox', 'toPc', null],
      'narrowDirection keeps what both allow',
    );
    t.equal(
      [
        compareDirection('both', 'toPc'),
        compareDirection('toPc', 'both'),
        compareDirection('toPc', 'toPc'),
        compareDirection('toPc', 'toSandbox'),
      ],
      [1, -1, 0, 1],
      'compareDirection: narrower = 1, wider = -1, same = 0, incomparable = 1',
    );
    t.equal(
      [asDirection('toPc'), asDirection(undefined), asDirection('nonsense')],
      ['toPc', 'both', 'both'],
      'asDirection',
    );
  },
};

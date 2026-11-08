// sandbox.clipboard and sandbox.clipboardDirection: what one launch really gets (the .wsb devices, the text bridge,
// OSC 52) and how it is said. Pure.
import type { Config } from './types.js';

export type ClipboardMode = Config['sandbox']['clipboard'];
export type ClipboardDirection = Config['sandbox']['clipboardDirection'];

export interface ClipboardSides {
  readonly toPc: boolean;
  readonly toSandbox: boolean;
}

export function sidesOf(direction: ClipboardDirection): ClipboardSides {
  return { toPc: direction !== 'toSandbox', toSandbox: direction !== 'toPc' };
}

/** The direction of these sides; null when neither is left. */
export function directionOf(sides: ClipboardSides): ClipboardDirection | null {
  if (sides.toPc && sides.toSandbox) return 'both';
  if (sides.toPc) return 'toPc';
  if (sides.toSandbox) return 'toSandbox';
  return null;
}

/** What is left when both narrow each other (null = nothing: no clipboard). */
export function narrowDirection(a: ClipboardDirection, b: ClipboardDirection): ClipboardDirection | null {
  const x = sidesOf(a);
  const y = sidesOf(b);
  return directionOf({ toPc: x.toPc && y.toPc, toSandbox: x.toSandbox && y.toSandbox });
}

/** 1 = `wanted` copies less than `running` (or neither covers the other), -1 = more, 0 = the same. */
export function compareDirection(running: ClipboardDirection, wanted: ClipboardDirection): number {
  if (running === wanted) return 0;
  const r = sidesOf(running);
  const w = sidesOf(wanted);
  const wantedInRunning = (!w.toPc || r.toPc) && (!w.toSandbox || r.toSandbox);
  if (wantedInRunning) return 1;
  const runningInWanted = (!r.toPc || w.toPc) && (!r.toSandbox || w.toSandbox);
  return runningInWanted ? -1 : 1;
}

/** A stored value as a direction (a record from before 1.29 has none: "both"). */
export function asDirection(value: unknown): ClipboardDirection {
  return value === 'toPc' || value === 'toSandbox' ? value : 'both';
}

export interface ClipboardPlan {
  readonly mode: ClipboardMode;
  readonly direction: ClipboardDirection;
  /** Windows Sandbox's own clipboard (ClipboardRedirection in the .wsb). */
  readonly sharedClipboard: boolean;
  /** Protected Client as the sandbox really starts (off for the shared clipboard). */
  readonly protectedClient: boolean;
  /** The text bridge runs (host watcher + guest daemon). */
  readonly bridge: boolean;
  /** Text may reach this PC (the bridge, and OSC 52 in sandbox attach). */
  readonly toPc: boolean;
  readonly toSandbox: boolean;
  /** Why the launch differs from the settings, in one plain line; null when it does not. */
  readonly note: string | null;
}

export const SHARED_PC_NOTE =
  'Protected Client is off for this sandbox: it blocks the shared clipboard (sandbox.clipboard "shared"; "text" keeps it on).';
export const HCS_CLIPBOARD_NOTE = 'The HCS engine has no shared clipboard: text is copied through attached terminals.';

export function sharedDirectionNote(d: ClipboardDirection): string {
  return 'sandbox.clipboardDirection "' + d + '" uses the text clipboard: the shared one always works both ways.';
}

export function resolveClipboard(
  s: Pick<Config['sandbox'], 'engine' | 'clipboard' | 'clipboardDirection' | 'protectedClient'>,
): ClipboardPlan {
  const none: ClipboardPlan = {
    mode: 'off',
    direction: s.clipboardDirection,
    sharedClipboard: false,
    protectedClient: s.protectedClient,
    bridge: false,
    toPc: false,
    toSandbox: false,
    note: null,
  };
  if (s.clipboard === 'off') return none;
  const hcs = s.engine === 'hcs';
  const sides = sidesOf(s.clipboardDirection);
  const text = (note: string | null): ClipboardPlan => ({
    mode: 'text',
    direction: s.clipboardDirection,
    sharedClipboard: false,
    protectedClient: s.protectedClient,
    bridge: !hcs,
    toPc: sides.toPc,
    toSandbox: sides.toSandbox,
    note,
  });
  if (s.clipboard === 'text') return text(null);
  if (hcs) return text(HCS_CLIPBOARD_NOTE);
  if (s.clipboardDirection !== 'both') return text(sharedDirectionNote(s.clipboardDirection));
  return {
    mode: 'shared',
    direction: 'both',
    sharedClipboard: true,
    protectedClient: false,
    bridge: false,
    toPc: true,
    toSandbox: true,
    note: s.protectedClient ? SHARED_PC_NOTE : null,
  };
}

/** "text both ways (Protected Client on)" and the like. */
export function clipboardLine(plan: ClipboardPlan, engine: Config['sandbox']['engine']): string {
  if (plan.mode === 'off') return 'off';
  if (plan.mode === 'shared') return 'shared: text, images and files both ways (Protected Client off)';
  if (engine === 'hcs') return 'text through attached terminals';
  const words =
    plan.direction === 'both'
      ? 'both ways'
      : plan.direction === 'toPc'
        ? 'from the sandbox to this PC only'
        : 'from this PC into the sandbox only';
  return 'text ' + words + ' (Protected Client ' + (plan.protectedClient ? 'on' : 'off') + ')';
}

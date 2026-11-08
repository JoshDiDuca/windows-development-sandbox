// The sandbox side of sandbox.clipboard "text": a copy here goes to <data>\clipboard\to-pc.json (the PC's watcher
// decides whether it may land on the PC); the PC's text arrives in to-sandbox.json and is put on this clipboard.
// Pure with ports (clipboard.ts has the real helper). Never logs or keeps the text beyond its hash.
import type { RunDir } from '../../shared/channel/run-dir.js';
import { clipboardFile, takeClipboardFile } from '../../shared/clipboard/index.js';
import { writeJsonAtomic } from '../../shared/io/index.js';

export interface GuestClipboardHelper {
  onChange(listener: (text: string | null) => void): void;
  write(text: string): Promise<boolean>;
  onExit(listener: () => void): void;
  stop(): void;
}

export interface GuestBridgeOptions {
  readonly run: RunDir;
  readonly toPc: boolean;
  readonly toSandbox: boolean;
  readonly open: () => GuestClipboardHelper | null;
  readonly log: (line: string) => void;
}

const POLL_MS = 250;
const REOPEN_MS = 60000;
const MAX_REOPENS = 5;

export class GuestClipboardBridge {
  private helper: GuestClipboardHelper | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reopenTimer: NodeJS.Timeout | null = null;
  private ends = 0;
  private stopped = false;
  private busy = false;
  /** Hash of the text the PC last put here: its echo from the helper is not a copy. */
  private lastSet: string | null = null;

  constructor(private readonly o: GuestBridgeOptions) {}

  start(): void {
    this.openHelper();
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    this.timer = null;
    this.reopenTimer = null;
    this.helper?.stop();
    this.helper = null;
  }

  /** The PC's text, if it sent some: put on this clipboard. */
  async take(): Promise<boolean> {
    const taken = takeClipboardFile(this.o.run.clipboardToSandboxFile);
    if (!taken || !this.o.toSandbox || !this.helper) return false;
    this.lastSet = taken.hash;
    return this.helper.write(taken.text);
  }

  /** A change of this clipboard (null: no text, too big or unreadable). */
  changed(text: string | null): void {
    if (!this.o.toPc || text === null) return;
    const file = clipboardFile(text);
    if (!file || file.sha256 === this.lastSet) return;
    try {
      writeJsonAtomic(this.o.run.clipboardToPcFile, file);
    } catch {
      // The folder is not writable now: this copy stays here.
    }
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.take();
    } catch {
      // Skipped; the next look tries again.
    } finally {
      this.busy = false;
    }
  }

  private openHelper(): void {
    if (this.stopped) return;
    const helper = this.o.open();
    if (!helper) return;
    helper.onChange((text) => this.changed(text));
    helper.onExit(() => {
      if (this.helper !== helper) return;
      this.helper = null;
      this.ends++;
      this.o.log('Clipboard: the helper ended (' + this.ends + ').');
      if (this.ends > MAX_REOPENS || this.stopped) return;
      this.reopenTimer = setTimeout(() => this.openHelper(), REOPEN_MS);
      this.reopenTimer.unref();
    });
    this.helper = helper;
  }
}

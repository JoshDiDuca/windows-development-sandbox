// The PC side of sandbox.clipboard "text", run by the background watcher while the sandbox runs. A copy in the sandbox
// reaches this PC only while the sandbox window is in front (ClipboardGate); this PC's text goes into the sandbox when
// its window comes to the front. Never logs, keeps or throws the text: notes carry counts only.
import fs from 'node:fs';
import { assertNoLinks } from '../../core/util/index.js';
import { RunDir } from '../../shared/channel/run-dir.js';
import {
  ClipboardGate,
  clipboardFile,
  takeClipboardFile,
  textHash,
  type ToPcDecision,
  type ToSandboxDecision,
} from '../../shared/clipboard/index.js';
import { writeJsonAtomic } from '../../shared/io/index.js';
import { clearClipboardFiles } from './files.js';
import type { HostClipboardPort } from './port.js';
import type { ClipboardSettings } from './settings.js';

export interface HostBridgeOptions {
  readonly dataPath: string;
  readonly settings: ClipboardSettings;
  readonly open: () => HostClipboardPort | null;
  readonly note: (line: string) => void;
  readonly now?: () => number;
}

const POLL_MS = 250;
/** A file for the sandbox it has not taken within this time is stale: deleted. */
const EXPIRY_MS = 15000;
const NOTE_EVERY_MS = 60000;
const REOPEN_MS = 60000;

export class HostClipboardBridge {
  private readonly run: RunDir;
  private readonly gate: ClipboardGate;
  private port: HostClipboardPort | null = null;
  private openedAt = -Infinity;
  private noPortNoted = false;
  private linkNoted = false;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private offeredAt: number | null = null;
  private copied = 0;
  private sent = 0;
  private refused = 0;
  private refusedUnnoted = 0;
  private lastRefusedNote = -Infinity;
  private lastTooBigNote = -Infinity;

  constructor(private readonly o: HostBridgeOptions) {
    this.run = new RunDir(o.dataPath);
    this.gate = new ClipboardGate({ toPc: o.settings.toPc, toSandbox: o.settings.toSandbox });
  }

  start(): void {
    clearClipboardFiles(this.o.dataPath);
    try {
      assertNoLinks(this.o.dataPath, this.run.clipboardDir);
      fs.mkdirSync(this.run.clipboardDir, { recursive: true });
    } catch (e) {
      this.o.note('the clipboard folder cannot be used: ' + (e instanceof Error ? e.message : 'refused'));
    }
    this.ensurePort();
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.port?.stop();
    this.port = null;
    clearClipboardFiles(this.o.dataPath);
    this.o.note('copied ' + this.copied + ' to this PC, ' + this.sent + ' into the sandbox, refused ' + this.refused);
  }

  /** One look for a copy from the sandbox (tests call it directly). */
  async poll(): Promise<ToPcDecision | null> {
    const port = this.ensurePort();
    if (!port) return null;
    const { clipboardDir, clipboardToPcFile, clipboardToSandboxFile } = this.run;
    try {
      assertNoLinks(this.o.dataPath, clipboardDir);
    } catch {
      if (!this.linkNoted) this.o.note('the clipboard folder is a link: nothing is copied');
      this.linkNoted = true;
      return null;
    }
    const nowMs = this.now();
    if (this.offeredAt !== null && (nowMs - this.offeredAt > EXPIRY_MS || !fs.existsSync(clipboardToSandboxFile))) {
      if (nowMs - this.offeredAt > EXPIRY_MS) fs.rmSync(clipboardToSandboxFile, { force: true });
      this.offeredAt = null;
    }
    const taken = takeClipboardFile(clipboardToPcFile);
    if (!taken) return null;
    const decision = this.gate.toPc(taken.hash, nowMs);
    if (decision === 'accept') {
      if (await port.write(taken.text)) this.copied++;
    } else if (decision === 'background') {
      this.refused++;
      this.refusedUnnoted++;
      if (nowMs - this.lastRefusedNote >= NOTE_EVERY_MS) {
        this.lastRefusedNote = nowMs;
        const n = this.refusedUnnoted;
        this.refusedUnnoted = 0;
        this.o.note(
          'refused ' + n + ' cop' + (n === 1 ? 'y' : 'ies') + ' from the sandbox: its window was not in front',
        );
      }
    }
    return decision;
  }

  /** The port's foreground event (tests call it directly). */
  async foreground(inFront: boolean): Promise<ToSandboxDecision | null> {
    const nowMs = this.now();
    const offer = this.gate.foreground(inFront, nowMs);
    if (!offer || !this.o.settings.toSandbox) return null;
    const port = this.ensurePort();
    if (!port) return null;
    const r = await port.read();
    if (r.kind !== 'text') {
      if (r.kind === 'tooBig' && nowMs - this.lastTooBigNote >= NOTE_EVERY_MS) {
        this.lastTooBigNote = nowMs;
        this.o.note("this PC's clipboard text is over 1 MB: not copied into the sandbox");
      }
      return null;
    }
    const decision = this.gate.toSandbox(textHash(r.text));
    if (decision !== 'send') return decision;
    const file = clipboardFile(r.text);
    if (!file) return null;
    try {
      assertNoLinks(this.o.dataPath, this.run.clipboardDir);
      writeJsonAtomic(this.run.clipboardToSandboxFile, file);
      this.offeredAt = this.now();
      this.sent++;
    } catch {
      // The folder is unusable (a link, or gone): nothing is sent.
      return null;
    }
    return decision;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.poll();
    } catch {
      // A failed look is skipped; the next one tries again. (No text is ever in the error.)
    } finally {
      this.busy = false;
    }
  }

  /** The open port; after it exited, a new one at most once a minute. Null without HostTools. */
  private ensurePort(): HostClipboardPort | null {
    if (this.port) return this.port;
    const nowMs = this.now();
    if (nowMs - this.openedAt < REOPEN_MS) return null;
    this.openedAt = nowMs;
    const port = this.o.open();
    if (!port) {
      if (!this.noPortNoted)
        this.o.note('HostTools.exe could not be built, so no text is copied between this PC and the sandbox');
      this.noPortNoted = true;
      return null;
    }
    port.onForeground((inFront) => void this.foreground(inFront).catch(() => null));
    port.onExit(() => {
      if (this.port === port) this.port = null;
    });
    this.port = port;
    return port;
  }
}

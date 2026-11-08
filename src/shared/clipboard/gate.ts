// The bridge's security rules, pure (the host watcher runs them; tests drive them with fake times).
export const FOREGROUND_GRACE_MS = 2000;
export type ToPcDecision = 'accept' | 'background' | 'echo' | 'off';
export type ToSandboxDecision = 'send' | 'same' | 'off';

/**
 * The bridge's rules: a copy from the sandbox reaches this PC only while its window is in front (or was, within 2 s);
 * this PC's text goes in only when asked at a switch to the window, and never what the other side already has.
 */
export class ClipboardGate {
  private front = false;
  private leftAt = -Infinity;
  private known = false;
  private pcHas: string | null = null;
  private sandboxHas: string | null = null;

  constructor(
    private readonly sides: { readonly toPc: boolean; readonly toSandbox: boolean },
    private readonly graceMs: number = FOREGROUND_GRACE_MS,
  ) {}

  /** The sandbox window came to the front (true) or left it; true on a switch TO it (offer this PC's text). */
  foreground(inFront: boolean, nowMs: number): boolean {
    const was = this.known && this.front;
    if (this.known && was && !inFront) this.leftAt = nowMs;
    this.known = true;
    this.front = inFront;
    return inFront && !was;
  }

  inFront(nowMs: number): boolean {
    return this.front || nowMs - this.leftAt <= this.graceMs;
  }

  /** A copy the sandbox made. */
  toPc(hash: string, nowMs: number): ToPcDecision {
    if (!this.sides.toPc) return 'off';
    if (hash === this.pcHas) return 'echo';
    this.sandboxHas = hash;
    if (!this.inFront(nowMs)) return 'background';
    this.pcHas = hash;
    return 'accept';
  }

  /** This PC's text at a switch to the window. */
  toSandbox(hash: string): ToSandboxDecision {
    if (!this.sides.toSandbox) return 'off';
    this.pcHas = hash;
    if (hash === this.sandboxHas) return 'same';
    this.sandboxHas = hash;
    return 'send';
  }
}

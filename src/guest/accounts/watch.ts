// While the sandbox runs: each sign-in that may come back (Epic, Steam, Unity) is looked at every minute or so, and
// when the tool holds a different one (renewed, or a first sign-in made here) it is left for the PC in
// <data>\state\accounts\<kind>.json, which the PC seals and deletes on its next sync. Only kinds whose lease this
// launch holds; seeded with what was delivered, so the first look writes nothing. flush() looks once more now (the
// daemon calls it where claude-mem is saved) and, at the end, lets go of what must not stay taken.
import fs from 'node:fs';
import path from 'node:path';
import { fingerprint } from '../../shared/accounts/fingerprint.js';
import { HANDOFF_PARTS, SERVICE_SPECS, type ServiceKind } from '../../shared/accounts/kinds.js';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { errMsg } from '../../core/util/errors.js';
import type { GuestAdapter } from './adapter.js';
import { ADAPTERS } from './adapters.js';
import { readDelivered } from './apply.js';

const DEFAULT_CHECK_MS = 60_000;

export interface WatchOptions {
  /** The data folder (C:\AgentData); the handoffs go in its state\accounts. */
  readonly dataDir: string;
  readonly launchId: string;
  /** Where delivered.json is (default: the sandbox's accounts folder). */
  readonly root?: string;
  readonly adapters?: { readonly [K in ServiceKind]?: GuestAdapter<K> };
  readonly warn?: (line: string) => void;
}

export class AccountWatch {
  private readonly last = new Map<ServiceKind, string | null>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly kinds: readonly ServiceKind[];

  constructor(
    kinds: readonly ServiceKind[],
    private readonly o: WatchOptions,
  ) {
    this.kinds = kinds.filter((k) => SERVICE_SPECS[k].returns && this.adapter(k).current);
    const delivered = readDelivered(o.root);
    for (const kind of this.kinds) this.last.set(kind, delivered.fingerprints[kind] ?? null);
  }

  private adapter(kind: ServiceKind): GuestAdapter<ServiceKind> {
    return (this.o.adapters?.[kind] ?? ADAPTERS[kind]) as GuestAdapter<ServiceKind>;
  }

  /** The kinds being watched. */
  watched(): readonly ServiceKind[] {
    return this.kinds;
  }

  start(): void {
    for (const kind of this.kinds) {
      const timer = setInterval(() => void this.look(kind), this.adapter(kind).checkMs ?? DEFAULT_CHECK_MS);
      timer.unref();
      this.timers.push(timer);
    }
  }

  /** Lets an adapter that answers asynchronously ask its tool first, then looks; never throws. */
  private async look(kind: ServiceKind): Promise<boolean> {
    try {
      await this.adapter(kind).refresh?.();
    } catch (e) {
      this.o.warn?.(SERVICE_SPECS[kind].label + ' sign-in: could not read it: ' + errMsg(e));
    }
    return this.check(kind);
  }

  /** One look at one kind; true when a handoff was written. */
  check(kind: ServiceKind): boolean {
    try {
      const now = this.adapter(kind).current?.() ?? null;
      if (!now) return false;
      const print = fingerprint(now);
      if (print === this.last.get(kind)) return false;
      const file = path.join(this.o.dataDir, ...HANDOFF_PARTS, kind + '.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomic(file, { kind, launchId: this.o.launchId, payload: now });
      this.last.set(kind, print);
      return true;
    } catch (e) {
      this.o.warn?.(SERVICE_SPECS[kind].label + ' sign-in: could not keep it for the next sandbox: ' + errMsg(e));
      return false;
    }
  }

  /** Looks at every kind now; with `final` (the sandbox stops) each adapter also lets go of what it holds. */
  async flush(final = false): Promise<void> {
    for (const kind of this.kinds) await this.look(kind);
    if (!final) return;
    for (const timer of this.timers) clearInterval(timer);
    for (const kind of this.kinds) {
      try {
        await this.adapter(kind).release?.();
      } catch (e) {
        this.o.warn?.(SERVICE_SPECS[kind].label + ': could not let go of the sign-in: ' + errMsg(e));
      }
    }
  }
}

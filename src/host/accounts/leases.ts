// Which data set holds a one-holder sign-in (Epic, Steam, Unity work in one place at a time), in host-only storage
// (<storage>\accounts\leases.json). A launch claims the lease even when nothing is saved yet, so a first sign-in made
// in that sandbox can come back; a lease whose sandbox no longer runs is stale and is taken over. A sign-in several
// sandboxes may use at once (Comet) has one lease per data set (claimShared): each may hand it back, the last wins.
import path from 'node:path';
import { z } from 'zod';
import { JsonFile } from '../../shared/io/index.js';
import { SERVICE_KINDS, type ServiceKind } from '../../shared/accounts/index.js';
import { accountsDir } from './store.js';

const LeaseSchema = z.object({
  kind: z.enum(SERVICE_KINDS),
  dataSet: z.string().min(1).max(200),
  launchId: z.string().min(1).max(64),
  issuedAt: z.string().max(64),
  /** The fingerprint of what was handed over (null: nothing saved yet). */
  delivered: z.string().max(128).nullable(),
});
/** Room for one lease per kind, plus one per data set for the kinds several sandboxes share. */
const LeasesSchema = z.object({ leases: z.array(LeaseSchema).max(SERVICE_KINDS.length * 64) });

export type Lease = Readonly<z.output<typeof LeaseSchema>>;
export type ClaimResult = { ok: true } | { ok: false; heldBy: string };

export class AccountLeases {
  private readonly file: JsonFile<z.output<typeof LeasesSchema>>;

  constructor(storageRoot: string) {
    this.file = new JsonFile(LeasesSchema, path.join(accountsDir(storageRoot), 'leases.json'));
  }

  private all(): Lease[] {
    return this.file.read()?.leases ?? [];
  }

  private keep(leases: readonly Lease[]): void {
    this.file.write({ leases: [...leases] });
  }

  holder(kind: ServiceKind): Lease | null {
    return this.all().find((l) => l.kind === kind) ?? null;
  }

  /** The kind's lease that this data set holds, if any. */
  leaseOf(kind: ServiceKind, dataSet: string): Lease | null {
    return this.all().find((l) => l.kind === kind && l.dataSet === dataSet) ?? null;
  }

  /** A lease for this data set and launch beside the other data sets' (a sign-in several sandboxes may use). */
  claimShared(kind: ServiceKind, dataSet: string, launchId: string, delivered: string | null): void {
    const lease: Lease = { kind, dataSet, launchId, issuedAt: new Date().toISOString(), delivered };
    this.keep([...this.all().filter((l) => !(l.kind === kind && l.dataSet === dataSet)), lease]);
  }

  /** The lease for this data set and launch, unless another data set's sandbox still runs with it. */
  claim(
    kind: ServiceKind,
    dataSet: string,
    launchId: string,
    delivered: string | null,
    isRunning: (dataSet: string) => boolean,
  ): ClaimResult {
    const held = this.holder(kind);
    if (held && held.dataSet !== dataSet && isRunning(held.dataSet)) return { ok: false, heldBy: held.dataSet };
    const lease: Lease = { kind, dataSet, launchId, issuedAt: new Date().toISOString(), delivered };
    this.keep([...this.all().filter((l) => l.kind !== kind), lease]);
    return { ok: true };
  }

  release(kind: ServiceKind, dataSet: string): void {
    const all = this.all();
    const kept = all.filter((l) => !(l.kind === kind && l.dataSet === dataSet));
    if (kept.length !== all.length) this.keep(kept);
  }

  /** Every lease of a data set (its sandbox stopped). */
  releaseAll(dataSet: string): void {
    const all = this.all();
    const kept = all.filter((l) => l.dataSet !== dataSet);
    if (kept.length !== all.length) this.keep(kept);
  }

  /** Drops the kind's lease (you forgot the sign-in): what a sandbox hands back afterwards is refused. */
  revoke(kind: ServiceKind): Lease[] {
    const all = this.all();
    const gone = all.filter((l) => l.kind === kind);
    if (gone.length) this.keep(all.filter((l) => l.kind !== kind));
    return gone;
  }
}

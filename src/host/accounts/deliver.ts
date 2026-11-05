// Which saved service sign-ins a launch hands to its sandbox: only kinds you share (accounts.<kind>.share), that a
// toolchain (or app) on for this boot uses, and that no other project in the boot turned off. A one-holder kind (Epic,
// Steam, Unity) also needs its lease, and a kind several sandboxes share that comes back (Comet) gets one of its own;
// the lease is claimed even when nothing is saved yet, so a first sign-in made in the sandbox can come back. What a
// sandbox left behind earlier is taken first, so the newest one travels. The payloads are returned for
// generateSandbox's one-shot file only; the notes never hold a secret.
import type { BootWant } from '../../core/local-config/index.js';
import type { Config } from '../../core/types.js';
import {
  fingerprint,
  SERVICE_KINDS,
  SERVICE_SPECS,
  serviceWanted,
  type Payloads,
  type ServiceKind,
  type ServiceSpec,
  type UsedBy,
} from '../../shared/accounts/index.js';
import { setNameOf } from '../storage/index.js';
import { takeHandoffs } from './handoff.js';
import { AccountLeases } from './leases.js';
import { ServiceAccountStore } from './store.js';

export interface AccountDelivery {
  readonly payloads: Payloads;
  /** The kinds whose lease this launch holds (the sandbox may hand them back). */
  readonly leased: readonly ServiceKind[];
  readonly notes: readonly string[];
}

export interface DeliveryInput {
  readonly config: Config;
  /** The other projects this sandbox boots with (each one's own settings). */
  readonly others: readonly BootWant[];
  /** The toolchains on for this boot. */
  readonly on: ReadonlySet<UsedBy>;
  readonly storageRoot: string;
  readonly dataPath: string;
  readonly launchId: string;
  /** Whether a sandbox still runs with that data set (a lease held there is not taken over). */
  readonly isRunning: (dataSet: string) => boolean;
  readonly store?: ServiceAccountStore;
  readonly leases?: AccountLeases;
}

/** How to get a first sign-in of a kind, for the note when none is saved. */
function howToSave(spec: ServiceSpec): string {
  if (spec.kind === 'epic')
    return "sign in to the Epic Games Launcher in this sandbox once, or take this PC's: sandbox account import epic";
  if (spec.kind === 'steam') return 'sign in once in this sandbox with sbx-steam login';
  if (spec.kind === 'unity')
    return 'sign in to Unity once in this sandbox (Unity page: Sign in to Unity), or: sandbox account login unity';
  if (spec.kind === 'comet') return 'sign in to Comet once in this sandbox, and it is kept for the next ones';
  if (spec.returns) return 'sign in once in this sandbox, or: sandbox account import ' + spec.kind;
  return spec.sources.includes('typed')
    ? 'save one: sandbox account login ' + spec.kind
    : 'save one: sandbox account import ' + spec.kind + ' --from <file>';
}

export function prepareServiceAccounts(i: DeliveryInput): AccountDelivery {
  const store = i.store ?? new ServiceAccountStore(i.storageRoot);
  const leases = i.leases ?? new AccountLeases(i.storageRoot);
  const dataSet = setNameOf(i.dataPath);
  const payloads: Record<string, unknown> = {};
  const leased: ServiceKind[] = [];
  const notes: string[] = [];
  // A sign-in the last sandbox renewed but did not get to hand over (it did not stop cleanly) comes first.
  try {
    takeHandoffs(i.dataPath, false, store, leases);
  } catch {
    // Never stops a launch: the saved sign-in stays as it was.
  }
  for (const kind of SERVICE_KINDS) {
    const spec: ServiceSpec = SERVICE_SPECS[kind];
    if (!i.config.accounts[kind].share || !serviceWanted(kind, i.on)) continue;
    const off = i.others.find((o) => !o.config.accounts[kind].share);
    if (off) {
      notes.push(
        'Your ' + spec.label + ' sign-in was not handed over: ' + off.name + ' (also in this sandbox) turns it off.',
      );
      continue;
    }
    try {
      let payload: unknown = null;
      let unreadable = false;
      try {
        payload = store.read(kind);
      } catch {
        unreadable = true;
      }
      if (spec.singleHolder) {
        const claim = leases.claim(kind, dataSet, i.launchId, payload ? fingerprint(payload) : null, i.isRunning);
        if (!claim.ok) {
          notes.push(
            'Your ' + spec.label + ' sign-in is in use by sandbox ' + claim.heldBy + ': this one starts without it.',
          );
          continue;
        }
        if (spec.returns) leased.push(kind);
      } else if (spec.returns) {
        // Several sandboxes may use it at once: each gets its own lease, so each may hand a renewed one back.
        leases.claimShared(kind, dataSet, i.launchId, payload ? fingerprint(payload) : null);
        leased.push(kind);
      }
      if (unreadable) {
        notes.push(
          'Your saved ' +
            spec.label +
            ' sign-in could not be read (only the Windows user that saved it can): ' +
            howToSave(spec) +
            '.',
        );
        continue;
      }
      if (!payload) {
        notes.push('No ' + spec.label + ' sign-in is saved yet: ' + howToSave(spec) + '.');
        continue;
      }
      payloads[kind] = payload;
      notes.push('Your ' + spec.label + ' sign-in is handed to this sandbox: ' + spec.warnings[0]);
    } catch {
      // A store or lease file that cannot be written: this kind is left out, the launch goes on.
      notes.push('Your ' + spec.label + ' sign-in could not be prepared, so it was not handed over.');
    }
  }
  return { payloads: payloads as Payloads, leased, notes };
}

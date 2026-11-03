// What a sandbox hands back: a sign-in it renewed (or one you made there), left in its data folder as
// state\accounts\<kind>.json. Taken on every sync cycle: sealed into the store when the kind returns, the launch holds
// its lease and the file is a plain file within the size limit of the right shape; deleted unsealed otherwise. The
// last sync of a sandbox releases its leases. The state folder is found through hostDataFolder (contained storage
// keeps it in the image).
import fs from 'node:fs';
import path from 'node:path';
import { assertNoLinks, isLink } from '../../core/util/index.js';
import {
  HANDOFF_PARTS,
  handoffSchema,
  SERVICE_KINDS,
  SERVICE_SPECS,
  type ServiceKind,
} from '../../shared/accounts/index.js';
import { readBoundedFile } from '../../shared/io/index.js';
import { hostDataFolder, hostDataRoot, setNameOf, storageOf } from '../storage/index.js';
import { AccountLeases } from './leases.js';
import { HOST_SOURCES } from './sources.js';
import { ServiceAccountStore } from './store.js';

/** Room for the handoff's own fields around the payload. */
const ENVELOPE_BYTES = 1024;

/** state\accounts in a data set, as this PC sees it. */
export function handoffDir(dataPath: string): string {
  return path.join(hostDataFolder(dataPath, HANDOFF_PARTS[0]), HANDOFF_PARTS[1]);
}

function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes a handoff file without following anything the sandbox planted: a link is removed itself, and nothing is
 * touched when a folder on the way is a link. False when it could not be removed.
 */
function drop(root: string, file: string): boolean {
  try {
    if (isLink(file)) {
      fs.unlinkSync(file);
      return true;
    }
    assertNoLinks(root, file);
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function takeHandoffs(
  dataPath: string,
  final: boolean,
  store: ServiceAccountStore = new ServiceAccountStore(storageOf(dataPath)),
  leases: AccountLeases = new AccountLeases(storageOf(dataPath)),
): { taken: ServiceKind[]; dropped: ServiceKind[] } {
  const taken: ServiceKind[] = [];
  const dropped: ServiceKind[] = [];
  const root = hostDataRoot(dataPath);
  const dir = handoffDir(dataPath);
  const dataSet = setNameOf(dataPath);
  for (const kind of SERVICE_KINDS) {
    const file = path.join(dir, kind + '.json');
    if (!exists(file)) continue;
    let ok = false;
    try {
      assertNoLinks(root, file);
      const spec = SERVICE_SPECS[kind];
      const bytes = readBoundedFile(file, spec.maxBytes + ENVELOPE_BYTES);
      const parsed = bytes ? handoffSchema(kind).safeParse(JSON.parse(bytes.toString('utf8'))) : null;
      const lease = leases.leaseOf(kind, dataSet);
      if (parsed?.success && spec.returns && lease && lease.launchId === parsed.data.launchId) {
        const payload = parsed.data.payload;
        store.save(kind, payload as never, 'sandbox', HOST_SOURCES[kind].summary(payload as never));
        ok = true;
      }
    } catch {
      // A link on the way, not JSON, or a store that cannot be written: dropped below, the saved one stays.
    }
    drop(root, file);
    (ok ? taken : dropped).push(kind);
  }
  if (final) leases.releaseAll(dataSet);
  return { taken, dropped };
}

/**
 * Forgets a sign-in everywhere: the saved one, its lease (what a running sandbox hands back afterwards is refused),
 * and every copy a sandbox left in a data set and the PC has not taken yet.
 */
export function forgetEverywhere(
  kind: ServiceKind,
  storageRoot: string,
  store: ServiceAccountStore = new ServiceAccountStore(storageRoot),
  leases: AccountLeases = new AccountLeases(storageRoot),
): { removed: boolean; pendingDeleted: number } {
  const removed = store.remove(kind);
  leases.revoke(kind);
  let pendingDeleted = 0;
  const sets = path.join(storageRoot, 'data');
  let names: string[] = [];
  try {
    names = fs.readdirSync(sets);
  } catch {
    // No data sets yet.
  }
  for (const name of names) {
    const dataPath = path.join(sets, name);
    if (isLink(dataPath)) continue;
    const file = path.join(handoffDir(dataPath), kind + '.json');
    if (exists(file) && drop(hostDataRoot(dataPath), file)) pendingDeleted++;
  }
  return { removed, pendingDeleted };
}

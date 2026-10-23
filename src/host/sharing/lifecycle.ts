// A sandbox's time as a shared one: at launch its owner writes the record that says whose it is and whether others may
// use it (and opens or closes the folders for them); when it ends the record goes and the folders close again. The
// pieces that touch the PC (the record folder, the permissions) are given, so tests run on temp folders.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { RunDir } from '../../shared/channel/index.js';
import { isWithin } from '../../shared/paths/index.js';
import { JsonFile } from '../../shared/io/index.js';
import { InstallLayout, InstallRecordFile, machineInstall } from '../install/index.js';
import { storageOf } from '../storage/index.js';
import { sharingAclPlan, applyAcl, type AclChange } from './acl.js';
import { ActiveRecords, type ActiveSandbox } from './active-record.js';
import { groupHasAccess } from './group-access.js';
import { activeDir, usersDir } from './machine-paths.js';

export interface SharingDeps {
  readonly records: ActiveRecords;
  /** Applies folder permission changes (the real one refuses inside the self-test). */
  readonly apply: (changes: readonly AclChange[]) => void;
  /** The group of users who may share (from install.json); null: no permissions to change. */
  readonly groupSid: string | null;
  /** The shared tree (machine\users): permissions change only for data folders inside it. */
  readonly usersDir: string;
  /**
   * Does the group have an entry on any of these folders (true also when that cannot be read)? When it says no, a
   * launch that shares nothing has no entries to remove and skips the permission script. Left out: always apply.
   */
  readonly groupHasAccess?: (dirs: readonly string[]) => boolean;
}

/** What the launch knows about the sandbox it is about to start. */
export type SharingStart = Omit<ActiveSandbox, 'startedAt'> & { readonly startedAt?: string };

/**
 * The machinery of the all-users install on this PC, or null when there is none (nothing is shared then: one user, one
 * storage folder). It is found from any copy of the program: an npm copy or a checkout that starts a sandbox shares it
 * the same way the installed one does, with the group and the settings the install recorded.
 */
export function sharingDeps(packageRoot: string): SharingDeps | null {
  const detected = InstallLayout.detect(packageRoot);
  const layout = detected?.scope === 'machine' ? detected : machineInstall();
  if (!layout) return null;
  return {
    records: new ActiveRecords(activeDir()),
    apply: applyAcl,
    groupSid: new InstallRecordFile(layout.root).read()?.groupSid ?? null,
    usersDir: usersDir(),
    groupHasAccess,
  };
}

/** Folder permissions change only with a group, and only inside the shared tree (never your own storage folder). */
function opens(deps: SharingDeps, dataPath: string): deps is SharingDeps & { readonly groupSid: string } {
  return deps.groupSid !== null && isWithin(deps.usersDir, dataPath);
}

/** Writes the record, and opens (shared) or closes (not shared) the owner's folders for the group. */
export function beginSharing(deps: SharingDeps, start: SharingStart, now: Date = new Date()): void {
  deps.records.write({ ...start, startedAt: start.startedAt ?? now.toISOString() });
  if (!opens(deps, start.dataPath)) return;
  // The owner creates the run folder and every channel folder in it before others may write there: a folder another
  // user created would stay theirs, and writable by them, after sharing is turned off.
  const run = new RunDir(start.dataPath);
  for (const dir of [
    run.root,
    run.requestsDir,
    run.responsesDir,
    run.sessionsDir,
    run.projectsDir,
    run.auditDir,
    run.treesDir,
  ])
    fs.mkdirSync(dir, { recursive: true });
  const plan = sharingAclPlan({
    storageUserDir: storageOf(start.dataPath),
    dataPath: start.dataPath,
    groupSid: deps.groupSid,
    on: start.shared,
  });
  // Not shared and nothing of the group left to take away: nothing to write, so a slow folder cannot block the launch.
  // When the entries cannot be read, or one is there, the removal runs and a failure of it refuses the launch.
  if (!start.shared && deps.groupHasAccess && !deps.groupHasAccess(plan.map((c) => c.path))) return;
  deps.apply(plan);
}

/** The sandbox of this data folder ended: its record goes and the group loses access again. Never throws. */
export function endSharing(deps: SharingDeps, dataPath: string): void {
  try {
    const mine = deps.records.readAll().filter((r) => r.dataPath.toLowerCase() === dataPath.toLowerCase());
    for (const record of mine) deps.records.clear(record.sid);
    if (opens(deps, dataPath) && fs.existsSync(path.join(dataPath, 'run')))
      deps.apply(
        sharingAclPlan({
          storageUserDir: storageOf(dataPath),
          dataPath,
          groupSid: deps.groupSid,
          on: false,
        }),
      );
  } catch {
    // Best effort: a stale record is ignored (its session has no sandbox), and the next launch sets the folders again.
  }
}

const SHARING_NOTICE =
  'Others in Agent Sandbox Users can attach to and run commands in this sandbox. Their sessions use the agent logins ' +
  'in it, and history goes to your account.';

const NoticeSchema = z.object({ told: z.literal(true) });

/** The sharing explanation the first time sharing is on for this user (null afterwards). */
export function takeSharingNotice(storageRoot: string): string | null {
  const file = new JsonFile(NoticeSchema, path.join(storageRoot, 'sharing-notice.json'));
  if (file.read()) return null;
  file.write({ told: true });
  return SHARING_NOTICE;
}

// Machine-wide settings (the machine file under the user file), the records of who started a sandbox, who owns the
// running one, and the folder permissions for sharing. Everything happens in temp folders; the folder-permission
// script runs on the temp folders only, and only on Windows.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULTS, loadConfig, machineConfigPath } from '../core/config/index.js';
import { ConfigSchema, LocalOverridesSchema } from '../core/schema/index.js';
import { nativeFile, nativeScript } from '../host/native.js';
import {
  ActiveRecords,
  parseTasklist,
  runFolderAccess,
  runPrivateFolder,
  sharingAclPlan,
  whoOwnsSandbox,
  type ActiveSandbox,
} from '../host/sharing/index.js';
import { SYSTEM } from '../shared/system.js';
import type { Suite } from './support/suite.js';
import type { Harness } from './support/harness.js';

const ALICE_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const BOB_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1002';
const GROUP_SID = 'S-1-5-21-1111111111-2222222222-3333333333-5000';

/** A record as a starter writes it. */
function record(sid: string, extra: Partial<ActiveSandbox> = {}): ActiveSandbox {
  return {
    user: sid === ALICE_SID ? 'alice' : 'bob',
    sid,
    windowsSession: 2,
    dataPath: 'C:\\Users\\alice\\AgentSandbox\\data\\default',
    shared: true,
    startedAt: '2026-10-14T09:00:00Z',
    version: '1.4.3',
    projects: [{ id: 'app', hostPath: 'C:\\Dev\\app', guestPath: 'C:\\Workspace\\app' }],
    ...extra,
  };
}

// Five process rows (the sandbox window in session 2) and the INFO line tasklist prints when a filter matches nothing.
const TASKLIST = [
  '"explorer.exe","4120","Console","1","123,456 K"',
  '"WindowsSandboxClient.exe","8124","Console","2","1,234 K"',
  '"svchost.exe","900","Services","0","12,345 K"',
  '"conhost.exe","8130","Console","2","4,096 K"',
  '',
  'INFO: No tasks are running which match the specified criteria.',
  '',
].join('\r\n');

/** Layers: defaults, the machine file, the user file. */
async function layering(t: Harness): Promise<void> {
  t.section('layering: machine file under the user file');
  t.check(
    machineConfigPath({ ProgramData: 'D:\\PD' }) === path.join('D:\\PD', 'AgentSandbox', 'config.json') &&
      machineConfigPath({ AGENT_SANDBOX_MACHINE_HOME: t.at('m') }) === path.join(t.at('m'), 'config.json'),
    'the machine file is %ProgramData%\\AgentSandbox\\config.json, movable with AGENT_SANDBOX_MACHINE_HOME (tests)',
  );

  const quiet = loadConfig();
  const machineFile = t.writeJson(machineConfigPath(), {
    sharing: { otherUsers: true },
    storage: { root: t.at('machine-storage') },
  });
  const machineOnly = loadConfig();
  const userFile = t.writeJson(t.at('user', 'config.json'), { sharing: { otherUsers: false } });
  const both = loadConfig(userFile);
  t.equal(
    [
      [quiet.layers?.machine, quiet.layers?.user, quiet.config.sharing.otherUsers],
      [machineOnly.config.sharing.otherUsers, machineOnly.config.storage.root, machineOnly.configPath],
      [both.config.sharing.otherUsers, both.config.storage.root, both.layers],
    ],
    [
      [null, null, false],
      [true, t.at('machine-storage'), null],
      [false, t.at('machine-storage'), { machine: machineFile, user: userFile }],
    ],
    'no files: defaults (sharing off); a machine file alone applies; the user file wins but keys it leaves out keep the machine value',
  );

  t.writeJson(machineFile, { storage: { root: 'relative\\store' } });
  await t.throws(
    () => loadConfig(),
    'storage.root',
    'a relative folder in the machine file is refused, naming the key',
  );
  t.writeJson(machineFile, { sharing: { otherUsers: 'yes' } });
  await t.throws(() => loadConfig(), 'otherUsers', 'a machine file is validated like a user file');
}

/** A project file can never make this PC's sandbox shared; the user file can. */
function projectCannotShare(t: Harness): void {
  t.check(
    !LocalOverridesSchema.safeParse({ sharing: { otherUsers: true } }).success &&
      ConfigSchema.safeParse({ ...DEFAULTS, sharing: { otherUsers: true } }).success,
    'sharing is a user (or machine) setting only: a project file cannot set sharing.otherUsers',
  );
}

/** Records: write, read, clear, and what is skipped (corrupt, mismatched, a folder, a link). */
function recordsSection(t: Harness): void {
  t.section('active records');
  const dir = t.dir('active');
  const records = new ActiveRecords(dir);
  t.equal(records.readAll(), [], 'a missing folder reads as no records');

  records.write(record(ALICE_SID));
  records.write(record(BOB_SID, { shared: false, windowsSession: 3 }));
  const both = records.readAll().length;
  records.clear(BOB_SID);
  t.check(
    both === 2 &&
      records
        .readAll()
        .map((r) => r.sid)
        .join() === ALICE_SID,
    'each user has their own record; clear removes only that user’s',
  );

  t.write(path.join(dir, 'S-1-5-21-1111111111-2222222222-3333333333-1003.json'), '{ not json');
  t.writeJson(
    path.join(dir, 'S-1-5-21-1111111111-2222222222-3333333333-1004.json'),
    record('S-1-5-21-1111111111-2222222222-3333333333-1005'),
  );
  fs.mkdirSync(path.join(dir, 'S-1-5-21-1111111111-2222222222-3333333333-1006.json'));
  const linked = 'S-1-5-21-1111111111-2222222222-3333333333-1007';
  const outside = t.writeJson(t.at('outside', 'record.json'), record(linked));
  try {
    fs.symlinkSync(outside, path.join(dir, linked + '.json'), 'file');
  } catch {
    t.skip('file links need a privilege this user may lack; the link check did not run');
  }
  t.equal(
    records.readAll().map((r) => r.sid),
    [ALICE_SID],
    'a corrupt file, a file named for another SID, a folder and a link are skipped (links never followed)',
  );

  let refused = false;
  try {
    records.write({ ...record(ALICE_SID), sid: '..\\evil' } as ActiveSandbox);
  } catch {
    refused = true;
  }
  t.check(refused, 'a record with a bad SID is refused on write (its file name would leave the folder)');
}

/** Who owns the running sandbox, from a recorded tasklist sample. */
function ownership(t: Harness): void {
  t.section('tasklist and the sandbox owner');
  const rows = parseTasklist(TASKLIST);
  t.check(
    rows.length === 4 &&
      JSON.stringify(rows[1]) === JSON.stringify({ image: 'WindowsSandboxClient.exe', pid: 8124, session: 2 }),
    'tasklist rows are read; the INFO line is skipped and a Mem with a thousands separator does not break a row',
  );

  const none = parseTasklist('"explorer.exe","4120","Console","1","123,456 K"');
  const aliceShared = whoOwnsSandbox(rows, 1, [record(ALICE_SID, { windowsSession: 2, shared: true })]);
  const bobPrivate = whoOwnsSandbox(rows, 1, [record(BOB_SID, { windowsSession: 2, shared: false })]);
  const remoteOnly = parseTasklist('"WindowsSandboxRemoteSession.exe","777","Console","3","900 K"');
  t.equal(
    [
      whoOwnsSandbox(none, 1, []).kind,
      whoOwnsSandbox(rows, 2, []).kind,
      aliceShared.kind === 'other' ? [aliceShared.user, aliceShared.shared] : aliceShared.kind,
      bobPrivate.kind === 'other' ? [bobPrivate.user, bobPrivate.shared] : bobPrivate.kind,
      whoOwnsSandbox(rows, 1, []).kind,
      whoOwnsSandbox(rows, 1, [record(ALICE_SID, { windowsSession: 9 })]).kind,
      whoOwnsSandbox(remoteOnly, 1, [record(ALICE_SID, { windowsSession: 3 })]).kind,
    ],
    ['none', 'mine', ['alice', true], ['bob', false], 'unknown-other', 'unknown-other', 'other'],
    'owner: none, mine, another user (shared or not), no record, a stale record, and the remote-session process',
  );
}

/** The permission entries sharing needs, on and off. */
async function permissionPlan(t: Harness): Promise<void> {
  t.section('folder permissions for sharing');
  const storageUserDir = t.at('ProgramData', 'AgentSandbox', 'users', 'alice');
  const dataPath = path.join(storageUserDir, 'data', 'default');
  const entries = (add: boolean) => [
    { path: storageUserDir, sid: GROUP_SID, rights: 'Traverse', scope: 'this-folder', add },
    { path: path.join(storageUserDir, 'data'), sid: GROUP_SID, rights: 'Traverse', scope: 'this-folder', add },
    { path: dataPath, sid: GROUP_SID, rights: 'Traverse', scope: 'this-folder', add },
    { path: path.join(dataPath, 'run'), sid: GROUP_SID, rights: 'Modify', scope: 'inherit', add },
  ];
  t.equal(
    [
      sharingAclPlan({ storageUserDir, dataPath, groupSid: GROUP_SID, on: true }),
      sharingAclPlan({ storageUserDir, dataPath, groupSid: GROUP_SID, on: false }),
    ],
    [entries(true), entries(false)],
    'sharing on: traverse on the user folder, data folder and data set, modify (inherited) on run; off removes the same entries',
  );
  await t.throws(
    () => sharingAclPlan({ storageUserDir, dataPath: t.at('elsewhere', 'default'), groupSid: GROUP_SID, on: true }),
    'not under',
    'a data set outside the user folder is refused',
  );
}

/** The PowerShell script: it parses, changes a temp folder's permissions, and refuses links. Windows only. */
async function folderScript(t: Harness): Promise<void> {
  t.section('set-folder-access.ps1');
  if (process.platform !== 'win32') {
    t.skip('the folder-permission script runs only on Windows');
    return;
  }
  const parsed = spawnSync(
    SYSTEM.powershell(),
    nativeScript('check-syntax.ps1', ['-Path', nativeFile('scripts', 'set-folder-access.ps1')]),
    { encoding: 'utf8', windowsHide: true },
  );
  t.equal(
    parsed.status,
    0,
    'set-folder-access.ps1 parses with Windows PowerShell 5.1 (' + (parsed.stderr || '').trim() + ')',
  );

  const who = spawnSync(SYSTEM.whoami(), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const match = /"([^"]+)","(S-1-[0-9-]+)"/.exec(who.stdout ?? '');
  if (!match) {
    t.skip('could not read the current user SID with whoami');
    return;
  }
  const [, account, sid] = match;
  const target = t.dir('acl-target');
  const icacls = (): string =>
    (spawnSync(SYSTEM.icacls(), [target], { encoding: 'utf8', windowsHide: true }).stdout ?? '').toLowerCase();
  const explicitRead = account.toLowerCase() + ':(r)';

  runFolderAccess([{ path: target, sid, rights: 'Read', scope: 'this-folder', add: true }]);
  const granted = icacls().includes(explicitRead);
  runFolderAccess([{ path: target, sid, rights: 'Read', scope: 'this-folder', add: false }]);
  t.check(
    granted && !icacls().includes(explicitRead),
    'adding a Read entry grants it on the temp folder; removing takes it away',
  );

  const link = t.at('acl-link');
  fs.symlinkSync(target, link, 'junction');
  let refused = '';
  try {
    runFolderAccess([{ path: link, sid, rights: 'Read', scope: 'this-folder', add: true }]);
  } catch (e) {
    refused = (e as Error).message;
  }
  t.includes(refused, 'link', 'a junction is refused, and nothing is changed through it');

  // Nothing to change: removing an entry that is not there leaves the permissions as they were.
  const before = icacls();
  runFolderAccess([{ path: target, sid, rights: 'Read', scope: 'this-folder', add: false }]);
  t.equal(icacls(), before, 'removing an entry that is not there changes nothing');

  // A this-folder entry is written to that folder only: it stays auto-inherited (D:AI) and a child is not touched; an
  // entry that changes nothing writes nothing (the change time of the folder does not move).
  const sddls = (folder: string, also?: string): string[] =>
    (
      spawnSync(
        SYSTEM.powershell(),
        nativeScript('read-folder-sddl.ps1', ['-Path', folder, ...(also ? ['-Also', also] : [])]),
        {
          encoding: 'utf8',
          windowsHide: true,
        },
      ).stdout ?? ''
    )
      .split(/\r?\n/)
      .filter(Boolean);
  const inherits = t.dir('acl-inherits');
  // Set-Acl marks the folder auto-inherited, whatever its parent says: start from that state.
  runFolderAccess([{ path: inherits, sid, rights: 'Modify', scope: 'inherit', add: true }]);
  const child = path.join(inherits, 'child');
  fs.mkdirSync(child);
  fs.writeFileSync(path.join(child, 'a.txt'), 'x');
  const [folderBefore, childBefore] = sddls(inherits, child);
  if (!folderBefore?.includes('D:AI')) {
    t.skip('the temp folder does not inherit its permissions here, so D:AI cannot be checked');
  } else {
    const childChange = fs.statSync(child).ctimeMs;
    runFolderAccess([{ path: inherits, sid, rights: 'Read', scope: 'this-folder', add: true }]);
    const [folderAfter, childAfter] = sddls(inherits, child);
    t.check(
      folderAfter !== folderBefore && folderAfter.includes('D:AI'),
      'a this-folder entry changes the folder and keeps it auto-inherited (D:AI)',
    );
    t.check(
      childAfter === childBefore && fs.statSync(child).ctimeMs === childChange,
      'a this-folder entry leaves a child’s permissions byte for byte the same',
    );
    runFolderAccess([{ path: inherits, sid, rights: 'Read', scope: 'this-folder', add: true }]);
    const changed = fs.statSync(inherits).ctimeMs;
    runFolderAccess([{ path: inherits, sid, rights: 'Read', scope: 'this-folder', add: true }]);
    runFolderAccess([{ path: inherits, sid, rights: 'Modify', scope: 'this-folder', add: false }]);
    t.check(
      fs.statSync(inherits).ctimeMs === changed && sddls(inherits)[0] === folderAfter,
      'an entry that changes nothing writes nothing',
    );
    runFolderAccess([{ path: inherits, sid, rights: 'Read', scope: 'this-folder', add: false }]);
    t.equal(sddls(inherits)[0], folderBefore, 'removing the entry restores the folder exactly');
  }

  // A private folder: inheritance off, only you, SYSTEM and Administrators; a second run changes nothing.
  const own = t.dir('acl-private');
  runPrivateFolder(own);
  const first = (spawnSync(SYSTEM.icacls(), [own], { encoding: 'utf8', windowsHide: true }).stdout ?? '').toLowerCase();
  runPrivateFolder(own);
  const second = (
    spawnSync(SYSTEM.icacls(), [own], { encoding: 'utf8', windowsHide: true }).stdout ?? ''
  ).toLowerCase();
  t.check(
    first === second &&
      first.includes('nt authority\\system:(oi)(ci)(f)') &&
      first.includes('builtin\\administrators:(oi)(ci)(f)') &&
      !first.includes('builtin\\users'),
    'a private folder is closed to other users, and making it private again changes nothing',
  );
  fs.mkdirSync(path.join(own, 'child'));
  fs.writeFileSync(path.join(own, 'child', 'a.txt'), 'x');
  t.check(
    fs.readFileSync(path.join(own, 'child', 'a.txt'), 'utf8') === 'x',
    'the owner can still use a private folder',
  );
  // Security review 2026-10: under an all-users install another member of the group can create users\<you> first.
  const theirs = t.dir('acl-someone-elses');
  const given = spawnSync(SYSTEM.icacls(), [theirs, '/setowner', '*S-1-5-18'], { encoding: 'utf8', windowsHide: true });
  if (given.status !== 0) t.skip('a folder owned by someone else (cannot give a folder to SYSTEM here)');
  else
    await t.throws(
      () => runPrivateFolder(theirs),
      'not to you',
      'a folder someone else owns is refused, never made "private" for you (its owner could open it again)',
    );
}

export const sharingSuite: Suite = {
  name: 'sharing',
  title: 'machine settings, sharing records, sandbox owner, folder permissions',
  run: async (t) => {
    const savedMachine = process.env.AGENT_SANDBOX_MACHINE_HOME;
    process.env.AGENT_SANDBOX_MACHINE_HOME = t.at('machine-home');
    try {
      await layering(t);
      projectCannotShare(t);
      recordsSection(t);
      ownership(t);
      await permissionPlan(t);
      await folderScript(t);
    } finally {
      // Later suites load the settings too: the machine file this suite wrote must not outlive it.
      fs.rmSync(t.at('machine-home'), { recursive: true, force: true });
      if (savedMachine === undefined) delete process.env.AGENT_SANDBOX_MACHINE_HOME;
      else process.env.AGENT_SANDBOX_MACHINE_HOME = savedMachine;
    }
  },
};

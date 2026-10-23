// Contained storage (beta): the image is there, what the record says is mounted matches what is really mounted, and
// the folders around the image are private. A mount left behind (a sandbox that ended without letting go, a crash) is
// dismounted here, which needs the Windows permission prompt.
import fs from 'node:fs';
import { isWin } from '../../../../core/util/index.js';
import { parseIcacls, privacyProblems, SHARING_GROUP } from '../../../../host/health/index.js';
import { realContainedDeps } from '../../../../host/sandbox/index.js';
import { protectPrivateFolder } from '../../../../host/sharing/index.js';
import { containedAvailability, ContainedStorage, containedPaths } from '../../../../host/storage/index.js';
import type { Check, Finding, FixOutcome, RepairEnv } from '../types.js';
import { ok } from './common.js';

function storageOf(env: RepairEnv): ContainedStorage {
  const { config } = env.ctx.loaded;
  return new ContainedStorage(
    realContainedDeps(env.storageRoot, config.storage.containedMaxGb, Boolean(env.ctx.options.config)),
    config.storage.dataName,
  );
}

/** Only when contained storage is on, or an image or a record of one exists. */
const inUse = (env: RepairEnv): boolean => {
  if (!isWin) return false;
  const { config } = env.ctx.loaded;
  const paths = containedPaths(env.storageRoot, config.storage.dataName);
  return config.storage.contained === 'vhdx' || fs.existsSync(paths.image) || fs.existsSync(paths.stateFile);
};

export const CONTAINED_CHECKS: Check[] = [
  {
    id: 'data-contained',
    group: 'Data folder',
    name: 'Contained storage',
    checking: 'the contained storage image (beta)',
    applies: inUse,
    timeoutMs: 60_000,
    run: async (env: RepairEnv): Promise<Finding> => {
      const wanted = env.ctx.loaded.config.storage.contained === 'vhdx';
      const available = containedAvailability();
      if (!available.available)
        return wanted
          ? {
              status: 'needs-you',
              detail: 'storage.contained is "vhdx", but ' + available.reasons.join(' '),
              means: 'A launch cannot mount the image on this PC.',
              fix: available.fixes.join(' '),
            }
          : {
              status: 'skipped',
              detail: 'an image exists, but this PC cannot look at it: ' + available.reasons.join(' '),
            };
      const storage = storageOf(env);
      const diagnosis = await storage.diagnose();
      switch (diagnosis.kind) {
        case 'image-missing':
          return wanted
            ? {
                status: 'needs-you',
                detail: 'the image is missing: ' + storage.paths.image,
                means: 'A launch stops until it is there (the tools, state and logs in it are gone with it).',
                fix: 'Restore the file, or run: sandbox storage contained off (and then on again for a new, empty image).',
              }
            : ok('no image (contained storage is off)');
        case 'in-use':
          return ok('mounted, in use by a running sandbox');
        case 'stale-mount':
          return {
            status: 'needs-you',
            detail: 'the image is still mounted at ' + storage.paths.mount + ', and nothing uses it',
            means: 'It stays attached to this PC until it is dismounted; a launch would reuse it.',
            plan: 'dismount the image (Windows asks for permission)',
            data: 'dismount',
          };
        case 'stale-state':
          return {
            status: 'warn',
            detail: 'the record says the image is mounted, but it is not',
            means: 'Nothing is wrong with the image; the record is out of date.',
            plan: 'correct the record',
            data: 'record',
          };
        default:
          return ok('not mounted' + (wanted ? '' : ' (contained storage is off; the image is kept)'));
      }
    },
    fix: async (env: RepairEnv, finding: Finding): Promise<FixOutcome> => {
      const storage = storageOf(env);
      if (finding.data === 'record') {
        storage.clearRecord();
        return { done: 'corrected the record' };
      }
      const result = await storage.dismountIfIdle();
      if (!result.dismounted) throw new Error('Could not dismount the image: ' + (result.note ?? 'unknown reason'));
      return { done: 'dismounted the image' };
    },
    needsIdle: 'fix',
  },
  {
    id: 'data-contained-privacy',
    group: 'Data folder',
    name: 'Contained storage folders',
    checking: 'who can open the contained storage folders',
    applies: inUse,
    run: (env: RepairEnv): Finding => {
      const { config } = env.ctx.loaded;
      const paths = containedPaths(env.storageRoot, config.storage.dataName);
      // While mounted, the mount folder shows the image's own root, and nothing is changed under a mount point.
      if (env.running) return ok('a sandbox is running; not looked at now');
      const loose: string[] = [];
      for (const dir of [paths.imagesDir, paths.mountsDir, paths.mount]) {
        if (!fs.existsSync(dir)) continue;
        const text = env.system.icacls(dir);
        if (text === null) return { status: 'skipped', detail: 'could not read the permissions of ' + dir };
        const problems = privacyProblems(parseIcacls(text, dir), SHARING_GROUP);
        if (problems.length > 0) loose.push(dir + ' (' + problems.join(', ') + ')');
      }
      if (loose.length === 0) return ok('private (you, SYSTEM and administrators)');
      return {
        status: 'warn',
        detail: 'open to more than you: ' + loose.join('; '),
        means: 'Other users of this PC could open the image or the folders it is mounted in.',
        plan: 'make them private',
        data: 'private',
      };
    },
    fix: (env: RepairEnv): FixOutcome => {
      const { config } = env.ctx.loaded;
      const paths = containedPaths(env.storageRoot, config.storage.dataName);
      // Never with an image mounted below: a folder with files is walked, and a mount point must not be.
      if (env.running) throw new Error('a sandbox is running; run repair again once it is closed');
      for (const dir of [paths.imagesDir, paths.mountsDir, paths.mount])
        if (fs.existsSync(dir)) protectPrivateFolder(dir);
      return { done: 'made the folders private' };
    },
    needsIdle: 'fix',
  },
];

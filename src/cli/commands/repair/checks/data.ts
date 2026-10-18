// The data folder: where it is, that it can be written, how much room is left, data left behind in another folder, and
// what an interrupted install left inside it (links the sandbox made, half-downloaded or half-installed tools). Nothing
// here follows a link or deletes anything but leftovers.
import fs from 'node:fs';
import path from 'node:path';
import { GB, freeBytesAt, humanBytes } from '../../../../core/disk.js';
import { dirExists, isLink, removeLink } from '../../../../core/util/index.js';
import { writeProblem } from '../../../../host/health/index.js';
import { assertTestWritable } from '../../../../host/test-guard.js';
import {
  OLD_DEFAULT_ROOT,
  StorageHistory,
  holdsData,
  oldDefaultRoot,
  otherDataFolders,
  sharedDefaultRoot,
} from '../../../../host/storage/index.js';
import { removeTree } from '../../../services/data-remove.js';
import { findHalfInstalled, findLinks, findStagingLeftovers, resolvedVersionsValid } from '../finders.js';
import type { Check, Finding, FixOutcome, RepairEnv } from '../types.js';
import { guard, ok, plural, rel } from './common.js';

const same = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export const DATA_CHECKS: Check[] = [
  {
    id: 'data-folder',
    group: 'Data folder',
    name: 'Data folder',
    checking: 'where the data folder is',
    run: (env: RepairEnv): Finding => {
      for (const dir of [env.storageRoot, env.dataPath])
        if (isLink(dir))
          return {
            status: 'needs-you',
            detail: dir + ' is a link or junction',
            means: 'The sandbox tool refuses to work through links: one could lead to other folders on this PC.',
            fix: 'Point storage.root at the real folder (sandbox config path), or move the data with: sandbox storage move <folder>',
          };
      if (!dirExists(env.storageRoot)) return ok(env.storageRoot + ' (not created yet; the first start makes it)');
      const bad = writeProblem(env.storageRoot) ?? (dirExists(env.dataPath) ? writeProblem(env.dataPath) : null);
      if (bad)
        return {
          status: 'needs-you',
          detail: 'cannot write in ' + env.storageRoot + ' (' + bad + ')',
          means: 'The sandbox cannot save its tools, logins or logs.',
          fix: 'Check the folder is not read-only and that you may write to it, or choose another with: sandbox storage move <folder>',
        };
      return ok(env.dataPath + ' (you can write there)');
    },
  },
  {
    id: 'data-disk',
    group: 'Data folder',
    name: 'Free disk space',
    run: (env: RepairEnv): Finding => {
      const free = freeBytesAt(env.storageRoot);
      if (free === null) return { status: 'skipped', detail: 'could not check the drive of ' + env.storageRoot };
      if (free >= 20 * GB) return ok(humanBytes(free) + ' free');
      return {
        status: 'warn',
        detail:
          humanBytes(free) +
          ' free on the drive of ' +
          env.storageRoot +
          (free < 5 * GB ? ' (toolchains need several GB)' : ' (getting low)'),
        means: 'Tool installs and caches can use several GB.',
        fix: 'See what is stored with: sandbox data, and free space with: sandbox data clean <target>',
      };
    },
  },
  {
    id: 'data-pinned-old',
    group: 'Data folder',
    name: 'Old data folder',
    run: (env: RepairEnv): Finding => {
      const old = oldDefaultRoot();
      const shared = sharedDefaultRoot();
      if (!old || !same(env.storageRoot, old) || same(old, shared))
        return ok('your data is not in the old per-user folder');
      if (!holdsData(env.storageRoot)) return ok('the old folder is empty');
      return {
        status: 'warn',
        detail:
          'your data is still in the old per-user folder ' +
          old +
          ' (kept by settings that say ' +
          OLD_DEFAULT_ROOT +
          ')',
        means:
          'It keeps working. New installs keep their data in ' +
          shared +
          ', which only you can read, and which an install for everyone can share.',
        fix: 'Move it when you like (it shows the size and time first): sandbox storage move "' + shared + '"',
      };
    },
  },
  {
    id: 'data-elsewhere',
    group: 'Data folder',
    name: 'Data in other folders',
    run: (env: RepairEnv): Finding => {
      const others = otherDataFolders(env.storageRoot, new StorageHistory(env.userDir));
      if (!others.length) return ok('no saved data in any other known folder');
      const both = holdsData(env.storageRoot);
      return {
        status: 'warn',
        detail: (both ? 'data is in this folder and also in ' : 'data is in ') + others.join(', '),
        means: both
          ? 'A move may have stopped half way, or you used another version for a while. Nothing is deleted for you.'
          : 'Your current data folder is empty, so the sandbox starts from scratch. That data is not lost.',
        fix: both
          ? 'Check that other folder, and delete it yourself when you are sure. Or switch to it with: sandbox storage use "' +
            others[0] +
            '"'
          : 'Bring it here with: sandbox storage move "' +
            others[0] +
            '" (or switch with: sandbox storage use "' +
            others[0] +
            '")',
      };
    },
  },
  {
    id: 'data-links',
    group: 'Data folder',
    name: 'Links in the data folder',
    checking: 'the data folder for links',
    needsIdle: 'look',
    run: (env: RepairEnv): Finding => {
      const links = findLinks(env.dataPath);
      if (!links.length) return ok('none (nothing in ' + env.dataPath + ' points elsewhere)');
      return {
        status: 'needs-you',
        detail: plural(links.length, 'link') + ' made inside the sandbox',
        means: "A link here could point at this PC's own files; the tool must not follow it.",
        plan: 'remove ' + plural(links.length, 'link') + ' without following them',
        lines: links.map((l) => rel(env.dataPath, l)),
        data: links,
      };
    },
    fix: (env: RepairEnv, finding: Finding): FixOutcome => {
      const links = Array.isArray(finding.data) ? (finding.data as string[]) : [];
      // Only if every folder above is still real.
      for (const link of links) {
        guard(env, path.dirname(link));
        removeLink(link);
      }
      return {
        done: 'removed ' + plural(links.length, 'link') + ' without following ' + (links.length === 1 ? 'it' : 'them'),
      };
    },
  },
  {
    id: 'data-downloads',
    group: 'Data folder',
    name: 'Interrupted downloads',
    needsIdle: 'look',
    run: (env: RepairEnv): Finding => {
      guard(env, env.toolsDir);
      const found = findStagingLeftovers(env.toolsDir);
      if (!found.length) return ok('none');
      return {
        status: 'needs-you',
        detail: plural(found.length, 'half-finished download or copy folder'),
        means: 'They only waste space; the next start downloads again.',
        plan: 'remove ' + plural(found.length, 'half-finished folder'),
        lines: found.map((p) => rel(env.toolsDir, p)),
        data: found,
      };
    },
    fix: (env: RepairEnv, finding: Finding): FixOutcome => {
      const found = Array.isArray(finding.data) ? (finding.data as string[]) : [];
      guard(env, env.toolsDir);
      for (const p of found) removeTree(p, env.dataPath);
      return { done: 'removed ' + plural(found.length, 'half-finished folder') };
    },
  },
  {
    id: 'data-toolchains',
    group: 'Data folder',
    name: 'Half-installed toolchains',
    needsIdle: 'look',
    run: (env: RepairEnv): Finding => {
      guard(env, env.toolsDir);
      const found = findHalfInstalled(env.toolsDir);
      if (!found.length) return ok('every toolchain folder has its program');
      return {
        status: 'needs-you',
        detail: found.map((f) => rel(env.toolsDir, f.path) + ' (no ' + f.missing + ')').join(', '),
        means: 'An install stopped half way; that tool will not run.',
        plan: 'remove ' + plural(found.length, 'half-installed folder') + ' (the next sandbox installs them again)',
        data: found.map((f) => f.path),
      };
    },
    fix: (env: RepairEnv, finding: Finding): FixOutcome => {
      const found = Array.isArray(finding.data) ? (finding.data as string[]) : [];
      guard(env, env.toolsDir);
      for (const p of found) removeTree(p, env.dataPath);
      return {
        done: 'removed ' + found.map((p) => rel(env.toolsDir, p)).join(', ') + '; the next sandbox installs them again',
      };
    },
  },
  {
    id: 'data-versions-cache',
    group: 'Data folder',
    name: 'Resolved versions cache',
    needsIdle: 'look',
    run: (env: RepairEnv): Finding => {
      const file = path.join(env.toolsDir, 'resolved-versions.json');
      if (!fs.existsSync(file) && !isLink(file)) return ok('not created yet');
      guard(env, env.toolsDir);
      if (isLink(file))
        return {
          status: 'needs-you',
          detail: 'tools\\resolved-versions.json is a link',
          plan: 'remove the link',
          data: file,
        };
      if (fs.statSync(file).size < 4 * 1024 * 1024 && resolvedVersionsValid(fs.readFileSync(file, 'utf8')))
        return ok('valid');
      return {
        status: 'needs-you',
        detail: 'tools\\resolved-versions.json is damaged',
        means: 'The sandbox cannot read which tool versions it looked up.',
        plan: 'remove it (versions are looked up again on the next start)',
        data: file,
      };
    },
    fix: (env: RepairEnv, finding: Finding): FixOutcome => {
      const file = String(finding.data);
      guard(env, env.toolsDir);
      if (isLink(file)) {
        removeLink(file);
        return { done: 'removed the link in place of tools\\resolved-versions.json' };
      }
      assertTestWritable(file);
      fs.rmSync(file, { force: true });
      return { done: 'removed tools\\resolved-versions.json (versions are looked up again on the next start)' };
    },
  },
];

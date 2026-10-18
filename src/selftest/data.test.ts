// `sandbox data` and `sandbox clean`: what a clean target may name, how sizes and removal treat links, and which old
// launch folders, logs and downloads are pruned.
import fs from 'node:fs';
import path from 'node:path';
import { findLinks } from '../cli/commands/repair/finders.js';
import { removeTree, resolveCleanTargets } from '../cli/services/index.js';
import { humanBytes, sizeOf } from '../core/disk.js';
import { pruneStorage } from '../host/storage/index.js';
import type { Suite } from './support/suite.js';

export const dataSuite: Suite = {
  name: 'data',
  title: 'data clean targets, sizes and removal with links, storage cleanup',
  run: async (t) => {
    t.section('clean targets');
    const storage = t.at('data-store');
    const dataPath = path.join(storage, 'data', 'default');
    const resolve = (...inputs: string[]): string[] =>
      resolveCleanTargets(inputs, dataPath, storage).map((r) => path.relative(storage, r.path));
    const inData = (...parts: string[]): string => path.join('data', 'default', ...parts);
    t.equal(
      [
        resolve('tools/go'),
        resolve('tools\\go'),
        resolve('Tools/agents/claude'),
        resolve('databases/postgres-18'),
        resolve('logs'),
        resolve('launches'),
        resolve('state/claude'),
        resolve('tools', 'tools/go', 'tools/go'),
        resolve('all', 'logs'),
      ],
      [
        [inData('tools', 'go')],
        [inData('tools', 'go')],
        [inData('tools', 'agents', 'claude')],
        [inData('databases', 'postgres-18')],
        [inData('logs')],
        ['launches'],
        [inData('state', 'claude')],
        [inData('tools')],
        [inData(), 'launches'],
      ],
      'targets resolve inside the data folder (either slash, any case); launches is the storage folder; nested and repeated collapse; `all` is data plus launches',
    );
    t.check(
      Boolean(resolveCleanTargets(['state/claude'], dataPath, storage)[0].warning?.includes('login')) &&
        Boolean(resolveCleanTargets(['all'], dataPath, storage)[0].warning),
      'cleaning state warns about the login; cleaning everything carries a warning',
    );
    const badTargets = [
      '',
      '..',
      'tools/..',
      'tools/../../x',
      '../data',
      'C:\\Windows',
      'C:tools',
      '/etc',
      '\\\\server\\share',
      'tools/*',
      'tools/go:stream',
      'tools/a/b',
      'tools/agents/a/b',
      'logs/guest.log',
      'accounts',
      'sync',
      'windows',
      'tools/.',
      'tools/go.',
    ];
    const accepted = badTargets.filter((target) => {
      try {
        resolveCleanTargets([target], dataPath, storage);
        return true;
      } catch {
        return false;
      }
    });
    t.equal(
      accepted,
      [],
      'rejected: .., absolute paths, drive letters, UNC, wildcards, streams, too deep, unknown areas',
    );
    await t.throws(
      () => resolveCleanTargets([], dataPath, storage),
      '',
      'rejected: no target at all (that is not "everything")',
    );

    t.section('sizes and removal never follow links');
    const sized = t.at('sized');
    t.write(path.join(sized, 'a.bin'), 'x'.repeat(1000));
    t.write(path.join(sized, 'sub', 'b.bin'), 'y'.repeat(24));
    const outside = t.at('outside');
    t.write(path.join(outside, 'keep.txt'), 'z'.repeat(5000));
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(sized, 'sub', 'escape'), 'junction');
      linked = true;
    } catch {
      /* no junctions here */
    }
    t.check(
      sizeOf(sized) === 1024 && humanBytes(1536) === '1.5 KB' && humanBytes(3 * 1024 ** 3) === '3.0 GB',
      'sizes count real files only' + (linked ? ' (a junction counts 0)' : '') + ', in readable units',
    );
    if (linked) t.equal(findLinks(sized).length, 1, 'repair finds a junction planted in the data folder');
    removeTree(sized, t.temp);
    t.check(
      !fs.existsSync(sized) && fs.existsSync(path.join(outside, 'keep.txt')),
      'a folder is removed, but never what a link inside points to',
    );

    t.section('storage cleanup');
    const store = t.at('prune');
    const aged = (p: string, days: number): void => {
      const d = new Date(Date.now() - days * 86400000);
      fs.utimesSync(p, d, d);
    };
    for (const [name, days] of [
      ['old', 9],
      ['kept', 30],
      ['new', 1],
    ] as const) {
      aged(t.write(path.join(store, 'launches', name, 'agent.wsb'), 'x'), days);
      aged(path.join(store, 'launches', name), days);
    }
    aged(t.write(path.join(store, 'data', 'd', 'logs', 'guest-old.log'), 'x'), 20);
    t.write(path.join(store, 'data', 'd', 'logs', 'guest-new.log'), 'x');
    const staging = t.dir('prune', 'data', 'd', 'tools', 'git.staging-ab12');
    aged(staging, 2);
    t.dir('prune', 'data', 'd', 'tools', 'node');
    const pruned = pruneStorage(store, { keep: ['kept'] });
    const left = (p: string): boolean => fs.existsSync(path.join(store, p));
    t.equal(
      {
        removed: pruned.launches,
        old: left('launches/old'),
        kept: left('launches/kept'),
        new: left('launches/new'),
      },
      { removed: 1, old: false, kept: true, new: true },
      'cleanup: launch folders older than 7 days go; the running launch and recent ones stay',
    );
    t.equal(
      {
        oldLog: left('data/d/logs/guest-old.log'),
        newLog: left('data/d/logs/guest-new.log'),
        interrupted: left('data/d/tools/git.staging-ab12'),
        realTool: left('data/d/tools/node'),
      },
      { oldLog: false, newLog: true, interrupted: false, realTool: true },
      'cleanup: logs older than 14 days and interrupted downloads go; new logs and real tools stay',
    );
  },
};

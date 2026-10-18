// The managed install layout, the shims, the update decision and the updater (installs, failures, rollback), all in
// temp folders. The updater runs real packages: a tiny tarball per version whose sandbox.js prints its version, started
// through the shim with a real cmd.exe. Releases come from a folder feed, never from the network.
import fs from 'node:fs';
import path from 'node:path';
import { extractArchive } from '../shared/download/index.js';
import { InstallLayout, readBins, shimText, writeShims } from '../host/install/index.js';
import { FolderFeed, Updater, UpdateStateFile, decideUpdate, isTooSoon } from '../host/update/index.js';
import { NODE, SHA_WRONG, packTarball, publish, runShim } from './support/releases.js';
import type { Suite } from './support/suite.js';

export const updateSuite: Suite = {
  name: 'update',
  title: 'install layout, shims, update decision, updater with rollback',
  run: async (t) => {
    t.section('install layout');
    // A space in the path, as in Program Files.
    const root = t.dir('install root');
    const layout = InstallLayout.at(root, 'user');
    const detected = InstallLayout.detect(path.join(root, 'versions', '1.2.3', 'package'));
    t.check(
      detected?.root === root &&
        detected.scope === 'user' &&
        InstallLayout.detect(t.at('npm', 'lib', 'windows-development-sandbox')) === null &&
        InstallLayout.detect(t.at('versions', 'x.y', 'package')) === null,
      'a versions\\x.y.z\\package folder is a managed install; an npm global or odd folder names are not',
    );

    for (const v of ['1.10.0', '1.9.0', '1.0.0']) t.dir('sorted', 'versions', v);
    t.dir('sorted', 'versions', '1.11.0.staging');
    t.equal(
      InstallLayout.at(t.at('sorted'), 'user').installedVersions(),
      ['1.0.0', '1.9.0', '1.10.0'],
      'installed versions sort by number, staging ignored',
    );
    const badVersion = await t.thrownMessage(() => layout.versionDir('../evil'));
    const badNode = await t.thrownMessage(() => layout.nodeDir('22.3.0'));
    t.check(
      badVersion.includes('not a version number') && badNode.includes('not a Node version'),
      'version and Node folder names are checked',
      badVersion + ' / ' + badNode,
    );

    // The private Node: a hard link to this process's node.exe (a copy when the volumes differ).
    const nodeExe = layout.nodeExe(NODE);
    fs.mkdirSync(path.dirname(nodeExe), { recursive: true });
    try {
      fs.linkSync(process.execPath, nodeExe);
    } catch {
      fs.copyFileSync(process.execPath, nodeExe);
    }
    // The first install, made by hand (what the installer does): one version, the pointers, the shims.
    const feed = t.at('feed');
    await extractArchive(packTarball(t, '1.0.0', 'good'), layout.versionDir('1.0.0'));
    layout.setActive('1.0.0', NODE);
    writeShims(layout, { sandbox: 'dist/bin/sandbox.js' });
    const notInstalled = await t.thrownMessage(() => layout.setActive('9.9.9', NODE));
    t.check(
      layout.activeVersion() === '1.0.0' && layout.activeNode() === NODE && notInstalled.includes('is not installed'),
      'the active pointers are read back; setActive refuses a version not installed',
      notInstalled,
    );

    t.section('shims');
    const sh = shimText('sandbox', 'sh');
    t.check(
      shimText('sandbox', 'cmd') ===
        [
          '@echo off',
          'setlocal',
          'set /p V=<"%~dp0..\\active-version"',
          'set /p N=<"%~dp0..\\active-node"',
          '"%~dp0..\\node\\%N%\\node.exe" "%~dp0..\\versions\\%V%\\package\\dist\\bin\\sandbox.js" %*',
          '',
        ].join('\r\n') &&
        sh.startsWith('#!/bin/sh\n') &&
        !sh.includes('\r') &&
        sh.includes(
          'exec "$root/node/$node_version/node.exe" "$root/versions/$version/package/dist/bin/sandbox.js" "$@"',
        ),
      'the cmd shim has the exact text with CRLF; the sh shim is a POSIX script with LF that execs the active node and version',
    );
    const badShim = await t.thrownMessage(() => shimText('bad name;', 'cmd'));
    const badBin = await t.thrownMessage(() => readBins({ bin: { 'a b': 'x.js' } }));
    t.check(
      badShim.includes('not a command name') && badBin.includes('invalid name'),
      'a shim name must be a plain command name; a bad bin name in package.json is refused',
      badShim + ' / ' + badBin,
    );

    t.section('the update decision');
    const now = new Date('2026-10-14T12:00:00Z');
    const latest = (version: string) => ({ version, tarball: { url: 'file:///x.tgz', sha256: SHA_WRONG } });
    const base = { current: '1.0.0', now, sandboxRunning: false, minHoursBetweenChecks: 24 };
    const none = { lastCheck: undefined };
    const kinds = (over: object, version: string | null, state: object = none): unknown =>
      decideUpdate({ ...base, ...over, latest: version ? latest(version) : null, state });
    const recent = { lastCheck: new Date(now.getTime() - 3600_000).toISOString() };
    const failed = { failed: { version: '1.0.2', at: now.toISOString(), reason: 'x' } };
    const install = (v: string): unknown => ({ kind: 'install', release: latest(v) });
    const skip = (reason: string): unknown => ({ kind: 'skip', reason });
    t.equal(
      [
        kinds({}, '1.0.1'),
        kinds({}, null),
        kinds({}, '1.0.0'),
        kinds({}, '0.9.0'),
        kinds({ sandboxRunning: true }, '1.0.1'),
        kinds({}, '1.0.1', recent),
        kinds({ force: true }, '1.0.1', recent),
        kinds({}, '1.0.2', failed),
        kinds({}, '1.0.1', failed),
        kinds({}, '1.0.3', failed),
      ],
      [
        install('1.0.1'),
        skip('no-release'),
        skip('up-to-date'),
        skip('up-to-date'),
        install('1.0.1'),
        skip('too-soon'),
        install('1.0.1'),
        skip('failed-before'),
        skip('failed-before'),
        install('1.0.3'),
      ],
      'only a newer release installs, also while a sandbox runs; an hour after the last check is too soon unless forced; a failed version (and older) is not retried',
    );
    t.check(!isTooSoon({ lastCheck: 'not a date' }, now, 24), 'a damaged last-check time does not block updates');

    t.section('updater: install, failure, rollback');
    const clock = { at: new Date('2026-10-14T12:00:00Z') };
    const updater = new Updater(layout, new FolderFeed(feed), { now: () => clock.at, minHoursBetweenChecks: 0 });
    const firstRun = runShim(layout);

    publish(t, feed, '1.0.1', 'good');
    const first = await updater.run({ sandboxRunning: false });
    t.check(
      firstRun === '1.0.0' &&
        JSON.stringify(first) === JSON.stringify({ kind: 'installed', version: '1.0.1', previous: '1.0.0' }) &&
        layout.activeVersion() === '1.0.1' &&
        runShim(layout) === '1.0.1' &&
        new UpdateStateFile(root).read().previous === '1.0.0',
      'the shim runs the pointed version; a good release installs, becomes active, and the old one is kept for a rollback',
      JSON.stringify(first),
    );

    publish(t, feed, '1.0.2', 'broken');
    clock.at = new Date(clock.at.getTime() + 60 * 60 * 1000);
    const bad = await updater.run({ sandboxRunning: false });
    t.check(
      bad.kind === 'failed' &&
        bad.version === '1.0.2' &&
        bad.reason.includes('did not start') &&
        layout.activeVersion() === '1.0.1' &&
        runShim(layout) === '1.0.1' &&
        !fs.existsSync(layout.versionDir('1.0.2')) &&
        new UpdateStateFile(root).read().failed?.version === '1.0.2',
      'a version that does not start fails with the reason; the working version stays active, the failed one is deleted and recorded',
      JSON.stringify(bad),
    );

    const gated = new Updater(layout, new FolderFeed(feed), { now: () => clock.at, minHoursBetweenChecks: 24 });
    t.equal(
      [
        await gated.run({ sandboxRunning: false }),
        await gated.run({ sandboxRunning: false, force: true }),
        await updater.run({ sandboxRunning: true }),
      ],
      [
        { kind: 'skipped', reason: 'too-soon', current: '1.0.1' },
        { kind: 'skipped', reason: 'failed-before', current: '1.0.1' },
        { kind: 'skipped', reason: 'failed-before', current: '1.0.1' },
      ],
      'no second look within 24 hours, no retry of the failed version (a running sandbox is not a reason to skip)',
    );

    publish(t, feed, '1.0.3', 'good');
    const third = await updater.run({ sandboxRunning: false });
    t.check(
      JSON.stringify(third) === JSON.stringify({ kind: 'installed', version: '1.0.3', previous: '1.0.1' }) &&
        JSON.stringify(layout.installedVersions()) === JSON.stringify(['1.0.1', '1.0.3']),
      'a newer good release after a failure installs; only the active and the previous version are kept',
      JSON.stringify(third),
    );

    publish(t, feed, '1.0.4', 'good', undefined, 'some-other-package');
    const named = await updater.run({ sandboxRunning: false });
    publish(t, feed, '1.0.5', 'good', SHA_WRONG);
    const hash = await updater.run({ sandboxRunning: false });
    t.check(
      named.kind === 'failed' &&
        named.reason.includes('is not windows-development-sandbox') &&
        hash.kind === 'failed' &&
        hash.reason.includes('Checksum mismatch') &&
        layout.activeVersion() === '1.0.3' &&
        new UpdateStateFile(root).read().failed?.version === '1.0.5',
      'a release of another package is refused; a wrong sha256 is refused before extracting, changes nothing and is recorded',
      JSON.stringify([named, hash]),
    );

    const rolledBack =
      updater.rollback() === '1.0.1' &&
      layout.activeVersion() === '1.0.1' &&
      runShim(layout) === '1.0.1' &&
      new UpdateStateFile(root).read().previous === '1.0.3';
    publish(t, feed, '1.0.6', 'good');
    t.check(
      rolledBack && (await updater.run({ sandboxRunning: false })).kind === 'installed' && runShim(layout) === '1.0.6',
      'rollback moves the pointers back (a second one goes forward again); a newer release after a rollback installs',
    );

    t.section('updater: a failed download is retried, not blocked');
    const before = new UpdateStateFile(root).read().failed;
    publish(t, feed, '1.0.7', 'good');
    const tarball = path.join(feed, 'windows-development-sandbox-1.0.7.tgz');
    const copy = t.at('pack', 'kept-1.0.7.tgz');
    fs.copyFileSync(tarball, copy);
    fs.rmSync(tarball);
    const missing = await updater.run({ sandboxRunning: false });
    const downloadHeld =
      missing.kind === 'failed' &&
      missing.blocked === false &&
      JSON.stringify(new UpdateStateFile(root).read().failed) === JSON.stringify(before) &&
      new UpdateStateFile(root).read().lastResult?.ok === false &&
      layout.activeVersion() === '1.0.6';
    fs.copyFileSync(copy, tarball);
    // A failure on this PC (a read-only shim) must not block the version either.
    const shim = path.join(layout.binDir, 'sandbox.cmd');
    fs.chmodSync(shim, 0o444);
    const local = await updater.run({ sandboxRunning: false });
    fs.chmodSync(shim, 0o666);
    t.check(
      downloadHeld && local.kind === 'failed' && local.blocked === false && layout.activeVersion() === '1.0.6',
      'a failed download or a failure on this PC (a read-only shim) is reported but does not block the version',
      JSON.stringify([missing, local]),
    );
    const retried = await updater.run({ sandboxRunning: false });
    t.check(
      JSON.stringify(retried) === JSON.stringify({ kind: 'installed', version: '1.0.7', previous: '1.0.6' }) &&
        (await new FolderFeed(t.dir('empty-feed')).latest()) === null,
      'the next run retries the same version and installs it; a folder with no feed.json has no release',
      JSON.stringify(retried),
    );
  },
};

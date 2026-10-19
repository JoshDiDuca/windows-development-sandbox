// Names, paths and text coming from a hostile sandbox or workspace: file names, deletes, printed text, mappings, state
// files and the launch path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertCmdSafePath } from '../host/sandbox/index.js';
import { assertSafeMapping } from '../core/safe-paths.js';
import { safeText } from '../core/util/index.js';
import { isSafeFileName } from '../shared/paths/index.js';
import { removeRefusal, safeRemove } from '../shared/io/index.js';
import { writeJsonAtomic } from '../shared/io/index.js';
import type { Suite } from './support/suite.js';

export const hostileInputSuite: Suite = {
  name: 'hostile-input',
  title: 'file names, deletes, printed text, mappings and state files from an untrusted sandbox',
  run: async (t, f) => {
    t.section('file names');
    const unsafe = ['CON.jsonl', 'nul', 'aux.json', 'COM1.txt', 'a:b', 'x.jsonl.', 'x ', '..', 'a\\b', 'LPT3'];
    t.equal(
      unsafe.filter(isSafeFileName),
      [],
      'device names, streams and trailing dots are not valid names to copy into this PC',
    );
    const fine = ['C--Workspace-app', 'a.jsonl', '.credentials.json', 'console.jsonl'];
    t.equal(
      fine.filter((name) => !isSafeFileName(name)),
      [],
      'ordinary names (even ones that merely contain a device name) are valid',
    );

    t.section('deletes');
    const profile = os.homedir();
    const root = t.at('safe-root');
    const targets: Record<string, string> = {
      'your profile': profile,
      'a folder above your profile': path.dirname(profile),
      'a drive root': 'C:\\',
      Windows: 'C:\\Windows',
      'an empty path': '',
      'a relative path': 'relative\\folder',
      'a path outside the root': t.at('outside-root', 'x'),
    };
    for (const [what, target] of Object.entries(targets))
      t.check(removeRefusal(target, root) !== null, 'a delete is refused for ' + what);
    t.check(
      removeRefusal('\\\\?\\C:\\Users\\someone\\x', '\\\\?\\C:\\Users\\someone') !== null,
      'a delete is refused for \\\\?\\ paths',
    );
    t.check(removeRefusal('C:\\Windows\\Temp\\x', 'C:\\Windows\\Temp') !== null, 'a delete is refused inside Windows');
    t.check(
      removeRefusal('C:\\Program Files\\x\\y', 'C:\\Program Files\\x') !== null,
      'a delete is refused inside Program Files',
    );
    t.check(
      removeRefusal('C:\\Program Files\\App\\versions\\1.0.0', 'C:\\Program Files\\App\\versions') === null &&
        removeRefusal('C:\\Program Files\\App\\versions', 'C:\\Program Files\\App') !== null,
      "an all-users install may delete inside its own folders, never a whole program's",
    );
    const allowedTarget = path.join(root, 'tools', 'go');
    t.write(path.join(allowedTarget, 'go.exe'), 'x');
    safeRemove(allowedTarget, root);
    t.check(!fs.existsSync(allowedTarget), 'a folder inside its root is deleted');

    t.section('text, mappings, state files, launch path');
    t.equal(
      safeText('ok \x1b[31mred\x1b[0m \x1b]52;c;ZXZpbA==\x07\x1b]0;title\x07\x1b[2J\x07end'),
      'ok \x1b[31mred\x1b[0m end',
      'sandbox text printed on this PC keeps colours but loses every other escape sequence',
    );
    await t.throws(
      () => assertSafeMapping(path.join(t.packageRoot, 'dist'), t.packageRoot, t.at('storage')),
      'overlaps',
      'extra mappings may not reach the install folder',
    );
    await t.throws(
      () => assertSafeMapping(t.at('storage', 'data'), t.packageRoot, t.at('storage')),
      'overlaps',
      'extra mappings may not reach the storage folder',
    );
    const atomicFile = t.at('atomic', 'state.json');
    writeJsonAtomic(atomicFile, { a: 1 });
    writeJsonAtomic(atomicFile, { a: 2 });
    t.equal(t.readJson(atomicFile).a, 2, 'state files are replaced whole...');
    t.equal(fs.readdirSync(path.dirname(atomicFile)).length, 1, '... with no temp files left behind');
    await t.throws(
      () => assertCmdSafePath('C:\\a\\%TEMP%\\agent.wsb'),
      'cannot be started safely',
      'a launch path with %VAR% (which cmd.exe would expand) is refused',
    );
    await t.throws(
      () => assertCmdSafePath('C:\\a"&calc&"\\agent.wsb'),
      'cannot be started safely',
      'a launch path with quotes and & is refused',
    );

    t.section('repo files read on this PC (security review 2026-10)');
    const repoDir = t.dir('hostile-versions');
    fs.writeFileSync(path.join(repoDir, '.nvmrc'), '\u001b]52;c;ZXZpbA==\u0007\u001b[2J20\n');
    fs.writeFileSync(path.join(repoDir, '.python-version'), '3.12.1\n');
    const versionsRun = await f.run({ cwd: repoDir });
    t.check(
      !versionsRun.versions.node.spec.includes('\u001b') &&
        versionsRun.versions.node.source !== '.nvmrc' &&
        versionsRun.versions.python.spec === '3.12.1',
      'a version file holding escape codes is ignored (it would reach the launch table); a plain one is used',
      JSON.stringify(versionsRun.versions),
    );
    fs.writeFileSync(path.join(repoDir, '.sandbox-config.json'), '{"readOnly": true}' + ' '.repeat(1100 * 1024));
    await t.throws(
      () => f.run({ cwd: repoDir, trustConfig: true }),
      'over 1 MB',
      'a .sandbox-config.json over 1 MB is refused before it is parsed',
    );
    fs.rmSync(path.join(repoDir, '.sandbox-config.json'));
  },
};

// Loading the settings: built-in defaults, a user config file, and the example config that ships with the tool.
import path from 'node:path';
import _ from 'lodash';
import fs from 'node:fs';
import { DEFAULTS, loadConfig } from '../core/config/index.js';
import { diffText, exportSettings, planImport } from '../app/features/settings/settings-share.js';
import { readJsonc } from '../core/util/index.js';
import type { Suite } from './support/suite.js';

export const configSuite: Suite = {
  name: 'config',
  title: 'built-in defaults, user config file, config.example.json',
  run: async (t, f) => {
    t.section('built-in defaults');
    const builtIn = loadConfig();
    t.equal(
      {
        configPath: builtIn.configPath,
        guestWorkspace: builtIn.config.guestWorkspace,
        headless: builtIn.config.sandbox.headless,
        vGpu: builtIn.config.sandbox.vGpu,
        gitAccess: builtIn.config.provisioning.git.access,
      },
      { configPath: null, guestWorkspace: 'auto', headless: false, vGpu: false, gitAccess: 'full' },
      'with no user config the built-in defaults apply (auto guest folder, headless off, vGPU off, git full)',
    );

    t.section('a user config file');
    const customFile = t.writeJson(t.at('cfg.json'), {
      sandbox: { headless: true },
      toolchains: { rust: { enabled: false } },
      mappings: [{ host: 'rel-folder', guest: 'C:\\Rel', readOnly: true }],
    });
    const custom = loadConfig(customFile);
    t.equal(
      {
        headless: custom.config.sandbox.headless,
        rust: custom.config.toolchains.rust.enabled,
        python: custom.config.toolchains.python.enabled,
      },
      { headless: true, rust: false, python: 'auto' },
      'a config file only needs the keys it changes (deep merge over the defaults)',
    );
    await t.throws(
      () => loadConfig(t.at('missing.json')),
      'Config file not found',
      'an explicit --config that does not exist is an error',
    );

    t.dir('rel-folder');
    const relativeRun = await f.run({}, { ...custom.config, storage: f.baseConfig.storage });
    const mappedHosts = relativeRun.config.mappings.map((m) => m.host);
    t.check(
      mappedHosts.includes(t.at('rel-folder')),
      "relative mappings in the user config resolve against the config file's folder",
      'mapped hosts: ' + JSON.stringify(mappedHosts),
    );

    t.section('export and import of settings');
    const SECRET = 'sk-test-0123456789';
    const mine = loadConfig(
      t.writeJson(t.at('share', 'mine.json'), {
        storage: { root: t.dir('share', 'storage') },
        sandbox: { memoryMb: 4096, headless: true },
        toolchains: { rust: { enabled: false } },
        mappings: [{ host: 'C:\\Somebody\\Folder', guest: 'C:\\Folder', readOnly: false }],
        harnesses: {
          planted: { npmPackage: 'planted', npmBin: 'planted', arguments: [], environment: { PLANTED_KEY: SECRET } },
        },
      }),
    ).config;
    const exported = exportSettings(mine, false);
    const flat = JSON.stringify(exported.data);
    t.check(
      !flat.includes(SECRET) && !flat.includes('storage') && !flat.includes('Somebody'),
      'an export has no secret, no storage folder and no folder of this PC',
      flat,
    );
    t.equal(
      [exported.data.sandbox, exported.data.toolchains, exported.data.defaultHarness],
      [{ memoryMb: 4096, headless: true }, { rust: { enabled: false } }, undefined],
      'an export keeps only what differs from the defaults',
    );
    t.equal(
      exported.skipped.map((x) => x.why).sort(),
      ['machine', 'path', 'secret'],
      'an export says what it left out (the data folder, a folder of this PC, a secret)',
    );
    t.check(
      JSON.stringify(exportSettings(mine, true).data).includes('Somebody'),
      '--with-paths keeps folders of this PC (secrets and the data folder stay out)',
    );

    const shared = JSON.stringify({
      $schema: './config.schema.json',
      sandbox: { memoryMb: 2048, headless: false },
      storage: { root: 'D:\\elsewhere' },
      mappings: [{ host: 'D:\\theirs', guest: 'C:\\T', readOnly: false }],
      harnesses: { planted: { environment: { PLANTED_KEY: 'theirs' } } },
      toolchains: { rust: { enabled: false } },
    });
    const plan = planImport(shared, mine);
    t.equal(
      diffText(plan.lines),
      ['sandbox.memoryMb: 4096 -> 2048', 'sandbox.headless: true -> false'],
      'an import shows old -> new for each changed setting and nothing for the unchanged ones',
    );
    t.equal(
      plan.skipped.map((x) => x.why).sort(),
      ['machine', 'path', 'secret'],
      'an import skips secrets, the data folder and paths even when the file has them',
    );
    t.check(
      planImport('{"sandbox": {"noSuchThing": 1}}', mine).problems.length > 0 &&
        planImport('[1]', mine).problems.length > 0 &&
        planImport('{', mine).problems.length > 0,
      'an import refuses a file that is not valid settings',
    );

    const home = t.dir('share', 'home');
    const baseEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !['AGENT_SANDBOX_CONFIG', 'AGENT_WORKSPACE'].includes(k)),
    );
    const env = { ...baseEnv, AGENT_SANDBOX_HOME: home, NO_COLOR: '1', AGENT_SANDBOX_HOST_ONLY: '1' };
    const yours = t.writeJson(t.at('share', 'yours.json'), {
      storage: { root: t.dir('share', 'storage2') },
      sandbox: { memoryMb: 4096 },
    });
    const sharedFile = t.at('share', 'theirs.json');
    fs.writeFileSync(sharedFile, shared);
    const bin = (args: string[]): Promise<{ status: number | null; out: string }> =>
      f.runBin('agent-sandbox', [...args, '--config', yours], { cwd: f.workA, env });
    const outFile = t.at('share', 'out.json');
    const exportRun = await bin(['config', 'export', outFile]);
    const written = readJsonc<{ sandbox?: { memoryMb?: number }; storage?: unknown }>(outFile);
    t.check(
      exportRun.status === 0 && written.sandbox?.memoryMb === 4096 && written.storage === undefined,
      'sandbox config export writes the file without the data folder',
      exportRun.out,
    );
    const again = await bin(['config', 'export', outFile]);
    t.check(again.status !== 0, 'export does not overwrite a file that is there', again.out);
    const before = fs.readFileSync(yours, 'utf8');
    const refused = await bin(['config', 'import', sharedFile]);
    t.check(
      refused.status !== 0 && fs.readFileSync(yours, 'utf8') === before,
      'import without --yes and without a terminal changes nothing',
      refused.out,
    );
    const imported = await bin(['config', 'import', sharedFile, '--yes']);
    const after = readJsonc<{ sandbox?: { memoryMb?: number }; storage?: { root?: string }; mappings?: unknown }>(
      yours,
    );
    t.check(
      imported.status === 0 &&
        imported.out.includes('sandbox.memoryMb: 4096 -> 2048') &&
        after.sandbox?.memoryMb === 2048 &&
        after.storage?.root !== 'D:\\elsewhere' &&
        after.mappings === undefined,
      'sandbox config import --yes applies the settings and never the data folder or paths',
      imported.out,
    );

    t.section('config.example.json');
    const examplePath = path.join(t.packageRoot, 'config.example.json');
    t.equal(loadConfig(examplePath).config.defaultHarness, 'claude', 'config.example.json is valid');
    const example = _.omit(readJsonc<object>(examplePath), '$schema');
    t.check(
      _.isEqual(example, DEFAULTS),
      'config.example.json lists exactly the built-in defaults',
      'the differences are in: ' +
        Object.keys(DEFAULTS)
          .filter(
            (key) =>
              !_.isEqual(
                (example as Record<string, unknown>)[key],
                (DEFAULTS as unknown as Record<string, unknown>)[key],
              ),
          )
          .join(', '),
    );
  },
};

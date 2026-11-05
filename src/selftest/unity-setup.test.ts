// Unity set-up on the data disk: an editor is installed into tools\unity\editors\<version> through ensurePersisted (a
// fake installer in a temp folder stands in for the Unity CLI), kept, pruned; sbx-unity is gone. Nothing is downloaded.
import fs from 'node:fs';
import path from 'node:path';
import { ensurePersisted, type InstallSpec, type PersistedDeps } from '../guest/toolchains/persisted.js';
import type { Suite } from './support/suite.js';

const GB = 1024 ** 3;

export const unitySetupSuite: Suite = {
  name: 'unity-setup',
  title: 'Unity set-up on the data disk: editors kept between sandboxes, no sbx-unity helper',
  run: async (t) => {
    t.section('an editor on the data disk');
    const tools = t.dir('unity-tools');
    const deps: PersistedDeps = { toolsDir: tools, statfs: () => ({ bavail: 100 * GB, bsize: 1 }) };
    const spec = (version: string): InstallSpec => ({
      name: 'unity/editors',
      version,
      needBytes: 10 * GB,
      marker: 'Editor\\Unity.exe',
      what: 'Unity ' + version,
      keepVersions: 2,
    });
    const fake = (version: string) => async (staging: string, temp: string) => {
      fs.writeFileSync(path.join(temp, 'download.part'), 'x');
      fs.mkdirSync(path.join(staging, 'Editor'), { recursive: true });
      fs.writeFileSync(path.join(staging, 'Editor', 'Unity.exe'), 'unity ' + version);
    };
    const first = await ensurePersisted(spec('6000.0.58f2'), fake('6000.0.58f2'), deps);
    t.check(
      first.fresh && first.dir === path.join(tools, 'unity', 'editors', '6000.0.58f2'),
      'the editor goes to tools\\unity\\editors\\<version>',
    );
    let ran = false;
    const second = await ensurePersisted(
      spec('6000.0.58f2'),
      async () => {
        ran = true;
      },
      deps,
    );
    t.check(!second.fresh && !ran, 'a second call finds it and installs nothing');

    await t.throws(
      () =>
        ensurePersisted(
          spec('6000.0.60f1'),
          async () => {
            throw new Error('the CLI failed');
          },
          deps,
        ),
      'the CLI failed',
      'a failed install is reported',
    );
    const editors = path.join(tools, 'unity', 'editors');
    t.equal(
      fs.readdirSync(editors).filter((n) => n.startsWith('.staging-')).length,
      0,
      'a failed install leaves no .staging-* folder',
    );

    await ensurePersisted(spec('6000.0.59f1'), fake('6000.0.59f1'), deps);
    await ensurePersisted(spec('6000.1.0f1'), fake('6000.1.0f1'), deps);
    const kept = fs.readdirSync(editors).sort();
    t.check(
      kept.length === 2 && kept.includes('6000.1.0f1') && !kept.includes('6000.0.58f2'),
      'keepVersions 2 removes the least recently used editor',
    );

    t.section('no sbx-unity helper');
    t.check(
      !fs.existsSync(path.join(t.packageRoot, 'src', 'guest', 'devtools', 'unity.ts')),
      'devtools/unity.ts is gone',
    );
    const toolJs = path.join(t.packageRoot, 'dist', 'runtime', 'tool.js');
    t.check(
      !fs.existsSync(toolJs) ||
        !fs.readFileSync(toolJs, 'utf8').includes('build with -executeMethod, the licence status'),
      'runtime/tool.js has no sbx-unity helper (the setting texts may still name the MCP server)',
    );
  },
};

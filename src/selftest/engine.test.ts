// The engine layer and storage providers (phase 1): the Windows Sandbox engine writes exactly the .wsb and launch
// folder the code before the layer did, the settings for later engines are refused clearly, and a project cannot set
// them.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../core/config/index.js';
import { LocalOverridesSchema } from '../core/schema/index.js';
import type { Config, ResolvedMapping } from '../core/types.js';
import { xmlEscape } from '../core/util/index.js';
import {
  engineFor,
  engineReports,
  WindowsSandboxEngine,
  type EngineCapabilities,
  type LaunchPlan,
} from '../host/engines/index.js';
import { buildLaunchPlan, buildWsb } from '../host/launch/index.js';
import { folderAttachment, FolderStorageProvider, providerFor } from '../host/storage/index.js';
import { sandboxFolder } from '../shared/paths/index.js';
import { NO_HCS_PC } from './support/hcs-probes.js';
import { ENGINE_CASES } from './support/engine-cases.js';
import { ENGINE_GOLDEN, LAUNCH_FILES_GOLDEN } from './support/engine-golden.js';
import type { Suite } from './support/suite.js';

/** The .wsb writer as it was before the engine layer (frozen copy), to compare real launches with. */
function legacyWsb(config: Config, memoryMb: number, mappings: readonly ResolvedMapping[]): string {
  const s = config.sandbox;
  const element = (name: string, value: string): string => '<' + name + '>' + value + '</' + name + '>';
  const toggle = (value: boolean): string => (value ? 'Enable' : 'Disable');
  const devices = [
    ['vGPU', s.vGpu],
    ['Networking', s.networking],
    ['ClipboardRedirection', s.clipboard],
    ['AudioInput', s.audioInput],
    ['VideoInput', s.videoInput],
    ['PrinterRedirection', s.printerRedirection],
    ['ProtectedClient', s.protectedClient],
  ] as const;
  const folders = mappings
    .map((m) =>
      element(
        'MappedFolder',
        element('HostFolder', xmlEscape(m.host)) +
          element('SandboxFolder', xmlEscape(sandboxFolder(m.guest))) +
          element('ReadOnly', String(m.readOnly)),
      ),
    )
    .join('');
  return element(
    'Configuration',
    element('MemoryInMB', String(memoryMb)) +
      devices.map(([name, value]) => element(name, toggle(value))).join('') +
      element('MappedFolders', folders) +
      element('LogonCommand', element('Command', xmlEscape('C:\\AgentLaunch\\sandbox\\boot\\logon.cmd'))),
  );
}

function filesUnder(dir: string, rel = ''): string[] {
  return fs
    .readdirSync(path.join(dir, rel), { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? filesUnder(dir, rel ? rel + '/' + e.name : e.name) : [rel ? rel + '/' + e.name : e.name],
    )
    .sort();
}

export const engineSuite: Suite = {
  name: 'engine',
  title: 'engine layer, Windows Sandbox engine, storage providers, new settings',
  run: async (t, f) => {
    t.section('the .wsb through the engine is what it always was');
    for (const c of ENGINE_CASES) {
      const plan: LaunchPlan = buildLaunchPlan({
        config: c.config,
        memoryMb: c.memoryMb,
        mappings: c.mappings,
        launchPath: 'C:\\L\\launches\\1',
        storage: [],
      });
      const viaEngine = new WindowsSandboxEngine(c.config.sandbox, () => false).plan(plan).files[0].text;
      t.check(
        viaEngine === ENGINE_GOLDEN[c.name] &&
          buildWsb(c.config, c.memoryMb, [...c.mappings]) === ENGINE_GOLDEN[c.name],
        'byte-identical .wsb: ' + c.name,
        'expected: ' + ENGINE_GOLDEN[c.name] + '\nactual:   ' + viaEngine,
      );
      t.equal(viaEngine, legacyWsb(c.config, c.memoryMb, c.mappings), 'same as the frozen old writer: ' + c.name);
    }

    t.section('a real launch');
    const gen = await f.launch({}, { args: ['--version'], probe: { ...f.probe, gitDir: f.shared, nvmDir: f.workB } });
    t.equal(
      fs.readFileSync(gen.wsbPath, 'utf8'),
      legacyWsb(f.baseConfig, gen.memoryMb, gen.mappings),
      'the launch writes the .wsb the old writer would have (same settings, memory and mappings)',
    );
    t.equal(path.basename(gen.wsbPath), 'agent.wsb', 'the engine file is still agent.wsb in the launch folder');
    t.equal(gen.enginePlan.entry, gen.wsbPath, 'the engine plan starts from that file');
    // home/.gitconfig is written only when this machine's ~/.gitconfig has a name or email (a GitHub runner has none).
    const sameOnEveryMachine = (f: string): boolean => f !== 'home/.gitconfig';
    t.equal(
      filesUnder(gen.launchPath).filter(sameOnEveryMachine),
      LAUNCH_FILES_GOLDEN.filter(sameOnEveryMachine),
      'the launch folder has exactly the files it had before',
    );
    t.equal(
      gen.mappings.find((m) => m.guest === 'C:\\AgentData')?.host,
      f.baseConfig.storage.root + '\\data\\testdata',
      'the data folder is still mapped at C:\\AgentData (through the folder provider)',
    );

    t.section('capabilities');
    const caps = (over: Partial<Config['sandbox']>, cli: boolean): EngineCapabilities =>
      new WindowsSandboxEngine({ ...DEFAULTS.sandbox, ...over }, () => cli).capabilities();
    t.equal(
      caps({}, false),
      {
        desktop: true,
        gpu: false,
        clipboard: true,
        audio: false,
        video: false,
        printers: false,
        liveFolderAdd: false,
        attachedDisks: false,
        multipleInstances: false,
        hvsocket: false,
      },
      'Windows Sandbox: desktop and clipboard by default, no live folders without the wsb CLI, no disks, one at a time',
    );
    t.equal(
      [caps({ vGpu: true, audioInput: true, videoInput: true, printerRedirection: true, clipboard: false }, true)].map(
        (c) => [c.gpu, c.audio, c.video, c.printers, c.clipboard, c.liveFolderAdd],
      ),
      [[true, true, true, true, false, true]],
      'capabilities follow the device settings and the wsb CLI',
    );
    const reports = await engineReports(f.baseConfig, NO_HCS_PC);
    t.check(
      reports.length === 2 &&
        reports[0].inUse &&
        !reports[1].inUse &&
        !reports[1].check.available &&
        reports[1].check.reasons[0].includes('computecore.dll'),
      'sandbox engine lists both engines; the HCS check says what this PC lacks',
    );

    t.section('settings that cannot work yet are refused');
    const hcs: Config = { ...structuredClone(f.baseConfig), sandbox: { ...f.baseConfig.sandbox, engine: 'hcs' } };
    const vhdx: Config = {
      ...structuredClone(f.baseConfig),
      storage: { ...f.baseConfig.storage, contained: 'vhdx' },
    };
    t.equal(
      [DEFAULTS.sandbox.engine, DEFAULTS.storage.contained, DEFAULTS.storage.containedMaxGb],
      ['windows-sandbox', 'off', 64],
      'defaults: Windows Sandbox, loose folders, 64 GB',
    );
    await t.throws(
      () => engineFor(hcs),
      'The HCS engine has to be opened first',
      'engine hcs is not handed out without its check',
    );
    await t.throws(
      () =>
        providerFor(vhdx, {
          availability: () => ({ available: false, reasons: ['No disks here.'], fixes: ['Use a PC.'] }),
        }),
      'Contained storage cannot be used: No disks here.',
      'contained vhdx is refused where this PC cannot use it',
    );
    const launches = path.join(f.baseConfig.storage.root, 'launches');
    const before = fs.readdirSync(launches).length;
    await t.throws(() => f.launch({}, { config: hcs }), 'HCS engine has to be opened first', 'a launch with hcs stops');
    await t.throws(
      () => f.launch({}, { config: vhdx }),
      'Contained storage was not prepared for this launch',
      'a launch with vhdx that was not mounted first stops',
    );
    t.equal(fs.readdirSync(launches).length, before, 'a refused launch writes no launch folder');

    t.section('storage provider: folder');
    const set = { dataPath: 'C:\\S\\data\\x', guest: 'C:\\AgentData' };
    const prepared = await new FolderStorageProvider().prepare(set);
    t.equal(
      [prepared.attachments, prepared.mappings, (await new FolderStorageProvider().check()).available],
      [[folderAttachment(set)], [{ host: set.dataPath, guest: set.guest, readOnly: false }], true],
      'the folder provider shares the data folder read/write, as before',
    );

    t.section('a project cannot choose the engine or the storage kind');
    t.check(
      !LocalOverridesSchema.safeParse({ sandbox: { engine: 'hcs' } }).success &&
        !LocalOverridesSchema.safeParse({ storage: { contained: 'vhdx' } }).success &&
        !LocalOverridesSchema.safeParse({ storage: { containedMaxGb: 8 } }).success,
      "a project's .sandbox-config.json cannot set sandbox.engine, storage.contained or storage.containedMaxGb",
    );
    t.check(
      LocalOverridesSchema.safeParse({ sandbox: { vGpu: false } }).success,
      'other sandbox settings are still allowed in a project file',
    );

    t.section('sandbox engine');
    const run = await f.runBin(
      'agent-sandbox',
      ['engine', '--json', '--config', t.writeJson(t.at('engine-config.json'), {})],
      {
        cwd: f.workA,
        env: { ...process.env, NO_COLOR: '1', AGENT_SANDBOX_HOME: t.dir('engine-home'), AGENT_SANDBOX_HOST_ONLY: '1' },
      },
    );
    const parsed = JSON.parse(run.out.slice(run.out.indexOf('{'))) as { engine: string; engines: { id: string }[] };
    t.check(
      run.status === 0 &&
        parsed.engine === 'windows-sandbox' &&
        parsed.engines.map((e) => e.id).join() === 'windows-sandbox,hcs',
      'sandbox engine --json names the engine in use and both engines',
      run.out,
    );
  },
};

// The HCS engine (alpha, start disabled). Nothing here can run HCS (no Hyper-V in the test machines): documents are
// compared as text, the check runs against pretend PCs, the helper against a fake process runner, and HcsHost only
// has to compile and answer once. Temp folders only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../app/context.js';
import { cleanEngineRun, engineLeftoversRun } from '../app/features/engine/index.js';
import { fakeIO } from '../app/kernel/index.js';
import { DEFAULTS } from '../core/config/index.js';
import type { Config } from '../core/types.js';
import { isWin } from '../core/util/index.js';
import { HCS_CHECKS, HCS_PROBES } from '../cli/commands/repair/checks/hcs.js';
import type { RepairEnv } from '../cli/commands/repair/types.js';
import {
  checkHcs,
  engineFor,
  HCS_CAPABILITIES,
  HcsEngine,
  LEFTOVER_DEPS,
  lookForLeftovers,
  openEngine,
  stopLeftovers,
  type EnginePlan,
  type LaunchPlan,
} from '../host/engines/index.js';
import { parseWhoamiGroups } from '../host/engines/hcs/check.js';
import { buildDocuments, cpuCount, layerGuid } from '../host/engines/hcs/documents.js';
import {
  HcsHelper,
  HcsReplySchema,
  buildHcsHostTo,
  userSystemPrefix,
  type HelperRunner,
} from '../host/engines/hcs/helper.js';
import { chainIds, DockerImageStore, FolderImageStore, type ImageFiles } from '../host/engines/hcs/images.js';
import { SYSTEM } from '../shared/system.js';
import { fakeProbes, FAKE_IMAGE } from './support/hcs-probes.js';
import type { Suite } from './support/suite.js';

const LAUNCH: LaunchPlan = {
  launchPath: 'C:\\L\\launches\\1',
  memoryMb: 4096,
  cpuLimit: 50,
  networking: true,
  devices: {
    gpu: false,
    clipboard: true,
    audioInput: false,
    videoInput: false,
    printers: false,
    protectedClient: true,
  },
  mappings: [
    { host: 'C:\\L\\launches\\1', guest: 'C:\\AgentLaunch', readOnly: true },
    { host: 'C:\\S\\run', guest: 'C:\\AgentData\\run', readOnly: false },
    { host: 'C:\\Work\\app', guest: 'C:\\Workspace\\app', readOnly: true },
  ],
  logonCommand: 'C:\\AgentLaunch\\sandbox\\boot\\logon.cmd',
  storage: [{ kind: 'disk', image: 'C:\\S\\images\\set.vhdx', guest: 'C:\\AgentData', maxGb: 64 }],
};

const SCHEMA = { Major: 2, Minor: 1 };

interface SchemaNode {
  $ref?: string;
  allOf?: SchemaNode[];
  enum?: unknown[];
  type?: string;
  properties?: Record<string, SchemaNode>;
  additionalProperties?: SchemaNode | boolean;
  items?: SchemaNode;
}

/** Where `document` (a ComputeSystem) differs from Microsoft's Swagger schema: unknown properties, values, types. */
function schemaProblems(schemaFile: string, document: unknown, label: string): string[] {
  const defs = (JSON.parse(fs.readFileSync(schemaFile, 'utf8')) as { definitions: Record<string, SchemaNode> })
    .definitions;
  // ComputeSystem.HostedSystem is typed as a plain object; its shape is the separate HostedSystem definition.
  if (defs.HostedSystem && defs.ComputeSystem.properties)
    defs.ComputeSystem.properties.HostedSystem = { $ref: '#/definitions/HostedSystem' };
  const problems: string[] = [];
  const walk = (value: unknown, schema: SchemaNode | undefined, where: string): void => {
    if (!schema) return;
    if (schema.$ref) {
      const name = schema.$ref.replace('#/definitions/', '');
      if (!defs[name]) problems.push(where + ': missing definition ' + name);
      else walk(value, defs[name], where);
      return;
    }
    schema.allOf?.forEach((s) => walk(value, s, where));
    if (schema.enum && !schema.enum.includes(value)) problems.push(where + ': "' + String(value) + '" is not allowed');
    if (schema.type === 'object' || schema.properties || schema.additionalProperties) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        problems.push(where + ': not an object');
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        const prop = schema.properties?.[key];
        if (prop) walk(child, prop, where + '.' + key);
        else if (typeof schema.additionalProperties === 'object')
          walk(child, schema.additionalProperties, where + '[' + key + ']');
        else problems.push(where + ': unknown property "' + key + '"');
      }
      return;
    }
    if (schema.type === 'array') {
      if (Array.isArray(value)) value.forEach((item, i) => walk(item, schema.items, where + '[' + i + ']'));
      else problems.push(where + ': not an array');
      return;
    }
    const kind = typeof value;
    if (schema.type === 'string' && kind !== 'string') problems.push(where + ': not text');
    if ((schema.type === 'integer' || schema.type === 'number') && kind !== 'number')
      problems.push(where + ': not a number');
    if (schema.type === 'boolean' && kind !== 'boolean') problems.push(where + ': not true/false');
  };
  walk(document, { $ref: '#/definitions/ComputeSystem' }, label);
  return problems;
}
const hvConfig = {
  DefaultBindSecurityDescriptor: 'D:P(A;;FA;;;SY)(A;;FA;;;BA)',
  DefaultConnectSecurityDescriptor: 'D:P(A;;FA;;;SY)(A;;FA;;;BA)',
  ServiceTable: {},
};

/** Docker's image store as files in memory. */
function dockerDisk(diffIds: readonly string[], extra: Record<string, string> = {}): ImageFiles {
  const root = 'C:\\ProgramData\\docker';
  const meta = root + '\\image\\windowsfilter';
  const id = 'sha256:' + 'b'.repeat(64);
  const files: Record<string, string> = {
    [meta + '\\repositories.json']: JSON.stringify({
      Repositories: { 'mcr.microsoft.com/windows/servercore': { 'mcr.microsoft.com/windows/servercore:ltsc2022': id } },
    }),
    [meta + '\\imagedb\\content\\sha256\\' + 'b'.repeat(64)]: JSON.stringify({
      rootfs: { type: 'layers', diff_ids: diffIds },
    }),
    ...extra,
  };
  chainIds(diffIds).forEach((chain, i) => {
    files[meta + '\\layerdb\\sha256\\' + chain.slice(7) + '\\cache-id'] = 'cache' + i + '\n';
  });
  const dirs = new Set<string>(diffIds.map((_, i) => root + '\\windowsfilter\\cache' + i));
  dirs.add(root + '\\windowsfilter\\cache0\\UtilityVM\\Files');
  return { readText: (f) => files[f] ?? null, isDir: (d) => dirs.has(d) };
}

export const hcsSuite: Suite = {
  name: 'hcs',
  title: 'HCS engine (alpha, start disabled): documents, check, image store, helper, HcsHost',
  run: async (t, f) => {
    const hcsConfig: Config = { ...structuredClone(f.baseConfig), sandbox: { ...f.baseConfig.sandbox, engine: 'hcs' } };

    t.section('documents: a Hyper-V isolated container, no network, code read-only');
    const docs = buildDocuments({
      launch: LAUNCH,
      image: FAKE_IMAGE,
      id: 'agent-sandbox-1',
      scratchVhdx: 'C:\\L\\launches\\1\\hcs\\scratch.vhdx',
      hostCpus: 8,
    });
    const os = { ReadOnly: true, ShareRead: true, CacheIo: true, TakeBackupPrivilege: true, PseudoOplocks: true };
    t.equal(
      docs.uvm,
      {
        Owner: 'agent-sandbox',
        SchemaVersion: SCHEMA,
        ShouldTerminateOnLastHandleClosed: false,
        VirtualMachine: {
          StopOnReset: true,
          Chipset: {
            Uefi: { BootThis: { DeviceType: 'VmbFs', DevicePath: '\\EFI\\Microsoft\\Boot\\bootmgfw.efi' } },
          },
          ComputeTopology: { Memory: { SizeInMB: 4096, AllowOvercommit: true }, Processor: { Count: 4 } },
          Devices: {
            Scsi: {
              '0': {
                Attachments: {
                  '0': {
                    Type: 'VirtualDisk',
                    Path: 'C:\\S\\images\\set.vhdx',
                    ReadOnly: false,
                    CachingMode: 'Uncached',
                  },
                  '1': {
                    Type: 'VirtualDisk',
                    Path: 'C:\\L\\launches\\1\\hcs\\scratch.vhdx',
                    ReadOnly: false,
                    CachingMode: 'Uncached',
                  },
                },
              },
            },
            VirtualSmb: {
              Shares: [
                { Name: 'os', Path: 'C:\\img\\base\\UtilityVM\\Files', Options: os },
                {
                  Name: 'layer0',
                  Path: 'C:\\img\\l2',
                  Options: { ReadOnly: true, ShareRead: true, NoDirectmap: true },
                },
                {
                  Name: 'layer1',
                  Path: 'C:\\img\\base',
                  Options: { ReadOnly: true, ShareRead: true, NoDirectmap: true },
                },
                { Name: 'dir0', Path: 'C:\\L\\launches\\1', Options: { ReadOnly: true, NoDirectmap: true } },
                { Name: 'dir1', Path: 'C:\\S\\run', Options: { ReadOnly: false, NoDirectmap: true } },
                { Name: 'dir2', Path: 'C:\\Work\\app', Options: { ReadOnly: true, NoDirectmap: true } },
              ],
            },
            HvSocket: { HvSocketConfig: hvConfig },
          },
          GuestConnection: {},
        },
      },
      'the utility VM: memory, 4 of 8 processors, the agent disk and scratch on SCSI, vSMB shares, no network adapter',
    );
    const map = (hostPath: string, hostPathType: string, containerPath: string, readOnly: boolean): object => ({
      HostPath: hostPath,
      HostPathType: hostPathType,
      ContainerPath: containerPath,
      ReadOnly: readOnly,
    });
    t.equal(
      docs.container,
      {
        Owner: 'agent-sandbox',
        SchemaVersion: SCHEMA,
        ShouldTerminateOnLastHandleClosed: false,
        HostingSystemId: 'agent-sandbox-1',
        HostedSystem: {
          SchemaVersion: SCHEMA,
          Container: {
            GuestOs: { HostName: 'agent-sandbox' },
            Storage: {
              Layers: [
                { Id: layerGuid('C:\\img\\l2'), Path: 'layer0', PathType: 'VirtualSmbShareName' },
                { Id: layerGuid('C:\\img\\base'), Path: 'layer1', PathType: 'VirtualSmbShareName' },
              ],
              Path: 'C:\\scratch',
            },
            Memory: { SizeInMB: 4096 },
            MappedDirectories: [
              map('dir0', 'VirtualSmbShareName', 'C:\\AgentLaunch', true),
              map('dir1', 'VirtualSmbShareName', 'C:\\AgentData\\run', false),
              map('dir2', 'VirtualSmbShareName', 'C:\\Workspace\\app', true),
              map('C:\\agent-disk0\\tools', 'AbsolutePath', 'C:\\AgentData\\tools', false),
              map('C:\\agent-disk0\\state', 'AbsolutePath', 'C:\\AgentData\\state', false),
              map('C:\\agent-disk0\\logs', 'AbsolutePath', 'C:\\AgentData\\logs', false),
            ],
            HvSocket: { Config: hvConfig },
          },
        },
      },
      'the container: layers from shares, the code read-only, run read-write, tools/state/logs from the agent disk',
    );
    const text = JSON.stringify([docs.uvm, docs.container]);
    t.check(
      !text.includes('NetworkAdapters') && !text.includes('Networking') && !text.includes('EndpointList'),
      'no network adapter, endpoint or networking section by default',
    );
    t.check(
      docs.uvm.VirtualMachine !== undefined &&
        (
          (
            docs.uvm as { VirtualMachine: { Devices: { VirtualSmb: { Shares: { Name: string; Options: object }[] } } } }
          ).VirtualMachine.Devices.VirtualSmb.Shares.filter((s) => s.Name !== 'os') as { Options: object }[]
        ).every((s) => (s.Options as { NoDirectmap?: boolean }).NoDirectmap === true),
      'every share except the OS files has NoDirectmap',
    );
    t.equal(
      [docs.disks, docs.notes.length, docs.uvmId, docs.containerId],
      [[{ image: 'C:\\S\\images\\set.vhdx', maxGb: 64, lun: 0 }], 2, 'agent-sandbox-1', 'agent-sandbox-1-c'],
      'one agent disk to create; notes say networking and the clipboard are not there',
    );
    t.equal(
      [cpuCount('none', 8), cpuCount(50, 8), cpuCount(5, 8), cpuCount(100, 2), cpuCount(10, 1)],
      [8, 4, 1, 2, 1],
      'processors from the CPU percentage',
    );
    t.check(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(layerGuid('C:\\x')) &&
        layerGuid('C:\\X') === layerGuid('c:\\x'),
      'layer ids are stable GUIDs',
    );
    const noDisk = buildDocuments({
      launch: { ...LAUNCH, networking: false, storage: [], devices: { ...LAUNCH.devices, clipboard: false } },
      image: FAKE_IMAGE,
      id: 'x',
      scratchVhdx: 'C:\\s.vhdx',
      hostCpus: 4,
    });
    t.check(
      noDisk.disks.length === 0 && noDisk.notes.length === 0 && JSON.stringify(noDisk.container).includes('dir0'),
      'without a disk there is nothing to create, and no notes when nothing was asked for that is missing',
    );

    t.section('capabilities');
    t.equal(
      HCS_CAPABILITIES,
      {
        desktop: false,
        gpu: false,
        clipboard: false,
        audio: false,
        video: false,
        printers: false,
        liveFolderAdd: true,
        attachedDisks: true,
        multipleInstances: true,
        hvsocket: true,
      },
      'HCS: headless, no GPU or clipboard; disks, several at once, Hyper-V sockets',
    );

    t.section('check: each missing piece gives its reason and the exact fix');
    const good = fakeProbes();
    t.equal(checkHcs(good), { available: true, reasons: [], fixes: [] }, 'a PC with everything is available');
    const cases: { name: string; pc: Parameters<typeof fakeProbes>[0]; reason: RegExp; fix: RegExp }[] = [
      { name: 'not Windows', pc: { windows: false }, reason: /only runs on Windows/, fix: /windows-sandbox/ },
      { name: 'old build', pc: { build: 14393 }, reason: /build 14393 is too old/, fix: /Update Windows/ },
      {
        name: 'no computecore.dll',
        pc: { computecore: false },
        reason: /computecore\.dll/,
        fix: /Enable-WindowsOptionalFeature -Online -All -FeatureName VirtualMachinePlatform/,
      },
      {
        name: 'no vmcompute',
        pc: { services: { vmcompute: false, cexecsvc: true } },
        reason: /vmcompute/,
        fix: /FeatureName Microsoft-Hyper-V-All/,
      },
      {
        name: 'no Containers',
        pc: { services: { vmcompute: true, cexecsvc: false } },
        reason: /Containers feature/,
        fix: /FeatureName Containers$/,
      },
      {
        name: 'not an administrator',
        pc: { token: { elevatedAdministrator: false, hyperVAdministrators: false } },
        reason: /neither an elevated Administrator nor in Hyper-V Administrators/,
        fix: /net localgroup "Hyper-V Administrators"/,
      },
      {
        name: 'no image',
        pc: { image: null },
        reason: /No Windows Server Core \(ltsc2022\) image.*fake store has no image/,
        fix: /docker pull mcr\.microsoft\.com\/windows\/servercore:ltsc2022.*AGENT_SANDBOX_HCS_IMAGE/,
      },
    ];
    for (const c of cases) {
      const r = checkHcs(fakeProbes(c.pc));
      t.check(
        !r.available && r.reasons.length === 1 && c.reason.test(r.reasons[0]) && c.fix.test(r.fixes[0]),
        'check: ' + c.name,
        JSON.stringify(r),
      );
    }
    t.check(
      checkHcs(fakeProbes({ token: { elevatedAdministrator: false, hyperVAdministrators: true } })).available,
      'Hyper-V Administrators is enough without elevation',
    );
    const bare = checkHcs(
      fakeProbes({ computecore: false, services: { vmcompute: false, cexecsvc: false }, image: null }),
    );
    t.check(
      bare.reasons.length === 4 && bare.fixes.length === 4,
      'several things missing: one reason and one fix each, in step',
    );
    t.check(
      good.calls.every((c) => /^(serviceInstalled|fileExists|imageStore\.find)/.test(c)),
      'the check only looked (service queries, file checks, image lookup)',
    );
    const csv =
      '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"\r\n' +
      '"BUILTIN\\Hyper-V Administrators","Alias","S-1-5-32-578","Mandatory group, Enabled by default, Enabled group"\r\n';
    t.equal(
      [
        parseWhoamiGroups(csv),
        parseWhoamiGroups(
          '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Mandatory group, Enabled by default, Enabled group, Group owner"',
        ),
      ],
      [
        { elevatedAdministrator: false, hyperVAdministrators: true },
        { elevatedAdministrator: true, hyperVAdministrators: false },
      ],
      'an Administrators group that is deny-only (not elevated) does not count',
    );

    t.section('images: an image that is already on this PC');
    const diffs = ['sha256:' + '1'.repeat(64), 'sha256:' + '2'.repeat(64)];
    const second = crypto
      .createHash('sha256')
      .update(diffs[0] + ' ' + diffs[1])
      .digest('hex');
    t.equal(chainIds(diffs), [diffs[0], 'sha256:' + second], "Docker's chain ids");
    const found = new DockerImageStore('C:\\ProgramData\\docker', dockerDisk(diffs)).find();
    t.equal(
      found.image,
      {
        id: 'sha256:' + 'b'.repeat(64),
        layers: ['C:\\ProgramData\\docker\\windowsfilter\\cache0', 'C:\\ProgramData\\docker\\windowsfilter\\cache1'],
        utilityVmFiles: 'C:\\ProgramData\\docker\\windowsfilter\\cache0\\UtilityVM\\Files',
      },
      'the Server Core image is found from its metadata, base layer first',
    );
    t.check(
      new DockerImageStore('C:\\nothing', { readText: () => null, isDir: () => false })
        .find()
        .reason.includes('no Windows images'),
      'no Docker store: says so',
    );
    const noTag: ImageFiles = {
      readText: (p) =>
        p.endsWith('repositories.json')
          ? JSON.stringify({
              Repositories: { 'mcr.microsoft.com/windows/nanoserver': { 'x:ltsc2022': 'sha256:' + 'c'.repeat(64) } },
            })
          : null,
      isDir: () => false,
    };
    t.check(
      new DockerImageStore('C:\\d', noTag).find().reason.includes('no windows/servercore:ltsc2022'),
      'only Nano Server: not the image we need',
    );
    const missingLayer = dockerDisk(diffs);
    t.check(
      new DockerImageStore('C:\\ProgramData\\docker', { ...missingLayer, isDir: () => false }).find().image === null,
      'a layer folder that is gone: no image',
    );
    const folderDisk: ImageFiles = {
      readText: (p) =>
        p === 'C:\\mine\\image.json'
          ? JSON.stringify({ layers: ['C:\\mine\\l0'], utilityVmFiles: 'C:\\mine\\l0\\UtilityVM\\Files' })
          : null,
      isDir: () => true,
    };
    t.check(
      new FolderImageStore('C:\\mine', folderDisk).find().image?.layers[0] === 'C:\\mine\\l0' &&
        new FolderImageStore(undefined, folderDisk).find().image === null,
      'your own image folder (image.json) is used when set, ignored when not',
    );

    t.section('the engine: refused until its check passes, start disabled');
    t.equal([new HcsEngine(FAKE_IMAGE, fakeProbes(), t.dir('hcs-root')).id], ['hcs'], 'the engine id is hcs');
    await t.throws(
      () => engineFor(hcsConfig),
      'The HCS engine has to be opened first',
      'engineFor(hcs) does not hand it out',
    );
    await t.throws(
      () => openEngine(hcsConfig, fakeProbes({ computecore: false, image: null })),
      /cannot run on this PC: computecore\.dll .*No Windows Server Core.*Fix: .*Enable-WindowsOptionalFeature/s,
      'openEngine(hcs) fails with the check reasons and fixes when the check fails',
    );
    const opened = await openEngine(hcsConfig, fakeProbes());
    t.check(
      opened.id === 'hcs' && opened.capabilities().hvsocket,
      'openEngine(hcs) returns the engine when the check passes',
    );
    t.check((await openEngine(f.baseConfig)).id === 'windows-sandbox', 'the default engine is still Windows Sandbox');

    const root = t.dir('hcs-engine');
    const launch: LaunchPlan = { ...LAUNCH, launchPath: path.join(root, 'launches', '1') };
    const plan: EnginePlan = opened.plan(launch);
    t.check(
      plan.engine === 'hcs' &&
        plan.files.map((x) => path.basename(x.path)).join() === 'uvm.json,container.json,plan.json' &&
        plan.entry === path.join(launch.launchPath, 'hcs', 'plan.json'),
      'plan(): the two documents and the plan file, entry is plan.json',
    );
    await t.throws(
      () => opened.start(plan),
      'starting it is not enabled yet; see docs/design/engines.md',
      'start() is refused by default',
    );
    const flagged = new HcsEngine(FAKE_IMAGE, fakeProbes(), root, { env: { AGENT_SANDBOX_HCS_EXPERIMENTAL: '1' } });
    await t.throws(
      () => flagged.start(plan),
      'starting it is not enabled yet',
      'start() is refused inside the self-test even with the flag (the real self-test check)',
    );
    t.check(process.env.AGENT_SANDBOX_SELFTEST === '1', 'this run really is the self-test');
    await t.throws(
      () =>
        new HcsEngine(FAKE_IMAGE, fakeProbes(), root, {
          env: { AGENT_SANDBOX_HCS_EXPERIMENTAL: '0' },
          selfTest: () => false,
        }).start(plan),
      'starting it is not enabled yet',
      'start() is refused without the flag outside the self-test too',
    );

    t.section('start() order, with the flag and a fake helper (the self-test guard switched off for this one engine)');
    const log: string[] = [];
    const fakeRun: HelperRunner = (_exe, args) => {
      log.push(
        args
          .slice(0, args.indexOf('--out'))
          .map((a) => (a.endsWith('request.json') ? '<request>' : a))
          .join(' '),
      );
      const answer = { ok: true, hresult: '0x00000000', message: 'ok', json: '[]', values: {} };
      fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify(answer), 'utf8');
      return { status: 0 };
    };
    const helper = new HcsHelper(() => 'C:\\fake\\HcsHost.exe', fakeRun, t.dir('hcs-helper-temp'));
    const live = new HcsEngine(FAKE_IMAGE, fakeProbes(), root, {
      helper,
      env: { AGENT_SANDBOX_HCS_EXPERIMENTAL: '1' },
      selfTest: () => false,
      exists: () => true,
    });
    for (const file of plan.files) t.write(file.path, file.text);
    const mineId = userSystemPrefix() + '1';
    const running = await live.start(plan);
    t.equal(
      log,
      [
        'grant-vm-access ' + mineId + ' C:\\S\\images\\set.vhdx',
        'grant-vm-access ' + mineId + ' ' + path.join(launch.launchPath, 'hcs', 'scratch.vhdx'),
        'create <request>',
        'start ' + mineId,
        'create <request>',
        'start ' + mineId + '-c',
      ],
      'disks get access, the utility VM is created and started, then the container',
    );
    t.check(running.id === mineId && running.engine === 'hcs', 'start() reports the sandbox');
    t.check(
      mineId !== userSystemPrefix('someone-else', 'PC') + '1',
      "the id carries this Windows user's tag (another user's sandbox of the same name gets another id)",
    );

    t.section('the helper: private temp folder, checked answers');
    const tempRoot = t.dir('hcs-helper-checks');
    const answers: string[] = [];
    const answering =
      (text: (out: string) => void): HelperRunner =>
      (_e, args) => {
        text(args[args.indexOf('--out') + 1]);
        answers.push(path.dirname(args[args.indexOf('--out') + 1]));
        return { status: 1 };
      };
    await t.throws(
      () =>
        new HcsHelper(
          () => 'C:\\x.exe',
          answering((o) => fs.writeFileSync(o, 'not json')),
          tempRoot,
        ).enumerate(),
      'not JSON',
      'an answer that is not JSON is refused',
    );
    await t.throws(
      () =>
        new HcsHelper(
          () => 'C:\\x.exe',
          answering((o) => fs.writeFileSync(o, '{"ok":true}')),
          tempRoot,
        ).enumerate(),
      'form this version does not know',
      'an answer of the wrong shape is refused',
    );
    await t.throws(
      () =>
        new HcsHelper(
          () => 'C:\\x.exe',
          answering(() => undefined),
          tempRoot,
        ).enumerate(),
      'gave no answer',
      'no answer file is refused',
    );
    await t.throws(
      () =>
        new HcsHelper(
          () => 'C:\\x.exe',
          answering((o) =>
            fs.writeFileSync(
              o,
              JSON.stringify({ ok: false, hresult: '0x8037011B', message: 'Access is denied', json: '', values: {} }),
            ),
          ),
          tempRoot,
        ).start('agent-sandbox-abc'),
      'Access is denied',
      "a failed answer stops with the helper's message",
    );
    t.equal(fs.readdirSync(tempRoot), [], 'the private temp folders are removed after every call');
    await t.throws(
      () => new HcsHelper(() => 'C:\\x.exe', fakeRun, tempRoot).start('--evil'),
      'Not a valid sandbox id',
      'ids are checked',
    );
    await t.throws(
      () => new HcsHelper(() => 'C:\\x.exe', fakeRun, tempRoot).createVhdx('rel.vhdx', 8),
      'Not a full path',
      'paths must be full paths',
    );
    await t.throws(
      () => new HcsHelper(() => null, fakeRun, tempRoot).check(),
      'HcsHost.exe could not be built',
      'no helper: a clear stop',
    );
    t.check(
      HcsReplySchema.safeParse({ ok: true, hresult: '0x0', message: '', json: '', values: {} }).success,
      'the reply schema',
    );

    t.section('doctor row: only when sandbox.engine is hcs');
    const rowEnv = (config: Config): RepairEnv => ({ ctx: { loaded: { config } } }) as unknown as RepairEnv;
    const row = HCS_CHECKS[0];
    t.check(
      row.name === 'HCS engine (alpha)' &&
        !row.applies?.(rowEnv(f.baseConfig)) &&
        row.applies?.(rowEnv(hcsConfig)) === true,
      'the "HCS engine (alpha)" row is hidden by default and shown for engine hcs',
    );
    HCS_PROBES.current = fakeProbes({ image: null });
    const finding = await row.run(rowEnv(hcsConfig));
    HCS_PROBES.current = null;
    t.check(
      finding.status === 'needs-you' && /docker pull/.test(finding.fix ?? ''),
      'the row says what is missing and the command, and repair has no automatic fix for it',
    );
    t.check(row.fix === undefined, 'repair never fixes HCS prerequisites (they change Windows)');

    t.section('HCS systems left running: only ours are listed and stopped (fake helper)');
    const mine = userSystemPrefix() + '1';
    const theirs = userSystemPrefix('someone-else', 'PC') + '1';
    const systems = [
      {
        Id: mine,
        SystemType: 'VirtualMachine',
        Owner: 'agent-sandbox',
        State: 'Running',
        CreateTimestamp: '2026-01-01T10:00:00Z',
      },
      { Id: mine + '-c', SystemType: 'Container', Owner: 'agent-sandbox', State: 'Running' },
      { Id: theirs, SystemType: 'VirtualMachine', Owner: 'agent-sandbox', State: 'Running' },
      { Id: 'WindowsSandbox-9', SystemType: 'VirtualMachine', Owner: 'agent-sandbox', State: 'Running' },
      { Id: 'agent-sandbox-evil', SystemType: 'VirtualMachine', Owner: 'docker', State: 'Running' },
      { Id: 'docker-1', SystemType: 'Container', Owner: 'docker', State: 'Running' },
    ];
    const calls: string[] = [];
    let present = [...systems];
    const leftoverRun: HelperRunner = (_exe, args) => {
      const verb = args[0];
      calls.push(args.slice(0, args.indexOf('--out')).join(' '));
      if (verb === 'terminate') present = present.filter((s) => s.Id !== args[1]);
      const json = verb === 'enumerate' ? JSON.stringify(present) : '';
      fs.writeFileSync(
        args[args.indexOf('--out') + 1],
        JSON.stringify({ ok: true, hresult: '0x0', message: 'ok', json, values: {} }),
        'utf8',
      );
      return { status: 0 };
    };
    const leftoverTemp = t.dir('hcs-leftovers-temp');
    const helperCalls: boolean[] = [];
    const useLeftovers = (probes = fakeProbes()): void => {
      LEFTOVER_DEPS.current = {
        probes,
        helper: () => {
          helperCalls.push(true);
          return new HcsHelper(() => 'C:\\fake\\HcsHost.exe', leftoverRun, leftoverTemp);
        },
      };
    };
    const ctx = { loaded: { config: hcsConfig } } as unknown as AppContext;
    try {
      useLeftovers();
      const look = lookForLeftovers('C:\\S');
      t.check(
        look.available &&
          look.systems.map((s) => s.id).join() === mine + ',' + mine + '-c' &&
          look.systems[0].kind === 'VirtualMachine' &&
          look.systems[0].since === '2026-01-01T10:00:00Z' &&
          look.systems[1].since === null,
        "only systems with our Owner and this user's id prefix are listed (not another user's, Windows Sandbox, Docker, or a foreign owner)",
        JSON.stringify(look),
      );
      const query = await engineLeftoversRun.run(ctx, {}, fakeIO().io);
      t.check(
        query.available && query.systems.length === 2 && /2 HCS systems/.test(query.message),
        'engine.leftovers returns them with a plain message',
      );

      calls.length = 0;
      const outcome = stopLeftovers('C:\\S', [mine, mine + '-c', theirs, 'WindowsSandbox-9', 'docker-1', '--evil']);
      t.equal(
        calls.filter((c) => c.startsWith('terminate')),
        ['terminate ' + mine + '-c', 'terminate ' + mine],
        'only ours reach terminate, the container before its utility VM',
      );
      t.check(
        outcome.filter((o) => o.stopped).length === 2 && outcome.filter((o) => !o.stopped).length === 4,
        'ids that are not ours (or not running) are reported, never terminated',
      );

      present = [...systems];
      calls.length = 0;
      const declined = fakeIO([false]);
      await t.throws(
        () => cleanEngineRun.run(ctx, {}, declined.io),
        'Nothing changed',
        'declining the question stops cleanly',
      );
      t.check(!calls.some((c) => c.startsWith('terminate')), 'declining terminates nothing');
      calls.length = 0;
      const yes = fakeIO([true]);
      const cleaned = await cleanEngineRun.run(ctx, {}, yes.io);
      t.check(
        cleaned.stopped === 2 &&
          cleaned.failed === 0 &&
          yes.seen.questions.length === 1 &&
          yes.seen.questions[0].kind === 'confirm' &&
          calls.filter((c) => c.startsWith('terminate')).length === 2,
        'engine.clean asks once, then stops what is ours',
      );
      const again = await cleanEngineRun.run(ctx, {}, fakeIO().io);
      t.check(
        again.stopped === 0 && /Nothing to clean/.test(again.message),
        'with none left it asks nothing and says so',
      );

      calls.length = 0;
      helperCalls.length = 0;
      useLeftovers(fakeProbes({ computecore: false }));
      const missing = await cleanEngineRun.run(ctx, {}, fakeIO().io);
      t.check(
        !missing.available && /not on this PC/.test(missing.message) && calls.length === 0 && helperCalls.length === 0,
        'HCS missing: a plain message, the helper is never started, nothing to clean',
      );

      t.section('doctor row: HCS systems left running');
      present = [...systems];
      useLeftovers();
      const leftoverRow = HCS_CHECKS[1];
      t.check(
        leftoverRow.name === 'HCS systems left running' &&
          leftoverRow.applies?.(rowEnv(f.baseConfig)) === true &&
          helperCalls.every(Boolean),
        'shown on any engine when one of ours is found, and the doctor never builds HcsHost.exe to look',
      );
      const warn = await leftoverRow.run(rowEnv(f.baseConfig));
      t.check(
        warn.status === 'warn' && warn.fix === 'sandbox engine clean' && warn.detail.includes(mine),
        'a warning with the fix "sandbox engine clean"',
      );
      present = [];
      t.check(
        leftoverRow.applies?.(rowEnv(f.baseConfig)) === false &&
          leftoverRow.applies?.(rowEnv(hcsConfig)) === true &&
          (await leftoverRow.run(rowEnv(hcsConfig))).status === 'ok',
        'hidden when none is left (unless the engine is hcs, where it says none is running)',
      );
      useLeftovers(fakeProbes({ computecore: false }));
      t.check(leftoverRow.applies?.(rowEnv(f.baseConfig)) === false, 'hidden on a PC without HCS');
    } finally {
      LEFTOVER_DEPS.current = null;
    }

    t.section('sandbox engine check hcs');
    const out = await f.runBin(
      'agent-sandbox',
      ['engine', 'check', 'hcs', '--config', t.writeJson(t.at('hcs-config.json'), {})],
      {
        cwd: f.workA,
        env: { ...process.env, NO_COLOR: '1', AGENT_SANDBOX_HOME: t.dir('hcs-home'), AGENT_SANDBOX_HOST_ONLY: '1' },
      },
    );
    t.check(
      /hcs can be used|hcs cannot be used on this PC yet/.test(out.out) &&
        (out.status === 0 || out.out.includes('To fix:')),
      'the command prints the check in plain words with the fixes',
      out.out,
    );
    t.check(DEFAULTS.sandbox.engine === 'windows-sandbox', 'the default engine is unchanged');

    t.section("documents against Microsoft's published HCS schema (Windows 11 21H2 and Windows 10 1809)");
    const schemaDir = path.join(t.packageRoot, 'src', 'selftest', 'fixtures', 'hcs-schema');
    if (!fs.existsSync(schemaDir)) {
      t.check(true, 'skipped: the schema fixtures are only in the repository');
    } else {
      for (const file of fs.readdirSync(schemaDir).filter((f) => f.endsWith('.json'))) {
        const problems = [
          ...schemaProblems(path.join(schemaDir, file), docs.uvm, 'utility VM'),
          ...schemaProblems(path.join(schemaDir, file), docs.container, 'container'),
        ];
        t.check(problems.length === 0, 'every property and value is in ' + file, problems.join('\n'));
      }
    }

    t.section('the helpers say the version they ship with (file details)');
    const version = (
      JSON.parse(fs.readFileSync(path.join(t.packageRoot, 'package.json'), 'utf8')) as { version: string }
    ).version;
    for (const helper of ['HostTools', 'HcsHost']) {
      const info = fs.readFileSync(path.join(t.packageRoot, 'native', 'csharp', helper, 'AssemblyInfo.cs'), 'utf8');
      t.check(
        info.includes('AssemblyInformationalVersion("' + version + '")') &&
          info.includes('AssemblyFileVersion("' + version + '.0")'),
        helper + '.exe file version is ' + version + ' (update AssemblyInfo.cs with package.json)',
      );
    }

    t.section('HcsHost.exe compiles (C# 5, the csc that ships with Windows)');
    if (!isWin || !fs.existsSync(SYSTEM.csc())) {
      t.check(true, 'skipped: no Windows csc on this machine');
    } else {
      const exe = t.at('hcshost', 'HcsHost.exe');
      t.check(buildHcsHostTo(exe), 'HcsHost.exe builds');
      if (fs.existsSync(exe)) {
        const reply = new HcsHelper(() => exe, undefined, tempRoot).check();
        t.check(
          reply.values.computecore === 'yes' || reply.values.computecore === 'no',
          'HcsHost.exe check answers with valid JSON (computecore: ' + reply.values.computecore + ')',
          JSON.stringify(reply),
        );
        const usage = new HcsHelper(() => exe, undefined, tempRoot).call(['frobnicate']);
        t.check(!usage.ok && /Usage/.test(usage.message), 'an unknown verb is a usage error');

        // Raw calls (past the TypeScript checks): HcsHost.exe itself refuses anything that is not ours.
        const raw = new HcsHelper(() => exe, undefined, tempRoot);
        const refused = (args: string[], request?: unknown): boolean => {
          const r = raw.call(args, request);
          return !r.ok && /^Refused: /.test(r.message);
        };
        t.check(
          ['WindowsSandbox-1', 'wsl', '--help', 'agent-sandbox-', 'agent-sandbox-a b'].every(
            (id) => refused(['terminate', id]) && refused(['start', id]) && refused(['properties', id]),
          ),
          "start, terminate and properties refuse every id that is not this tool's (Windows Sandbox, WSL, options)",
        );
        t.check(
          refused(['create'], { id: 'agent-sandbox-1', document: JSON.stringify({ Owner: 'docker' }) }) &&
            refused(['create'], { id: 'agent-sandbox-1', document: '{"SchemaVersion":{}}' }) &&
            refused(['create'], { id: 'agent-sandbox-1', document: 'not json' }) &&
            refused(['create'], { id: 'wsl-vm', document: JSON.stringify({ Owner: 'agent-sandbox' }) }),
          'create refuses a document owned by anyone else, without an Owner, not JSON, or under a foreign id',
        );
        const notDisk = t.write(path.join(tempRoot, 'hosts.txt'), 'x');
        const missing = path.join(tempRoot, 'missing.vhdx');
        t.check(
          refused(['grant-vm-access', 'agent-sandbox-1', notDisk]) &&
            refused(['grant-vm-access', 'agent-sandbox-1', missing]) &&
            refused(['grant-vm-access', 'agent-sandbox-1', 'relative.vhdx']),
          'grant-vm-access refuses anything but an existing .vhdx at a full path',
        );
        // share (prototype, docs/design/hcs-live-folders.md): refused before HCS is asked, so no Hyper-V is needed.
        const folder = t.dir('hcs-share-folder');
        const share = (over: Record<string, unknown>): Record<string, unknown> => ({
          id: 'agent-sandbox-1',
          action: 'add',
          name: 'agentsbx-0123abcd',
          path: folder,
          ...over,
        });
        let link = '';
        try {
          link = path.join(tempRoot, 'share-link');
          fs.symlinkSync(folder, link, 'junction');
        } catch {
          link = ''; // a folder that refuses links (a mapped folder): that case is skipped
        }
        t.check(
          refused(['share'], share({ id: '0b9a3c2e-1f00-4a4c-9d1e-6a7b8c9d0e1f' })) &&
            refused(['share'], share({ id: 'WindowsSandbox' })) &&
            refused(['share'], share({ name: '3ad483dec1a233132da4197c9790dcda06668793230cd6d9e94b1882e0f7f29c' })) &&
            refused(['share'], share({ name: 'agentsbx-XYZ' })) &&
            refused(['share'], share({ action: 'update' })) &&
            refused(['share'], share({ path: 'relative\\folder' })) &&
            refused(['share'], share({ path: 'C:\\' })) &&
            refused(['share'], share({ path: path.join(tempRoot, 'missing-folder') })) &&
            refused(['share'], share({ path: folder + '\\..\\' + path.basename(folder) })) &&
            refused(['share'], share({ path: folder + '/../' + path.basename(folder) })) &&
            refused(['share'], share({ path: folder + ':stream' })) &&
            refused(['share'], share({ path: folder + '.' })) &&
            refused(['share'], share({ path: folder + ' ' })) &&
            refused(['share'], share({ path: 'C:\\PROGRA~1' })) &&
            refused(['share'], share({ readOnly: 'yes' })) &&
            (!link || refused(['share'], share({ path: link }))),
          'share refuses a Windows Sandbox or other foreign id, a foreign share name, an update, a drive, a relative, ' +
            "missing, dotted, '/', stream, trailing-dot or -space, short-name or linked folder" +
            (link ? '' : ' (link case skipped)'),
        );
        const existing = t.write(path.join(tempRoot, 'existing.vhdx'), 'keep me');
        const over = raw.call(['create-vhdx', existing, '1']);
        t.check(
          !over.ok && fs.readFileSync(existing, 'utf8') === 'keep me',
          'create-vhdx never touches an existing file',
          over.message,
        );
      }
    }
  },
};

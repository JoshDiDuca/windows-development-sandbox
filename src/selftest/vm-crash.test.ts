// A crash of the sandbox's VM program (vmwp.exe): the Windows release table, the crash dump capture (the decisions and
// the script's parse), reading a minidump without a debugger (HostTools minidump, compiled and run on synthetic dumps,
// including damaged ones) and the crash report's new lines. Nothing here touches the registry or this PC's settings.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { machineRoot } from '../core/config/index.js';
import { isWin } from '../core/util/index.js';
import { nativeFile, nativeScript } from '../host/native.js';
import { SYSTEM } from '../shared/system.js';
import { parseWindowsVersion, WINDOWS_RELEASES, windowsServicing, windowsVersionText } from '../host/health/index.js';
import {
  adapterLine,
  crashReportText,
  dumpArea,
  dumpLines,
  isVmwpCrash,
  newestVmwpDump,
  parseAdapters,
  parseMiniDump,
  recordVmDumpsAnswer,
  shouldOfferVmDumps,
  vmDumpsAsked,
  type StopCause,
} from '../host/life/index.js';
import { parseVmDumpState, vmDumpCommand, vmDumpFolder } from '../host/sandbox/index.js';
import { windowsReleaseHint } from '../cli/commands/launch/windows-hint.js';
import type { Suite } from './support/suite.js';

const vmwpCause: StopCause = {
  kind: 'hyperv',
  at: '2026-11-08T03:00:00Z',
  text: 'a program that runs the sandbox VM (vmwp.exe) crashed',
};

const NOW = new Date('2026-11-08T12:00:00Z');

interface DumpOptions {
  readonly stackSize?: number;
  readonly memoryList?: boolean;
}

/** A minimal x64 minidump: three modules, one thread, an access violation in ntdll.dll+0x21afd. */
function syntheticDump(options: DumpOptions = {}): Buffer {
  const modules = [
    { base: 0x7ff600000000n, size: 0x100000, name: 'C:\\Windows\\System32\\vmwp.exe', ms: 0x000a0000, ls: 0x585d17ed },
    { base: 0x7ffa00000000n, size: 0x200000, name: 'C:\\Windows\\System32\\ntdll.dll', ms: 0x000a0000, ls: 0x585d17ac },
    { base: 0x7ffb00000000n, size: 0x50000, name: 'C:\\Windows\\System32\\vmuidevices.dll', ms: 0, ls: 0 },
  ];
  const stackValues = [1n, 0x7ffb00000010n, 0x7ff600000005n, 0x7ffa00000020n, 0x7ffb00000020n, 0x7ffb00000030n, 0x42n];
  const stackStart = 0x1000000n;
  const buffer = Buffer.alloc(4096);
  const streams = options.memoryList ? 4 : 3;
  let at = 32 + streams * 12;
  const place = (size: number): number => {
    const rva = at;
    at += size;
    at = (at + 7) & ~7;
    return rva;
  };
  buffer.write('MDMP', 0, 'latin1');
  buffer.writeUInt32LE(0xa793, 4);
  buffer.writeUInt32LE(streams, 8);
  buffer.writeUInt32LE(32, 12);
  const moduleRva = place(4 + modules.length * 108);
  const threadRva = place(4 + 48);
  const exceptionRva = place(168);
  const contextRva = place(256);
  const stackRva = place(stackValues.length * 8);
  const memoryRva = options.memoryList ? place(4 + 16) : 0;
  const nameRvas = modules.map((m) => {
    const rva = place(4 + m.name.length * 2);
    buffer.writeUInt32LE(m.name.length * 2, rva);
    buffer.write(m.name, rva + 4, 'utf16le');
    return rva;
  });
  modules.forEach((m, i) => {
    const e = moduleRva + 4 + i * 108;
    buffer.writeBigUInt64LE(m.base, e);
    buffer.writeUInt32LE(m.size, e + 8);
    buffer.writeUInt32LE(nameRvas[i], e + 20);
    buffer.writeUInt32LE(0xfeef04bd, e + 24);
    buffer.writeUInt32LE(m.ms, e + 32);
    buffer.writeUInt32LE(m.ls, e + 36);
  });
  buffer.writeUInt32LE(modules.length, moduleRva);
  stackValues.forEach((v, i) => buffer.writeBigUInt64LE(v, stackRva + i * 8));
  buffer.writeUInt32LE(1, threadRva);
  buffer.writeUInt32LE(77, threadRva + 4);
  const stackBytes = options.stackSize ?? stackValues.length * 8;
  buffer.writeBigUInt64LE(stackStart, threadRva + 4 + 24);
  buffer.writeUInt32LE(stackBytes, threadRva + 4 + 32);
  buffer.writeUInt32LE(stackBytes === 0 ? 0 : stackRva, threadRva + 4 + 36);
  if (options.memoryList) {
    buffer.writeUInt32LE(1, memoryRva);
    buffer.writeBigUInt64LE(stackStart, memoryRva + 4);
    buffer.writeUInt32LE(stackValues.length * 8, memoryRva + 12);
    buffer.writeUInt32LE(stackRva, memoryRva + 16);
  }
  buffer.writeUInt32LE(77, exceptionRva);
  buffer.writeUInt32LE(0xc0000005, exceptionRva + 8);
  buffer.writeBigUInt64LE(0x7ffa00000000n + 0x21afdn, exceptionRva + 24);
  buffer.writeUInt32LE(256, exceptionRva + 160);
  buffer.writeUInt32LE(contextRva, exceptionRva + 164);
  buffer.writeBigUInt64LE(stackStart, contextRva + 0x98);
  const directory = [
    [3, 4 + 48, threadRva],
    [4, 4 + modules.length * 108, moduleRva],
    [6, 168, exceptionRva],
    ...(options.memoryList ? [[5, 4 + 16, memoryRva]] : []),
  ];
  directory.forEach(([type, size, rva], i) => {
    buffer.writeUInt32LE(type, 32 + i * 12);
    buffer.writeUInt32LE(size, 36 + i * 12);
    buffer.writeUInt32LE(rva, 40 + i * 12);
  });
  return buffer.subarray(0, at);
}

export const vmCrashSuite: Suite = {
  name: 'vm-crash',
  title: "A crash of the sandbox's VM: Windows release, crash dumps, reading a minidump, the report lines",
  run: async (t) => {
    t.section('the Windows release table');
    t.check(
      WINDOWS_RELEASES.map((r) => r.build + '=' + r.name).join(' ') ===
        '22000=21H2 22621=22H2 22631=23H2 26100=24H2 26200=25H2',
      'the table lists 21H2 to 25H2 by build',
    );
    const e22h2 = windowsServicing(22621, 'Enterprise', NOW);
    t.check(
      e22h2?.state === 'out' &&
        e22h2.line ===
          "Windows 11 22H2 gets no more fixes since 15 Oct 2025 (Enterprise); crashes of the sandbox's VM (vmwp.exe) are in Windows' own code.",
      '22H2 Enterprise: no more fixes since 15 Oct 2025',
      e22h2?.line ?? '',
    );
    t.check(
      windowsServicing(22621, 'Professional', NOW)?.endsOn === '2024-10-08',
      '22H2 Pro ended earlier (8 Oct 2024)',
    );
    t.check(
      windowsServicing(22631, 'Enterprise', NOW)?.state === 'soon' &&
        windowsServicing(22631, 'Enterprise', NOW)?.line?.includes('stops getting fixes on 11 Nov 2026') === true,
      '23H2 Enterprise ends in 3 days: warned',
    );
    t.check(windowsServicing(22631, 'Core', NOW)?.state === 'out', '23H2 Home is out of servicing');
    t.check(
      windowsServicing(26100, 'Enterprise', NOW)?.state === 'ok' &&
        windowsServicing(26100, 'Enterprise', NOW)?.line === null &&
        windowsServicing(26200, 'Professional', NOW)?.state === 'ok',
      '24H2 Enterprise and 25H2 Pro are fine',
    );
    t.check(windowsServicing(26100, 'Professional', NOW)?.state === 'out', '24H2 Pro ended on 13 Oct 2026');
    t.check(
      windowsServicing(27000, 'Enterprise', NOW) === null &&
        windowsServicing(19045, 'Enterprise', NOW) === null &&
        windowsServicing(null, null, NOW) === null,
      'a newer or older build, or none: nothing is claimed',
    );
    t.check(
      windowsServicing(22621, null, NOW)?.endsOn === '2025-10-15',
      'an unknown edition uses the later date (no false alarm)',
    );
    t.check(
      windowsServicing(22621, 'Enterprise', new Date('2025-09-01T00:00:00Z'))?.state === 'soon' &&
        windowsServicing(22621, 'Enterprise', new Date('2025-06-01T00:00:00Z'))?.state === 'ok',
      'ends within 60 days: soon; further away: ok',
    );
    const text = [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion',
      '    CurrentBuild    REG_SZ    22621',
      '    CurrentBuildNumber    REG_SZ    22621',
      '    DisplayVersion    REG_SZ    22H2',
      '    EditionID    REG_SZ    Enterprise',
      '    UBR    REG_DWORD    0x184c',
    ].join('\r\n');
    const version = parseWindowsVersion(text);
    t.check(
      version?.build === 22621 &&
        version.edition === 'Enterprise' &&
        version.displayVersion === '22H2' &&
        version.revision === 6220 &&
        windowsVersionText(version) === 'Windows 11 22H2 (build 22621.6220), Enterprise',
      'the build, edition and revision come from the OS values, not from file versions',
      JSON.stringify(version),
    );
    t.check(parseWindowsVersion('nothing') === null, 'no build: no version');

    t.section('the launch line: only when out of servicing, once a day');
    const storage = t.dir('windows-hint');
    const out = parseWindowsVersion(text);
    const first = windowsReleaseHint(storage, out, NOW);
    t.check(first?.includes('no more fixes since 15 Oct 2025') === true, 'said the first time');
    t.check(windowsReleaseHint(storage, out, new Date(NOW.getTime() + 3600_000)) === null, 'not again within a day');
    t.check(windowsReleaseHint(storage, out, new Date(NOW.getTime() + 25 * 3600_000)) !== null, 'again the next day');
    t.check(
      windowsReleaseHint(
        t.dir('windows-hint-2'),
        { build: 26200, revision: null, edition: 'Enterprise', displayVersion: '25H2' },
        NOW,
      ) === null && windowsReleaseHint(t.dir('windows-hint-3'), null, NOW) === null,
      'a current release or an unreadable one says nothing',
    );
    t.check(
      !(first ?? '').toLowerCase().includes('insider') && !(first ?? '').toLowerCase().includes('assistant'),
      'the line states the fact only',
    );

    t.section('keeping the dump: decisions and commands');
    t.check(
      isVmwpCrash(vmwpCause) && !isVmwpCrash({ ...vmwpCause, kind: 'gpu' }) && !isVmwpCrash(null),
      'vmwp crash cause',
    );
    const facts = { cause: vmwpCause, dumpsOn: false, asked: false, interactive: true };
    t.check(shouldOfferVmDumps(facts), 'offered after a vmwp crash, to a person, once');
    t.check(
      !shouldOfferVmDumps({ ...facts, interactive: false }) &&
        !shouldOfferVmDumps({ ...facts, dumpsOn: true }) &&
        !shouldOfferVmDumps({ ...facts, asked: true }) &&
        !shouldOfferVmDumps({ ...facts, cause: { ...vmwpCause, kind: 'memory', text: 'this PC ran out of memory' } }),
      'never unattended, when already on, when asked before, or for another cause',
    );
    const run = t.dir('offer-run');
    t.check(!vmDumpsAsked(run), 'not asked yet');
    recordVmDumpsAnswer(run, false);
    t.check(vmDumpsAsked(run), 'the answer is recorded, so it is asked once');
    t.check(
      vmDumpFolder() === path.join(machineRoot(), 'vm-dumps') || vmDumpFolder().endsWith('AgentSandbox\\vm-dumps'),
      'the dumps go to a machine-wide folder (ProgramData\\AgentSandbox\\vm-dumps)',
      vmDumpFolder(),
    );
    t.check(
      parseVmDumpState('noise\n{"on":true,"folder":"C:\\\\ProgramData\\\\AgentSandbox\\\\vm-dumps"}\n')?.on === true &&
        parseVmDumpState('{"on":"yes"}') === null &&
        parseVmDumpState('') === null,
      'the script state is read through a schema',
    );
    const command = vmDumpCommand(
      'C:\\Program Files\\x\\set-vm-crash-dumps.ps1',
      'on',
      'C:\\ProgramData\\AgentSandbox\\vm-dumps',
    );
    t.check(
      command.includes(
        "& 'C:\\Program Files\\x\\set-vm-crash-dumps.ps1' -Action on -Folder 'C:\\ProgramData\\AgentSandbox\\vm-dumps'",
      ) && command.startsWith('Set-ExecutionPolicy -Scope Process'),
      'the elevated command quotes the script path and the folder',
      command,
    );
    await t.throws(
      () => vmDumpCommand('C:\\x.ps1', 'on', "C:\\a'; calc; '"),
      'characters that are not allowed',
      'a folder with quotes is refused',
    );

    t.section('the scripts parse and say what they need');
    for (const script of ['set-vm-crash-dumps.ps1', 'get-video-controllers.ps1']) {
      const source = fs.readFileSync(nativeFile('scripts', script), 'utf8');
      t.check(
        source.startsWith('#Requires -Version 5.1') && source.includes('\r\n') && !/[^\r]\n/.test(source),
        script + ': version line, CRLF',
      );
      if (isWin && fs.existsSync(SYSTEM.powershell())) {
        const parse = spawnSync(
          SYSTEM.powershell(),
          nativeScript('check-syntax.ps1', ['-Path', nativeFile('scripts', script)]),
          {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 60000,
          },
        );
        t.check(parse.status === 0, script + ' parses in Windows PowerShell', parse.stderr);
      }
    }
    const setter = fs.readFileSync(nativeFile('scripts', 'set-vm-crash-dumps.ps1'), 'utf8');
    t.check(
      setter.includes("ValidateSet('on', 'off', 'status')") &&
        setter.includes('Windows Error Reporting\\LocalDumps\\vmwp.exe') &&
        setter.includes('S-1-5-83-0') &&
        setter.includes('ExpandString') &&
        setter.includes('$miniDump = 1') &&
        setter.includes('$dumpCount = 5'),
      'the script sets DumpFolder (expand string), DumpType 1, DumpCount 5 and grants the virtual machines group',
    );

    t.section('what the dump shows (pure)');
    const info = parseMiniDump(
      '{"exceptionCode":"0xc0000005","exceptionAddress":"0x7ffa00021afd","faultingModule":"ntdll.dll","faultingOffset":"0x21afd","faultingVersion":"10.0.22621.6060","stackModules":["vmuidevices.dll","ntdll.dll"],"modules":3}',
    );
    t.check(
      info !== null && parseMiniDump('{"exceptionCode":1}') === null && parseMiniDump('x') === null,
      'the dump answer is read through a schema',
    );
    const lines = info ? dumpLines(info) : [];
    t.check(
      lines[0] ===
        'What the dump shows: access violation (0xc0000005) in ntdll.dll+0x21afd; on its stack: vmuidevices.dll, ntdll.dll.' &&
        lines[1]?.includes('graphics (vGPU) path') === true,
      'exception, module+offset, stack modules, and the graphics meaning',
      lines.join('\n'),
    );
    t.check(
      dumpArea(['ntdll.dll', 'nvwgf2umx.dll']) === 'graphics' &&
        dumpArea(['ntdll.dll', 'amdxx64.dll']) === 'graphics' &&
        dumpArea(['igd10iumd64.dll']) === 'graphics' &&
        dumpArea(['dxgkrnl.dll']) === 'graphics' &&
        dumpArea(['vrd.dll']) === 'graphics' &&
        dumpArea(['ntdll.dll', 'vmchipset.dll']) === 'hyperv' &&
        dumpArea(['vmbusres.dll']) === 'hyperv' &&
        dumpArea(['ntdll.dll', 'vmwp.exe', 'kernelbase.dll']) === 'windows',
      'module names map to graphics, Hyper-V devices or the VM worker',
    );
    t.check(
      newestVmwpDump([
        { name: 'C:\\d\\vmwp.exe.100.dmp', at: '2026-11-08T01:00:00Z' },
        { name: 'C:\\d\\vmwp.exe.200.dmp', at: '2026-11-08T03:00:00Z' },
        { name: 'C:\\Windows\\Minidump\\a.dmp', at: '2026-11-08T05:00:00Z' },
      ]) === 'C:\\d\\vmwp.exe.200.dmp',
      'the newest vmwp.exe dump is picked, other dumps are not',
    );
    const adapters = parseAdapters(
      '[{"name":"NVIDIA GeForce RTX 4070","driverVersion":"32.0.15.6094","driverDate":"2024-10-02"}]',
    );
    t.check(
      adapterLine(adapters[0]) === 'NVIDIA GeForce RTX 4070, driver 32.0.15.6094 of 2024-10-02' &&
        parseAdapters('{"name":"Basic"}').length === 1 &&
        parseAdapters('junk').length === 0,
      'graphics adapters: name, driver, date (one bare object is fine)',
    );

    t.section('the crash report lines');
    const windows = parseWindowsVersion(text)!;
    const report = crashReportText(vmwpCause, [], '', '2026-11-08T02:59:00Z', {
      windows,
      vgpu: true,
      graphics: adapters.map(adapterLine),
      dumpShows: lines,
    });
    t.check(
      report.includes('This PC runs Windows 11 22H2 (build 22621.6220), Enterprise.') &&
        report.includes('gets no more fixes since 15 Oct 2025 (Enterprise)') &&
        report.includes('Graphics adapter: NVIDIA GeForce RTX 4070, driver 32.0.15.6094') &&
        report.includes('What the dump shows: access violation (0xc0000005) in ntdll.dll+0x21afd'),
      'build and edition, the out-of-servicing line, the adapter and the dump lines',
      report,
    );
    const plain = crashReportText(vmwpCause, [], '', '2026-11-08T02:59:00Z', {
      windows: { ...windows, build: 26200 },
    });
    t.check(
      !plain.includes('no more fixes') &&
        plain.includes('No crash dump of vmwp.exe was kept') &&
        plain.includes('sandbox vm-dumps on'),
      'a current release has no warning; without a dump the report says how to keep one',
    );
    const memory = crashReportText(
      { kind: 'memory', at: '2026-11-08T03:00:00Z', text: 'this PC ran out of memory' },
      [],
      '',
      '2026-11-08T02:59:00Z',
      { windows },
    );
    t.check(!memory.includes('no more fixes') && !memory.includes('vm-dumps'), 'other causes get neither line');

    t.section('HostTools minidump on synthetic dumps (C# 5, the csc that ships with Windows)');
    if (!isWin || !fs.existsSync(SYSTEM.csc())) {
      t.skip('no Windows csc on this machine');
      return;
    }
    const dir = t.dir('minidump');
    const sources = fs
      .readdirSync(nativeFile('csharp', 'HostTools'))
      .filter((n) => n.endsWith('.cs'))
      .map((n) => nativeFile('csharp', 'HostTools', n));
    const exe = path.join(dir, 'HostTools.exe');
    const build = spawnSync(SYSTEM.csc(), ['/nologo', '/out:' + exe, ...sources], {
      encoding: 'utf8',
      windowsHide: true,
    });
    t.check(build.status === 0, 'HostTools compiles with MiniDump.cs', build.stdout);
    if (build.status !== 0) return;
    const read = (name: string, bytes: Buffer): { status: number | null; out: string; err: string } => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, bytes);
      const r = spawnSync(exe, ['minidump', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
    };
    const good = read('good.dmp', syntheticDump());
    const parsed = parseMiniDump(good.out);
    t.check(
      good.status === 0 &&
        parsed?.exceptionCode === '0xc0000005' &&
        parsed.faultingModule === 'ntdll.dll' &&
        parsed.faultingOffset === '0x21afd' &&
        parsed.faultingVersion === '10.0.22621.6060' &&
        parsed.modules === 3 &&
        parsed.stackModules.join(',') === 'vmuidevices.dll,vmwp.exe,ntdll.dll',
      'exception, faulting module+offset+version, stack modules in first-seen order',
      good.out + good.err,
    );
    const viaMemoryList = read('memory-list.dmp', syntheticDump({ stackSize: 0, memoryList: true }));
    t.check(
      viaMemoryList.status === 0 &&
        parseMiniDump(viaMemoryList.out)?.stackModules.join(',') === 'vmuidevices.dll,vmwp.exe,ntdll.dll',
      'a thread without its own stack memory is found in the memory list',
      viaMemoryList.out + viaMemoryList.err,
    );
    const damaged = (name: string, edit: (b: Buffer) => Buffer): { status: number | null; err: string } => {
      const r = read(name, edit(syntheticDump()));
      return { status: r.status, err: r.err };
    };
    const refusals = [
      damaged('not-a-dump.dmp', () => Buffer.from('hello world, this is not a dump'.padEnd(64, ' '))),
      damaged('cut.dmp', (b) => b.subarray(0, 100)),
      damaged('empty.dmp', () => Buffer.alloc(0)),
      damaged('many-streams.dmp', (b) => {
        b.writeUInt32LE(0x7fffffff, 8);
        return b;
      }),
      damaged('directory-outside.dmp', (b) => {
        b.writeUInt32LE(0xfffffff0, 12);
        return b;
      }),
      damaged('many-modules.dmp', (b) => {
        b.writeUInt32LE(0x0fffffff, b.readUInt32LE(32 + 12 + 8));
        return b;
      }),
      damaged('exception-outside.dmp', (b) => {
        b.writeUInt32LE(0xffffff00, 32 + 24 + 8);
        return b;
      }),
    ];
    t.check(
      refusals.every((r) => r.status === 1 && r.err.length > 0),
      'a file that is not a sound dump is refused with a message (exit 1), never a crash',
      JSON.stringify(refusals),
    );
    const badName = damaged('name-outside.dmp', (b) => {
      const module = b.readUInt32LE(32 + 12 + 8) + 4;
      b.writeUInt32LE(0xfffffff0, module + 20);
      return b;
    });
    t.check(badName.status === 0, 'a module name outside the file is shown as ? instead of failing');
    const big = path.join(dir, 'big.dmp');
    fs.writeFileSync(big, Buffer.alloc(0));
    fs.truncateSync(big, 64 * 1024 * 1024 + 1);
    const bigRun = spawnSync(exe, ['minidump', big], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    t.check(bigRun.status === 1 && (bigRun.stderr ?? '').includes('64 MB'), 'a file over 64 MB is refused');
    let unexpected = 0;
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 40; i++) {
      const b = syntheticDump();
      for (let k = 0; k < 6; k++) b[next() % b.length] = next() & 0xff;
      const r = read('fuzz.dmp', b);
      if (r.status !== 0 && r.status !== 1) unexpected++;
    }
    t.check(unexpected === 0, 'randomly damaged dumps only ever end in a result or a plain refusal (40 tries)');
  },
  live: true,
  timeoutMs: 240000,
};

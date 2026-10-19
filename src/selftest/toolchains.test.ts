// Picking tool versions and release assets: Node/Go/Python/Java version rules, GitHub release pages, PowerShell 7,
// cargo-binstall, the small CLI tools (gh, zstd, openssl), when PowerShell 7 is wanted, and the apps' agent add-ons.
import fs from 'node:fs';
import path from 'node:path';
import {
  javaMajorFrom,
  pickGoRelease,
  pickNodeVersion,
  pickPackageVersion,
  pickSpreadVersions,
  projectUses,
  specFromVersionFile,
} from '../core/detect/index.js';
import { parseReleasePage, parseReleaseTags } from '../shared/download/index.js';
import { decidePwsh, pcHasPwsh, PWSH_MAX_BYTES, readPwshScripts, usesPwsh } from '../core/detect/index.js';
import { binstallAsset, CLI_TOOLS, decideCli, pwshAsset, type CliSettings } from '../guest/toolchains/catalogue.js';
import { missingExtensions, vscodeExtensions, vscodeSettings } from '../guest/toolchains/tools/vscode-profile.js';
import {
  addonGuideLine,
  addonMcpServer,
  APP_CATEGORIES,
  APPS,
  appsNeedMesa,
  appsNeedUv,
  appsToInstall,
  CCUSAGE_VERSION,
  claudeManagedSettings,
  CONTEXT7_MCP_VERSION,
  exeMatcher,
  HEADROOM_VERSION,
  headroomArgs,
  headroomEnv,
  headroomUrl,
  PLAYWRIGHT_MCP_VERSION,
  RTK_VERSION,
  withAddonMcpServers,
} from '../shared/apps/index.js';
import { ConfigSchema, LocalOverridesSchema } from '../core/schema/index.js';
import type { Suite } from './support/suite.js';

export const toolchainsSuite: Suite = {
  name: 'toolchains',
  title: 'version pickers, release assets, PowerShell 7 and CLI tool decisions',
  run: (t) => {
    t.section('version pickers');
    const releases = [
      { version: 'v23.1.0', lts: false as const },
      { version: 'v22.11.0', lts: 'Jod' },
      { version: 'v20.18.0', lts: 'Iron' },
      { version: 'v20.9.0', lts: 'Iron' },
    ];
    const node = (spec: string): string | null => pickNodeVersion(releases, spec);
    t.equal(
      [node('lts/*'), node('lts/iron'), node('20'), node('v20.9.0'), node('node'), node('99')],
      ['22.11.0', '20.18.0', '20.18.0', '20.9.0', '23.1.0', null],
      '.nvmrc specs resolve (lts/*, lts/<name>, major, exact, node)',
    );
    const installed = ['16.20.2', '18.19.0', '18.20.4', '20.18.0', '22.3.0', '22.11.0', '23.1.0', 'notes'];
    t.equal(
      [
        pickSpreadVersions(installed, '22.11.0', 3),
        pickSpreadVersions(['20.18.0'], '22.3.0', 3),
        pickSpreadVersions(['18.20.4', '20.18.0'], '22.3.0', 1),
      ],
      [['22.11.0', '16.20.2', '23.1.0'], ['22.3.0', '20.18.0'], ['22.3.0']],
      'host nvm versions: capped, the current one first (added if missing), the rest spread across other majors',
    );
    const go = [
      { version: 'go1.24rc1', stable: false, files: [] },
      { version: 'go1.23.2', stable: true, files: [] },
      { version: 'go1.23.1', stable: true, files: [] },
      { version: 'go1.22.8', stable: true, files: [] },
    ];
    t.equal(
      [
        pickGoRelease(go, 'stable')?.version,
        pickGoRelease(go, '1.22')?.version,
        pickGoRelease(go, 'go1.23.1')?.version,
        pickGoRelease(go, '1.30'),
      ],
      ['go1.23.2', 'go1.22.8', 'go1.23.1', null],
      'Go versions resolve (stable, minor prefix, exact); release candidates are skipped',
    );
    t.equal(
      [
        javaMajorFrom('21\n'),
        javaMajorFrom('1.8'),
        javaMajorFrom('# sdkman\njava=21.0.2-tem\n', true),
        specFromVersionFile('ruby-3.3.1\n'),
        pickPackageVersion(['3.9.13', '3.12.7', '3.12.10', '3.13.0-rc1', '3.13.1'], '3'),
      ],
      ['21', '8', '21', '3.3.1', '3.13.1'],
      'version files (.java-version, .sdkmanrc, .ruby-version) and the newest stable Python match',
    );
    t.check(
      projectUses(['README.md', 'server/go.mod'], ['go.mod']) &&
        projectUses(['App.csproj'], ['*.csproj']) &&
        !projectUses(['notes.txt', 'docs/readme.md'], ['go.mod', '*.csproj']),
      'enabled "auto": a language is used when its marker file is in the workspace or one folder down',
    );

    t.section('GitHub release pages (the fallback when the API is rate limited)');
    const tags =
      '<a href="/coreybutler/nvm-windows/releases/tag/1.2.2">x</a><a href="/coreybutler/nvm-windows/releases/tag/1.2.2">y</a><a href="/other/repo/releases/tag/9">z</a><a href="/coreybutler/nvm-windows/releases/tag/1.1.12">w</a>';
    const page =
      '<a href="/o/r/releases/download/v1/tool-win-x64.zip">x</a><span>sha256:' +
      'a'.repeat(64) +
      '</span><a href="/o/r/releases/download/v1/tool-linux.tar.gz">y</a>';
    const assets = parseReleasePage(page);
    t.equal(
      [
        parseReleaseTags(tags, 'coreybutler/nvm-windows'),
        assets.length,
        assets[0].url,
        [assets[0].sha256, assets[1].sha256],
      ],
      [['1.2.2', '1.1.12'], 2, 'https://github.com/o/r/releases/download/v1/tool-win-x64.zip', ['a'.repeat(64), null]],
      "release pages: this repo's tags once each; asset links become URLs; only an asset's own sha256 is used",
    );

    t.section('release assets per architecture');
    const matching = (pattern: RegExp, names: string[]): string[] => names.filter((n) => pattern.test(n));
    const pwshNames = [
      'PowerShell-7.6.6-win-x64.zip',
      'PowerShell-7.6.6-win-arm64.zip',
      'PowerShell-7.6.6-win-x64.msi',
      'PowerShell-7.6.6-win-fxdependent.zip',
      'PowerShell-7.6.6-win-x86.zip',
      'PowerShell-7.6.6-win-x64.zip.sha256',
    ];
    const binstallNames = [
      'cargo-binstall-x86_64-pc-windows-msvc.zip',
      'cargo-binstall-x86_64-pc-windows-msvc.full.zip',
      'cargo-binstall-x86_64-pc-windows-msvc.zip.sig',
      'cargo-binstall-aarch64-pc-windows-msvc.zip',
      'cargo-binstall-x86_64-unknown-linux-musl.tgz',
    ];
    t.equal(
      [
        matching(pwshAsset('x64'), pwshNames),
        matching(pwshAsset('arm64'), pwshNames),
        matching(binstallAsset('x64'), binstallNames),
      ],
      [
        ['PowerShell-7.6.6-win-x64.zip'],
        ['PowerShell-7.6.6-win-arm64.zip'],
        ['cargo-binstall-x86_64-pc-windows-msvc.zip'],
      ],
      'PowerShell 7 and cargo-binstall: the portable Windows zip, not the MSI, fxdependent, .full or signature',
    );
    const cliAsset = (name: string, arch: 'x64' | 'arm64', names: string[]): string[] =>
      matching(CLI_TOOLS.find((c) => c.name === name)!.asset(arch), names);
    const ghNames = [
      'gh_2.102.0_windows_amd64.zip',
      'gh_2.102.0_windows_amd64.msi',
      'gh_2.102.0_windows_386.zip',
      'gh_2.102.0_windows_arm64.zip',
      'gh_2.102.0_linux_amd64.tar.gz',
    ];
    const zstdNames = ['zstd-v1.5.7-win64.zip', 'zstd-v1.5.7-win32.zip', 'zstd-v1.5.7.tar.gz'];
    t.equal(
      [cliAsset('gh', 'x64', ghNames), cliAsset('gh', 'arm64', ghNames), cliAsset('zstd', 'arm64', zstdNames)],
      [['gh_2.102.0_windows_amd64.zip'], ['gh_2.102.0_windows_arm64.zip'], ['zstd-v1.5.7-win64.zip']],
      'CLI catalogue: gh zip per architecture; zstd win64 also serves Arm',
    );

    t.section('which CLI tools are installed');
    const cli = (settings: CliSettings, gitAccess: 'full' | 'readonly' | 'none', hasGithubDir = false): string =>
      Object.entries(decideCli(settings, { gitAccess, hasGithubDir }))
        .filter(([, d]) => d.on)
        .map(([n]) => n)
        .join();
    t.equal(
      [
        cli({ gh: true, zstd: true, openssl: true }, 'full'),
        cli({ gh: true, zstd: true }, 'readonly'),
        cli({ gh: 'auto', zstd: 'auto', openssl: 'auto' }, 'full', true),
        cli({ gh: 'auto', zstd: 'auto' }, 'full', false),
        cli({}, 'full', true),
      ],
      ['gh,zstd,openssl', 'zstd', 'gh,openssl', '', ''],
      'CLI tools: gh needs git access "full"; "auto" means gh with a .github folder and openssl always; unlisted stay off',
    );

    t.section('PowerShell 7: when a script needs it');
    const ps = (text: string, file = 'moh.ps1'): string | null => usesPwsh([{ path: file, text }]);
    t.check(
      ps('#Requires -Version 7.2\nparam()') === 'moh.ps1: #Requires -Version 7' &&
        ps('  #requires -PSEdition Core') !== null &&
        ps('#Requires -Modules Pester -Version 7') !== null &&
        ps('<#\n.SYNOPSIS\n  Usage: pwsh scripts/moh/build-openmohaa.ps1 -Release\n#>') !== null &&
        ps('& pwsh.exe -NoProfile -File x.ps1') !== null &&
        ps('C:\\Program Files\\PowerShell\\7\\pwsh.exe -c 1') !== null,
      'markers: #Requires 7+, -PSEdition Core, a usage line or a call that runs pwsh',
    );
    t.check(
      ps('#Requires -Version 5.1') === null &&
        ps('#Requires -PSEdition Desktop') === null &&
        ps('# Works in Windows PowerShell and pwsh too.') === null &&
        ps('$pwsh -x; Write-Host mypwsh -y') === null &&
        ps('#Requires -Version 7', 'notes.txt') === null &&
        ps('Write-Host hi') === null,
      'not markers: 5.1, Desktop, prose that mentions pwsh, variables, longer words, non-scripts',
    );

    // Hostile scripts (a cloned repository is untrusted): capped and scanned in linear time.
    const evilStart = Date.now();
    const evilText = (
      ' #requires' +
      ' -version'.repeat(5000) +
      '\n' +
      'xpwsh pwsh\t\t'.repeat(20000) +
      '\n' +
      ' '.repeat(100000) +
      'pwsh\n' +
      'pwsh\n'.repeat(50000)
    ).repeat(3);
    const evil = usesPwsh(Array.from({ length: 100 }, (_, i) => ({ path: 'a' + i + '.ps1', text: evilText })));
    const evilMs = Date.now() - evilStart;
    t.check(
      evil === null && evilMs < 2000,
      'hostile scripts (huge lines, endless repeats) do not match and are scanned in linear time',
      'took ' + evilMs + ' ms',
    );

    const needsIt = [{ path: 'x/run.ps1', text: '#Requires -PSEdition Core' }];
    t.check(
      decidePwsh('auto', [], true, true).on &&
        !decidePwsh('auto', [], false, true).on &&
        !decidePwsh('auto', [], true, false).on &&
        decidePwsh('auto', needsIt, false, false).reason === 'x/run.ps1: #Requires -PSEdition Core' &&
        !decidePwsh(false, [{ path: 'a.ps1', text: '#Requires -Version 7' }], true, true).on &&
        decidePwsh(true, [], false, false).on,
      'pwsh "auto": on for a new folder when this PC has it, or when a script needs it (named); true/false always win',
    );
    t.check(
      pcHasPwsh({ ProgramFiles: 'C:\\PF' }, (p) => p === 'C:\\PF\\PowerShell\\7\\pwsh.exe') &&
        pcHasPwsh({ PATH: 'C:\\x;C:\\tools\\pwsh' }, (p) => p === 'C:\\tools\\pwsh\\pwsh.exe') &&
        !pcHasPwsh({ PATH: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps' }, (p) => /WindowsApps/.test(p)),
      'pwsh on this PC: found in Program Files or on PATH; a Store alias does not count',
    );

    const scanRoot = t.at('pwsh-scan');
    t.write(path.join(scanRoot, 'moh.ps1'), '#Requires -Version 7\n');
    t.write(path.join(scanRoot, 'scripts', 'build.ps1'), 'x'.repeat(200000) + '\n#Requires -Version 7');
    t.write(path.join(scanRoot, 'node_modules', 'pkg.ps1'), '#Requires -Version 7');
    t.write(path.join(scanRoot, 'scripts', 'deep', 'far.ps1'), '#Requires -Version 7');
    t.write(path.join(scanRoot, 'readme.md'), 'pwsh -File x.ps1');
    const scanned = readPwshScripts(scanRoot);
    t.check(
      scanned.map((s) => s.path).join() === 'moh.ps1,scripts/build.ps1' && scanned[1].text.length === PWSH_MAX_BYTES,
      'pwsh scan: *.ps1 at the root and one folder down only (node_modules skipped), each read up to its cap',
    );

    t.section('VS Code set-up');
    const vs = vscodeSettings({
      javaHome: 'C:\\t\\java\\jdk-17.0.9+9',
      python: 'C:\\t\\python\\python.exe',
      pwsh: 'C:\\t\\pwsh\\pwsh.exe',
      gcc: 'C:\\t\\mingw\\bin\\gcc.exe',
      cl: 'C:\\t\\msvc\\cl.exe',
      dotnet: 'C:\\t\\dotnet\\dotnet.exe',
    });
    t.check(
      vs['java.jdt.ls.java.home'] === 'C:\\t\\java\\jdk-17.0.9+9' &&
        (vs['java.configuration.runtimes'] as { name: string }[])[0].name === 'JavaSE-17' &&
        vs['terminal.integrated.defaultProfile.windows'] === 'PowerShell 7' &&
        vs['C_Cpp.default.compilerPath'] === 'C:\\t\\msvc\\cl.exe' &&
        !('go.goroot' in vs),
      "vscode: settings point at the sandbox's JDK (with its version), PowerShell 7 and compiler (MSVC first); missing tools are not set",
    );
    const ext = vscodeExtensions({
      toolchains: ['node', 'java'],
      databases: ['postgres'],
      recommended: ['Foo.Bar', 'not an id'],
      extra: ['eamodio.gitlens', 'redhat.java'],
    });
    t.check(
      ext.includes('mtxr.sqltools-driver-pg') &&
        ext.includes('foo.bar') &&
        ext.includes('eamodio.gitlens') &&
        !ext.includes('not an id') &&
        ext.filter((e) => e === 'redhat.java').length === 1 &&
        missingExtensions(['golang.go', 'redhat.java'], ['golang.go-0.48.0']).join() === 'redhat.java',
      'vscode: extensions for the languages in use, the project and you (no duplicates, nothing malformed); only missing ones are downloaded',
    );

    t.section('apps catalogue');
    const ids = APPS.map((a) => a.id);
    const badPattern = (a: (typeof APPS)[number]): boolean => {
      if (!('github' in a.source)) return false;
      try {
        new RegExp(a.source.asset);
        return false;
      } catch {
        return true;
      }
    };
    t.check(
      ids.every((id, i) => ids.indexOf(id) === i) &&
        APPS.every((a) => APP_CATEGORIES.some((c) => c.id === a.category)) &&
        !APPS.some(badPattern),
      'apps: ids are unique, every app is in a known category, every GitHub asset pattern compiles',
    );
    t.check(
      exeMatcher('/^Godot_v[\\d.]+-stable_win64\\.exe$/')('Godot_v4.7.2-stable_win64.exe') &&
        !exeMatcher('/^Godot_v[\\d.]+-stable_win64\\.exe$/')('Godot_v4.7.2-stable_win64_console.exe') &&
        exeMatcher('Code.exe')('code.EXE'),
      'apps: the program is found by name or by pattern',
    );
    const chosen = appsToInstall(
      {
        install: ['firefox', 'jq', 'githubdesktop'],
        custom: { mine: { name: 'Mine', url: 'https://example.com/m.zip', exe: 'm.exe' } },
      },
      'readonly',
    );
    t.check(
      chosen.entries.map((e) => e.id).join() === '7zip,firefox,jq,custom/mine' &&
        chosen.skipped.length === 1 &&
        appsNeedMesa({ install: ['godot'], custom: {} }) &&
        !appsNeedMesa({ install: ['jq'], custom: {} }),
      'apps: 7-Zip first when an installer needs it; an app with its own git is skipped unless git access is "full"; engines bring Mesa',
    );
    // The release files the entries were written against (GitHub, 2026-10): the x64 build matches, the others do not.
    const pick = (id: string, files: string[]): string[] => {
      const source = APPS.find((x) => x.id === id)?.source;
      const re = new RegExp(source && 'github' in source ? source.asset : '$^');
      return files.filter((f) => re.test(f));
    };
    t.equal(
      [
        pick('ast-grep', [
          'app-aarch64-pc-windows-msvc.zip',
          'app-i686-pc-windows-msvc.zip',
          'app-x86_64-pc-windows-msvc.zip',
        ]),
        pick('jj', ['jj-v0.46.0-aarch64-pc-windows-msvc.zip', 'jj-v0.46.0-x86_64-pc-windows-msvc.zip']),
        pick('rust-analyzer', ['rust-analyzer-i686-pc-windows-msvc.zip', 'rust-analyzer-x86_64-pc-windows-msvc.zip']),
      ],
      [
        ['app-x86_64-pc-windows-msvc.zip'],
        ['jj-v0.46.0-x86_64-pc-windows-msvc.zip'],
        ['rust-analyzer-x86_64-pc-windows-msvc.zip'],
      ],
      'apps: ast-grep, Jujutsu and rust-analyzer pick the x64 Windows release file',
    );
    t.check(
      appsToInstall({ install: ['jj', 'ast-grep', 'rust-analyzer'], custom: {} }, 'readonly').skipped.length === 1 &&
        appsToInstall({ install: ['jj'], custom: {} }, 'full').entries.some((e) => e.id === 'jj'),
      'apps: Jujutsu brings its own git, so it needs git access "full"; the other two do not',
    );
    const custom = (app: object): boolean => ConfigSchema.shape.apps.shape.custom.safeParse({ x: app }).success;
    t.check(
      custom({ name: 'A', github: 'o/r', asset: 'win.*\\.zip$', exe: 'a.exe' }) &&
        custom({ name: 'B', url: 'https://x.org/b.zip', exe: 'b.exe' }) &&
        !custom({ name: 'C', url: 'http://x.org/c.zip', exe: 'c.exe' }) &&
        !custom({ name: 'D', github: 'o/r', asset: '(', exe: 'd.exe' }) &&
        !custom({ name: 'E', github: 'o/r', asset: 'x', url: 'https://x.org', exe: 'e.exe' }),
      'apps: your own program comes from a GitHub release or an https link; plain http, a broken pattern or both are refused',
    );
    t.check(
      !LocalOverridesSchema.safeParse({ apps: { custom: {} } }).success &&
        LocalOverridesSchema.safeParse({ apps: { install: ['jq'] } }).success,
      'apps: a project file may add catalogue apps but never programs of its own',
    );

    t.section('agent add-ons');
    const rtk = APPS.find((a) => a.id === 'rtk');
    const rtkSource = rtk?.source;
    t.check(
      rtk?.category === 'agents' &&
        rtk.cli === true &&
        rtk.userOnly === true &&
        rtkSource !== undefined &&
        'url' in rtkSource &&
        rtkSource.url.startsWith('https://github.com/rtk-ai/rtk/releases/download/v' + RTK_VERSION + '/') &&
        rtkSource.url.endsWith('-x86_64-pc-windows-msvc.zip') &&
        /^[0-9a-f]{64}$/.test(rtkSource.sha256 ?? ''),
      'rtk: a pinned https release file of rtk-ai/rtk with its SHA-256, on PATH, in your own settings only',
    );
    t.check(
      APPS.every((a) => !('url' in a.source) || a.source.url.startsWith('https://')) &&
        APPS.every(
          (a) => !('url' in a.source) || a.source.sha256 === undefined || /^[0-9a-f]{64}$/.test(a.source.sha256),
        ),
      'apps: every direct link is https, and a pinned checksum is 64 hex characters',
    );
    const agentApps = APPS.filter((a) => a.category === 'agents').map((a) => a.id);
    t.check(
      APP_CATEGORIES.some((c) => c.id === 'agents' && c.label === 'Agent add-ons') &&
        agentApps.includes('rtk') &&
        agentApps.includes('claude-mem') &&
        APPS.find((a) => a.id === 'claude-mem')?.setting === 'claudeProfile.syncClaudeMem',
      'apps: the Agent add-ons category holds rtk and claude-mem (claude-mem through its own setting)',
    );
    t.check(
      !LocalOverridesSchema.safeParse({ apps: { install: ['rtk'] } }).success &&
        !LocalOverridesSchema.safeParse({ apps: { install: ['claude-mem'] } }).success &&
        ConfigSchema.shape.apps.shape.install.safeParse(['rtk']).success,
      'rtk: only your own settings turn it on; a project file cannot',
    );
    const exe = 'C:\\AgentData\\tools\\apps\\rtk\\rtk.exe';
    const withRtk = claudeManagedSettings([], exe);
    const both = claudeManagedSettings(['Bash(git push:*)'], exe);
    const gitOnly = claudeManagedSettings(['Bash(git push:*)'], null);
    t.equal(
      withRtk?.hooks?.PreToolUse,
      [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"C:/AgentData/tools/apps/rtk/rtk.exe" hook claude' }] }],
      "rtk: its documented Bash PreToolUse hook goes into the sandbox's managed settings",
    );
    t.check(
      claudeManagedSettings([], null) === null &&
        gitOnly?.hooks === undefined &&
        gitOnly?.permissions?.deny.length === 1 &&
        both?.permissions?.deny.length === 1 &&
        both.hooks?.PreToolUse.length === 1 &&
        withRtk?.permissions === undefined,
      'rtk: no hook when it is off; the git deny rules stay beside it; nothing to write when neither',
    );

    t.section('agent add-ons: Headroom, ccusage, Playwright MCP, Context7 MCP');
    const pinned = {
      headroom: ['uv', 'headroom-ai', HEADROOM_VERSION],
      ccusage: ['npm', 'ccusage', CCUSAGE_VERSION],
      'playwright-mcp': ['npm', '@playwright/mcp', PLAYWRIGHT_MCP_VERSION],
      context7: ['npm', '@upstash/context7-mcp', CONTEXT7_MCP_VERSION],
    } as const;
    for (const [id, [kind, pkg, version]] of Object.entries(pinned)) {
      const entry = APPS.find((a) => a.id === id);
      const source = entry?.source;
      t.check(
        entry?.category === 'agents' &&
          entry.userOnly === true &&
          source !== undefined &&
          'locked' in source &&
          source.locked === kind &&
          source.package === pkg &&
          source.version === version &&
          /^\d+\.\d+\.\d+$/.test(version) &&
          !LocalOverridesSchema.safeParse({ apps: { install: [id] } }).success &&
          ConfigSchema.shape.apps.shape.install.safeParse([id]).success,
        id + ': in Agent add-ons, a pinned ' + kind + ' package (' + pkg + ' ' + version + '), your own settings only',
      );
      const lockDir = path.join(t.packageRoot, 'sandbox', 'addons', id);
      if (kind === 'npm') {
        const manifest = JSON.parse(fs.readFileSync(path.join(lockDir, 'package.json'), 'utf8')) as {
          dependencies: Record<string, string>;
        };
        const lock = JSON.parse(fs.readFileSync(path.join(lockDir, 'package-lock.json'), 'utf8')) as {
          lockfileVersion: number;
          packages: Record<string, { version?: string; resolved?: string; integrity?: string; link?: boolean }>;
        };
        const deps = Object.entries(lock.packages).filter(([key]) => key !== '');
        t.check(
          manifest.dependencies[pkg] === version &&
            Object.keys(manifest.dependencies).length === 1 &&
            lock.lockfileVersion === 3 &&
            lock.packages['node_modules/' + pkg]?.version === version &&
            deps.length > 0 &&
            deps.every(
              ([, p]) =>
                !p.link &&
                (p.resolved ?? '').startsWith('https://registry.npmjs.org/') &&
                /^sha512-[A-Za-z0-9+/]+=*$/.test(p.integrity ?? ''),
            ),
          id + ': its lock file pins ' + pkg + ' ' + version + '; every package comes from npm with a sha512 integrity',
        );
      } else {
        const lines = fs.readFileSync(path.join(lockDir, 'requirements.txt'), 'utf8').split(/\r?\n/);
        const requirements = lines.filter((l) => /^[A-Za-z0-9]/.test(l));
        const blocks = lines
          .join('\n')
          .split(/\n(?=[A-Za-z0-9])/)
          .slice(1);
        t.check(
          requirements.includes(pkg + '==' + version + ' \\') &&
            requirements.length > 10 &&
            requirements.every((l) => /^[A-Za-z0-9._-]+(\[[^\]]+\])?==[^\s]+ \\$/.test(l)) &&
            blocks.every((b) => /--hash=sha256:[0-9a-f]{64}/.test(b)) &&
            !lines.some((l) => /^\s*(-e|--index-url|--extra-index-url|-f|--find-links|git\+|https?:)/.test(l.trim())),
          id + ': its requirements.txt pins every package to one version with SHA-256 hashes, from PyPI only',
        );
      }
    }
    t.check(
      appsNeedUv({ install: ['headroom'], custom: {} }) &&
        !appsNeedUv({ install: ['ccusage', 'rtk'], custom: {} }) &&
        !appsNeedUv(undefined),
      'headroom: choosing it brings the uv step (it installs with uv)',
    );
    const services = APPS.filter((a) => a.service).map((a) => a.id);
    t.check(
      ['headroom', 'playwright-mcp', 'context7'].every((id) => services.includes(id)) &&
        APPS.find((a) => a.id === 'ccusage')?.cli === true &&
        !services.includes('ccusage'),
      'add-ons: the proxy and MCP servers get no shortcut and no PATH entry; ccusage is a command on PATH',
    );

    // Headroom: loopback only, Anthropic only, no telemetry, and none of the agents' secrets in its environment.
    const args = headroomArgs();
    t.check(
      args[0] === 'proxy' &&
        args[args.indexOf('--host') + 1] === '127.0.0.1' &&
        args[args.indexOf('--port') + 1] === '8787' &&
        args[args.indexOf('--anthropic-api-url') + 1] === 'https://api.anthropic.com' &&
        args.includes('--no-telemetry') &&
        headroomUrl() === 'http://127.0.0.1:8787',
      'headroom: the proxy listens on 127.0.0.1 only and forwards only to api.anthropic.com, telemetry off',
    );
    const proxyEnv = headroomEnv({
      PATH: 'C:\\Windows',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      GITHUB_TOKEN: 'ghp',
      OPENAI_API_KEY: 'sk',
      DB_PASSWORD: 'pw',
      HTTPS_PROXY: 'http://127.0.0.1:3128',
      HEADROOM_OFFLINE: '0',
    });
    t.check(
      proxyEnv.PATH === 'C:\\Windows' &&
        proxyEnv.HTTPS_PROXY === 'http://127.0.0.1:3128' &&
        !Object.values(proxyEnv).some((v) => ['sk-ant-x', 'oauth', 'ghp', 'sk', 'pw'].includes(v)) &&
        proxyEnv.HEADROOM_OFFLINE === '1' &&
        proxyEnv.HEADROOM_TELEMETRY === 'off' &&
        proxyEnv.HEADROOM_UPDATE_CHECK === 'off',
      'headroom: starts without keys or tokens, offline apart from forwarding (no telemetry, updates or downloads)',
    );
    const routed = claudeManagedSettings([], null, headroomUrl());
    t.check(
      routed?.env?.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8787' &&
        claudeManagedSettings([], exe)?.env === undefined &&
        claudeManagedSettings(['Bash(git push:*)'], null)?.env === undefined &&
        claudeManagedSettings(['Bash(git push:*)'], exe, headroomUrl())?.hooks?.PreToolUse.length === 1,
      "headroom: Claude Code is pointed at the proxy only while it runs (the sandbox's managed settings env)",
    );

    // MCP servers: set while on, removed when off, your own servers never touched.
    const playwright = APPS.find((a) => a.id === 'playwright-mcp')?.mcp;
    const context7 = APPS.find((a) => a.id === 'context7')?.mcp;
    const known = APPS.flatMap((a) => (a.mcp ? [a.mcp.name] : []));
    const pw = playwright ? addonMcpServer('C:\\AgentData\\tools\\apps\\playwright-mcp', playwright) : null;
    t.equal(
      pw,
      {
        type: 'stdio',
        command: 'node',
        args: [
          'C:\\AgentData\\tools\\apps\\playwright-mcp\\node_modules\\@playwright\\mcp\\cli.js',
          '--browser',
          'msedge',
        ],
        env: {},
      },
      'playwright-mcp: a stdio MCP server run by node from its own folder, with Edge',
    );
    const mine = { playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp'] } };
    const on = withAddonMcpServers(mine, pw ? { 'sbx-playwright': pw } : {}, known);
    const off = withAddonMcpServers({ ...on, 'sbx-context7': {} }, {}, known);
    t.check(
      known.length === 2 &&
        known.every((n) => n.startsWith('sbx-')) &&
        context7?.name === 'sbx-context7' &&
        'sbx-playwright' in on &&
        'playwright' in on &&
        Object.keys(off).join() === 'playwright' &&
        withAddonMcpServers({ 'sbx-other': 1 }, {}, known)['sbx-other'] === 1,
      'add-ons: their sbx-... MCP servers are set while on and removed when off; servers of your own stay',
    );
    t.check(
      addonGuideLine([], false).length === 0 &&
        addonGuideLine(['sbx-playwright'], true).length === 2 &&
        addonGuideLine(['sbx-playwright'], false)[0].includes('sbx-playwright'),
      'add-ons: the agent guide names the MCP servers and ccusage only when they are on',
    );
  },
};

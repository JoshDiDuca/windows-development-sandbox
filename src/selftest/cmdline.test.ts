// How the sandbox builds command lines for npm-installed agents (.cmd files run through cmd.exe): & | < > ^ % and
// quotes must reach the agent unchanged.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isWin } from '../core/util/index.js';
import { commandLine, shellLaunch } from '../guest/sessions/cmdline.js';
import { runNode } from './support/fixtures.js';
import type { Suite } from './support/suite.js';

// Odd quote counts flip cmd's quote state for every later argument: those come after them on purpose.
const TRICKY_ARGUMENTS = [
  'https://x?a=1&b=2',
  '50% off',
  'a|b<c>d',
  'x^y',
  'say "hi" & go',
  'plain',
  '%PATH%',
  'a"b&c',
  'q"x|y^z"w',
  'e"5%',
  'k&v',
  '100%',
];

export const cmdlineSuite: Suite = {
  name: 'cmdline',
  title: 'cmd.exe quoting for npm-installed agents',
  run: async (t) => {
    t.section('command lines');
    // guest/cmdline.ts is loaded in a child process with a throwaway launch/data folder (it reads session.json on
    // load).
    const quoteDir = t.at('quote');
    t.write(path.join(quoteDir, 'launch', 'session.json'), '{}');
    const agentCmd = t.write(
      path.join(quoteDir, 'agent.cmd'),
      '@"' + process.execPath + '" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n',
    );
    const script = [
      'const m = await import(process.argv[1]); const [cmd, tricky] = JSON.parse(process.argv[2]);',
      'console.log(JSON.stringify({ normal: m.commandLine("C:\\\\W\\\\cmd.exe", ["/d", "/c", "C:\\\\a\\\\agent.cmd", "--model", "big one", "plain", ""]), direct: m.commandLine("C:\\\\a\\\\agent.exe", ["a&b", "50%"]),',
      '  url: m.cmdArgs(["https://x?a=1&b=2"]), pct: m.cmdArgs(["50%"]), live: m.commandLine("cmd.exe", ["/d", "/c", cmd, ...tricky]).slice(8) }));',
    ].join('\n');
    const probe = await runNode(
      [
        '--input-type=module',
        '-e',
        script,
        pathToFileURL(path.join(t.packageRoot, 'dist', 'guest', 'sessions', 'cmdline.js')).href,
        JSON.stringify([agentCmd, TRICKY_ARGUMENTS]),
      ],
      {
        env: {
          ...process.env,
          AGENT_LAUNCH_DIR: path.join(quoteDir, 'launch'),
          AGENT_DATA_DIR: path.join(quoteDir, 'data'),
        },
      },
    );
    let quoting: Record<string, string> = {};
    try {
      quoting = JSON.parse(probe.out) as Record<string, string>;
    } catch {
      /* reported below */
    }
    const whyEmpty = quoting.normal ? '' : 'the helper printed: ' + probe.out.trim().slice(0, 300);
    t.check(
      quoting.normal === 'C:\\W\\cmd.exe /d /c C:\\a\\agent.cmd --model "big one" plain ""',
      'ordinary arguments are quoted as before',
      whyEmpty + '\nactual: ' + quoting.normal,
    );
    t.check(
      quoting.direct === 'C:\\a\\agent.exe a&b 50%',
      'a program started directly gets & and % unchanged',
      'actual: ' + quoting.direct,
    );
    t.equal(quoting.url, '"https://x?a=1&b=2"', 'cmd /c arguments: & | < > ^ are quoted');
    t.equal(quoting.pct, '"50"%""', 'cmd /c arguments: % is split out so no %name% expands');

    // (A temp folder with spaces would also need cmd's own quote rules, so this end-to-end run skips those.)
    if (isWin && quoting.live && !/\s/.test(agentCmd)) {
      const echoed = spawnSync(process.env.ComSpec ?? 'cmd.exe', [quoting.live], {
        encoding: 'utf8',
        windowsVerbatimArguments: true,
        windowsHide: true,
      });
      t.equal(
        echoed.stdout.trim(),
        JSON.stringify(TRICKY_ARGUMENTS),
        'cmd /d /c <agent>.cmd passes &, |, <, >, ^, % and quotes through to the agent unchanged',
      );
    } else t.skip('end-to-end cmd.exe quoting run (not Windows, or the temp path has spaces)');

    t.section('plain shell sessions');
    const paths = { pwsh: 'C:/T/pwsh/pwsh.exe', powershell: 'C:/W/powershell.exe', cmd: 'C:/W/cmd.exe' };
    const noPwsh = { ...paths, pwsh: null };
    t.equal(
      [
        shellLaunch('auto', paths),
        shellLaunch('auto', noPwsh),
        shellLaunch('powershell', paths),
        shellLaunch('cmd', paths),
      ].map((l) => l.name + ' ' + commandLine(l.file, l.args)),
      [
        'pwsh C:/T/pwsh/pwsh.exe -NoLogo',
        'powershell C:/W/powershell.exe -NoLogo',
        'powershell C:/W/powershell.exe -NoLogo',
        'cmd C:/W/cmd.exe',
      ],
      'a shell runs by its absolute path: auto is pwsh when present, else Windows PowerShell; cmd takes no arguments',
    );
    await t.throws(
      () => shellLaunch('pwsh', noPwsh),
      'PowerShell 7 is not installed',
      'asking for pwsh where it is missing says so',
    );
  },
};

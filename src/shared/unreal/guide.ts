// The Unreal lines of the sandbox guide (the managed CLAUDE.md and AGENTS.md): which engine each project builds with
// and the plain commands an agent builds, tests, cooks, packages and debugs with. Pure, from the status the sandbox
// wrote (status.ts).
import path from 'node:path';
import type { UnrealStatus } from './status.js';
import { ORIGIN_LABELS } from './engines.js';

const win = path.win32;

export interface UnrealGuideProject {
  /** The project's folder in the sandbox. */
  readonly workspace: string;
  /** Its .uproject, when it has one. */
  readonly uproject: string | null;
}

/** The guide's Unreal lines for these projects (none when Unreal is not set up). */
export function unrealGuideLines(status: UnrealStatus, projects: readonly UnrealGuideProject[]): string[] {
  const lines: string[] = [];
  const several = projects.length > 1;
  for (const p of projects) {
    const choice = status.projects.find((s) => s.workspace.toLowerCase() === p.workspace.toLowerCase());
    const engine = choice?.engine ? status.engines.find((e) => e.dir.toLowerCase() === choice.engine!.toLowerCase()) : undefined;
    const name = several ? ' (' + win.basename(p.workspace) + ')' : '';
    if (engine)
      lines.push(
        '- Unreal' +
          name +
          ': engine ' +
          engine.id +
          ' ' +
          engine.version +
          ' at `' +
          engine.dir +
          '` (' +
          ORIGIN_LABELS[engine.origin] +
          '; ' +
          (choice?.reason ?? '') +
          '). `UE_ROOT` is set; Build.bat, RunUAT.bat, UnrealEditor.exe and UnrealEditor-Cmd.exe are on PATH.' +
          (engine.writable ? '' : ' Read-only: never install plugins into it; put them in the project\'s Plugins folder.'),
      );
    else if (choice) lines.push('- Unreal' + name + ': no engine for this project (' + choice.reason + ').');
  }
  if (!status.engines.length)
    lines.push(
      '- Unreal: no engine yet. Ask the user to install one with the Epic Games Launcher on their PC (the next sandbox maps it read-only), or to open the launcher here and sign in once: it installs into `' +
        (status.launcher.installLocation ?? 'the data disk') +
        '`, kept between sandboxes.',
    );
  else if (status.engines.length > 1)
    lines.push(
      '- Unreal engines here: ' +
        status.engines.map((e) => e.id + ' ' + e.version + (e.writable ? '' : ' (read-only)')).join(', ') +
        ". A project uses the one its .uproject's EngineAssociation names (a writable copy before this PC's read-only one), else the newest.",
    );
  if (!status.engines.length) return lines;
  const uproject = projects.find((p) => p.uproject)?.uproject ?? '<Project>.uproject';
  const project = win.basename(uproject, '.uproject');
  const q = '"' + uproject + '"';
  lines.push(
    '- Unreal commands: build `Build.bat ' +
      project +
      'Editor Win64 Development -Project=' +
      q +
      ' -WaitMutex -NoHotReload` (the game: `' +
      project +
      ' Win64 Development`); project files `Build.bat -projectfiles -project=' +
      q +
      ' -game -progress`; tests `UnrealEditor-Cmd.exe ' +
      q +
      ' -ExecCmds="Automation RunTests <filter>;Quit" -TestExit="Automation Test Queue Empty" -unattended -nullrhi -nosplash -nop4 -log`; package `RunUAT.bat BuildCookRun -project=' +
      q +
      ' -platform=Win64 -clientconfig=Development -build -cook -stage -pak -archive -archivedirectory=<folder> -nop4 -unattended -utf8output`.',
    '- Unreal logs: `<Project>\\Saved\\Logs`, the build tool `%LOCALAPPDATA%\\UnrealBuildTool\\Log.txt`, crashes `<Project>\\Saved\\Crashes\\*\\UEMinidump.dmp`' +
      (status.debugger
        ? '; debug a crash with `cdb -z "<UEMinidump.dmp>" -c "!analyze -v;q"` (attach: `cdb -p <pid>`; windbg is on PATH too)'
        : '') +
      '. The editor needs a GPU (vGPU); builds, -nullrhi tests and cooking do not.' +
      (status.ddc.dir ? ' Derived data cache: `' + status.ddc.dir + '` (kept).' : ''),
  );
  if (status.mcpUrl)
    lines.push(
      '- Unreal editor MCP: `sbx-unreal-editor` (' +
        status.mcpUrl +
        ') answers while the editor runs with the ModelContextProtocol and AllToolsets plugins on in the .uproject and `ModelContextProtocol.StartServer` run (or bAutoStartServer=True in Saved\\Config\\WindowsEditor\\EditorPerProjectUserSettings.ini, [/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]).',
    );
  return lines;
}

/** The short tool-summary line of a project's engine. */
export function unrealSummaryLine(status: UnrealStatus, workspace: string): string {
  const choice = status.projects.find((s) => s.workspace.toLowerCase() === workspace.toLowerCase());
  const engine = choice?.engine ? status.engines.find((e) => e.dir.toLowerCase() === choice.engine!.toLowerCase()) : undefined;
  if (engine) return 'unreal: ' + engine.id + ' ' + engine.version + ' (' + ORIGIN_LABELS[engine.origin] + ')';
  return status.engines.length
    ? 'unreal: no engine for this project (' + (choice?.reason ?? 'none matches') + ')'
    : 'unreal: no engine yet (sign in to the Epic Games Launcher once, or install one on your PC)';
}

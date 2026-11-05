// The Unity lines of the sandbox guide (the managed CLAUDE.md and AGENTS.md): which editor each project opens with and
// the plain commands an agent builds, tests and imports with. Pure, from the status the sandbox wrote (status.ts).
import path from 'node:path';
import { ORIGIN_LABELS } from './editors.js';
import type { UnityStatus } from './status.js';

const win = path.win32;

export interface UnityGuideProject {
  /** The project's folder in the sandbox. */
  readonly workspace: string;
}

function sameDir(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function exeOf(root: string): string {
  return win.join(root, 'Editor', 'Unity.exe');
}

/** The guide's Unity lines for these projects (none when Unity is not set up). */
export function unityGuideLines(status: UnityStatus, projects: readonly UnityGuideProject[]): string[] {
  const lines: string[] = [];
  const several = projects.length > 1;
  let first: { exe: string; workspace: string } | null = null;
  const bridges = new Set<string>();
  let withoutBridge = false;
  for (const p of projects) {
    const choice = status.projects.find((s) => sameDir(s.workspace, p.workspace));
    const editor = choice?.editor ? status.editors.find((e) => sameDir(e.root, choice.editor!)) : undefined;
    if (!choice || !editor) continue;
    const exe = exeOf(editor.root);
    const name = several ? ' (' + win.basename(p.workspace) + ')' : '';
    first ??= { exe, workspace: p.workspace };
    lines.push(
      '- Unity' +
        name +
        ': editor ' +
        editor.version +
        ' at `' +
        exe +
        '` (' +
        ORIGIN_LABELS[editor.origin] +
        '; ' +
        choice.reason +
        '). Build or run code without opening it: `"' +
        exe +
        '" -batchmode -nographics -quit -projectPath "' +
        p.workspace +
        '" -executeMethod <Class.Method> -logFile -`; tests: `-runTests -testPlatform EditMode -testResults <file>` (without -quit). Opening the project in another Unity version upgrades its files: never do that without asking the user.' +
        (editor.writable ? '' : " It is the user's PC copy, read-only: never add modules to it."),
    );
    if (choice.bridge) bridges.add(choice.bridge);
    else withoutBridge = true;
  }
  if (!lines.length) return lines;
  if (status.cli)
    lines.push(
      '- `unity` (Unity CLI ' +
        status.cli.version +
        ') is on PATH: `unity editors -i`, `unity build`, `unity test`, `unity open <project>` (opens it signed in).',
    );
  if (bridges.has('pipeline'))
    lines.push(
      '- The open editor can be driven with `unity command` and `unity eval` (Unity Pipeline package); MCP clients use sbx-unity.',
    );
  if (bridges.has('coplay')) lines.push('- The open editor can be driven with MCP for Unity (sbx-unity-mcp in Apps).');
  if (withoutBridge)
    lines.push(
      "- To drive a running editor (scenes, GameObjects, play mode) the project needs an editor bridge package: ask the user to add it on the sandbox tool's Unity page. Never change Packages/manifest.json yourself unless asked.",
    );
  if (status.pcAssets.length && first)
    lines.push(
      "- The user's Unity Asset Store downloads (read-only): `" +
        status.pcAssets[0] +
        '`; import one with the editor closed: `"' +
        first.exe +
        '" -batchmode -nographics -quit -projectPath "' +
        first.workspace +
        '" -importPackage "<file>"`.' +
        (status.assetCache.dir ? ' Downloads made here go to `' + status.assetCache.dir + '` (kept).' : ''),
    );
  if (status.licence.state !== 'active')
    lines.push(
      '- Unity licence: ' +
        status.licence.detail +
        ". Batch mode fails without one: ask the user to sign in to Unity on the sandbox tool's Unity page.",
    );
  return lines;
}

/** One line about a project's editor, for the status the agent and the page show. */
export function unitySummaryLine(status: UnityStatus, workspace: string): string {
  const choice = status.projects.find((s) => sameDir(s.workspace, workspace));
  if (!choice) return 'Unity: not set up for this project';
  const editor = choice.editor ? status.editors.find((e) => sameDir(e.root, choice.editor!)) : undefined;
  return editor
    ? 'Unity ' + editor.version + ' (' + ORIGIN_LABELS[editor.origin] + '; ' + choice.reason + ')'
    : 'Unity: no editor (' + choice.reason + ')';
}

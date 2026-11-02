import os from 'node:os';
import path from 'node:path';
import { runScriptWithJson } from '../runtime/process.js';

export interface Shortcut {
  readonly name: string;
  readonly exe: string;
  /** The program's command line (Comet's profile and DevTools port). */
  readonly args?: string;
}

/** Desktop and Start menu shortcuts, all in one PowerShell call (sandbox\scripts\new-shortcuts.ps1). */
export function shortcuts(apps: readonly Shortcut[]): void {
  if (!apps.length) return;
  const desktop = path.join(os.homedir(), 'Desktop');
  const start = path.join(
    process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Sandbox apps',
  );
  const links = apps.flatMap((app) => {
    const name = app.name.replace(/[\\/:*?"<>|]/g, '');
    return [desktop, start].map((folder) => ({
      link: path.join(folder, name + '.lnk'),
      target: app.exe,
      workingDirectory: path.dirname(app.exe),
      ...(app.args ? { arguments: app.args } : {}),
    }));
  });
  runScriptWithJson('new-shortcuts.ps1', 'ListFile', links);
}

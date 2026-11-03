// Agent add-ons in this sandbox: an add-on is plugged into the agents only while it is chosen (apps.install) AND its
// program is really there (a failed download adds no hook, proxy or MCP server that would fail on every use).
import fs from 'node:fs';
import path from 'node:path';
import { APPS, appById } from '../../shared/apps/index.js';
import { findExe } from '../apps/find-exe.js';
import { dryRun } from '../runtime/paths.js';
import { session } from '../runtime/session.js';
import { tool } from '../toolchains/tool-env.js';

/** The add-on's program when it is chosen and installed (a remote server: its folder once set up), else null. */
export function installedAddon(id: string): string | null {
  const entry = appById(id);
  if (dryRun || !entry || !(session.apps?.install ?? []).includes(id)) return null;
  if ('remote' in entry.source) {
    const folder = tool('apps', id);
    return fs.existsSync(path.join(folder, '.agent-sandbox-app')) ? folder : null;
  }
  return findExe(tool('apps', id), entry.exe);
}

/** rtk.exe when rtk is chosen and installed, else null. */
export function installedRtk(): string | null {
  return installedAddon('rtk');
}

/** The add-ons with an MCP server that are chosen and installed: their folder and program. */
export function installedMcpAddons(): { id: string; folder: string; exe: string }[] {
  return APPS.flatMap((a) => {
    const exe = a.mcp ? installedAddon(a.id) : null;
    return exe ? [{ id: a.id, folder: tool('apps', a.id), exe }] : [];
  });
}

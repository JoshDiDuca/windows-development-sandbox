// Claude Code managed settings for the sandbox (C:\Program Files\ClaudeCode\managed-settings.json). Managed settings
// have the highest precedence and cannot be overridden by user or project settings, so they carry the hard rules (the
// git access mode), the sandbox's own hooks (rtk, when it is installed) and the Headroom proxy's address while it runs
// (env.ANTHROPIC_BASE_URL). Rewritten every boot; removed when there is nothing to write. Your Claude settings from
// this PC are never changed for this.
import fs from 'node:fs';
import path from 'node:path';
import type { GitAccess } from '../../core/types.js';
import { claudeManagedSettings } from '../../shared/apps/index.js';
import { gitDenyRules } from './git-rules.js';
import { managedClaudeMd } from '../boot/guide.js';
import { installedRtk } from './agent-addons.js';
import { log } from '../runtime/log.js';

export function managedSettingsFile(): string {
  return path.join(path.dirname(managedClaudeMd()), 'managed-settings.json');
}

/** `headroom`: the proxy's base URL when it answered at this boot (null: Claude Code talks to the API directly). */
export function writeManagedSettings(access: GitAccess, headroom: string | null = null): void {
  const file = managedSettingsFile();
  const rtk = installedRtk();
  const settings = claudeManagedSettings(gitDenyRules(access), rtk, headroom);
  if (!settings) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  if (rtk) log("rtk: Claude Code's Bash commands go through it (hook in " + file + ')');
}

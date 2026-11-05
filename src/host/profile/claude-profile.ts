// Your Claude settings from this PC, staged into the launch folder for the sandbox with secrets stripped.
import fs from 'node:fs';
import path from 'node:path';
import type { ClaudeProfileConfig, ProfileResult } from '../../core/types.js';
import { dirExists, ensureDir, fileExists, homeDir, isLink, readJson, writeJson } from '../../core/util/index.js';
import { stripMcpServers, stripSettings, type SecretsConfig } from './secrets.js';

const MAX_BYTES = 250 * 1024 * 1024;

/** Real files only: a link inside ~/.claude (even a loop or a dead one) is neither followed nor counted nor copied. */
function directorySize(dir: string, keep: (full: string) => boolean = () => true): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (!keep(full)) continue;
    if (entry.isDirectory()) total += directorySize(full, keep);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

/** Plugin leftovers Claude never reads: interrupted clones (temp_*) and marketplace backups. */
function isPluginJunk(parts: readonly string[]): boolean {
  const top = parts[0]?.toLowerCase();
  const name = parts[1]?.toLowerCase() ?? '';
  return (
    parts.length >= 2 &&
    (top === 'cache' || top === 'marketplaces') &&
    (name.startsWith('temp_') || name.endsWith('.backup') || name.endsWith('.staging'))
  );
}

/**
 * Which parts of your plugins folder are staged, as a filter over full paths. Everything Claude needs to load a plugin
 * (installed_plugins.json, marketplaces, the plugin cache) is kept; when that is over the size cap, git history
 * (`.git`) and then `node_modules` are left out, and the guest's plugins restore what they need on first use.
 */
export function pluginFilter(source: string, level: 0 | 1 | 2): (full: string) => boolean {
  return (full: string): boolean => {
    if (full === source) return true;
    const parts = path.relative(source, full).split(path.sep);
    if (isPluginJunk(parts)) return false;
    if (level >= 1 && parts.includes('.git')) return false;
    if (level >= 2 && parts.includes('node_modules')) return false;
    return true;
  };
}

/** The least trimmed level at which the plugins folder fits the cap, or null when even the most trimmed does not. */
export function pluginTrimLevel(source: string): 0 | 1 | 2 | null {
  for (const level of [0, 1, 2] as const) {
    if (directorySize(source, pluginFilter(source, level)) <= MAX_BYTES) return level;
  }
  return null;
}

function validJson(file: string): boolean {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return true;
  } catch {
    return false;
  }
}

export function hostClaudeDir(settings: ClaudeProfileConfig): string {
  return settings.hostDir === 'auto'
    ? (process.env.CLAUDE_CONFIG_DIR ?? path.join(homeDir(), '.claude'))
    : settings.hostDir;
}

export function hostGlobalStateFile(settings: ClaudeProfileConfig): string {
  if (settings.globalStateFile !== 'auto') return settings.globalStateFile;
  return process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(homeDir(), '.claude.json');
}

/**
 * What of your .claude.json the sandbox gets: everything except secrets and other projects. API keys and the account
 * block stay on this PC (logins travel only through `sandbox account`), and of the per-project entries only
 * this workspace's (with its MCP servers) is kept; other projects' entries can hold their MCP servers' tokens.
 */
export function sandboxGlobalState(state: Record<string, unknown>, workspaceHost: string): Record<string, unknown> {
  const { primaryApiKey: _key, customApiKeyResponses: _responses, oauthAccount: _account, projects, ...rest } = state;
  const same = (key: string): boolean =>
    key.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
    workspaceHost.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const own = Object.entries((projects ?? {}) as Record<string, unknown>).filter(([key]) => same(key));
  return { ...rest, projects: Object.fromEntries(own) };
}

/**
 * Copies SELECTED Claude settings from this PC into the launch folder. Conversation history is handled
 * separately by history.ts (it needs path translation), and the login only travels when copyCredentials is on.
 */
export function stageClaudeProfile(
  settings: ClaudeProfileConfig,
  launchPath: string,
  workspaceHost: string,
  secrets: SecretsConfig,
): ProfileResult {
  const result: ProfileResult = { hostDir: null, staged: [], skipped: [], credentials: false, secretsRemoved: [] };
  if (!settings.enabled) return result;
  const hostDir = hostClaudeDir(settings);
  result.hostDir = hostDir;
  const target = path.join(launchPath, 'claude-profile');
  ensureDir(target);

  // The login goes only through copyCredentials (a project file asking for it is flagged); include never copies it.
  const items = settings.include.filter((name) => name.toLowerCase() !== '.credentials.json');
  if (settings.copyCredentials) items.push('.credentials.json');
  for (const name of items) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
      result.skipped.push(name + ' (invalid name)');
      continue;
    }
    const source = path.join(hostDir, name);
    const destination = path.join(target, name);
    if (fileExists(source)) {
      if (name.toLowerCase().endsWith('.json') && !validJson(source)) {
        result.skipped.push(name + ' (invalid JSON on host; fix or remove it)');
        continue;
      }
      // Claude's settings can carry credentials in "env" and commands that fetch them; those stay here.
      if (/^settings(.local)?.json$/i.test(name))
        writeJson(
          destination,
          stripSettings(readJson<Record<string, unknown>>(source), secrets, result.secretsRemoved),
        );
      else fs.copyFileSync(source, destination);
    } else if (dirExists(source)) {
      const level = name === 'plugins' ? pluginTrimLevel(source) : directorySize(source) > MAX_BYTES ? null : 0;
      if (level === null) {
        result.skipped.push(name + ' (over 250 MB)');
        continue;
      }
      const keep = name === 'plugins' ? pluginFilter(source, level) : (): boolean => true;
      fs.cpSync(source, destination, {
        recursive: true,
        force: true,
        filter: (from: string) => from === source || (!isLink(from) && keep(from)),
      });
    } else {
      result.skipped.push(name + ' (not found)');
      continue;
    }
    result.staged.push(name);
    if (name === '.credentials.json') result.credentials = true;
  }

  if (settings.globalStateFile !== '') {
    const globalFile = hostGlobalStateFile(settings);
    if (!fileExists(globalFile)) result.skipped.push('.claude.json (not found)');
    else if (!validJson(globalFile)) result.skipped.push('.claude.json (invalid JSON on host)');
    else {
      writeJson(
        path.join(target, '.claude.json'),
        stripMcpServers(
          sandboxGlobalState(readJson<Record<string, unknown>>(globalFile), workspaceHost),
          secrets,
          result.secretsRemoved,
        ),
      );
      result.staged.push('.claude.json');
    }
  }
  return result;
}

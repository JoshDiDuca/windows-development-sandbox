// Claude plugins carried between sandbox data sets when the account changes (claudeProfile.sharePluginsAcrossAccounts).
// One plugin set is kept in host-only storage (<storage>\accounts\shared-plugins): the plugins folder plus the plugin
// keys of settings.json. A data set that has plugins refreshes it; one that has none (a fresh data set) receives it.
// The sandbox wrote everything it holds: no links, bounded file count and size, nothing is executed, and logins
// (.credentials.json, .claude.json) never travel with it.
import fs from 'node:fs';
import path from 'node:path';
import { isSafeFileName } from '../../shared/paths/index.js';
import { safeRemove } from '../../shared/io/index.js';
import { assertNoLinks, ensureDir, errMsg, fail, fileExists, isLink, removeLink } from '../../core/util/index.js';
import { assertTestWritable } from '../test-guard.js';
import { readUntrusted, writeSandboxJson } from './claude-login.js';

/** The settings.json keys that belong to plugins; nothing else of settings.json is copied. */
export const PLUGIN_SETTING_KEYS = ['enabledPlugins', 'extraKnownMarketplaces'] as const;
export const MAX_PLUGIN_FILES = 20000;
export const MAX_PLUGIN_BYTES = 1024 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 24;
const INSTALLED = 'installed_plugins.json';
/** What Claude rewrites when a plugin or marketplace is added, removed or updated: equal files, same plugins. */
const RECORDS = [INSTALLED, 'known_marketplaces.json'] as const;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;

export type PluginShareResult = 'saved' | 'restored' | 'nothing';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Copies a plugins folder: every entry a plain file or folder with a safe name, within the file and size caps. */
export function copyPluginTree(from: string, to: string): void {
  let files = 0;
  let bytes = 0;
  const walk = (src: string, dest: string, depth: number): void => {
    if (depth > MAX_DEPTH) fail('The plugins folder is nested too deeply (' + from + ').', 'Remove the odd folders.');
    ensureDir(dest);
    for (const entry of fs.readdirSync(src)) {
      const file = path.join(src, entry);
      if (!isSafeFileName(entry)) fail('Plugin file name refused: ' + entry, 'Remove it from ' + from + '.');
      if (isLink(file)) fail('Refusing to copy plugins: ' + file + ' is a link.', 'Remove the link and try again.');
      const stat = fs.statSync(file);
      if (stat.isDirectory()) walk(file, path.join(dest, entry), depth + 1);
      else if (stat.isFile()) {
        files++;
        bytes += stat.size;
        if (files > MAX_PLUGIN_FILES || bytes > MAX_PLUGIN_BYTES)
          fail('The plugins are too big to copy between accounts.', 'Remove unused plugins and try again.');
        fs.copyFileSync(file, path.join(dest, entry));
      }
    }
  };
  walk(from, to, 0);
}

function pluginSettings(claudeDir: string): Record<string, unknown> {
  const settings = readUntrusted(path.join(claudeDir, 'settings.json'), MAX_SETTINGS_BYTES);
  const out: Record<string, unknown> = {};
  if (isObject(settings)) for (const key of PLUGIN_SETTING_KEYS) if (isObject(settings[key])) out[key] = settings[key];
  return out;
}

export class PluginShare {
  constructor(private readonly dir: string) {}

  /** The shared set kept next to the saved accounts of a storage folder. */
  static in(storageRoot: string): PluginShare {
    return new PluginShare(path.join(storageRoot, 'accounts', 'shared-plugins'));
  }

  /** When a sandbox ends: its plugins refresh the shared set. Never throws; returns the problem, if any. */
  saveQuietly(dataPath: string, claudeDir: string): string | null {
    try {
      if (PluginShare.hasPlugins(claudeDir) && !this.matches(claudeDir)) this.save(dataPath, claudeDir);
      return null;
    } catch (e) {
      return errMsg(e);
    }
  }

  private get pluginsDir(): string {
    return path.join(this.dir, 'plugins');
  }
  private get settingsFile(): string {
    return path.join(this.dir, 'settings.json');
  }

  hasShared(): boolean {
    return fileExists(path.join(this.pluginsDir, INSTALLED));
  }

  /** Whether a Claude folder (the sandbox's) has plugins installed. */
  static hasPlugins(claudeDir: string): boolean {
    const file = path.join(claudeDir, 'plugins', INSTALLED);
    return !isLink(path.join(claudeDir, 'plugins')) && !isLink(file) && fileExists(file);
  }

  /** The plugins of a data set's Claude folder become the shared set (replacing the old one). */
  save(dataPath: string, claudeDir: string): void {
    assertNoLinks(dataPath, path.join(claudeDir, 'plugins'));
    assertTestWritable(this.dir);
    const tmp = this.pluginsDir + '.new';
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      copyPluginTree(path.join(claudeDir, 'plugins'), tmp);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    fs.rmSync(this.pluginsDir, { recursive: true, force: true });
    fs.renameSync(tmp, this.pluginsDir);
    writeSandboxJson(this.settingsFile, pluginSettings(claudeDir));
  }

  /** The shared set goes into a data set's Claude folder; its own settings win, its other settings are untouched. */
  restore(dataPath: string, claudeDir: string): void {
    assertNoLinks(dataPath, claudeDir);
    const target = path.join(claudeDir, 'plugins');
    ensureDir(claudeDir);
    if (isLink(target)) removeLink(target);
    else safeRemove(target, claudeDir);
    copyPluginTree(this.pluginsDir, target);
    const shared = readUntrusted(this.settingsFile, MAX_SETTINGS_BYTES);
    if (!isObject(shared)) return;
    const file = path.join(claudeDir, 'settings.json');
    const own = readUntrusted(file, MAX_SETTINGS_BYTES);
    if (own !== null && !isObject(own)) return;
    const merged: Record<string, unknown> = { ...(own ?? {}) };
    for (const key of PLUGIN_SETTING_KEYS)
      if (isObject(shared[key])) merged[key] = { ...shared[key], ...(isObject(merged[key]) ? merged[key] : {}) };
    writeSandboxJson(file, merged);
  }

  /**
   * Whether the shared set already holds this Claude folder's plugins: the same plugin records and plugin settings.
   * Copying a big plugins folder takes seconds, so a switch between accounts with the same plugins skips it.
   */
  matches(claudeDir: string): boolean {
    if (!this.hasShared()) return false;
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    for (const name of RECORDS) {
      const own = readUntrusted(path.join(claudeDir, 'plugins', name), MAX_RECORD_BYTES);
      if (!same(own, readUntrusted(path.join(this.pluginsDir, name), MAX_RECORD_BYTES))) return false;
    }
    const shared = readUntrusted(this.settingsFile, MAX_SETTINGS_BYTES);
    return same(pluginSettings(claudeDir), isObject(shared) ? shared : {});
  }

  /** One step when an account is switched to. */
  sync(dataPath: string, claudeDir: string): PluginShareResult {
    if (PluginShare.hasPlugins(claudeDir)) {
      if (this.matches(claudeDir)) return 'nothing';
      this.save(dataPath, claudeDir);
      return 'saved';
    }
    if (this.hasShared()) {
      this.restore(dataPath, claudeDir);
      return 'restored';
    }
    return 'nothing';
  }
}

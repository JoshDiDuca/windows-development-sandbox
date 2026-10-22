// One config file being edited: your own settings, or a project's .sandbox-config.json. One setting is changed at a
// time through jsonc-parser, so comments and formatting stay, and nothing is written unless the whole file is still
// valid.
import fs from 'node:fs';
import path from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import _ from 'lodash';
import { DEFAULTS, loadConfig, mergeConfig, userConfigPath } from '../../../core/config/index.js';
import { LOCAL_CONFIG_NAME } from '../../../core/local-config/index.js';
import { ConfigSchema, describeIssues, LocalOverridesSchema } from '../../../core/schema/index.js';
import type { Config } from '../../../core/types.js';
import { SchemaNode } from '../../kernel/index.js';

/** The user's own config, or a project's .sandbox-config.json (a smaller schema; nothing is merged with defaults). */
export type SettingsTarget = 'user' | 'project';

/** What the value is in this JSON text (undefined when it is not set there). */
export function fileValue(text: string, key: string[]): unknown {
  return _.get(parse(text) ?? {}, key);
}

/**
 * Applies one change (undefined = remove the line, back to the default) to config text and returns the new text, or
 * the problems that make the result invalid. Pure; ConfigFile writes it.
 */
export function editConfigText(
  text: string,
  key: string[],
  value: unknown,
  target: SettingsTarget = 'user',
): { text: string } | { problems: string[] } {
  // Removing a setting the file does not have changes nothing (jsonc-parser throws on it).
  const edits =
    value === undefined && fileValue(text || '{}', key) === undefined
      ? []
      : modify(text || '{}', key, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } });
  const next = applyEdits(text || '{}', edits);
  const parsed =
    target === 'project'
      ? LocalOverridesSchema.safeParse(parse(next) ?? {})
      : ConfigSchema.safeParse(mergeConfig(DEFAULTS, parse(next) ?? {}));
  return parsed.success
    ? { text: next.endsWith('\n') ? next : next + '\n' }
    : { problems: describeIssues(parsed.error) };
}

/** One setting to change (value undefined = remove the line, back to the default). */
export interface SettingChange {
  readonly key: string[];
  readonly value: unknown;
}

export class ConfigFile {
  readonly schema: SchemaNode;
  /** The file as read in this synchronous run (see read). */
  private snapshot: { text: string; parsed: unknown } | undefined;

  constructor(
    readonly target: SettingsTarget,
    readonly file: string,
  ) {
    this.schema = new SchemaNode(target === 'project' ? LocalOverridesSchema : ConfigSchema);
  }

  static user(configPath: string | null): ConfigFile {
    return new ConfigFile('user', configPath ?? userConfigPath());
  }
  static project(dir: string): ConfigFile {
    return new ConfigFile('project', path.join(dir, LOCAL_CONFIG_NAME));
  }

  get isProject(): boolean {
    return this.target === 'project';
  }
  get exists(): boolean {
    return fs.existsSync(this.file);
  }
  text(): string {
    return this.read().text;
  }

  /** The value written in this file (undefined = not set here). */
  valueInFile(key: string[]): unknown {
    const value: unknown = _.get(this.read().parsed, key);
    // A copy: the parsed file is shared by every read in this run.
    return value !== null && typeof value === 'object' ? structuredClone(value) : value;
  }

  /**
   * The file's text and what it parses to, read once per synchronous run: the settings list asks for every setting's
   * value (hundreds of reads), and the next run (after a key, a save or a change outside) reads the file again.
   */
  private read(): { text: string; parsed: unknown } {
    if (!this.snapshot) {
      const text = this.exists ? fs.readFileSync(this.file, 'utf8') : '';
      this.snapshot = { text, parsed: parse(text) ?? {} };
      queueMicrotask(() => (this.snapshot = undefined));
    }
    return this.snapshot;
  }

  /** Your own settings with the built-in defaults filled in (what a sandbox uses without a project file). */
  userConfig(): Config {
    const file = this.isProject ? userConfigPath() : this.file;
    try {
      return loadConfig(fs.existsSync(file) ? file : undefined).config;
    } catch {
      return loadConfig(undefined).config;
    }
  }

  /** What is in effect: for your file the merged config, for a project file only what the file sets. */
  effective(key: string[], config: Config = this.userConfig()): unknown {
    return this.isProject ? this.valueInFile(key) : _.get(config, key);
  }

  defaultOf(key: string[]): unknown {
    return _.get(DEFAULTS, key);
  }

  /**
   * Saves one setting. In your own file a value equal to the default is removed instead (no line needed). Returns
   * 'unchanged', 'saved', or the problems that stopped it.
   */
  set(key: string[], value: unknown): 'unchanged' | 'saved' | { problems: string[] } {
    return this.setMany([{ key, value }]);
  }

  /** Saves several settings with one write, keeping comments; nothing is written unless every change is valid. */
  setMany(changes: readonly SettingChange[]): 'unchanged' | 'saved' | { problems: string[] } {
    const original = this.text();
    let text = original;
    const config = this.isProject ? undefined : this.userConfig();
    for (const { key, value } of changes) {
      const next = !this.isProject && value !== undefined && _.isEqual(value, this.defaultOf(key)) ? undefined : value;
      if (_.isEqual(next, fileValue(text, key)) && (config === undefined || _.isEqual(value, _.get(config, key))))
        continue;
      const result = editConfigText(text, key, next, this.target);
      if ('problems' in result) return result;
      text = result.text;
    }
    if (text === original) return 'unchanged';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, text, 'utf8');
    this.snapshot = undefined;
    return 'saved';
  }
}

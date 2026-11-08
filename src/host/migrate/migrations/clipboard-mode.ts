// 1.29 makes sandbox.clipboard a mode ("text", "shared" or "off") instead of true / false. Old values still load
// (true = "text", false = "off"); this writes the word into config.json so the file says what it means (comments stay).
import _ from 'lodash';
import type { Migration, MigrationContext } from '../migration.js';
import { readFileObject, setValue, type Json } from './config-file.js';

const CLIPBOARD = ['sandbox', 'clipboard'];

/** The old true / false in a config file, or null. */
export function legacyClipboard(file: Json): boolean | null {
  const v: unknown = _.get(file, CLIPBOARD);
  return typeof v === 'boolean' ? v : null;
}

export const clipboardMode: Migration = {
  id: '2026-11-clipboard-mode',
  introducedIn: '1.29.0',
  scope: 'user',
  needsIdleSandbox: false,
  summary: 'Writes sandbox.clipboard as "text" or "off" instead of true or false.',

  applies(ctx: MigrationContext): boolean {
    const file = readFileObject(ctx.configPath);
    return file !== null && legacyClipboard(file) !== null;
  },

  touches(ctx: MigrationContext): readonly string[] {
    return ctx.configPath ? [ctx.configPath] : [];
  },

  async run(ctx: MigrationContext, note: (line: string) => void): Promise<void> {
    const file = readFileObject(ctx.configPath);
    const value = file ? legacyClipboard(file) : null;
    if (!ctx.configPath || value === null) return;
    const mode = value ? 'text' : 'off';
    setValue(ctx.configPath, CLIPBOARD, mode);
    note('sandbox.clipboard: ' + String(value) + ' -> "' + mode + '"');
  },
};

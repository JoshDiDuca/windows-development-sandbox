// What the launch decided for the clipboard (host-only, <storage>\sync\<set>-clipboard.json): the watcher runs the
// bridge from it and sandbox attach decides whether the agent's copy (OSC 52) may reach this PC.
import { z } from 'zod';
import type { ClipboardPlan } from '../../core/clipboard.js';
import { CLIPBOARD_MODES } from '../../core/schema/index.js';
import { JsonFile } from '../../shared/io/index.js';
import { hostStateFile } from '../storage/index.js';

export const ClipboardSettingsSchema = z.object({
  mode: z.enum(CLIPBOARD_MODES),
  bridge: z.boolean(),
  toPc: z.boolean(),
  toSandbox: z.boolean(),
});
export type ClipboardSettings = z.output<typeof ClipboardSettingsSchema>;

const settingsFile = (storageRoot: string, dataPath: string): JsonFile<ClipboardSettings> =>
  new JsonFile(ClipboardSettingsSchema, hostStateFile(storageRoot, dataPath, '-clipboard.json'));

export function saveClipboardSettings(storageRoot: string, dataPath: string, plan: ClipboardPlan): void {
  settingsFile(storageRoot, dataPath).write({
    mode: plan.mode,
    bridge: plan.bridge,
    toPc: plan.toPc,
    toSandbox: plan.toSandbox,
  });
}

/** null when the launch wrote none (a sandbox started before the upgrade) or the file is damaged. */
export function readClipboardSettings(storageRoot: string, dataPath: string): ClipboardSettings | null {
  return settingsFile(storageRoot, dataPath).read();
}

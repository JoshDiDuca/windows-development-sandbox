// What a project WANTS at boot (a .wsb device you allowed for it, more memory, its mappings) and the running sandbox
// started without. Those can only come with a restart, so they are named (missingAtBoot), and a sandbox started with
// several projects boots with all of their allowed wants (widenForProjects). Pure.
import _ from 'lodash';
import type { Config, ResolvedMapping } from '../types.js';
import { protectionsOf, type Protections } from './policy.js';
import { strictness } from './overrides.js';

/** .wsb devices a project may want on (only when your settings or your answer for that project allow it). */
export const BOOT_SETTINGS = [
  'sandbox.vGpu',
  'sandbox.networking',
  'sandbox.clipboard',
  'sandbox.audioInput',
  'sandbox.videoInput',
  'sandbox.printerRedirection',
];
const LABELS: Readonly<Record<string, string>> = {
  'sandbox.vGpu': 'vGPU',
  'sandbox.networking': 'networking',
  'sandbox.clipboard': 'a wider clipboard',
  'sandbox.audioInput': 'the microphone',
  'sandbox.videoInput': 'the camera',
  'sandbox.printerRedirection': 'printers',
};

/** What the running sandbox booted with (host-only registry). */
export interface BootRecord {
  memoryMb: number | null;
  mappings: ResolvedMapping[];
}

/** What a project wants that the running sandbox started without. */
export interface Missing {
  settings: string[];
  memoryMb: number | null;
  mappings: ResolvedMapping[];
}

/** A project mapped at boot besides the launch folder, with its effective config. */
export interface BootWant {
  name: string;
  config: Config;
}

export interface Widened {
  config: Config;
  /** Setting -> the project it was turned on for. */
  widened: Record<string, string>;
  notes: string[];
}

function sameHost(a: string, b: string): boolean {
  return a.toLowerCase().replace(/\\+$/, '') === b.toLowerCase().replace(/\\+$/, '');
}

/** `m`'s folder is mapped, wherever the launch placed it (read-only is enough for a read-only wish). */
function isMapped(mapped: readonly ResolvedMapping[], m: { host: string; readOnly: boolean }): boolean {
  return mapped.some((x) => sameHost(x.host, m.host) && (m.readOnly || !x.readOnly));
}

function listing(items: readonly string[]): string {
  return items.length <= 1 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

/**
 * The boot-only things `config` (a project's effective config: your settings, its approved file, your answers) asks
 * for that the running sandbox lacks. `exists`: optional mappings whose folder is missing are no wish.
 */
export function missingAtBoot(
  running: Protections,
  boot: BootRecord,
  config: Config,
  exists: (folder: string) => boolean = () => true,
): Missing {
  const memory = config.sandbox.memoryMb;
  const wanted = protectionsOf(config);
  return {
    settings: BOOT_SETTINGS.filter((s) => strictness(s, wanted[s]) < strictness(s, running[s])),
    memoryMb: typeof memory === 'number' && boot.memoryMb !== null && memory > boot.memoryMb ? memory : null,
    mappings: config.mappings
      .filter((m) => (!m.optional || exists(m.host)) && !isMapped(boot.mappings, m))
      .map((m) => ({ host: m.host, guest: m.guest ?? m.host, readOnly: m.readOnly })),
  };
}

export function nothingMissing(m: Missing): boolean {
  return m.settings.length === 0 && m.memoryMb === null && m.mappings.length === 0;
}

/** "mw2-agent wants vGPU and 2 folders (C:\Steam\..., F:\SteamLibrary\...), but this sandbox started without them." */
export function describeMissing(project: string, m: Missing): string {
  const folders = m.mappings.length
    ? [
        m.mappings.length +
          ' folder' +
          (m.mappings.length === 1 ? '' : 's') +
          ' (' +
          m.mappings.map((x) => x.host).join(', ') +
          ')',
      ]
    : [];
  const items = [
    ...m.settings.map((s) => LABELS[s] ?? s),
    ...(m.memoryMb !== null ? [m.memoryMb + ' MB of memory'] : []),
    ...folders,
  ];
  const pronoun = items.length === 1 && !m.mappings.length ? 'it' : 'them';
  return project + ' wants ' + listing(items) + ', but this sandbox started without ' + pronoun + '.';
}

/** "Set sandbox.vGpu (or the mappings) in your own settings to have them in every sandbox." */
export function missingTip(m: Missing): string {
  const keys = [...m.settings, ...(m.memoryMb !== null ? ['sandbox.memoryMb'] : [])];
  const what = keys.length ? listing(keys) + (m.mappings.length ? ' (or the mappings)' : '') : 'the mappings';
  return 'Set ' + what + ' in your own settings to have them in every sandbox.';
}

/**
 * The launch folder's config plus what the other projects mapped at boot want: their allowed .wsb devices, a fixed
 * memory size larger than the launch's, and their mappings (placed with every other mapping at launch).
 * `keepOff`: devices the launch folder's own .sandbox-config.json switched off; they stay off.
 */
export function widenForProjects(
  launch: Config,
  others: readonly BootWant[],
  opts: { keepOff?: readonly string[]; exists?: (folder: string) => boolean } = {},
): Widened {
  const keepOff = opts.keepOff ?? [];
  const exists = opts.exists ?? ((): boolean => true);
  const config = _.cloneDeep(launch);
  const widened: Record<string, string> = {};
  const notes: string[] = [];
  for (const setting of BOOT_SETTINGS) {
    const looser = others.filter(
      (o) => strictness(setting, _.get(o.config, setting)) < strictness(setting, _.get(config, setting)),
    );
    const by = _.minBy(looser, (o) => strictness(setting, _.get(o.config, setting)));
    if (!by) continue;
    const label = LABELS[setting] ?? setting;
    if (keepOff.includes(setting)) {
      notes.push(
        by.name +
          ' wants ' +
          label +
          ", but the launch folder's .sandbox-config.json switches it off, so it stays off.",
      );
      continue;
    }
    const value: unknown = _.get(by.config, setting);
    _.set(config, setting, value);
    widened[setting] = by.name;
    if (setting === 'sandbox.clipboard' && config.sandbox.clipboard === 'shared')
      widened['sandbox.protectedClient'] = by.name;
    notes.push(
      label +
        (typeof value === 'string' ? ' is "' + value + '"' : ' is on') +
        ' in this sandbox (for every project in it): ' +
        by.name +
        ' asks for it and you allowed it.',
    );
  }
  for (const o of others) {
    const mem = o.config.sandbox.memoryMb;
    if (typeof mem === 'number' && typeof config.sandbox.memoryMb === 'number' && mem > config.sandbox.memoryMb)
      config.sandbox.memoryMb = mem;
    for (const m of o.config.mappings) {
      if (config.mappings.some((x) => sameHost(x.host, m.host))) continue;
      if (m.optional && !exists(m.host)) continue;
      if (!exists(m.host)) {
        notes.push(o.name + ': mapped folder not found, skipped: ' + m.host);
        continue;
      }
      // Where it appears (and moving it when that place is taken) is decided with every other mapping at launch.
      config.mappings.push({ ...m, optional: true });
    }
  }
  return { config, widened, notes };
}

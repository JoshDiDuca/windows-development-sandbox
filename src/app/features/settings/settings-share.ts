// Sharing your settings: the part of them that differs from the defaults, as a .json a team can pass around, and the
// reverse (read a file, show what it would change, apply the rest). Secrets (anything the schema marks), the data
// folder and folders or files of this PC never go into a file and are never taken from one. Node side (lodash,
// core/schema): the settings run functions use these; the menu and the web only see the operations.
import { parse, type ParseError } from 'jsonc-parser';
import _ from 'lodash';
import { DEFAULTS, mergeConfig } from '../../../core/config/index.js';
import { ConfigSchema, describeIssues, secretPaths } from '../../../core/schema/index.js';
import type { Config } from '../../../core/types.js';
import { pathKindOf } from '../../kernel/index.js';
import type { SettingChange } from './settings-file.js';

/** Settings that are about this PC and never travel (the data folder). */
const MACHINE_ONLY: readonly string[] = ['storage.root'];

/** A folder or file of this PC: a drive path, a network path, a rooted path or a %VARIABLE% path. */
const ABSOLUTE = /^([a-zA-Z]:[\\/]|\\\\|\/|%)/;

/** Why something was left out. */
export interface Skipped {
  readonly key: string;
  readonly why: 'secret' | 'path' | 'machine';
}

export interface Pruned {
  readonly data: Record<string, unknown>;
  readonly skipped: Skipped[];
}

const WHY_TEXT: Readonly<Record<Skipped['why'], string>> = {
  secret: 'a secret, never shared',
  path: 'a folder or file of this PC',
  machine: 'this PC only',
};

/** One line for a skipped setting. */
export function skippedLine(s: Skipped): string {
  return s.key + ' (' + WHY_TEXT[s.why] + ')';
}

const isSecret = (trail: readonly string[]): boolean =>
  secretPaths().some((p) => p.length === trail.length && p.every((part, i) => part === '*' || part === trail[i]));

/**
 * `value` without secrets, machine-only settings and (unless `withPaths`) folders and files of this PC. A list item
 * that holds such a path is dropped whole. `trail` is the key path, with * for a list item.
 */
function prune(value: unknown, trail: string[], withPaths: boolean, skipped: Skipped[]): unknown {
  const name = (): string => trail.join('.').replace(/\.\*/g, '[]');
  if (isSecret(trail)) {
    skipped.push({ key: name(), why: 'secret' });
    return undefined;
  }
  if (MACHINE_ONLY.includes(trail.join('.'))) {
    skipped.push({ key: name(), why: 'machine' });
    return undefined;
  }
  const isPath = !withPaths && pathKindOf(trail.filter((p) => p !== '*')) !== undefined;
  if (typeof value === 'string') {
    if (isPath && ABSOLUTE.test(value)) {
      skipped.push({ key: name(), why: 'path' });
      return undefined;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    for (const item of value) {
      const before = skipped.length;
      const out = prune(item, [...trail, '*'], withPaths, skipped);
      // A list item that lost a path (a folder entry without its folder) means nothing any more.
      const lostPath = skipped.slice(before).some((x) => x.why !== 'secret');
      if (out !== undefined && !lostPath) kept.push(out);
    }
    return kept.length || value.length === 0 ? kept : undefined;
  }
  if (_.isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = prune(v, [...trail, k], withPaths, skipped);
      if (next !== undefined) out[k] = next;
    }
    return _.isEmpty(out) && !_.isEmpty(value) ? undefined : out;
  }
  return value;
}

/** What `value` has that `base` does not (undefined when nothing). Lists and plain values are compared whole. */
function differences(value: unknown, base: unknown): unknown {
  if (_.isPlainObject(value) && _.isPlainObject(base)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const d = differences(v, (base as Record<string, unknown>)[k]);
      if (d !== undefined) out[k] = d;
    }
    return _.isEmpty(out) ? undefined : out;
  }
  return _.isEqual(value, base) ? undefined : value;
}

/** Your settings as a shareable object: only what differs from the defaults, without secrets or (by default) paths. */
export function exportSettings(config: Config, withPaths: boolean): Pruned {
  const skipped: Skipped[] = [];
  const diff = differences(config, DEFAULTS) ?? {};
  const data = (prune(diff, [], withPaths, skipped) ?? {}) as Record<string, unknown>;
  return { data, skipped };
}

/** One changed setting in a diff: old -> new. */
export interface DiffLine {
  readonly key: string[];
  readonly from: unknown;
  readonly to: unknown;
}

export interface ImportPlan {
  /** What would change (empty: nothing). */
  readonly changes: SettingChange[];
  readonly lines: DiffLine[];
  readonly skipped: Skipped[];
  /** Why the file cannot be imported at all (not JSON, not settings). */
  readonly problems: string[];
}

/** The leaves of an object as key paths; lists and plain values are leaves. */
function leaves(value: unknown, key: string[] = []): { key: string[]; value: unknown }[] {
  if (_.isPlainObject(value) && !_.isEmpty(value))
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => leaves(v, [...key, k]));
  return key.length ? [{ key, value }] : [];
}

/**
 * Reads a shared settings file and works out what importing it would do to `current` (your settings with defaults).
 * Pure: nothing is written.
 */
export function planImport(text: string, current: Config): ImportPlan {
  const none = { changes: [], lines: [], skipped: [] };
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length || !_.isPlainObject(parsed))
    return { ...none, problems: ['The file is not a settings file (a JSON object is expected).'] };
  const raw = _.omit(parsed as Record<string, unknown>, '$schema');
  const skipped: Skipped[] = [];
  const safe = (prune(raw, [], false, skipped) ?? {}) as Record<string, unknown>;
  const checked = ConfigSchema.safeParse(mergeConfig(DEFAULTS, safe));
  if (!checked.success) return { ...none, skipped, problems: describeIssues(checked.error) };
  const changes: SettingChange[] = [];
  const lines: DiffLine[] = [];
  for (const { key, value } of leaves(safe)) {
    const from = _.get(current, key) as unknown;
    if (_.isEqual(from, value)) continue;
    changes.push({ key, value });
    lines.push({ key, from, to: value });
  }
  return { changes, lines, skipped, problems: [] };
}

/** A value as one short piece of text for a diff. */
function show(value: unknown): string {
  if (value === undefined) return '(not set)';
  const text = JSON.stringify(value);
  return text.length > 60 ? text.slice(0, 57) + '...' : text;
}

/** The diff as plain lines: `key: old -> new`. */
export function diffText(lines: readonly DiffLine[]): string[] {
  return lines.map((l) => l.key.join('.') + ': ' + show(l.from) + ' -> ' + show(l.to));
}

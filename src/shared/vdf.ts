// Valve's KeyValues text format (.vdf: libraryfolders.vdf, appmanifest_*.acf, config.vdf, app_build and
// workshop_item scripts), parsed with hard limits on size, depth and keys (the files may come from a sandbox or a
// repo). One pass over the text, no regular expressions on it, no recursion, objects without a prototype. Pure.

export type VdfValue = string | VdfObject;
export interface VdfObject {
  readonly [key: string]: VdfValue;
}

export interface VdfLimits {
  /** The most characters read (default 1 MB). */
  readonly maxBytes?: number;
  /** The deepest nesting of { } (default 32). */
  readonly maxDepth?: number;
  /** The most keys in the whole text (default 100000). */
  readonly maxKeys?: number;
  /**
   * Backslash escapes in quoted text (\\ \" \n \t; default true), as Steam writes libraryfolders.vdf and config.vdf.
   * Hand-written build scripts ("ContentRoot" "..\content\") need false.
   */
  readonly escapes?: boolean;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_KEYS = 100_000;

type Token = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'open' } | { readonly kind: 'close' };

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f';
const ESCAPED: Readonly<Record<string, string>> = { '\\': '\\', '"': '"', n: '\n', t: '\t' };

/** The tokens of a text, or null when a quote or a [condition] is not closed. */
function tokenize(text: string, escapes: boolean): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (isSpace(c)) {
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '{') {
      tokens.push({ kind: 'open' });
      i++;
    } else if (c === '}') {
      tokens.push({ kind: 'close' });
      i++;
    } else if (c === '[') {
      // A platform condition ([$WIN32]) after a value: not used here, skipped.
      const end = text.indexOf(']', i);
      if (end < 0) return null;
      i = end + 1;
    } else if (c === '"') {
      let out = '';
      let start = ++i;
      for (;;) {
        if (i >= n) return null;
        const d = text[i];
        if (d === '"') break;
        if (escapes && d === '\\' && i + 1 < n && ESCAPED[text[i + 1]] !== undefined) {
          out += text.slice(start, i) + ESCAPED[text[i + 1]];
          i += 2;
          start = i;
          continue;
        }
        i++;
      }
      tokens.push({ kind: 'text', text: out + text.slice(start, i) });
      i++;
    } else {
      const start = i;
      while (i < n && !isSpace(text[i]) && text[i] !== '{' && text[i] !== '}' && text[i] !== '"') i++;
      tokens.push({ kind: 'text', text: text.slice(start, i) });
    }
  }
  return tokens;
}

/** An object being filled, with the keys it has in lower case (KeyValues keys are case-insensitive). */
interface Open {
  readonly target: Record<string, VdfValue>;
  readonly seen: Set<string>;
}

function open(): Open {
  return { target: Object.create(null) as Record<string, VdfValue>, seen: new Set() };
}

/** Sets a key unless the object has it already in any case (the first one wins); false when it was there. */
function setFirst(o: Open, key: string, value: VdfValue): boolean {
  const lower = key.toLowerCase();
  if (o.seen.has(lower)) return false;
  o.seen.add(lower);
  o.target[key] = value;
  return true;
}

/** The root object of a .vdf text, or null when it is not one (or breaks a limit). */
export function parseVdf(text: string, limits: VdfLimits = {}): VdfObject | null {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxKeys = limits.maxKeys ?? DEFAULT_MAX_KEYS;
  if (typeof text !== 'string' || text.length > maxBytes) return null;
  const tokens = tokenize(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, limits.escapes ?? true);
  if (!tokens) return null;
  const root = open();
  const stack: Open[] = [root];
  let keys = 0;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const current = stack[stack.length - 1];
    if (token.kind === 'close') {
      if (stack.length === 1) return null;
      stack.pop();
      i++;
      continue;
    }
    if (token.kind === 'open') return null;
    if (++keys > maxKeys) return null;
    const next = tokens[i + 1];
    if (!next || next.kind === 'close') return null;
    if (next.kind === 'open') {
      if (stack.length > maxDepth) return null;
      const child = open();
      // A duplicate key's block is still read (into one that is dropped) so the braces stay balanced.
      setFirst(current, token.text, child.target);
      stack.push(child);
    } else {
      setFirst(current, token.text, next.text);
    }
    i += 2;
  }
  return stack.length === 1 ? root.target : null;
}

/** The value at a path of keys (any case), or undefined. */
export function vdfGet(root: VdfValue | null | undefined, ...keys: readonly string[]): VdfValue | undefined {
  let at: VdfValue | undefined = root ?? undefined;
  for (const key of keys) {
    if (at === undefined || typeof at === 'string') return undefined;
    const lower = key.toLowerCase();
    let found: VdfValue | undefined;
    for (const k in at)
      if (k.toLowerCase() === lower) {
        found = at[k];
        break;
      }
    at = found;
  }
  return at;
}

/** The text at a path of keys (any case), or undefined when it is missing or a block. */
export function vdfText(root: VdfValue | null | undefined, ...keys: readonly string[]): string | undefined {
  const value = vdfGet(root, ...keys);
  return typeof value === 'string' ? value : undefined;
}

/** The block at a path of keys (any case), or undefined when it is missing or a text. */
export function vdfObject(root: VdfValue | null | undefined, ...keys: readonly string[]): VdfObject | undefined {
  const value = vdfGet(root, ...keys);
  return value !== undefined && typeof value !== 'string' ? value : undefined;
}

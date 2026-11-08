// Reading a zod schema the way forms need it: what is a section, what kind of editor fits a value, its range, what a
// new entry starts as. Nothing is listed by hand, so a new setting or option shows up in every form on its own.
// fields.ts turns these into Field descriptors; the menu's editors also use a node for checking values as you type.
import type { z } from 'zod';

type Def = {
  type: string;
  options?: ZodLike[];
  values?: unknown[];
  entries?: Record<string, string>;
  element?: ZodLike;
  innerType?: ZodLike;
  keyType?: ZodLike;
  valueType?: ZodLike;
  defaultValue?: unknown;
  in?: ZodLike;
  out?: ZodLike;
};
type ZodLike = z.ZodType & {
  _zod: { def: Def };
  shape?: Record<string, ZodLike>;
  description?: string;
  minValue?: number | null;
  maxValue?: number | null;
  isInt?: boolean;
};
type NumberCheck = { _zod: { def: { check?: string; value?: number; inclusive?: boolean } } };

/** The editor a setting gets. */
export type EditorKind =
  | 'boolean'
  | 'choice'
  | 'union'
  | 'number'
  | 'string'
  | 'string-list'
  | 'choice-list'
  | 'object-list'
  | 'string-map'
  | 'object-map'
  | 'object'
  | 'json';

/** Settings never shown (the link to the JSON Schema). */
const HIDDEN = new Set(['$schema']);

export class SchemaNode {
  readonly schema: ZodLike;

  constructor(schema: unknown) {
    this.schema = schema as ZodLike;
  }

  /** The real type under optional() / default() / nullable() / transforms. */
  get inner(): ZodLike {
    let s = this.schema;
    for (;;) {
      const def = s._zod.def;
      if (['optional', 'default', 'nullable', 'prefault', 'readonly'].includes(def.type) && def.innerType)
        s = def.innerType;
      else if (def.type === 'pipe' && def.in)
        // z.preprocess: a transform in front of the real schema (the form edits what comes out of it).
        s = def.in._zod.def.type === 'transform' && def.out ? def.out : def.in;
      else return s;
    }
  }

  get type(): string {
    return this.inner._zod.def.type;
  }
  /** A group of settings (an object with known fields), opened rather than edited. */
  get isSection(): boolean {
    return this.type === 'object' && Boolean(this.inner.shape);
  }
  /** The description, which .partial() / .optional() wrappers may carry on the inner schema instead. */
  get description(): string | undefined {
    return this.schema.description ?? this.inner.description;
  }
  get min(): number | undefined {
    return this.inner.minValue ?? undefined;
  }
  get max(): number | undefined {
    return this.inner.maxValue ?? undefined;
  }
  /** A number that must be whole. */
  get integer(): boolean {
    return Boolean(this.inner.isInt);
  }
  /** A secret (an API key): shown as ***, typed with each character hidden. */
  get secret(): boolean {
    const meta = (z: ZodLike): { secret?: boolean } | undefined =>
      (z as unknown as { meta?: () => { secret?: boolean } | undefined }).meta?.();
    return meta(this.schema)?.secret === true || meta(this.inner)?.secret === true;
  }
  /** May the setting be left out (optional or with a default)? */
  get optional(): boolean {
    return ['optional', 'default'].includes(this.schema._zod.def.type);
  }

  /** The numbers allowed, in words: "1 to 65535", "at least 2048", "more than 0", "" without limits. */
  rangeText(): string {
    const checks = ((this.inner._zod.def as { checks?: NumberCheck[] }).checks ?? []).map((c) => c._zod.def);
    const lower = checks.find((c) => c.check === 'greater_than');
    const upper = checks.find((c) => c.check === 'less_than');
    const lo = lower?.value;
    const hi = upper?.value;
    if (lo !== undefined && hi !== undefined && lower?.inclusive !== false && upper?.inclusive !== false)
      return lo + ' to ' + hi;
    const low = lo === undefined ? '' : (lower?.inclusive === false ? 'more than ' : 'at least ') + lo;
    const high = hi === undefined ? '' : (upper?.inclusive === false ? 'less than ' : 'at most ') + hi;
    return [low, high].filter(Boolean).join(' and ');
  }

  /** The fields of an object, in schema order. */
  children(): [string, SchemaNode][] {
    return Object.entries(this.inner.shape ?? {})
      .filter(([name]) => !HIDDEN.has(name))
      .map(([name, s]) => [name, new SchemaNode(s)]);
  }

  child(name: string): SchemaNode | undefined {
    const s = this.inner.shape?.[name];
    return s ? new SchemaNode(s) : undefined;
  }

  /** Every setting below this one that has an editor of its own (not a section), with its path. */
  leaves(key: string[] = []): { key: string[]; node: SchemaNode }[] {
    return this.children().flatMap(([name, child]) =>
      child.isSection ? child.leaves([...key, name]) : [{ key: [...key, name], node: child }],
    );
  }

  /** Array items, or a map's values. */
  get element(): SchemaNode | undefined {
    const def = this.inner._zod.def;
    return def.type === 'array' && def.element
      ? new SchemaNode(def.element)
      : def.type === 'record' && def.valueType
        ? new SchemaNode(def.valueType)
        : undefined;
  }

  /** Union members. */
  get options(): SchemaNode[] {
    return (this.inner._zod.def.options ?? []).map((o) => new SchemaNode(o));
  }

  /** The values an enum or literal allows. */
  get choices(): unknown[] {
    const def = this.inner._zod.def;
    if (def.type === 'enum') return Object.values(def.entries ?? {});
    if (def.type === 'literal') return def.values ?? [];
    return [];
  }

  get editor(): EditorKind {
    const type = this.type;
    if (type === 'boolean') return 'boolean';
    if (type === 'enum' || type === 'literal') return 'choice';
    if (type === 'union')
      return this.options.every((o) => ['literal', 'enum', 'boolean'].includes(o.type)) ? 'choice' : 'union';
    if (type === 'number' || type === 'string') return type;
    const element = this.element;
    if (type === 'array' && element)
      return element.type === 'string'
        ? 'string-list'
        : element.type === 'enum'
          ? 'choice-list'
          : element.type === 'object'
            ? 'object-list'
            : 'json';
    if (type === 'record' && element)
      return ['string', 'number', 'boolean'].includes(element.type)
        ? 'string-map'
        : element.type === 'object'
          ? 'object-map'
          : 'json';
    if (type === 'object') return 'object';
    return 'json';
  }

  /** Every value a choice allows (booleans of a union included). */
  get choiceValues(): unknown[] {
    if (this.type !== 'union') return this.choices;
    return this.options.flatMap((o) => (o.type === 'boolean' ? [true, false] : o.choices));
  }

  /** The member of a union that is not a fixed value (a number, a string ...), edited after "Custom...". */
  get openOption(): SchemaNode | undefined {
    return this.options.find((o) => !['literal', 'enum', 'boolean'].includes(o.type));
  }

  /**
   * What a new entry (in a list or a map) starts as: the default if there is one, otherwise the simplest valid shape.
   */
  initial(): unknown {
    const def = this.schema._zod.def;
    if (def.type === 'default') return structuredClone(def.defaultValue);
    switch (this.type) {
      case 'boolean':
        return false;
      case 'number':
        return this.min ?? 0;
      case 'string':
        return '';
      case 'enum':
      case 'literal':
        return this.choices[0];
      case 'union':
        return this.options[0]?.initial();
      case 'array':
        return [];
      case 'record':
        return {};
      case 'object':
        return Object.fromEntries(
          this.children()
            .filter(([, c]) => !['optional', 'default'].includes(c.schema._zod.def.type))
            .map(([name, c]) => [name, c.initial()]),
        );
      default:
        return null;
    }
  }

  /** Is `value` acceptable here on its own? (The whole file is checked again when it is saved.) */
  check(value: unknown): true | string {
    const result = this.schema.safeParse(value);
    return result.success
      ? true
      : result.error.issues.map((i) => (i.path.length ? i.path.join('.') + ': ' : '') + i.message).join('; ');
  }
}

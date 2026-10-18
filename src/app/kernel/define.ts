// The three things a feature defines, once: an operation (does something), a query (reads something, maybe live) and a
// view (what a screen shows, built from queries). Definitions are pure data plus pure functions, typed from their zod
// schemas, so the web bundle can import them; the Node side attaches the run function with implement().
import type { z } from 'zod';
import { fail } from '../../core/util/errors.js';
import { issuesText } from './errors.js';
import type { OperationIO } from './io.js';
import type { Page } from './view.js';

export type SurfaceName = 'cli' | 'menu' | 'web';
export const SURFACE_NAMES: readonly SurfaceName[] = ['cli', 'menu', 'web'];

/** Where a definition is offered: everywhere, or everywhere but these surfaces (each with the reason). */
export type Surfaces = 'all' | { readonly except: Readonly<Partial<Record<SurfaceName, string>>> };

/** The command groups of `sandbox --help` (and the menu's command list). */
export type CommandGroup = 'Agents' | 'Sessions' | 'Projects & accounts' | 'Data' | 'Web' | 'Health' | 'Advanced';

/** Lists filled in at run time (the menu's command form offers them). */
export type DynamicChoices = 'harnesses' | 'accounts' | 'sessions';

/** How one input field is spelled on the command line (the description comes from the schema's .describe()). */
export interface CliFlag {
  readonly flag: `--${string}`;
  readonly short?: `-${string}`;
  /** The name --help shows; `flag` stays accepted as a hidden alias. */
  readonly shownAs?: `--${string}`;
  /** Placeholder in --help (name for --agent <name>). */
  readonly value?: string;
  readonly choices?: DynamicChoices | readonly string[];
  readonly noMenu?: boolean;
  readonly advanced?: boolean;
  readonly label?: string;
}

/** The command line for a definition: a command of its own, or an action of an existing command (`config get`). */
export interface CliHint {
  readonly name: string;
  readonly action?: string;
  /** Required for a command of its own. */
  readonly group?: CommandGroup;
  /** --help's one line (default: the definition's summary). */
  readonly summary?: string;
  /** Input fields given as positional arguments, in order (after the action, if any). */
  readonly positional?: readonly string[];
  readonly flags?: Readonly<Record<string, CliFlag | undefined>>;
  /** The command takes -y/--yes, which answers its confirmations; the text is its --help line. */
  readonly yes?: string;
  /** Offers --json. */
  readonly json?: boolean;
  /** Shapes what --json prints (kept as the command printed it before the core); default: the output. */
  shapeJson?(output: unknown): unknown;
  /** The command's exit code for this output (default 0). */
  exitCode?(output: unknown): number;
  readonly examples?: readonly string[];
}

/** A CliHint as written in a definition: field names checked against the input, the output typed. */
export interface TypedCliHint<I, O> extends Omit<CliHint, 'positional' | 'flags' | 'shapeJson' | 'exitCode'> {
  readonly positional?: readonly (keyof I & string)[];
  readonly flags?: { readonly [K in keyof I]?: CliFlag };
  shapeJson?(output: O): unknown;
  exitCode?(output: O): number;
}

interface Definition<Id extends string, I extends z.ZodType, O extends z.ZodType> {
  readonly id: Id;
  /** Menu row, web button or heading, CLI summary. */
  readonly title: string;
  readonly summary: string;
  readonly input: I;
  readonly output: O;
  /** Default: every surface. */
  readonly surfaces?: Surfaces;
  readonly cli?: CliHint;
  /** The output in one text: what an operation did, or a value a query read (CLI output, menu notice, web note). */
  text?(output: z.output<O>): string;
  /** The next step to suggest after the text, CLI only (a dimmed "Next:" line); menu and web ignore it. */
  next?(output: z.output<O>): string | undefined;
}

/** What a definition is written as: its CLI hint typed against its own schemas. */
type Written<D extends Definition<string, z.ZodType, z.ZodType>> = Omit<D, 'kind' | 'cli'> & {
  readonly cli?: TypedCliHint<z.input<D['input']>, z.output<D['output']>>;
};

export interface OperationDef<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
  Id extends string = string,
> extends Definition<Id, I, O> {
  readonly kind: 'operation';
  /** Shown as dangerous (red); it asks for its own confirmation through io.confirm. */
  readonly danger?: boolean;
}

export interface QueryDef<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
  Id extends string = string,
> extends Definition<Id, I, O> {
  readonly kind: 'query';
  /** Read again this often while shown (the menu's status line and the web's subscriptions use the same rule). */
  readonly live?: { readonly everyMs: number };
}

export type AnyDefinition = OperationDef | QueryDef;
export type InputOf<D extends AnyDefinition> = z.output<D['input']>;
export type OutputOf<D extends AnyDefinition> = z.output<D['output']>;

export type QueryMap = Readonly<Record<string, QueryDef>>;
export type ViewData<Q extends QueryMap> = { readonly [K in keyof Q]: z.output<Q[K]['output']> };
export type ViewInputs<Q extends QueryMap> = { readonly [K in keyof Q]?: z.input<Q[K]['input']> };

/** The tabs of a view: which parameter they set, and its values. */
export interface ViewTabs<P> {
  readonly param: keyof P & string;
  readonly choices: readonly { readonly value: string; readonly label: string }[];
}

export interface ViewDef<Q extends QueryMap = QueryMap, P = Record<string, never>, Id extends string = string> {
  readonly kind: 'view';
  readonly id: Id;
  readonly title: string;
  readonly summary: string;
  readonly queries: Q;
  /** Every operation the page may offer (the parity check reads this). */
  readonly operations: readonly OperationDef[];
  /** Queries its inputs read while you fill them in (the web's folder picker reads files.browse). */
  readonly pickers?: readonly QueryDef[];
  /** A parameter switched with tabs above the page (Settings: all projects or this project), first choice default. */
  readonly tabs?: ViewTabs<P>;
  /** Parameters taken from the address as they are (the log shown), besides the tabs' one. */
  readonly params?: readonly (keyof P & string)[];
  /** The input of each query for these view parameters (default: each query's defaults). */
  inputs?(params: P): ViewInputs<Q>;
  /** Pure: query results in, a Page out. */
  build(data: ViewData<Q>, params: P): Page;
}

export function defineOperation<const Id extends string, I extends z.ZodType, O extends z.ZodType>(
  def: Written<OperationDef<I, O, Id>>,
): OperationDef<I, O, Id> {
  return { ...def, cli: def.cli as CliHint | undefined, kind: 'operation' };
}

export function defineQuery<const Id extends string, I extends z.ZodType, O extends z.ZodType>(
  def: Written<QueryDef<I, O, Id>>,
): QueryDef<I, O, Id> {
  return { ...def, cli: def.cli as CliHint | undefined, kind: 'query' };
}

/** Any view, whatever its parameters (a list of views, a view looked up by id); call build with the right ones. */
export type AnyView = ViewDef<QueryMap, never>;

export function defineView<const Id extends string, Q extends QueryMap, P = Record<string, never>>(
  def: Omit<ViewDef<Q, P, Id>, 'kind'>,
): ViewDef<Q, P, Id> {
  return { ...def, kind: 'view' };
}

/** Why a definition is not on a surface, or undefined when it is. */
export function exemption(def: { readonly surfaces?: Surfaces }, surface: SurfaceName): string | undefined {
  return def.surfaces === undefined || def.surfaces === 'all' ? undefined : def.surfaces.except[surface];
}

export function onSurface(def: { readonly surfaces?: Surfaces }, surface: SurfaceName): boolean {
  return exemption(def, surface) === undefined;
}

/** A definition with its run function (Node side). `Ctx` is what the program gives every run (app/context.ts). */
export interface Implementation<D extends AnyDefinition = AnyDefinition, Ctx = unknown> {
  readonly def: D;
  run(ctx: Ctx, input: InputOf<D>, io: OperationIO): Promise<OutputOf<D>>;
}

/** Binds implement() to the program's context type once (app/context.ts), so features write implement(def, run). */
export function implementer<Ctx>() {
  return function implement<D extends AnyDefinition>(
    def: D,
    run: (ctx: Ctx, input: InputOf<D>, io: OperationIO) => Promise<OutputOf<D>> | OutputOf<D>,
  ): Implementation<D, Ctx> {
    return { def, run: async (ctx, input, io) => run(ctx, input, io) };
  };
}

/** The input as the definition reads it (defaults filled in); a value that does not fit says what is wrong. */
export function parseInput<D extends AnyDefinition>(def: D, input: unknown): InputOf<D> {
  const parsed = def.input.safeParse(input ?? {});
  if (!parsed.success) fail('That does not work for ' + def.title.toLowerCase() + ': ' + issuesText(parsed.error));
  return parsed.data as InputOf<D>;
}

/** Runs an implementation the way every surface must: input checked before, output checked after. */
export async function invoke<D extends AnyDefinition, Ctx>(
  impl: Implementation<D, Ctx>,
  ctx: Ctx,
  input: unknown,
  io: OperationIO,
): Promise<OutputOf<D>> {
  const output = await impl.run(ctx, parseInput(impl.def, input), io);
  return impl.def.output.parse(output) as OutputOf<D>;
}

/** The inputs a view's queries run with for these parameters (defaults filled in). */
export function viewInputs<Q extends QueryMap, P>(view: ViewDef<Q, P>, params: P): { [K in keyof Q]: unknown } {
  const given: ViewInputs<Q> = view.inputs?.(params) ?? {};
  return Object.fromEntries(
    Object.entries(view.queries).map(([name, query]) => [name, parseInput(query, given[name as keyof Q])]),
  ) as { [K in keyof Q]: unknown };
}

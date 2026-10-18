# 11 · Engine

Read [00-worked-example.md](00-worked-example.md) first. This file only says what is special about the engine area.

## What it does today

`sandbox engine [show]` prints the engine in use and, for each engine (Windows Sandbox, HCS), whether this PC can run
it and what it can do; `sandbox engine check [engine]` explains what this PC lacks, with the fixes, and exits 1 when
the engine cannot be used. Read-only: nothing is changed. The menu does not offer it today.

## Files today

| File | What it does |
| --- | --- |
| `src/cli/commands/engine.ts` | the hand-written command: `engine()` (show, `--json`) and `checkEngine()` (check, `--json`, exit 1 when not available); `CAPABILITY_NAMES` (the 10 capability labels) |
| `src/host/engines/registry.ts` | `engineReports(config, hcsProbes = realHcsProbes())` -> `EngineReport[]` (`{ id, inUse, capabilities, check }`), always `windows-sandbox` then `hcs` |
| `src/host/engines/types.ts` | `EngineId`, `EngineCapabilities` (10 booleans: `desktop`, `gpu`, `clipboard`, `audio`, `video`, `printers`, `liveFolderAdd`, `attachedDisks`, `multipleInstances`, `hvsocket`), `EngineCheck` (`{ available, reasons, fixes }`) |
| `src/host/engines/hcs/check.ts` | `checkHcs(probes)`, `realHcsProbes()` (runs `sc query` and `whoami /groups` with `spawnSync`) |
| `src/host/engines/windows-sandbox/engine.ts` | `WindowsSandboxEngine.capabilities()` and `check()` |
| `src/cli/manifest.ts` (entry `name: 'engine'`, around line 389; the file is being edited by another change, search for it) | the command spec |
| `src/cli/commands/registry.ts` | `engine: engine` in `HANDLERS` |

`src/cli/commands/repair/engine.ts` is **not** this area: it is the doctor/repair check runner (area 7).

## CLI surface to keep

Manifest entry today (keep it, see "Registration"):

```ts
{
  name: 'engine',
  summary: '(beta) what runs your sandbox (Windows Sandbox or HCS) and what each engine can do on this PC',
  group: 'Health',
  examples: [
    'sandbox engine                  the engine in use and what each can do',
    'sandbox engine check hcs        what this PC lacks for the HCS engine, and the commands that would fix it',
  ],
  args: [
    { name: 'action', description: 'show or check', required: false, choices: ['show', 'check'] },
    { name: 'engine', description: 'the engine to check', required: false, choices: ['windows-sandbox', 'hcs'], when: 'check' },
  ],
  options: [],
  json,
}
```

| Command | Today |
| --- | --- |
| `sandbox engine` / `sandbox engine show` | `--json`: `{ engine: <id in use>, engines: EngineReport[] }`, exit 0. Text: `Engine in use: <id>  (setting: sandbox.engine)`, then per engine a blank line, `<id>` (+ `  (in use)`), `  can be used on this PC` (green) or `  cannot be used yet` (yellow), each reason indented, each fix as `  Fix: <fix>`, and a table of the 10 capabilities (`desktop window`, `GPU`, `clipboard`, `audio`, `camera`, `printers`, `add folders while running`, `attached disks`, `several at once`, `Hyper-V sockets`) with `yes`/`no`. Exit 0 |
| `sandbox engine check [engine]` | engine defaults to `hcs`. Unknown: `fail('Unknown engine: <x>', 'Use windows-sandbox or hcs.')`. `--json`: the one `EngineReport`, **exit 0 when available, 1 when not**. Text available: `<id> can be used on this PC.` (+ for hcs `HCS is in alpha: starting it is not enabled yet (docs/design/engines.md).`), exit 0. Text not available: `<id> cannot be used on this PC yet:`, then per reason `\n  <n>. <reason>` and `     To fix: <fix or 'see docs/design/engines.md'>`, then `\nNothing was changed. These commands change Windows, so they are yours to run (or not).`, **exit 1** |

docs/commands.md (line 132) documents "Exit code 1 when the engine cannot be used": keep it.

Tests that run the command (both through `f.runBin`, with `AGENT_SANDBOX_HOST_ONLY: '1'`):

- `src/selftest/engine.test.ts:201-216`, section `sandbox engine`, check "sandbox engine --json names the engine in use
  and both engines": `run.status === 0`, `parsed.engine === 'windows-sandbox'`, ids `windows-sandbox,hcs`.
- `src/selftest/hcs.test.ts:617-631`, section `sandbox engine check hcs`, check "the command prints the check in plain
  words with the fixes": output matches `/hcs can be used|hcs cannot be used on this PC yet/` and
  `(out.status === 0 || out.out.includes('To fix:'))`.
- `src/selftest/engine.test.ts:136-144` "sandbox engine lists both engines; the HCS check says what this PC lacks"
  tests `engineReports` directly (unchanged).

## Menu surface to keep

None today (the Maintenance page's `MORE_COMMANDS` is `['sync', 'audit', 'config', 'generate', 'exec', 'agent-commands']`,
no engine). This area **adds** a Maintenance category "Engine" (see "Registration").

## Kernel change this area needs: a command's exit code

The shared core has no way to say "exit 1" today (`definitionHandler` in `src/cli/operations/handler.ts` always
returns 0). Add one optional hook to the CLI hint:

- `src/app/kernel/define.ts`, `interface CliHint`: add
  `/** The command's exit code for this output (default 0). */ exitCode?(output: unknown): number;`
  and in `TypedCliHint` add `'exitCode'` to the `Omit<...>` list and `exitCode?(output: O): number;`.
- `src/cli/operations/handler.ts`, `definitionHandler`: after `runDefinition`, `const code = def.cli?.exitCode?.(output) ?? 0;`
  and return `code` instead of `0` in both the `--json` branch and after `printOutput`.

Add a check to `app.test.ts` for it (see "Tests"). If another area already added this hook, use it.

## Definitions to write (`src/app/features/engine/engine.def.ts`)

```ts
import { z } from 'zod';
import { defineQuery, defineView, type Fact, type Item, type Page, type Section } from '../../kernel/index.js';

const EngineIdSchema = z.enum(['windows-sandbox', 'hcs']).describe('The engine');

export const CapabilitiesSchema = z.object({
  desktop: z.boolean().describe('desktop window'),
  gpu: z.boolean().describe('GPU'),
  clipboard: z.boolean().describe('clipboard'),
  audio: z.boolean().describe('audio'),
  video: z.boolean().describe('camera'),
  printers: z.boolean().describe('printers'),
  liveFolderAdd: z.boolean().describe('add folders while running'),
  attachedDisks: z.boolean().describe('attached disks'),
  multipleInstances: z.boolean().describe('several at once'),
  hvsocket: z.boolean().describe('Hyper-V sockets'),
});

/** The labels, in this order (moved from CAPABILITY_NAMES in commands/engine.ts). */
export const CAPABILITY_NAMES = { desktop: 'desktop window', gpu: 'GPU', /* ... the same 10 */ } as const;

export const EngineReportSchema = z.object({
  id: EngineIdSchema,
  inUse: z.boolean().describe('sandbox.engine names it'),
  capabilities: CapabilitiesSchema.describe('What it can do'),
  check: z
    .object({
      available: z.boolean().describe('This PC can run it'),
      reasons: z.array(z.string()).describe('Why not, in plain words'),
      fixes: z.array(z.string()).describe('The command that fixes each reason (never run for you)'),
    })
    .describe('Whether this PC can run it'),
});
export type EngineReportRow = z.output<typeof EngineReportSchema>;

export const EnginesSchema = z.object({
  engine: EngineIdSchema.describe('The engine in use (setting sandbox.engine)'),
  engines: z.array(EngineReportSchema).describe('Every engine'),
});
export type Engines = z.output<typeof EnginesSchema>;

export const engineStatus = defineQuery({
  id: 'engine.status',
  title: 'Engine',
  summary: 'the engine in use and what each engine can do on this PC',
  input: z.object({}),
  output: EnginesSchema,
  cli: { name: 'engine', action: 'show', json: true },   // --json: { engine, engines } as before
});

export const checkEngine = defineQuery({
  id: 'engine.check',
  title: 'Check an engine',
  summary: 'what this PC lacks for an engine, and the commands that would fix it',
  input: z.object({ engine: z.string().default('hcs').describe('the engine to check') }),
  output: EngineReportSchema,
  surfaces: {
    except: {
      menu: "the Engine category shows every engine's check with its fixes (engine.status)",
      web: "the Engine page shows every engine's check with its fixes (engine.status)",
    },
  },
  text: (r) => checkText(r),               // several lines; CLI only (menu and web are exempt)
  cli: {
    name: 'engine',
    action: 'check',
    positional: ['engine'],
    json: true,
    exitCode: (r) => (r.check.available ? 0 : 1),
  },
});

/** The lines `sandbox engine check` prints, joined with \n (exactly the old words, without colours). */
export function checkText(r: EngineReportRow): string { /* see "CLI surface to keep" */ }

export function enginePage(o: Engines): Page { /* below */ }

export const engineView = defineView({
  id: 'engine',
  title: 'Engine',
  summary: 'What runs your sandbox, and what each engine can do on this PC.',
  queries: { engines: engineStatus },      // exactly one query: `sandbox engine` prints this page
  operations: [],
  build: ({ engines }) => enginePage(engines),
});
```

Why `engine` is `z.string()` and not the enum: an unknown name must keep failing with `Unknown engine: <x>` /
`Use windows-sandbox or hcs.` (from the run); a zod enum would fail earlier with a different text. The hand-written
manifest arg keeps `choices: ['windows-sandbox', 'hcs']` for `--help` and the menu form.

`enginePage(o)`:

- `notice: { text: 'Engine in use: ' + o.engine + '  (setting: sandbox.engine)' }` (the CLI prints it first, bold).
- One section per engine: `id: r.id`, `title: r.id + (r.inUse ? '  (in use)' : '')`,
  `summary: r.check.available ? 'can be used on this PC' : 'cannot be used yet'`,
  `facts`: the 10 capabilities in `CAPABILITY_NAMES` order, `value: 'yes' | 'no'` (`tone: 'muted'` for no),
  `items`: each reason `{ id: 'reason:' + i, label: reason, tone: 'warn' }` then each fix
  `{ id: 'fix:' + i, label: 'Fix: ' + fix }`.
- No actions, no `empty` (there are always two engines).

The CLI text of `sandbox engine` changes layout a little (title and availability on one line, capabilities before the
reasons, the table not indented): no test asserts it; `--json` is unchanged. Say so in the report.

## Run functions (`src/app/features/engine/engine.run.ts`)

- `engineStatusRun(ctx)`: `const reports = await engineReports(ctx.loaded.config)`;
  return `{ engine: reports.find((r) => r.inUse)?.id ?? ctx.loaded.config.sandbox.engine, engines: reports }`.
  No `requireOnPc` (it never had one). No questions.
- `checkEngineRun(ctx, input)`: `const report = (await engineReports(ctx.loaded.config)).find((r) => r.id === input.engine)`;
  missing -> `fail('Unknown engine: ' + input.engine, 'Use windows-sandbox or hcs.')`; return `report`.

`engineReports` returns readonly arrays; spread them (`[...r.check.reasons]`) if TypeScript complains about the
output type.

## Registration and wiring

- `src/app/features/engine/index.ts` barrel; `defs.ts`: `engineStatus, checkEngine` in `QUERIES`, `engineView` in
  `VIEWS` (import `./engine/engine.def.js`); `registry.ts`: `engineStatusRun, checkEngineRun`.
- **CLI**: `engine` stays a hand-written manifest entry, unchanged (both hints are `action`s of it). `sandbox engine`
  with no action does not match an action (`definitionFor` needs `positionals[0] === action`), so
  `src/cli/commands/engine.ts` becomes a forwarder:

  ```ts
  /** `sandbox engine` with no action is `sandbox engine show` (show and check themselves run as definitions). */
  export function engine(ctx: Context): Promise<number> {
    return definitionHandler(engineStatus)(ctx);
  }
  ```

  An unknown action or engine name never gets here: commander checks positional `choices`
  (`src/cli/args.ts`: "fixed choices are checked by the parser"). The `Unknown engine` failure in the run is for other
  callers.
- **Menu**: `MENU_VIEWS` gets `{ view: engineView, section: 'Maintenance' }`. In `src/cli/menu/pages/maintenance-page.ts`
  add a category before `more`: `{ id: 'engine', label: 'Engine', description: 'What runs your sandbox, and what each engine can do on this PC.' }`.
  The checks run `sc` and `whoami` synchronously, so do not read them in `load()`: keep `engine: Engines | null` in the
  page; while null the category shows one row `{ value: 'engine:load', label: 'Look at the engines', category: 'engine' }`
  (Enter label `check`); Enter on it sets `this.engine = await readQuery(engineStatus, this.ctx)`. Then the rows are
  `menuView(enginePage(this.engine), { category: 'engine', prefix: 'engine:', refresh: false }).items`, and the key
  bar for the category is `[{ key: 'l', label: 'check again' }]` (reads it again). Follow however areas 4, 7, 8 and 9
  reshaped the page (one category view each); if they introduced a helper for "a category that loads on demand", use it.
- **Web**: a child of Maintenance (the Maintenance parent comes from area 4, 04-data.md; nesting from area 2):
  `{ label: 'Engine', view: 'engine' }`.

## Web page

`/v/engine`: the notice "Engine in use: windows-sandbox  (setting: sandbox.engine)", then one card per engine titled
with its id, its availability as the summary, the capabilities as yes/no facts (a two-column grid; fine at 360 px),
and the reasons and "Fix: …" lines as rows. No buttons: fixes are commands the user runs; nothing is run for them.
Not live (reading it runs `sc` and `whoami`). No new Field kind, question or target.

## Delete or shrink afterwards

- `src/cli/commands/engine.ts`: shrinks to the forwarder (`CAPABILITY_NAMES`, `checkEngine` and the printing go).
- docs/commands.md lines 132-133: still true; update only if you changed a text.

## Tests

Keep passing: `npm test -- engine,hcs,app` ("sandbox engine --json names the engine in use and both engines", "the
command prints the check in plain words with the fixes", "sandbox engine lists both engines; ...").

Add (in `src/selftest/app.test.ts`, `t.section('engine')`):

- "engine page: the engine in use first, a card per engine, reasons and fixes" — build `enginePage` from a sample with
  hcs unavailable (`reasons: ['computecore.dll is missing']`, `fixes: ['Enable-WindowsOptionalFeature ...']`);
  `pageLines(page)[0]` is `Engine in use: windows-sandbox  (setting: sandbox.engine)`; lines include
  `Fix: Enable-WindowsOptionalFeature ...`; `pageActions(page)` is empty.
- "engine check text: the old words, numbered, with the fixes" — `checkText(unavailable)` includes
  `hcs cannot be used on this PC yet:`, `  1. computecore.dll is missing`, `     To fix: ` and
  `Nothing was changed.`; `checkText(available hcs)` includes `HCS is in alpha`.
- "a CLI hint can set the exit code" — `checkEngine.cli?.exitCode?.(unavailable) === 1` and `=== 0` for an available
  one. Also, with a throwaway `defineQuery` + `implementer`, nothing else: the handler change is covered by
  `hcs.test.ts` running the real command (exit 1 when HCS is missing).
- "engine and check are actions of engine" — `commandSpec('engine')?.args[0].choices` includes `show` and `check`, and
  `definitionFor('engine', ['check'])?.id === 'engine.check'`, `definitionFor('engine', []) === undefined`.

## Pitfalls

- **Exit code**: without the `exitCode` hook, `sandbox engine check hcs` would exit 0 on a PC that cannot run HCS. The
  hcs test would still pass (it accepts `status === 0`), so nothing catches it but you. Implement the hook.
- `engine.check` has a multi-line `text`: that is fine only because it is exempt on the menu and the web (their notice
  and notification are one line). Do not offer it on a page.
- `realHcsProbes()` uses `spawnSync`: in the web server it blocks the server for up to its timeouts while it runs.
  Acceptable for a page that is opened on purpose; never make `engine.status` live.
- Text from `engineReports` is written by our own host code (no sandbox text), so no `safeText` is needed; keep it that
  way (do not add guest data to it).
- The self-test runs inside a Windows Sandbox: HCS is never available there, so tests must use sample reports, not
  real checks, for anything they assert about availability.

## Checklist

1. Kernel: `exitCode` in `define.ts` + `handler.ts` (if not already there).
2. `engine.def.ts`, `engine.run.ts`, `index.ts`; `defs.ts`, `registry.ts`.
3. Forwarder in `commands/engine.ts`; Maintenance category; `MENU_VIEWS`; NAV child.
4. Commands (see [00-worked-example.md#commands-to-run](00-worked-example.md#commands-to-run)):

```
npm run build
npm run lint
npm run format:check
npm test -- app,engine,hcs,menu
npm test
```

`npm test` must print `ALL TESTS PASSED`. By hand: `node dist/bin/agent-sandbox.js engine --json`, `... engine`,
`... engine check hcs; echo $?` (expect 1 in the sandbox), `... engine --help`. Re-read
[00-worked-example.md#common-mistakes](00-worked-example.md#common-mistakes) and
[00-worked-example.md#writing-a-run-test](00-worked-example.md#writing-a-run-test).

## Report template

```
Area 11 (engine) — branch web-ui/engine
Moved: sandbox engine show/check -> src/app/features/engine (engine.status, engine.check, view engine)
Kernel: CliHint.exitCode added (define.ts, handler.ts) / already there
Deleted/shrunk: src/cli/commands/engine.ts -> forwarder
Menu: new Maintenance category "Engine" (loads on Enter)
Web: Maintenance > Engine
CLI text changes (with reason): sandbox engine layout ...; unknown action ...
Tests added: ...
Unsure / left undone: ...
```

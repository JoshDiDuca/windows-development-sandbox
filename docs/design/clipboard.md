# Clipboard modes: design and work plan

## Summary
- **Cause.** `sandbox.clipboard = true` writes `<ClipboardRedirection>Enable</ClipboardRedirection>`, and `<ProtectedClient>Enable</ProtectedClient>` comes from the default. Protected Client filters the RDP clipboard, so copying never works. Nothing in the code says these two settings conflict.
- **Fix.** `sandbox.clipboard` becomes a mode: `"text"` (default), `"shared"` or `"off"`.
  - `"text"` is our own text bridge. It goes through `<data>\clipboard\`, a folder next to `run\` that only the owner can use. It keeps Protected Client on, writes ClipboardRedirection **Disable**, and follows a foreground-window rule.
  - `"shared"` is Windows Sandbox's own clipboard. That launch turns Protected Client off and says so in one line.
  - `"off"` means no clipboard at all.
- **New setting** `sandbox.clipboardDirection`: `"both"`, `"toPc"` or `"toSandbox"`.
- **Old config values.** Legacy booleans are converted by a zod preprocess and by a config migration.
- **Work split.** Five packages: four for Sonnet, one for Haiku (docs).

Everything below was decided after reading the code. Paths are relative to `C:\Projects\AgentProjects\windows-sandbox`.

---

## 1. Why this fixes it
1. **"text" (default) no longer uses the RDP clipboard.**
   - The .wsb gets ClipboardRedirection Disable, so rdpclip no longer replaces the guest clipboard with an empty "Terminal Services Private Data" announcement.
   - Text moves through files that the host watcher (`src/sync/watcher.ts`) and the guest daemon both already poll.
   - Protected Client does not touch this path, so it stays on.
   - The HCS engine has no window, so "text" there means copy and paste through attached terminals (OSC 52 out, typed paste in). There is no bridge for HCS.
2. **"shared" really is shared.** Protected Client is the thing that blocks it, so the launch resolves `protectedClient: false` for that sandbox. The launch summary and the boot summary say so in one line, and doctor warns about it.
3. **The conflict is always visible.** It shows in the launch summary row `Clipboard`, the guest boot summary line, the doctor check `sandbox-clipboard`, and the engine capabilities.

## 2. Decisions (open questions, with the chosen answers)
| # | Question | Decision | Why |
|---|---|---|---|
| D1 | `"text"` and ClipboardRedirection | **Disable** | With Protected Client on, RDP carries nothing usable, and rdpclip taking ownership would wipe what the bridge sets. With Protected Client off (your own choice), RDP would leak everything continuously with no foreground rule. "text" means exactly one channel: the bridge. |
| D2 | `"shared"` with `protectedClient: true` | **The clipboard wins** for your own settings: Protected Client is off for that launch, with a one-line note. **A project file that explicitly sets `sandbox.protectedClient: true` turns `"shared"` into `"text"`** for that launch. | The default protectedClient is true and almost nobody sets it, so requiring two settings breaks "just works". `"shared"` can only come from your own settings (a project can only narrow), so turning Protected Client off is always your choice. A project asking for Protected Client is tightening, and gets the safe mode. |
| D3 | `"shared"` with direction other than `"both"` | Resolved to `"text"` with a note | The shared clipboard is always both ways. |
| D4 | `"shared"` on HCS | Resolved to `"text"` (through terminals) with a note | HCS has no shared clipboard. |
| D5 | Direction narrowing by a project file | Directions are treated as sets and intersected. Empty intersection (you allow `toPc`, the project asks `toSandbox`) gives `clipboard: "off"`. | "may only narrow: both -> one way -> off". |
| D6 | PC -> sandbox when the window first opens | Sent: the window coming to the front counts. A file the sandbox has not taken within 15 s is deleted by the host. | The user asked for the sandbox. The expiry stops stale text being delivered when the daemon starts minutes later. Documented. |
| D7 | Host attach OSC 52 | Allowed when the resolved `toPc` is true (text or shared). Not allowed for `off` or `toSandbox`. Read from the launch's host-only clipboard settings file; if missing (sandbox started before the upgrade), fall back to `resolveClipboard(ctx.loaded.config.sandbox).toPc`. | OSC 52 from an attached terminal is not bound by the foreground rule. This is accepted (requirement 4) and documented as a residual risk. Follow-up idea: allow it only while that console is in front. |
| D8 | Where the bridge's files live | `<data>\clipboard\to-pc.json` and `<data>\clipboard\to-sandbox.json`, **not** `run\` | Other users of a shared sandbox get Modify on `run\` (`src/host/sharing/acl.ts`). A folder next to `run\`, like `secrets\`, keeps another Windows user from reading your PC clipboard or injecting into it. |
| D9 | Native helpers | `sandbox/csharp/ClipboardText.cs` holds the read and write code once. It is compiled into the guest helper `ClipboardBridge.exe` and into HostTools.exe; host/native.ts adds it to HostTools' sources. Watch-clipboard loads it too (Add-Type of two files). | One copy of the retry, marker and size code. |
| D10 | Ctrl+C guard | Everything the bridge writes carries a marker format `AgentSandbox.ClipboardBridge`. `ClipboardWatch.cs` ignores changes that carry it, and so does the guest helper (no loop). | A clipboard set by the bridge is not "you just copied". Otherwise switching to the window would put the viewer in copy mode and eat the next Ctrl+C. |
| D11 | Allowed-request answers saved as `sandbox.clipboard = true` | No longer match, so you are asked again once | They are keyed by `JSON.stringify(value)`. Accepted. |
| D12 | Machine config (`%ProgramData%`) holding booleans | Accepted by the preprocess, not migrated (it needs admin rights) | |
| D13 | No HostTools (no csc) | The bridge is off, a line goes to the watcher log, and doctor warns. No PowerShell fallback. | A persistent PowerShell for this is not worth it. csc ships with Windows. |
| D14 | Windows clipboard history | Text the bridge puts on the PC is a normal clipboard entry | That is what users expect. |

## 3. Behaviour table: `resolveClipboard`
Columns: `clipboard`, `clipboardDirection`, engine (W = windows-sandbox, H = hcs), resulting `mode`, `sharedClipboard` (the .wsb value), `protectedClient` (the .wsb value), `bridge`, `toPc`, `toSandbox`, `note`.

| clipboard | direction | engine | mode | sharedClipboard | protectedClient | bridge | toPc | toSandbox | note |
|---|---|---|---|---|---|---|---|---|---|
| off | any | any | off | F | your setting | F | F | F | null |
| text | d | W | text | F | your setting | T | per d | per d | null |
| text | d | H | text | F | your setting | F | per d | per d | null |
| shared | both | W | shared | T | **F** | F | T | T | `SHARED_PC_NOTE` if your setting was true, else null |
| shared | ≠both | W | text | F | your setting | T | per d | per d | `sharedDirectionNote(d)` |
| shared | any | H | text | F | your setting | F | per d | per d | `HCS_CLIPBOARD_NOTE` |

`direction` in the plan is `"both"` for shared, and your own setting otherwise.

---

## 4. Package P1 (Sonnet): settings, policy, migration, schema plumbing
No dependencies. Run it first; P3 can run in parallel.

### 4.1 `src/core/schema/sandbox.ts`
Add next to the other exports:
```ts
export const CLIPBOARD_MODES = ['text', 'shared', 'off'] as const;
export const CLIPBOARD_DIRECTIONS = ['both', 'toPc', 'toSandbox'] as const;
/** true / false from versions before 1.29 mean "text" / "off"; anything else is checked as it is. */
export function clipboardFromLegacy(value: unknown): unknown {
  return value === true ? 'text' : value === false ? 'off' : value;
}
```
In `SandboxSchema`:
- Replace `clipboard` with `z.preprocess(clipboardFromLegacy, z.enum(CLIPBOARD_MODES).describe(CLIPBOARD_TEXT))`.
  - Put `.describe` on the **inner enum only**. The JSON Schema `pipeProcessor` uses `def.out` when `def.in` is a transform, and SchemaNode is made to do the same (4.6).
- Add `clipboardDirection: z.enum(CLIPBOARD_DIRECTIONS).describe(DIRECTION_TEXT)` right after it.
- Change the `protectedClient` description.

Texts (exact):
- `CLIPBOARD_TEXT`: `'Copy and paste between this PC and the sandbox. "text" (default) = text only, through this tool: a copy in the sandbox reaches this PC only while the sandbox window is in front, and the text on this PC\'s clipboard goes in when you switch to the sandbox window; Protected Client stays on. "shared" = Windows Sandbox\'s own clipboard (text, images and files, all the time); Protected Client blocks it, so that sandbox starts with Protected Client off. "off" = no clipboard at all. An agent\'s copy in sandbox attach reaches this PC with "text" and "shared". true / false from older versions mean "text" / "off". A project file can only narrow it (shared -> text -> off).'`
- `DIRECTION_TEXT`: `'Which way sandbox.clipboard "text" copies: "both" (default), "toPc" (from the sandbox to this PC only) or "toSandbox" (from this PC into the sandbox only). Only for "text": the shared clipboard always works both ways, so another value here makes "shared" work as "text". A project file can only narrow it.'`
- protectedClient: `'Run the sandbox window in Protected Client mode (recommended). It blocks Windows Sandbox\'s own clipboard, so sandbox.clipboard "shared" starts that sandbox with Protected Client off (a project file that sets this to true keeps it on and gets "text").'`

`LocalOverridesSchema` needs no change: `sandbox` is `.partial()` and both keys are allowed.

### 4.2 Defaults and the example file
- `src/core/config/defaults.ts`: `clipboard: 'text', clipboardDirection: 'both',` (direction right after clipboard).
- `config.example.json`: `"clipboard": "text", "clipboardDirection": "both",` in the same place. The `config` suite checks that it equals DEFAULTS.

### 4.3 New `src/core/clipboard.ts` (pure; may import only `./types.js` as a type)
Header: `// sandbox.clipboard and sandbox.clipboardDirection: what one launch really gets (the .wsb devices, the text bridge, OSC 52) and how it is said. Pure.`
```ts
import type { Config } from './types.js';
export type ClipboardMode = Config['sandbox']['clipboard'];
export type ClipboardDirection = Config['sandbox']['clipboardDirection'];
export interface ClipboardSides { readonly toPc: boolean; readonly toSandbox: boolean }
export function sidesOf(direction: ClipboardDirection): ClipboardSides;
/** The direction of these sides; null when neither is left. */
export function directionOf(sides: ClipboardSides): ClipboardDirection | null;
/** What is left when both narrow each other (null = nothing: no clipboard). */
export function narrowDirection(a: ClipboardDirection, b: ClipboardDirection): ClipboardDirection | null;
/** 1 = `wanted` copies less than `running` (or neither covers the other), -1 = more, 0 = the same. */
export function compareDirection(running: ClipboardDirection, wanted: ClipboardDirection): number;
/** A stored value as a direction (a record from before 1.29 has none: "both"). */
export function asDirection(value: unknown): ClipboardDirection;
export interface ClipboardPlan {
  readonly mode: ClipboardMode;
  readonly direction: ClipboardDirection;
  /** Windows Sandbox's own clipboard (ClipboardRedirection in the .wsb). */
  readonly sharedClipboard: boolean;
  /** Protected Client as the sandbox really starts (off for the shared clipboard). */
  readonly protectedClient: boolean;
  /** The text bridge runs (host watcher + guest daemon). */
  readonly bridge: boolean;
  /** Text may reach this PC (the bridge, and OSC 52 in sandbox attach). */
  readonly toPc: boolean;
  readonly toSandbox: boolean;
  /** Why the launch differs from the settings, in one plain line; null when it does not. */
  readonly note: string | null;
}
export const SHARED_PC_NOTE = 'Protected Client is off for this sandbox: it blocks the shared clipboard (sandbox.clipboard "shared"; "text" keeps it on).';
export const HCS_CLIPBOARD_NOTE = 'The HCS engine has no shared clipboard: text is copied through attached terminals.';
export function sharedDirectionNote(d: ClipboardDirection): string; // 'sandbox.clipboardDirection "' + d + '" uses the text clipboard: the shared one always works both ways.'
export function resolveClipboard(s: Pick<Config['sandbox'], 'engine' | 'clipboard' | 'clipboardDirection' | 'protectedClient'>): ClipboardPlan; // table in section 3
/** "text both ways (Protected Client on)" and the like. */
export function clipboardLine(plan: ClipboardPlan, engine: Config['sandbox']['engine']): string;
```
`clipboardLine` texts:
- off: `'off'`
- text on W: `'text ' + words + ' (Protected Client ' + (plan.protectedClient ? 'on' : 'off') + ')'`. `words` is `both ways`, `from the sandbox to this PC only` or `from this PC into the sandbox only`.
- text on H: `'text through attached terminals'`
- shared: `'shared: text, images and files both ways (Protected Client off)'`

Export from somewhere reachable: the project has no `core/index.ts`, so import by path (`../../core/clipboard.js`), like `core/disk.ts`.

### 4.4 `src/core/local-config/overrides.ts`
- Remove `'sandbox.clipboard'` from `OFF_IS_SAFER`.
- Add:
```ts
export const CLIPBOARD_STRICTNESS: Record<string, number> = { shared: 0, text: 1, off: 2 };
/** Protections with more than two values: the higher, the stricter. */
export const RANKED: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'provisioning.git.access': GIT_STRICTNESS,
  'sandbox.clipboard': CLIPBOARD_STRICTNESS,
};
export const DIRECTION_SETTING = 'sandbox.clipboardDirection';
export const NEVER_LOOSER = [...ON_IS_SAFER, ...OFF_IS_SAFER, ...Object.keys(RANKED), DIRECTION_SETTING];
/** How strict a value of a protection is (higher = stricter); legacy clipboard booleans count as "text" / "off". */
export function strictness(setting: string, value: unknown): number {
  const ranked = RANKED[setting];
  if (ranked) return ranked[String(setting === 'sandbox.clipboard' ? clipboardFromLegacy(value) : value)] ?? 0;
  if (ON_IS_SAFER.includes(setting)) return value ? 1 : 0;
  if (OFF_IS_SAFER.includes(setting)) return value ? 0 : 1;
  return 0;
}
```
`clipboardFromLegacy` is imported from `../schema/sandbox.js`. Check that `core/schema/index.ts` exports it, and add it there.

`keepStrictest(yours, merged)`: keep the two boolean loops, then add:
```ts
Object.keys(RANKED).forEach((p) => { if (strictness(p, _.get(yours, p)) > strictness(p, _.get(merged, p))) _.set(merged, p, _.get(yours, p)); });
const dir = narrowDirection(yours.sandbox.clipboardDirection, merged.sandbox.clipboardDirection);
if (dir) merged.sandbox.clipboardDirection = dir;
else { merged.sandbox.clipboard = 'off'; merged.sandbox.clipboardDirection = yours.sandbox.clipboardDirection; }
```
Delete the old git-only line; RANKED covers it.

`loosenedRequests`:
- Replace the git special case with `...Object.keys(RANKED).filter((p) => _.has(ov, p) && strictness(p, _.get(ov, p)) < strictness(p, _.get(config, p)))`.
- Add `...(_.has(ov, DIRECTION_SETTING) && compareDirection(config.sandbox.clipboardDirection, asDirection(_.get(ov, DIRECTION_SETTING))) < 0 ? [DIRECTION_SETTING] : [])`.

`applyOverrides`: after `keepStrictest(config, next)` add:
```ts
// A project asking for Protected Client keeps it: the shared clipboard (which needs it off) becomes "text".
if (rest.sandbox?.protectedClient === true && next.sandbox.clipboard === 'shared') next.sandbox.clipboard = 'text';
```
`ON_IS_SAFER` still lists `sandbox.protectedClient`; keep it.

### 4.5 `src/core/local-config/policy.ts`
- `protectionsOf(config)`: keep the generic map, then override with the effective values:
```ts
const plan = resolveClipboard(config.sandbox);
return { ...base, 'sandbox.clipboard': plan.mode, 'sandbox.clipboardDirection': plan.direction, 'sandbox.protectedClient': plan.protectedClient };
```
- `compare`: becomes `if (setting === DIRECTION_SETTING) return compareDirection(asDirection(running), asDirection(wanted)); return Math.sign(strictness(setting, wanted) - strictness(setting, running));`. Remove the three branches.
- `checkJoin` loop: first line `if (setting === DIRECTION_SETTING && strictness('sandbox.clipboard', running['sandbox.clipboard']) === 2) continue;` (a sandbox with no clipboard: direction does not matter).

### 4.6 `src/core/local-config/boot-wants.ts`
- `LABELS['sandbox.clipboard'] = 'a wider clipboard'`.
- `missingAtBoot`: `const wanted = protectionsOf(config);` then `settings: BOOT_SETTINGS.filter((s) => strictness(s, wanted[s]) < strictness(s, running[s]))`. Import `protectionsOf` from `./policy.js`; there is no cycle because policy does not import boot-wants.
- `widenForProjects`, per setting:
  - `const looser = others.filter((o) => strictness(s, _.get(o.config, s)) < strictness(s, _.get(config, s)));`
  - `const by = _.minBy(looser, (o) => strictness(s, _.get(o.config, s)));`
  - If `!by`, continue. Keep the keepOff note as it is.
  - `_.set(config, s, _.get(by.config, s)); widened[s] = by.name;`
  - When `s === 'sandbox.clipboard' && config.sandbox.clipboard === 'shared'`, also set `widened['sandbox.protectedClient'] = by.name`.
  - Note text: `label + (typeof value === 'string' ? ' is "' + value + '"' : ' is on') + ' in this sandbox (for every project in it): ' + by.name + ' asks for it and you allowed it.'`. For booleans this must stay byte-identical to the old text; the projects tests compare it.
- `src/cli/commands/launch/boot-wants.ts` line 54: `const keepOff = BOOT_SETTINGS.filter((s) => strictness(s, _.get(ctx.loaded.config, s)) < strictness(s, _.get(run.config, s)));`
- Export `strictness`, `RANKED`, `CLIPBOARD_STRICTNESS` and `DIRECTION_SETTING` from `src/core/local-config/index.ts`.

### 4.7 `src/app/kernel/schema-node.ts` (`get inner`)
Replace the pipe branch with:
```ts
else if (def.type === 'pipe' && def.in)
  // z.preprocess: a transform in front of the real schema (the form edits what comes out of it).
  s = def.in._zod.def.type === 'transform' && def.out ? def.out : def.in;
```

### 4.8 Migration
New file `src/host/migrate/migrations/clipboard-mode.ts`:
```ts
// 1.29 makes sandbox.clipboard a mode ("text", "shared" or "off") instead of true / false. Old values still load (true =
// "text", false = "off"); this writes the word into config.json so the file says what it means (comments stay).
import _ from 'lodash';
import type { Migration, MigrationContext } from '../migration.js';
import { readFileObject, setValue, type Json } from './config-file.js';
const CLIPBOARD = ['sandbox', 'clipboard'];
/** The old true / false in a config file, or null. */
export function legacyClipboard(file: Json): boolean | null { const v: unknown = _.get(file, CLIPBOARD); return typeof v === 'boolean' ? v : null; }
export const clipboardMode: Migration = {
  id: '2026-11-clipboard-mode', introducedIn: '1.29.0', scope: 'user', needsIdleSandbox: false,
  summary: 'Writes sandbox.clipboard as "text" or "off" instead of true or false.',
  applies: (ctx) => { const f = readFileObject(ctx.configPath); return f !== null && legacyClipboard(f) !== null; },
  touches: (ctx) => (ctx.configPath ? [ctx.configPath] : []),
  async run(ctx, note) { const f = readFileObject(ctx.configPath); const v = f ? legacyClipboard(f) : null;
    if (!ctx.configPath || v === null) return; const mode = v ? 'text' : 'off';
    setValue(ctx.configPath, CLIPBOARD, mode); note('sandbox.clipboard: ' + String(v) + ' -> "' + mode + '"'); },
};
```
Append it to `MIGRATIONS` in `src/host/migrate/registry.ts` (last). Do not edit `snapshots.ts`.

`async run` without await: lint may complain (`require-await`). If it does, follow drop-vs-install-files.ts, which uses the same shape.

### 4.9 Tests (P1)
- **local-config suite** (`src/selftest/local-config.test.ts`): change the boolean clipboard fixtures at lines 272-344 to modes. Add these checks:
  - A project `clipboard: "shared"` against yours `"text"` stays `"text"` and is listed by `loosenedRequests`.
  - A project `"off"` against yours `"text"` gives `"off"`.
  - Legacy `true` in a project file parses as `"text"`.
  - Direction: yours `both` + project `toPc` gives `toPc`. Yours `toPc` + project `toSandbox` gives clipboard `"off"`. Yours `toPc` + project `both` gives `toPc` and appears in `loosenedRequests`.
  - A project `protectedClient: true` with your `"shared"` gives `"text"`.
  - `checkJoin`: running `{clipboard:'text', dir:'both'}` with wanted `{text, toPc}` lands in `stricter`. Running `off` with wanted `{text, toPc}` puts no direction entry in `stricter` and a `looser` clipboard note.
  - `protectionsOf` of a shared config gives `sandbox.protectedClient: false`.
  - `missingAtBoot` with running `text` and a project wanting `shared` lists `sandbox.clipboard`. A legacy running `true` counts as `text`.
  - `widenForProjects` from `text` to `shared` sets widened for both clipboard and protectedClient.
- **New clipboard suite** (`src/selftest/clipboard.test.ts`, name `clipboard`, title `'clipboard: modes, directions, the bridge and its files'`, registered in `src/selftest/index.ts`). P1 adds the section `modes`: every row of the section 3 table through `resolveClipboard`, plus every `clipboardLine` text (exact strings above), plus `sidesOf`, `directionOf`, `narrowDirection` and `compareDirection` (incomparable pair gives 1).
- **config suite**: config.example equals DEFAULTS (existing test). Add: `validateConfig` with `sandbox.clipboard: true` gives `"text"`, `false` gives `"off"`, and `"maybe"` fails with a readable message.
- **migrate suite**:
  - A config.json `{ // keep\n "sandbox": { "clipboard": false } }` becomes `"off"` with the comment kept.
  - `true` becomes `"text"`.
  - `"text"` means `applies` is false.
  - No file means `applies` is false.
  - `MIGRATIONS` ends with `2026-11-clipboard-mode`.
- **app suite**: the settings fields for `sandbox.clipboard` are kind `enum` with choices `text, shared, off` (via `fields.ts` over ConfigSchema), and `sandbox.clipboardDirection` is kind `enum`. `schemas/config.schema.json` (after build) has an `enum` `["text","shared","off"]` under `sandbox.clipboard` with the description.

**P1 acceptance:** `npm run build` (commit `schemas/*.json`); `npm test -- clipboard,local-config,config,migrate,app,projects,layout` prints ALL TESTS PASSED; `npm run lint`; `npm run format:check`.

---

## 5. Package P2 (Sonnet): launch wiring, UX, doctor, engines
Depends on P1.

### 5.1 Engine types and the .wsb
- `src/host/engines/types.ts` `LaunchDevices`:
  - Rename `clipboard` to `sharedClipboard`, with doc `/** Windows Sandbox's own clipboard (ClipboardRedirection): only for sandbox.clipboard "shared". */`.
  - `protectedClient` doc: `/** As the sandbox really starts: off for the shared clipboard. */`.
  - The rename is on purpose: every user of the field breaks the build and gets revisited.
- `EngineCapabilities`: add `readonly textClipboard: boolean;` after `desktop`.
- `src/host/launch/launch-plan.ts` `buildLaunchPlan`: `const clip = resolveClipboard(s);` then `sharedClipboard: clip.sharedClipboard, protectedClient: clip.protectedClient`.
- `src/host/engines/windows-sandbox/wsb-text.ts`: `element('ClipboardRedirection', toggle(d.sharedClipboard))`. Element order unchanged.
- `src/host/engines/windows-sandbox/engine.ts` capabilities: `clipboard: this.sandbox.clipboard === 'shared'`, `textClipboard: this.sandbox.clipboard !== 'off'`.
- `src/host/engines/hcs/engine.ts` `HCS_CAPABILITIES`: `textClipboard: true` (clipboard stays false).
- `src/host/engines/hcs/documents.ts` line 155: drop clipboard from the condition and the text, giving `'GPU, microphone and camera do not exist in the HCS engine.'`. The clipboard note now comes from `resolveClipboard`.
- `src/app/features/engine/engine.def.ts`: `CAPABILITY_NAMES` gets `textClipboard: 'copy and paste of text'` (right after `desktop`), and `clipboard: 'shared clipboard (images, files)'`. Add `textClipboard` to `CapabilitiesSchema`.

### 5.2 Generated, summaries, session.json
- `src/core/types.ts`:
  - `Generated` gets `/** sandbox.clipboard as this launch really gets it. */ clipboard: ClipboardPlan;` (use `import type` from `./clipboard.js`).
  - `GuestSession` gets `/** sandbox.clipboard "text": the bridge runs in the daemon (older launch folders lack it). line: the boot summary's words. */ clipboard?: { bridge: boolean; toPc: boolean; toSandbox: boolean; line: string };`
- `src/host/launch/generate.ts`:
  - After `wide`: `const clipboard = resolveClipboard(config.sandbox);`
  - Pass it to `guestSession` through `SessionParts` (add the field in session-file.ts).
  - Return `clipboard` in the result.
  - After `writeLoadSettings(...)`: `saveClipboardSettings(storageRoot, dataPath, clipboard);` (5.3).
  - After `clearSecrets(storageRoot, dataPath);`: `clearClipboardFiles(dataPath);` (P4 makes this function; P2 adds a stub in `src/host/clipboard/files.ts` that P4 fills in, or P4 adds this line itself. Choose: **P4 adds the call.**)
- `src/host/launch/session-file.ts` `guestSession`: after `headless`, add `clipboard: { bridge: parts.clipboard.bridge, toPc: parts.clipboard.toPc, toSandbox: parts.clipboard.toSandbox, line: clipboardLine(parts.clipboard, config.sandbox.engine) },`. Key order matters (comment in file); add it in one place only.
- `src/cli/commands/launch/summary.ts` `launchSummary`: after `['Agent', ...]` add `['Clipboard', clipboardLine(generated.clipboard, generated.bootConfig.sandbox.engine)]`, and when `generated.clipboard.note`, also `['', generated.clipboard.note]`.
- `src/guest/boot/boot.ts` `summaryLines`: after the network-problem lines, `...(session.clipboard ? ['Clipboard: ' + session.clipboard.line] : []),`.

### 5.3 Host-only clipboard settings
New folder `src/host/clipboard/` with an `index.ts` barrel (re-exports only).

`settings.ts`:
```ts
// What the launch decided for the clipboard (host-only, <storage>\sync\<set>-clipboard.json): the watcher runs the
// bridge from it and sandbox attach decides whether the agent's copy (OSC 52) may reach this PC.
export const ClipboardSettingsSchema = z.object({ mode: z.enum(CLIPBOARD_MODES), bridge: z.boolean(), toPc: z.boolean(), toSandbox: z.boolean() });
export type ClipboardSettings = z.output<typeof ClipboardSettingsSchema>;
export function saveClipboardSettings(storageRoot: string, dataPath: string, plan: ClipboardPlan): void;
export function readClipboardSettings(storageRoot: string, dataPath: string): ClipboardSettings | null;
```
Use `JsonFile` and `hostStateFile`, like `src/host/network/port-forward.ts`. Add `'-clipboard.json'` to `StateFileSuffix` in `src/host/storage/state-files.ts`.

### 5.4 Attach
`src/cli/commands/launch/running.ts` `attachHere`:
- `clipboardWrites: readClipboardSettings(ctx.storageRoot, ctx.dataPath)?.toPc ?? resolveClipboard(ctx.loaded.config.sandbox).toPc`
- Comment: `// The agent's copy (OSC 52) reaches this PC only when this sandbox copies text to this PC anyway (sandbox.clipboard "text" or "shared", not "toSandbox").`
- Comment updates:
  - `src/guest/sessions/viewer.ts` lines 36-37 become `(and yours only through sandbox.clipboard "text" or "shared")`.
  - `src/shared/pty/output-filter.ts` lines 17-18 become `(its own terminal, or sandbox.clipboard "text" / "shared" copying to this PC)`.

### 5.5 Doctor
`src/cli/commands/repair/checks/sandbox.ts`: export a pure `clipboardFinding(sandbox: Config['sandbox'], cscFound: boolean): Finding` and add the check `{ id: 'sandbox-clipboard', group: 'Sandbox', name: 'Clipboard', run: (env) => clipboardFinding(env.ctx.loaded.config.sandbox, fileExists(SYSTEM.csc())) }` after `sandbox-vgpu`. Findings, checked in order:
1. `clipboard === 'shared' && protectedClient && engine === 'windows-sandbox'`:
   - status: warn
   - detail: `'the shared clipboard turns Protected Client off'`
   - means: `'sandbox.clipboard "shared" uses Windows Sandbox\'s own clipboard, which Protected Client blocks, so every sandbox starts with Protected Client off. "text" copies text both ways and keeps it on.'`
   - fix: `'Run: sandbox config set sandbox.clipboard text'`
2. `clipboard === 'shared' && clipboardDirection !== 'both'`:
   - status: warn
   - detail: `'sandbox.clipboardDirection only works with "text"'`
   - means: `sharedDirectionNote(dir)`
   - fix: `'Run: sandbox config set sandbox.clipboard text (or sandbox.clipboardDirection both)'`
3. `resolveClipboard(sandbox).bridge && !cscFound`:
   - status: warn
   - detail: `'text copy and paste needs HostTools.exe'`
   - means: `'It is built with the C# compiler that ships with Windows, which was not found, so no text is copied between this PC and the sandbox.'`
   - fix: `'Run: sandbox repair'`
4. Otherwise `ok(clipboardLine(resolveClipboard(sandbox), sandbox.engine))`.

### 5.6 Golden and fixture updates
- `src/selftest/support/engine-golden.ts` `ENGINE_GOLDEN`: every default-config case now has `<ClipboardRedirection>Disable</ClipboardRedirection>`.
- `src/selftest/support/engine-cases.ts`:
  - The "all devices" case uses `clipboard: 'shared'`; its golden becomes ClipboardRedirection Enable + ProtectedClient **Disable**.
  - The "no network" case uses `clipboard: 'off'`.
  - New case `'clipboard text with protectedClient off'` gives Disable/Disable.
- `src/selftest/engine.test.ts` line 33: map `['ClipboardRedirection', resolveClipboard(s).sharedClipboard]` and `['ProtectedClient', resolveClipboard(s).protectedClient]`. The capability test sets clipboard `'off'`/`'shared'` and checks `textClipboard`.
- `src/selftest/hcs.test.ts`:
  - `LAUNCH.devices` uses `sharedClipboard: false`.
  - The notes test (line ~276) now expects networking only.
  - The capabilities check expects `textClipboard: true`.
- `src/selftest/app.test.ts` line ~1531 and `src/selftest/support/web-preview.ts` lines ~470/495: add `textClipboard`.
- Clipboard suite section `launch`:
  - `buildWsb` for text, shared, off, and shared+toPc (shared+toPc gives Disable and Protected Client on).
  - `launchSummary` rows contain `['Clipboard', 'text both ways (Protected Client on)']`.
  - `guestSession(...).clipboard` for text equals `{ bridge: true, toPc: true, toSandbox: true, line: 'text both ways (Protected Client on)' }`.
  - `clipboardFinding` returns each of the four findings.
  - `saveClipboardSettings`/`readClipboardSettings` round-trip in a `t.dir`, and a damaged file gives null.

**P2 acceptance:** `npm run build`; `npm test -- clipboard,engine,engines,hcs,generate,app,web,repair,health,local-config,projects` prints ALL TESTS PASSED; `npm run lint`; `npm run format:check`.

---

## 6. Package P3 (Sonnet): native helpers (C# 5) and their compile and live checks
No TS dependencies; can run in parallel with P1. C# rules apply: Allman braces, `NativeMethods` nested class with `SetLastError`, `Win32Exception`, named constants, `finally` closes handles, no interpolation, `?.`, `nameof` or expression bodies. Every .ps1 starts with `#Requires -Version 5.1` and uses CRLF line endings.

### 6.1 `sandbox/csharp/ClipboardText.cs`
No `Main`; global namespace; `public static class SbxClipboardText`. Header: `// Text on the Windows clipboard (CF_UNICODETEXT) for the clipboard bridge and the clipboard watch: read and write with retries (another program may hold it open), and a marker format on what the bridge writes, so neither side takes it for a copy. user32 only (no OLE clipboard, so no STA thread is needed). C# 5.`

Constants:
- `public const string MarkerFormatName = "AgentSandbox.ClipboardBridge";`
- `CfUnicodeText = 13`
- `GmemMoveable = 0x0002`
- `OpenAttempts = 10`
- `OpenRetryMs = 30`
- `HwndMessage = new IntPtr(-3)`

P/Invoke: `OpenClipboard`, `CloseClipboard`, `EmptyClipboard`, `GetClipboardData`, `SetClipboardData`, `IsClipboardFormatAvailable`, `RegisterClipboardFormatW` (CharSet.Unicode), `GetClipboardSequenceNumber`, `GlobalAlloc`, `GlobalLock`, `GlobalUnlock`, `GlobalSize`, `GlobalFree`, `CreateWindowExW` (CharSet.Unicode), `DestroyWindow`.

Public API:
- `uint Sequence()`
- `bool HasMarker()`
- `string Read(int maxBytes, out bool tooBig)`:
  - Returns null when there is no text. Opens with `OpenClipboard(IntPtr.Zero)`, retrying `OpenAttempts` times; throws `Win32Exception` when the clipboard stays locked.
  - Reads at most `min(GlobalSize/2, maxBytes + 1)` chars, cut at the first NUL.
  - `tooBig = Encoding.UTF8.GetByteCount(s) > maxBytes`; when tooBig, return null.
- `void Write(string text)`:
  - Creates a message-only `STATIC` window (parent `HwndMessage`). `OpenClipboard(window)` needs a real owner: with a NULL owner, `EmptyClipboard` makes `SetClipboardData` fail.
  - Calls `EmptyClipboard`, puts the text with `GlobalAlloc` + copy + NUL into `SetClipboardData(13)`, and frees the memory with `GlobalFree` if that fails.
  - Adds the marker with a 1-byte `GlobalAlloc` under `RegisterClipboardFormat(MarkerFormatName)`.
  - `CloseClipboard` and `DestroyWindow` go in `finally`.

### 6.2 `sandbox/csharp/ClipboardBridge.cs` (guest helper, its own `Main`, compiled with ClipboardText.cs)
`ClipboardBridge serve --max-bytes N`; it also answers `get` (used by the live test).
- **stdin lines:** `set <base64 UTF-8>`, `get`.
- **stdout lines:** `ready`, `changed <base64>`, `changed-other` (no text, too big, or unreadable after 5 tries of the same sequence number), `set-ok`, `set-failed`, `got <base64>`, `got-none`, `got-too-big`, `get-failed`.
- **Loop:** a background thread reads stdin into a locked `Queue<string>`. The main loop runs every 150 ms: first the queued commands, then the sequence number. A change that `HasMarker()` is skipped (our own set or the host's).
- **Exit codes:** 0 when stdin closes, 2 on usage error.
- **Encoding:** base64 only on stdout (no console code page problems). Flush after each line.

### 6.3 `sandbox/csharp/ClipboardWatch.cs` and `sandbox/scripts/watch-clipboard.ps1`
- In `Run`, on a change: `if (!SbxClipboardText.HasMarker()) { print "changed" }`. Remove its own `GetClipboardSequenceNumber` P/Invoke and use `SbxClipboardText.Sequence()`.
- Add to its header: `Changes the clipboard bridge made (marker format) are not reported: they are not your copy.`
- The .ps1 becomes `Add-Type -Path @((Join-Path $PSScriptRoot '..\csharp\ClipboardText.cs'), (Join-Path $PSScriptRoot '..\csharp\ClipboardWatch.cs'))`.

In the sandbox the terminal viewer does not start the .ps1 (about 2 s of PowerShell start and Add-Type, 72 MB): it starts `ClipboardBridge.exe watch --parent <pid>` (compiled with ClipboardText.cs and ClipboardWatch.cs, `Main` calls `SbxClipboardWatch.Run`; about 0.08 s, 15 MB, same 150 ms poll). `viewer.ts` passes the exe path to `runTerminalClient` (`clipboardWatchExe`); without it (the PC's `sandbox attach`, no compiler) the .ps1 runs.

### 6.4 HostTools
- **`native/csharp/HostTools/Window.cs`:** add `public static bool SandboxInFront()`:
  - `GetForegroundWindow`, then `GetAncestor(h, GaRootOwner = 3)`, then `GetWindowThreadProcessId`.
  - Cache pid to answer for 5 s (static fields).
  - `Process.GetProcessById(pid)`, then `ProcessName.StartsWith("WindowsSandbox", OrdinalIgnoreCase)` (WindowsSandboxClient / WindowsSandboxRemoteSession, the same rule as `SandboxWindows`). Catch `ArgumentException` and `InvalidOperationException` and return false.
  - New P/Invokes: `GetForegroundWindow`, `GetAncestor`.
- **New `native/csharp/HostTools/HostClipboard.cs`:** `namespace AgentSandbox { public static class HostClipboard { public static int Serve(int maxBytes) } }`. Same thread and queue design as 6.2.
  - Prints `fg 1` / `fg 0` at start and on every change (polled every 150 ms).
  - Commands: `get` (gives `got <b64>`, `got-none`, `got-too-big` or `get-failed`) and `set <b64>` (gives `set-ok` or `set-failed`).
  - Exits 0 when stdin closes.
- **`Program.cs`:**
  - New case `"clipboard-bridge"` that needs `--max-bytes` as an int from 1 to 4194304, else `Usage()`.
  - Add `//   clipboard-bridge --max-bytes N   the sandbox window in front (fg 1/0) and this PC's clipboard text, until stdin closes` to the header.
  - Add `| clipboard-bridge --max-bytes N` to Usage.
- **`src/host/native.ts`:**
  - Export `/** HostTools' C# sources: native\csharp\HostTools\*.cs and the clipboard code it shares with the sandbox. */ export function hostToolsSources(packageRoot: string = PACKAGE_ROOT): string[]` (sorted folder files + `path.join(packageRoot, 'sandbox', 'csharp', 'ClipboardText.cs')`).
  - `hostToolsExe` hashes and compiles exactly that list.
- **`src/guest/runtime/csc.ts`:**
  - `SOURCES` values become `readonly string[]`, e.g. `ptyhost: ['PtyHost.cs']` and new `clipboardbridge: ['ClipboardBridge.cs', 'ClipboardText.cs']`.
  - `sourceOf` returns all the paths; `sourceHash` hashes all of them in order; csc gets all of them.

### 6.5 Tests (P3)
- **`src/selftest/heavy-load.test.ts`** C# section:
  - `build('clipboardwatch', [sandboxCs('ClipboardText.cs'), sandboxCs('ClipboardWatch.cs')], 'library')`
  - `build('clipboardbridge', [sandboxCs('ClipboardBridge.cs'), sandboxCs('ClipboardText.cs')])`
  - The HostTools build uses `hostToolsSources(t.packageRoot)`.
  - `clipboardbridge` without args exits 2.
  - `HostTools clipboard-bridge --max-bytes 1024` with `input: ''` prints a first line matching `/^fg [01]$/` and exits 0.
  - `HostTools clipboard-bridge` without `--max-bytes` exits 2.
- **`src/selftest/live-network.test.ts`** line ~153: compile with `hostToolsSources(t.packageRoot)`.
- **`src/selftest/support/engine-golden.ts` `LAUNCH_FILES_GOLDEN`:** add `'sandbox/csharp/ClipboardBridge.cs'` and `'sandbox/csharp/ClipboardText.cs'` in sorted position.
- **New live suite `clipboard-live`** (`src/selftest/clipboard-live.test.ts`, `live: true`, timeout 2 minutes):
  - Skip with `t.check(true, 'skipped: ...')` when not Windows, when csc is missing, or when `SYSTEM.tasklist() /fi "imagename eq rdpclip.exe" /nh` lists rdpclip.exe (the sandbox clipboard may be shared with a real PC, so nothing is written). Mention that last skip in the suite header.
  - Otherwise:
    1. Compile the bridge into `t.dir`.
    2. Spawn `serve --max-bytes 1048576` and wait for `ready`.
    3. `get` and save the reply.
    4. `set` a random `selftest-<hex>` and expect `set-ok`.
    5. `get` and expect equal.
    6. Check that no `changed ...` line arrived for our own set (marker).
    7. Restore: `set` the saved text, or skip restore when it was `got-none`. The test never leaves its text on the clipboard.
    8. Close stdin and expect exit 0.
  - Also run `watch-clipboard.ps1 -ProcessId <self>` during step 4 and check it printed no `changed` line.

**P3 acceptance:** `npm run build`; `npm test -- heavy-load,live-network,clipboard-live,engine,layout` prints ALL TESTS PASSED (run live suites twice before calling a failure real); `npm run lint`; `npm run format:check`.

---

## 7. Package P4 (Sonnet): the bridge (shared logic, host watcher, guest daemon)
Depends on P2 (settings file, `session.clipboard`) and P3 (helper protocols).

### 7.1 `src/shared/channel/run-dir.ts`
Add next to `secretsDir`:
```ts
/** The text clipboard bridge (sandbox.clipboard "text"): next to run, not in it, so other users of a shared sandbox cannot read or plant copies. */
readonly clipboardDir: string;      // path.join(dataDir, 'clipboard')
readonly clipboardToPcFile: string; // <clipboardDir>\to-pc.json      (guest writes, host reads and deletes)
readonly clipboardToSandboxFile: string; // <clipboardDir>\to-sandbox.json (host writes, guest reads and deletes)
```

### 7.2 New `src/shared/clipboard/` (`index.ts` barrel)
Built-ins, zod and `shared/io` only, because the guest bundles it.
- **`message.ts`:**
```ts
export const CLIPBOARD_MAX_BYTES = 1024 * 1024;          // UTF-8 text
export const CLIPBOARD_BASE64_MAX = 4 * Math.ceil(CLIPBOARD_MAX_BYTES / 3);
export const CLIPBOARD_FILE_MAX_BYTES = 1_500_000;
export const CLIPBOARD_LINE_MAX = 1_500_000;             // a helper's stdout line
export const ClipboardFileSchema = z.strictObject({ v: z.literal(1), text: z.string().max(CLIPBOARD_BASE64_MAX).regex(/^[A-Za-z0-9+/]*={0,2}$/), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
export type ClipboardFile = z.output<typeof ClipboardFileSchema>;
export function textHash(text: string): string;                   // sha256 hex of the UTF-8 bytes
export function toBase64Text(text: string): string | null;        // null when > CLIPBOARD_MAX_BYTES or it holds NUL
export function fromBase64Text(b64: string): string | null;       // canonical base64 only, UTF-8 fatal (TextDecoder), <= max, no NUL
export function clipboardFile(text: string): ClipboardFile | null;
/** The text of a file the other side wrote: shape, base64, UTF-8, size and hash checked; null otherwise. */
export function openClipboardFile(value: unknown): { text: string; hash: string } | null;
/** Reads (bounded, never through a link) and deletes the file; the checked text or null. */
export function takeClipboardFile(file: string): { text: string; hash: string } | null;
```
  - `takeClipboardFile`: `readBoundedFile(file, CLIPBOARD_FILE_MAX_BYTES)`, always `fs.rmSync(file, { force: true })` in `finally`, then JSON.parse in try/catch, then `openClipboardFile`.
- **`gate.ts`** (pure, the security rules):
```ts
export const FOREGROUND_GRACE_MS = 2000;
export type ToPcDecision = 'accept' | 'background' | 'echo' | 'off';
export type ToSandboxDecision = 'send' | 'same' | 'off';
/** The bridge's rules: a copy from the sandbox reaches this PC only while its window is in front (or was, within 2 s); this PC's text goes in only when asked at a switch to the window, and never what the other side already has. */
export class ClipboardGate {
  constructor(private readonly sides: { readonly toPc: boolean; readonly toSandbox: boolean }, private readonly graceMs: number = FOREGROUND_GRACE_MS) {}
  /** The sandbox window came to the front (true) or left it; returns true on a switch TO it (time to offer this PC's text). */
  foreground(inFront: boolean, nowMs: number): boolean;
  inFront(nowMs: number): boolean;
  /** A copy the sandbox made. */
  toPc(hash: string, nowMs: number): ToPcDecision;
  /** This PC's text at a switch to the window. */
  toSandbox(hash: string): ToSandboxDecision;
}
```
  - State: `front: boolean`, `leftAt: number` (-Infinity at start), `pcHas: string | null`, `sandboxHas: string | null`.
  - `toPc`: `!toPc` gives off. `hash === pcHas` gives echo. Otherwise `sandboxHas = hash`; then if not in front, background; else `pcHas = hash`, accept.
  - `toSandbox`: `!toSandbox` gives off. Otherwise `pcHas = hash`; `hash === sandboxHas` gives same; else `sandboxHas = hash`, send.
  - The first `foreground()` call sets the state and returns `inFront` (a window already in front at start counts as a switch: D6).

### 7.3 Host bridge: `src/host/clipboard/`
- **`port.ts`:**
```ts
export type ClipboardRead = { kind: 'text'; text: string } | { kind: 'none' } | { kind: 'tooBig' } | { kind: 'failed' };
export interface HostClipboardPort { onForeground(listener: (inFront: boolean) => void): void; read(): Promise<ClipboardRead>; write(text: string): Promise<boolean>; onExit(listener: () => void): void; stop(): void; }
/** HostTools clipboard-bridge; null off Windows, in the self-test, or when HostTools cannot be built. */
export function openHostClipboard(storageRoot: string): HostClipboardPort | null;
```
  - Spawn `[exe, 'clipboard-bridge', '--max-bytes', String(CLIPBOARD_MAX_BYTES)]` with `windowsHide` and stdio `['pipe','pipe','ignore']`.
  - Line buffer capped at `CLIPBOARD_LINE_MAX`; a longer line is dropped up to its newline.
  - Replies resolve a FIFO of pending calls, each with a 5 s timeout (`failed` / false).
  - `fg 0|1` lines go to the foreground listeners.
  - `stop()` ends stdin.
  - Guard with `isWin`, `selfTestRunning()` and `hostToolsExe`, like `HostMemoryStream`.
- **`files.ts`:** `export function clearClipboardFiles(dataPath: string): void`. It does `assertNoLinks(dataPath, run.clipboardDir)`, then removes `to-pc.json`, `to-sandbox.json` and `*.tmp` inside. Catch with a comment: missing folder or a planted link means nothing to remove.
- **`bridge.ts`:**
```ts
export interface HostBridgeOptions { readonly dataPath: string; readonly settings: ClipboardSettings; readonly open: () => HostClipboardPort | null; readonly note: (line: string) => void; readonly now?: () => number; }
/** The PC side of sandbox.clipboard "text", run by the background watcher while the sandbox runs. Never logs text. */
export class HostClipboardBridge {
  start(): void;   // clearClipboardFiles; mkdir clipboardDir after assertNoLinks; open the port (restart at most once a minute after it exits); 250 ms timer (unref) -> poll()
  stop(): void;    // timer off, port.stop(), clearClipboardFiles, note totals "copied N to this PC, M into the sandbox, refused R"
  /** One look for a copy from the sandbox (tests call it directly). */
  poll(): Promise<ToPcDecision | null>;
  /** The port's foreground event (tests call it directly). */
  foreground(inFront: boolean): Promise<ToSandboxDecision | null>;
}
```
  - `poll`:
    1. `assertNoLinks(dataPath, clipboardDir)` in try; on throw, note once and return null.
    2. Expire: if the host's own `to-sandbox.json` was written over 15 s ago (remember the time in memory), delete it.
    3. `takeClipboardFile(clipboardToPcFile)`. null gives null.
    4. Decide with `gate.toPc(hash, now)`. On accept, `await port.write(text)`. On background, `refused++`, then a note at most once every 60 s: `'refused ' + n + ' cop' + (n === 1 ? 'y' : 'ies') + ' from the sandbox: its window was not in front'`.
  - `foreground`:
    1. `const offer = gate.foreground(inFront, now)`.
    2. If `!offer || !settings.toSandbox`, return null.
    3. `const r = await port.read()`. Not text gives null (`tooBig`: note at most every 60 s, `'this PC\'s clipboard text is over 1 MB: not copied into the sandbox'`).
    4. `gate.toSandbox(textHash(text))`. On send, `writeJsonAtomic(clipboardToSandboxFile, clipboardFile(text))` after `assertNoLinks`, and remember the time.
  - Text is never kept on the object, never noted, never thrown in messages.
- **`src/sync/watcher.ts`:**
  - Field `private clipboard: HostClipboardBridge | null = null;`.
  - In `start()`, after port forwards:
```ts
// sandbox.clipboard "text": copies between this PC and the sandbox, only while its window is in front (host/clipboard).
const clip = readClipboardSettings(storageRoot, dataPath);
this.clipboard = clip?.bridge ? new HostClipboardBridge({ dataPath, settings: clip, open: () => openHostClipboard(storageRoot), note: (m) => this.note('clipboard: ' + m) }) : null;
this.clipboard?.start();
```
  - When `open()` returns null the bridge notes once: `'HostTools.exe could not be built, so no text is copied between this PC and the sandbox'`.
  - In `stop()`, first line: `this.clipboard?.stop();`. In the secrets cleanup block, add `clearClipboardFiles(this.dataPath)` under the same `!isSandboxRunning()` guard.
- **`src/host/launch/generate.ts`:** `clearClipboardFiles(dataPath);` after `clearSecrets(...)`.

### 7.4 Guest bridge
- **New `src/guest/daemon/clipboard-bridge.ts`** (pure with ports; no imports of `runtime/session` or `runtime/log`; added to `PURE_GUEST` in `src/selftest/layout.test.ts`):
```ts
export interface GuestClipboardHelper { onChange(listener: (text: string | null) => void): void; write(text: string): Promise<boolean>; onExit(listener: () => void): void; stop(): void; }
export interface GuestBridgeOptions { readonly run: RunDir; readonly toPc: boolean; readonly toSandbox: boolean; readonly open: () => GuestClipboardHelper | null; readonly log: (line: string) => void; readonly now?: () => number; }
export class GuestClipboardBridge {
  start(): void;  // open helper; 250 ms timer -> take(); on helper exit: reopen after 60 s, at most 5 times, log "Clipboard: the helper ended (n)".
  stop(): void;
  take(): Promise<boolean>;     // takeClipboardFile(run.clipboardToSandboxFile); dropped if !toSandbox; lastSet = hash; helper.write(text)
  changed(text: string | null): void;  // !toPc || text === null -> nothing; textHash === lastSet -> nothing; clipboardFile(text) -> writeJsonAtomic(run.clipboardToPcFile, ...); null (too big) -> nothing
}
```
- **New `src/guest/daemon/clipboard.ts`** (real side): `export function startClipboardBridge(): void`.
  - Returns unless `session.clipboard?.bridge && isWin && !testMode`.
  - The helper spawns `ensureCompiled('clipboardbridge')` with `['serve', '--max-bytes', String(CLIPBOARD_MAX_BYTES)]` and `windowsHide`.
  - Parses `changed <b64>` with `fromBase64Text`; `changed-other` maps to null. Replies to `set` go through a FIFO with a 5 s timeout.
  - Starts `new GuestClipboardBridge({ run, toPc, toSandbox, open, log: warn })`.
  - Never logs text.
- **`src/guest/entries/daemon.ts`:** `safely('clipboard', startClipboardBridge);` after `safely('port forwards', startRelays);`. Update the header to list the clipboard bridge.

### 7.5 Tests (P4, clipboard suite sections `files`, `gate`, `host bridge`, `guest bridge`)
- **files:**
  - The `clipboardFile` and `openClipboardFile` round trip; CRLF and emoji text keep their hash.
  - Refused:
    - 1 MiB + 1 byte, and `toBase64Text` of that gives null
    - non-canonical base64 (`'QQ'` without padding, whitespace)
    - invalid UTF-8 (`Buffer.from([0xc3,0x28])` as base64)
    - NUL in the text
    - wrong sha256
    - extra key (strict)
    - `v: 2`
  - `takeClipboardFile`:
    - deletes the file even when invalid
    - a 2 MB file gives null and is deleted
    - a missing file gives null
  - Reject a planted junction (Windows only: `fs.symlinkSync(target, dir, 'junction')` in `t.dir`, as the links suite does): `HostClipboardBridge.poll` returns null and does not delete in the target folder.
- **gate:** fake times.
  - Not in front gives background.
  - In front gives accept.
  - Left 1.5 s ago gives accept; 2.5 s ago gives background.
  - The same text again gives echo.
  - `toPc: false` gives off.
  - `toSandbox`: unchanged gives same; after a sandbox copy Y, PC Y gives same; PC X after that gives send. This is the X/Y/X scenario: copy X on PC and send; copy Y in sandbox and accept; copy X on PC again and send.
  - `toSandbox: false` gives off.
  - The first `foreground(true)` returns true and `foreground(true)` again returns false.
- **host bridge** (fake port and `t.dir` dataPath):
  - A copy accepted while in front reaches `port.write`; refused when not; the refusal note says a count and never contains the text (check the note strings do not include the random text).
  - A switch to the front writes `to-sandbox.json` with the PC text.
  - `toSandbox: false` writes none.
  - A file not taken in 15 s is deleted (inject `now`).
  - `stop()` removes both files.
  - The port's `read()` returning `tooBig` writes nothing.
- **guest bridge** (fake helper, `t.dir` RunDir):
  - `changed` writes `to-pc.json`.
  - A `take` of `to-sandbox.json` calls `write` and deletes the file; the helper's echo of that text writes nothing.
  - `toPc: false` writes nothing.
  - An invalid file is deleted unread.
- **layout suite:** passes with `guest/daemon/clipboard-bridge.js` in `PURE_GUEST`.

**P4 acceptance:** `npm run build`; `npm test -- clipboard,layout,channel,live-daemon,sync,sharing,secrets` prints ALL TESTS PASSED; `npm run lint`; `npm run format:check`.

---

## 8. Package P5 (Haiku): docs (after P4). CHANGELOG is left to the coordinator.
- **`docs/configuration.md`, Common settings table:** add two rows.
  - `sandbox.clipboard`: `"text"` (default), `"shared"` or `"off"` ([Copy and paste](#copy-and-paste)). `true` / `false` from older versions mean `"text"` / `"off"`.
  - `sandbox.clipboardDirection`: `"both"` (default), `"toPc"` or `"toSandbox"`; only for `"text"`.
- **New section `## Copy and paste`** before `## CPU, RAM and GPU`, at most 15 lines, covering:
  - the three modes
  - the foreground rule: "A copy in the sandbox reaches your PC only while the sandbox window is in front (or within 2 seconds after you leave it). The text on your PC's clipboard goes into the sandbox when you switch to its window, also when it first opens. Copies are text only, at most 1 MB."
  - shared needs Protected Client off, and the launch says so
  - a project file can only narrow (shared -> text -> off, both -> one way)
  - HCS: text through attached terminals
  - a headless sandbox: use `sandbox attach` (the agent's copy reaches your PC, and pasting into the terminal is typing)
  - where refusals are logged (the watcher log `host-sync-<set>.log`, counts only)
- **`docs/configuration.md` line ~305:** "turning off network, clipboard ..." becomes "narrowing the clipboard (`"shared"` -> `"text"` -> `"off"`, `sandbox.clipboardDirection`) and turning off network, ...".
- **`docs/configuration.md` line ~468:** HCS has "no desktop, GPU, shared clipboard (text copies through attached terminals), audio...".
- **`docs/troubleshooting.md` row at line 90:** "while `sandbox.clipboard` is on (the default)" becomes "while `sandbox.clipboard` is `"text"` (the default) or `"shared"`". Add a row "Copy from the sandbox does not reach the PC": the window must be in front, the mode, `sandbox doctor` "Clipboard", and the watcher log.
- **`docs/security.md` lines 74-76:** OSC 52 passes in `sandbox attach` when `sandbox.clipboard` is `"text"` or `"shared"` and not `"toSandbox"`. Add a bullet on the bridge: foreground rule, files next to `run\` (other users cannot reach them), deleted after reading, never logged, 1 MB text only, the marker.
- **`docs/design/engines.md`:** capabilities `copy and paste of text` (both engines) and `shared clipboard` (Windows Sandbox only).
- **`docs/projects.md` line 82:** unchanged wording is fine; add "clipboard mode and direction".

**P5 acceptance:** `npm run format:check`; `npm test -- ui-text,app`.

---

## 9. Order and parallelism
P1 and P3 run in parallel. Then P2 (needs P1). Then P4 (needs P2 and P3). Then P5. Each package ends with its own acceptance plus a final full `npm test` by the coordinator (gate on the text `ALL TESTS PASSED`).

**Real-PC check by the owner** (cannot be done in a sandbox):
1. Launch with defaults. The summary shows `Clipboard  text both ways (Protected Client on)`.
2. Copy in the sandbox window: it pastes on the PC.
3. Copy on the PC and click into the sandbox: it pastes there.
4. Make the guest set its clipboard while you are in another window (`Set-Clipboard x` from `sandbox exec` while you work elsewhere): the PC clipboard is unchanged and the watcher log says `refused 1 copy`.
5. Set `sandbox.clipboard shared`: the summary note says Protected Client is off, and images copy.

## 10. Risks
- **The foreground check depends on the sandbox client's process name** (`WindowsSandbox*`, as `Window.cs` already assumes). If a Windows version renames it, copies are only refused, never leaked. The log counts make it visible; the real-PC check above verifies it.
- **Clipboard locked by another program.** Mitigated by 10 tries x 30 ms; a failure is a lost copy, never a crash.
- **Switch latency.** The PC -> sandbox copy lands about 0.2-0.7 s after you switch (HostTools poll 150 ms, guest poll 250 ms). A very fast Ctrl+V right after Alt+Tab may paste the old text. Documented.
- **A hostile guest can overwrite your PC clipboard while you are in its window,** or within 2 s after you leave it. This is by design, documented.
- **OSC 52 in an attached terminal is not bound by the foreground rule** (D7). Documented; follow-up idea in D7.
- **Sandboxes running across the upgrade** have no clipboard settings file. There is no bridge until the next launch; attach falls back to your settings.
- **Allowed-request answers** stored for `sandbox.clipboard = true` are asked again once (D11).

## 11. Cleanups included
1. **`running.ts`** used your raw config for OSC 52 instead of what the sandbox booted with. It now reads the launch's own file (P2).
2. **Engine capabilities** mixed "shared" and "text". Now there are two capabilities, and HCS honestly says text works (P2).
3. **HCS documents** printed a clipboard note that resolution now gives (P2).
4. **Policy and boot-wants** hard-coded git as the only multi-value protection and `=== true` for boot settings. Replaced by `RANKED` / `strictness()` (P1).
5. **HostTools' source list** was duplicated in two tests. Now `hostToolsSources()` (P3).
6. **Guest csc helpers** can be built from more than one file (P3).
7. **`ClipboardWatch`** ignores bridge writes, so a switch to the window no longer puts the Ctrl+C guard in copy mode (P3).
8. **Security and troubleshooting docs** said "clipboard on" (P5).

Optional follow-up, not planned: the guest viewer could use `ClipboardBridge.exe` instead of starting PowerShell + Add-Type for each terminal.

## 12. Rules to keep in mind
- **CLAUDE.md** lists the guest files host code may import. Adding `daemon/clipboard-bridge` there is a docs change the coordinator should make only with the user's OK. The enforced list is `PURE_GUEST` in the layout suite.
- **Escaping.** Backslashes in TypeScript strings are written with the Edit tool, never through heredocs or `node -e`.
- **Never on a real PC.** All tests use `t.dir`. Nothing reads or sets the real clipboard except `clipboard-live`, which saves and restores it, refuses to write when rdpclip runs, and only runs where the self-test is allowed.
- **Never log clipboard text.** Grep the new code for `note(`, `log(` and `warn(` near `text` before calling it done.

### Critical files for implementation
- C:\Projects\AgentProjects\windows-sandbox\src\core\clipboard.ts (new) and src\core\schema\sandbox.ts
- C:\Projects\AgentProjects\windows-sandbox\src\core\local-config\overrides.ts (+ policy.ts, boot-wants.ts)
- C:\Projects\AgentProjects\windows-sandbox\src\host\launch\generate.ts (+ launch-plan.ts, session-file.ts, engines\windows-sandbox\wsb-text.ts)
- C:\Projects\AgentProjects\windows-sandbox\src\sync\watcher.ts with src\host\clipboard\bridge.ts (new), src\shared\clipboard\gate.ts (new), src\guest\daemon\clipboard-bridge.ts (new)
- C:\Projects\AgentProjects\windows-sandbox\sandbox\csharp\ClipboardText.cs (new) with native\csharp\HostTools\HostClipboard.cs (new), Window.cs, Program.cs, src\host\native.ts

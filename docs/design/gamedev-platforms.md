# Game, modding and mobile development with saved service sign-ins (design)

Status: approved by the secondary maintainer on 2026-11-02 (decisions marked **Decided**). Implemented in packages P1
(framework, first) and P2-P7 (parallel, after P1). Release: one minor version after every package is merged.

## 0. What is feasible

| Area | In Windows Sandbox | Where it lives | Size | Sign-in, and does it move between sandboxes |
| --- | --- | --- | --- | --- |
| SteamCMD (games, servers, workshop get/push, ContentBuilder) | Yes. `steamcmd.zip` from `steamcdn-a.akamaihd.net/client/installer/` (no checksum; `steamcmd.exe` is Valve-signed: check the signer) | binaries `tools\steamcmd`, working copy `C:\SteamCMD` each boot (its `config\` = the login never sits on the data disk) | 0.3 GB | `config\config.vdf` (ConnectCache) + `ssfn*` sentry files; CI tools copy them between machines to skip Steam Guard (verify on a PC). No password stored: first `sbx-steam login` is typed inside |
| Steam client (Steamworks API tests, overlay, in-game UGC upload) | Optional. SteamSetup.exe Valve-signed; unpack, steam.exe self-updates | `tools\steam` | 1-1.5 GB + games | `local.vdf` is very likely sealed to the Windows user: treat as not portable (sign in per sandbox). Payload keeps a reserved `client` field |
| Steamworks SDK | Not downloaded (partner login + licence) | project's `redistributable_bin` or a mapped folder; `toolchains.steam.sdkFolder` sets `STEAMWORKS_SDK` | - | ContentBuilder needs only steamcmd |
| PC's Steam/Epic libraries | Yes, mapped read-only (no copy) | `C:\PcInstalls\steam\...`, `C:\PcInstalls\epic\...` | 0 on C: | Steam client cannot use a read-only library: writable copy via `sbx-steam app <id>` into `tools\steam-apps` (free-space check) |
| Unreal Engine | Yes. VS Community is a real installer (exists); engine from the PC read-only, or installed by the launcher into `tools\unreal\engines` and re-registered each boot | data disk | 40-60 GB per engine, DDC 10-50 GB | Epic (fixed in P1) |
| Unity | Yes. Release API `services.api.unity.com/unity/editor/release/v1/releases` (SRI integrity); NSIS `/S /D=` into `tools\unity\<ver>`; editor runs without registry | data disk | editor 6-7 GB; Android module 4-5 GB; WebGL 1.5 GB | `Unity_lic.ulf`; portability unclear (verify on a PC). Fallback: sign in via Hub inside, the new `.ulf` is captured. Pro serial: best-effort `-returnlicense` |
| Godot (+ .NET) | Yes. `godotengine/godot-builds` releases with SHA512-SUMS; self-contained (`_sc_`) keeps data and templates beside the exe | data disk | 0.2 GB + ~1.2 GB templates per version | none |
| FiveM / RedM server (FXServer, txAdmin) | Server yes. Versions from `changelogs-live.fivem.net/api/changelog/versions/win32/server` (txAdmin bundled). No checksums: refused under `downloads.requireChecksum` unless FXServer.exe is signed (verify). Client NOT supported (GTA V, Rockstar login, anti-cheat) | `tools\fivem\artifacts\<build>`; txData `state\fivem` | 0.15 GB per build | `sv_licenseKey` (Cfx.re keymaster), optional `steam_webApiKey`: sealed, written each boot to a cfg on the sandbox's own disk that `+exec` reads |
| Android SDK (cmdline-tools, platform-tools, build-tools, platforms, NDK, CMake), Gradle, JDK | Yes, no emulator. URL + SHA-1 from `repository2-3.xml`; sdkmanager checks packages | `tools\android-sdk` | ~1 GB, +3 GB NDK | upload keystore + passwords (sealed); debug keystore and adb key in `state\android` |
| Flutter, Dart | Yes. `releases_windows.json` (sha256); Dart from dart-archive (`.sha256sum`). Windows desktop builds need VS Build Tools (real installer each boot) | data disk | Flutter 2.5 GB, Dart 0.2 GB | none |
| React Native / Expo | Yes (Node, Android, `eas-cli`); iOS builds in EAS cloud | - | - | `EXPO_TOKEN`, App Store Connect API key (`.p8`) |
| .NET MAUI | Android yes (`maui-android` workload); Windows target from dotnet CLI (verify); iOS/Mac no | - | - | - |
| Kotlin | Yes (Gradle; `kotlinc` from JetBrains releases, digest) | - | 0.1 GB | - |
| Blender and asset tools | apps (Blender already in the catalogue) | `tools\apps` | - | - |

**Not doing (Decided), and why:** Android emulator / WSA / Hyper-V (no nested virtualisation). Local iOS builds (no
Xcode/macOS; possible instead: write the code, Unity/Godot Xcode-project export, EAS Build/Submit, Codemagic, GitHub
macOS runners, `ssh` to your own Mac). Docker/GameCI images (no Docker). GameMaker (closed installer, Opera-account
runtimes; `apps.custom` covers it). O3DE (10 GB+ installer and hours of builds: documented as a source build). Swift for
Windows (VS every boot, SwiftPM symlinks fail on mapped folders, no iOS value: later). raylib, FNA, Bevy, MonoGame:
libraries on existing toolchains (docs recipes; `dotnet.templates`). Steam Guard TOTP secrets: never stored (permanent
2FA for the agent). Steamworks SDK / Epic downloads via Legendary: login and terms gated. Copying PC game installs:
map read-only instead. Unity Pro seat return on an abrupt close: not guaranteed (warned).

## 1. Shared architecture

### 1a. Service accounts (one generic kind in the Accounts feature)

Kinds: `epic, steam, unity, cfx, keystore, play, expo, appstore`.

Settings: user-only top-level `accounts.<kind>.share: boolean` (default false), replacing the unreleased
`toolchains.unreal.epicLogin`. `LocalOverrides` gets `accounts.<kind>.share` (partial); every share path goes in
`OFF_IS_SAFER` (a project can only turn it off). **Decided:** every `*.acceptLicense` (`msvc`, `unreal`, `unity`,
`fivem`, `android`) also goes in `OFF_IS_SAFER`: a repo must never accept a licence, or a 40 GB install, for you.

Pure spec `src/shared/accounts/kinds.ts` (zod only, web-safe):

```ts
export const SERVICE_KINDS = ['epic','steam','unity','cfx','keystore','play','expo','appstore'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];
export type UsedBy = 'unreal'|'steam'|'unity'|'fivem'|'android'|'flutter'|'reactNative'|'godot'|'dotnet';
export type AccountSource = 'pc' | 'file' | 'typed' | 'sandbox';
export interface ServiceField { readonly name: string; readonly label: string; readonly secret: boolean; readonly optional?: boolean; readonly pattern?: RegExp }
export interface ServiceSpec<K extends ServiceKind = ServiceKind> {
  readonly kind: K; readonly label: string;
  readonly usedBy: readonly UsedBy[];        // handed over only when one of these is on for this boot
  readonly sources: readonly AccountSource[];
  readonly singleHolder: boolean;            // one sandbox at a time (lease)
  readonly returns: boolean;                 // the guest may hand a renewed one back
  readonly maxBytes: number;
  readonly warnings: readonly string[];      // shown on every surface
  readonly fields: readonly ServiceField[];  // what `login` asks / what `import --from` needs
}
export const SERVICE_SPECS: { readonly [K in ServiceKind]: ServiceSpec<K> };
// payloads.ts
export const PAYLOADS: { readonly [K in ServiceKind]: z.ZodType };
export type Payload<K extends ServiceKind> = z.output<(typeof PAYLOADS)[K]>;
export const ServiceAccountsSchema: z.ZodType;  // strictObject of optional payloads: the secrets-file field
export const HANDOFF_PARTS = ['state', 'accounts'] as const;   // <data>\state\accounts\<kind>.json
export function handoffSchema<K extends ServiceKind>(kind: K): z.ZodType<{ kind: K; launchId: string; payload: Payload<K> }>;
export function serviceWanted(kind: ServiceKind, on: ReadonlySet<UsedBy>): boolean;
// fingerprint.ts (node:crypto, not for web)
export function fingerprint(payload: unknown): string;   // sha256 of canonical JSON
```

Payloads:

| Kind | Fields | Returns | One holder | Used by |
| --- | --- | --- | --- | --- |
| epic | `{data}` | yes | yes | unreal |
| steam | `{account, configVdf <=256 KB, sentries <=4 x {name:/^ssfn\d+$/, base64 <=64 KB}, client?}` | yes | yes | steam |
| unity | `{ulf? <=128 KB, email?, password?, serial?}` | yes | yes | unity |
| cfx | `{licenseKey: /^cfxk_[A-Za-z0-9_]+$/, steamWebApiKey?: /^[A-F0-9]{32}$/}` | no | no | fivem |
| keystore | `{fileName, jksBase64 <=256 KB, storePassword, keyAlias, keyPassword}` | no | no | android (flutter, reactNative, godot, unity imply android) |
| play | `{serviceAccountJson <=64 KB, type === 'service_account'}` | no | no | android |
| expo | `{token}` | no | no | reactNative |
| appstore | `{issuerId: uuid, keyId: /^[A-Z0-9]{10}$/, p8: PEM}` | no | no | reactNative, flutter |

Host side `src/host/accounts/`:

```ts
export class ServiceAccountStore {           // <storage>\accounts\<kind>.json {savedAt, source, summary, sealed}
  constructor(storageRoot: string, secrets?: SecretStore);
  state(kind: ServiceKind): 'none' | 'saved' | 'unreadable';
  info(kind: ServiceKind): { savedAt: string; source: AccountSource; summary: string | null } | null;
  read<K extends ServiceKind>(kind: K): Payload<K> | null;
  save<K extends ServiceKind>(kind: K, payload: Payload<K>, source: AccountSource): void;
  remove(kind: ServiceKind): boolean;
}
export interface Lease { readonly kind: ServiceKind; readonly dataSet: string; readonly launchId: string; readonly issuedAt: string; readonly delivered: string | null }
export class AccountLeases {                  // <storage>\accounts\leases.json (host-only)
  constructor(storageRoot: string);
  holder(kind: ServiceKind): Lease | null;
  claim(kind: ServiceKind, dataSet: string, launchId: string, delivered: string | null,
        isRunning: (dataSet: string) => boolean): { ok: true } | { ok: false; heldBy: string };
  release(kind: ServiceKind, dataSet: string): void;
  releaseAll(dataSet: string): void;
  revoke(kind: ServiceKind): Lease[];
}
export interface AccountDelivery { readonly payloads: Partial<{ [K in ServiceKind]: Payload<K> }>; readonly notes: readonly string[] }
export function prepareServiceAccounts(i: {
  config: Config; others: readonly BootWant[]; on: ReadonlySet<UsedBy>; storageRoot: string; dataPath: string;
  launchId: string; isRunning: (dataSet: string) => boolean; store?: ServiceAccountStore; leases?: AccountLeases;
}): AccountDelivery;                                            // never throws; notes never hold a secret
export function takeHandoffs(dataPath: string, final: boolean, store?: ServiceAccountStore, leases?: AccountLeases):
  { taken: ServiceKind[]; dropped: ServiceKind[] };            // reads hostDataFolder(dataPath,'state')
export function forgetEverywhere(kind: ServiceKind, storageRoot: string): { pendingDeleted: number };
export interface PcEnv { readonly localAppData: string; readonly appData: string; readonly programData: string }
export interface HostSource<K extends ServiceKind> {
  fromPc?(pc: PcEnv, from?: string): Payload<K> | null;
  fromFile?(bytes: Buffer, answers: Readonly<Record<string, string>>): Payload<K>;
  fromAnswers?(answers: Readonly<Record<string, string>>): Payload<K>;
  summary(p: Payload<K>): string | null;                       // e.g. Steam account name; never the secret
}
export const HOST_SOURCES: { readonly [K in ServiceKind]: HostSource<K> };   // sources.ts imports kinds/<kind>.ts
```

One delivery path: `launch.ts` calls `prepareServiceAccounts`; it hands over only kinds that are shared, used by a
toolchain that is on for a boot project, and not turned off by any project in the boot (`others`); one-holder kinds
need a free lease (else a note: "in use by sandbox X"); a lease is claimed even when nothing is saved yet, so a first
sign-in made inside can come back. Payloads go into `GenerateOptions.serviceAccounts` -> `writeSecrets` field
`serviceAccounts` (replaces `epicLogin`); `generate.ts` re-checks `config.accounts[k].share` like the GitHub token.
A project that joins later gets them in its request's secrets file (`withRequestSecrets`).

Guest side `src/guest/accounts/`:

```ts
export interface Applied { readonly env?: Readonly<Record<string, string>>; readonly summary: string }
export interface GuestAdapter<K extends ServiceKind> {
  readonly kind: K;
  apply(p: Payload<K>): Promise<Applied> | Applied;   // writes only to secretDir(kind) / the tool's own local files
  current?(): Payload<K> | null;                      // bounded, BOM-aware read of what the tool holds now
  readonly checkMs?: number;                          // default 60000
  release?(): Promise<void> | void;                   // flush time: e.g. Unity -returnlicense
}
export const ADAPTERS: { readonly [K in ServiceKind]: GuestAdapter<K> };
export function secretDir(kind: ServiceKind): string;  // %LOCALAPPDATA%\AgentSandbox\accounts\<kind> (own disk, wiped)
export function applyServiceAccounts(given: z.output<typeof ServiceAccountsSchema> | undefined): Promise<Record<string, string>>;
export class AccountWatch { constructor(kinds: readonly ServiceKind[]); start(): void; flush(): void }
```

Boot applies each payload, drops it from memory, writes delivered fingerprints and leased kinds to
`secretDir\delivered.json`; the returned env joins `applyBootEnvironment`. The daemon runs `AccountWatch` only for kinds
that return, seeded with the delivered fingerprint (the first check writes nothing). A handoff is written to
`state\accounts\<kind>.json` only when the fingerprint changes. `flush()` runs where claude-mem is saved (2-minute save,
idle shutdown, session close). The host runs `takeHandoffs` on every Watcher sync cycle; the final sync releases the
leases. A handoff without a lease for that data set, or failing size/link/schema, is deleted unsealed.

New helpers: `shared/io/bounded.ts` `readBoundedFile(file, max)` (lstat no links, open, fstat, read at most max+1 bytes
from the descriptor); `shared/io/text.ts` `decodeText` / `encodeText` (BOM-aware UTF-8 / UTF-16LE, writes back in the
encoding read).

Epic defects -> fixes: no CLI command -> account actions; contained storage path -> `hostDataFolder(dataPath,'state')`;
host seals any file -> lease check; delivered without the toolchain / ignores other projects -> `serviceWanted` +
`others`; no final check -> `flush()` + take every cycle; logout leaves pending copies -> `forgetEverywhere`; first
check copies back -> seeded fingerprint; UTF-16 ini -> `text.ts`; implied confirm -> `implied: false`, `--yes`; size
race -> `readBoundedFile`.

App feature `src/app/features/accounts/services.{def,run}.ts` (re-exported by the accounts barrel):
`listServices` (query `accounts.services`, cli `account status [name]`, json; per kind `{kind, label, share, state,
source, savedAt, summary, heldBy, usedBy}`), `serviceLogin` (`accounts.service.login`, asks `fields` via
`io.secret`/`io.text`), `serviceImport` (`accounts.service.import`, `--from`, `--yes`; one-holder kinds warn the PC is
signed out), `serviceLogout` (`accounts.service.logout`, danger, `--yes`). The share toggle reuses `setSetting {scope:
'user', key: 'accounts.<kind>.share'}` as a page action.

**The owner's rule (Decided):** service sign-ins live in the Accounts section on every surface. There is NO `sandbox
epic` (or `sandbox steam` ...) command. CLI fits the existing `sandbox account <action> [name]`:

```
sandbox account status [epic]
sandbox account import epic | unity | steam --from C:\steamcmd | keystore --from upload.jks
sandbox account login cfx | expo | appstore | play
sandbox account logout steam [--yes]
```

`manifest.ts`: widen `name`'s description, add `--from <path>` (with `import`), widen the option `when` to
`string | string[]` so `--yes` covers `remove`, `import`, `logout`. `sandbox account list` adds a "Services" block
(JSON shape unchanged). Menu: `AccountsPage` gets one category per kind after the agents (`servicePage(kind)`). Web:
`accountsView` adds the `services` query and appends the service sections (one renderer). Removed: the Epic Settings
row, the `epic` view, the NAV embed, `MENU_VIEWS` entry.

### 1b. Large persisted installs (`src/guest/toolchains/persisted.ts`, `installers.ts`)

```ts
export interface InstallSpec { readonly name: string; readonly version: string; readonly needBytes: number;
  readonly marker: string; readonly what: string; readonly keepVersions?: number }
export interface Installed { readonly dir: string; readonly fresh: boolean; readonly sizeBytes: number | null }
export async function ensurePersisted(spec: InstallSpec, install: (staging: string, temp: string) => Promise<void>): Promise<Installed>;
export function freeBytes(dir: string): number;
export function assertRoom(dir: string, needBytes: number, what: string, fix: string): void;
export function assertLocalRoom(needBytes: number, what: string): void;      // C:: need + 13 GB (paging file, builds)
export function recordUse(name: string, version: string): void;
export function installRecords(): readonly InstallRecord[];                  // tools\installs.json
export async function signedInstaller(url: string, file: string, what: string, signer: string | RegExp, sha256?: string | null): Promise<string>;
export const SIGNERS: { readonly microsoft: string; readonly valve: RegExp; readonly unity: RegExp };
// native/visual-studio.ts (moved out of unreal.ts)
export interface VsRequest { readonly product: 'community' | 'buildtools'; readonly components: readonly string[] }
export function visualStudioWanted(t: Toolchains): VsRequest | null;   // union: unreal, flutter.windowsDesktop, unity windows-il2cpp
export async function ensureVisualStudio(env: ToolEnv, req: VsRequest, o: { keepInstallFiles: boolean }): Promise<{ path: string; version: string }>;
```

`ensurePersisted`: checks room on the data disk (under contained storage that is the image: the fix names
`storage.containedMaxGb`), stages next to the target with `TEMP` inside it (mapped-folder move gotcha), writes
`.complete.json`, records the size in `tools\installs.json` (guest-written: the host reads it zod-checked, prints via
`safeText`; `sandbox data` shows it without walking 60 GB), prunes versions beyond `keepVersions`. Modules re-register
what they installed every boot. Real installers (VS, DirectX, Epic Launcher) stay on C: via `assertLocalRoom`. The
`Downloader` gains `sha1` and a `verify(file)` hook (Authenticode signer) that counts as integrity for
`requireChecksum`.

### 1c. Read-only PC installs

New user-only top-level section (never in `LocalOverrides`): `pcInstalls: { steamGames: boolean|number[], epicGames:
boolean|string[], unrealEngines: boolean|string[], unityEditors: boolean|string[] }`, all false. `src/host/pc-installs/`
finds them (Steam: `reg.exe` via system32 for `SteamPath` -> `libraryfolders.vdf` + app manifests; Epic:
`%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item`; Unreal: `LauncherInstalled.dat` +
`HKCU\Software\Epic Games\Unreal Engine\Builds`; Unity: Hub `secondaryInstallPath.json` + default Hub folder), bounded
sizes, paths through `assertSafeMapping`.

```ts
export interface PcInstall { readonly kind: 'steam-game'|'epic-game'|'unreal'|'unity'; readonly id: string; readonly name: string; readonly version?: string; readonly host: string; readonly guest: string }
export interface PcInstallSource { readonly kind: PcInstall['kind']; find(wanted: true | readonly (string | number)[], pc: PcEnv): PcInstall[] }
export interface PcInstallManifest { readonly items: readonly Omit<PcInstall, 'host'>[] }
export function discoverPcInstalls(s: PcInstalls, pc?: PcEnv): { mappings: ResolvedMapping[]; manifest: PcInstallManifest; notes: string[] };
```

Guest paths: `steamGames: true` -> `C:\PcInstalls\steam\library<N>` (each library's `steamapps`, read-only);
`steamGames: [ids]` -> `C:\PcInstalls\steam\<appid>`; `epicGames` -> `C:\PcInstalls\epic\<AppName>`; `unrealEngines` ->
`C:\PcInstalls\unreal\<UE_x>`; `unityEditors` -> `C:\PcInstalls\unity\<ver>`. `C:\PcInstalls` reserved in
`shared/paths`. `GuestSession.pcInstalls` holds the manifest (paths only). `collectMappings` takes
`o.pcInstallMappings`.

### 1d. One guest helper entry

`src/guest/entries/tool.ts` dispatches to `src/guest/devtools/<name>.ts`; boot writes `sbx-steam`, `sbx-fivem`,
`sbx-unity`, `sbx-android` `.cmd` shims next to `sbx-db` for the toolchains that are on.

```ts
export interface DevTool { readonly name: 'steam'|'fivem'|'unity'|'android'; readonly summary: string; run(args: readonly string[]): Promise<number> }
```

Step signature for new modules: `setupX(env: ToolEnv, config: Toolchains['x'], ctx: ToolCtx): Promise<void>` with
`ToolCtx = { refresh: boolean; pcInstalls: PcInstallManifest; duringSession: boolean }`. VS never installs during a
session (notes "restart").

## 2. Per area

New DEFAULTS (P1 adds all, with `config.example.json` and the schema):

```
toolchains.unreal:      {enabled:'auto', acceptLicense:false, components:[], keepInstallFiles:true, persistEngines:true, derivedDataCache:'persisted'}
toolchains.unity:       {enabled:'auto', acceptLicense:false, version:'project', modules:[], hub:false, keepVersions:2}
toolchains.godot:       {enabled:'auto', version:'project', dotnet:'auto', exportTemplates:true, keepVersions:2}
toolchains.steam:       {enabled:'auto', client:false, sdkFolder:''}
toolchains.fivem:       {enabled:'auto', acceptLicense:false, game:'gta5', artifact:'recommended', txAdmin:true, keepVersions:2}
toolchains.android:     {enabled:'auto', acceptLicense:false, platforms:['project'], buildTools:'latest', ndk:'auto', cmake:'auto', packages:[]}
toolchains.flutter:     {enabled:'auto', version:'project', windowsDesktop:false, precache:['android','web']}
toolchains.dart:        {enabled:'auto', version:'stable'}
toolchains.reactNative: {enabled:'auto', easCli:true}
toolchains.java.kotlin: false        toolchains.dotnet.templates: []
pcInstalls: {steamGames:false, epicGames:false, unrealEngines:false, unityEditors:false}
accounts:   {epic|steam|unity|cfx|keystore|play|expo|appstore: {share:false}}
```

Detection (`MARKERS` = file names; deeper checks via bounded hints): unity `ProjectVersion.txt`; godot
`project.godot` (+ dotnet / android export from `.csproj` / `export_presets.cfg`); steam `steam_appid.txt`,
`steam_api64.dll`, `steam_api.dll` (+ VDF with `"AppBuild"` / `"workshopitem"`); fivem `fxmanifest.lua`,
`__resource.lua` (depth 3); android: gradle `com.android.`, AndroidManifest depth 3, MAUI `<UseMaui>`; flutter: pubspec
with `flutter:`; dart: pubspec without; reactNative: package.json deps `react-native` / `expo`; java adds `*.kt`.
Implications: flutter / reactNative / MAUI / godot Android export -> android; android -> java (JDK 17+); godot.dotnet,
FiveM C# resource, MAUI -> dotnet. Licensed `auto` (msvc, unreal, unity, fivem, android) installs only after
`acceptLicense`.

| Area | Guest module | Account | Apps / docs | C: vs data disk |
| --- | --- | --- | --- | --- |
| Steam | steamcmd -> `C:\SteamCMD`, `steamcmd` on PATH. `sbx-steam`: `login`, `app <id> [--beta] [--dir]` (free-space check, size after), `workshop get <app> <item>...` (`+force_install_dir` on `cache\steam-workshop`), `workshop push <item.vdf>` (`workshop_build_item`), `build <app_build.vdf> [--preview]` (`run_app_build`), `games`, `client` | steam (captured inside, or import a PC steamcmd folder) | docs/steam.md | C: 0.3 GB; data: client, games, servers |
| Unreal | shared VS step; launcher default install location `tools\unreal\engines`; each boot restores launcher manifests + `LauncherInstalled.dat`, lists PC engines from `pcInstalls`; `UE-LocalDataCachePath` -> `tools\unreal\ddc` | epic | docs/game-engines.md | C: ~8 GB (VS, launcher); data: engines, DDC |
| Unity | Release API (version from `ProjectVersion.txt`, changeset), signed NSIS `/S /D` into `tools\unity\<ver>`, modules (`android`, `webgl`, `windows-il2cpp` adds VS components, `ios` = Xcode export only), Hub `editors-v2.json` when `hub`. `sbx-unity`: `install`, `editors`, `build -executeMethod`, `license status/return` | unity | docs/unity.md | data 6-12 GB per version |
| Godot | godot-builds zip (+ mono), `_sc_`, `godot` console exe on PATH, templates, Android SDK/JDK paths in `editor_settings-4.tres`; the `godot` app is skipped while the toolchain is on | - | docs/game-engines.md + apps: RenderDoc, Krita, Inkscape, Audacity, TrenchBroom, LDtk, Material Maker, GDevelop, Ren'Py, Tracy, Defold `bob.jar` | data ~1.5 GB per version |
| FiveM/RedM | artifacts by build into `tools\fivem\artifacts`. `sbx-fivem`: `serve [--txadmin]` (`+exec <secrets cfg> +exec server.cfg`; `+set gamename rdr3` for RedM; opens 30120/40120 in the sandbox firewall via a `.ps1`), `artifact list/use`, `new <res> --lua/--js/--ts/--cs`, `natives`. oxmysql with `databases.mysql` | cfx | docs/fivem.md + apps: lua-language-server, StyLua, selene, CodeWalker (needs the game read-only from `pcInstalls`) | data ~0.3 GB |
| Android | cmdline-tools (SHA-1 from repository XML), sdkmanager with licences, refuses `emulator` / `system-images`; `ANDROID_HOME`, `ANDROID_USER_HOME=state\android`, `AndroidSdkDirectory`, `JavaSdkDirectory`; LongPathsEnabled. `sbx-android`: `sdk`, `devices`, `connect ip:port` (only when the network setting allows the LAN). Kotlin `kotlinc`. MAUI `maui-android` workload | keystore (in `secretDir`; signing env, verify), play | docs/android.md + app android-studio (~3 GB) | data 1-4 GB |
| Flutter, Dart, RN/Expo, iOS | Flutter (version from `.fvmrc` / releases json), precache, `windowsDesktop` uses VS Build Tools; Dart SDK; `eas-cli` global | expo (`EXPO_TOKEN`), appstore (`.p8` in `secretDir`; `EXPO_ASC_*`) | docs/mobile.md (incl. iOS can/cannot) | data 3-4 GB |

## 3. Work packages

P1 first; it owns every shared file and lands stubs with the agreed signatures for every file the others own (stubs log
"not available yet" and return). P2-P7 then run in parallel in their own worktrees and edit no shared file except where
listed.

- **P1 framework**: accounts (shared/host/guest/app), persisted installs, PC installs, Epic fixes (moved into
  `accounts/kinds/epic.ts`; delete `src/app/features/epic/**`, `src/host/epic/**`, `src/shared/epic/**`,
  `src/guest/setup/epic-login.ts`, `src/selftest/epic.test.ts`, tests folded into `service-accounts.test.ts`), VS
  refactor (`native/visual-studio.ts`), tool entry, every schema/DEFAULTS/config.example/detect/plan/catalogue/manifest/
  menu/web/docs edit, stubs for P2-P7, `docs/accounts.md`, suites `service-accounts`, `persisted-installs`, `pc-installs`.
- **P2 Steam**: `src/guest/toolchains/steam/{steam,steamcmd,client}.ts`, `src/guest/devtools/steam.ts`,
  `src/shared/vdf.ts` (pure bounded parser), `src/{host,guest}/accounts/kinds/steam.ts`, `src/host/pc-installs/steam.ts`,
  `src/host/launch/hints/steam.ts`, `docs/steam.md`, `src/selftest/steam.test.ts`.
- **P3 Unreal engines, Godot, game-dev apps**: `src/guest/toolchains/engines/{unreal-engines,godot}.ts`,
  `src/host/pc-installs/{unreal,epic}.ts`, `src/host/launch/hints/engines.ts`, `src/shared/apps/catalogue-gamedev.ts`,
  `src/guest/apps/resolvers-gamedev.ts`, `docs/game-engines.md`, `src/selftest/engines.test.ts`; shared edits:
  `guest/apps/app-installer.ts` (skip `godot` app while the toolchain is on), `native/dotnet.ts` (`dotnet.templates`).
- **P4 Unity**: `src/guest/toolchains/engines/{unity,unity-release}.ts`, `src/guest/devtools/unity.ts`,
  `src/{host,guest}/accounts/kinds/unity.ts`, `src/host/pc-installs/unity.ts`, `docs/unity.md`,
  `src/selftest/unity.test.ts`.
- **P5 FiveM / RedM**: `src/guest/toolchains/fivem/{fivem,artifacts}.ts`, `src/guest/devtools/fivem.ts`,
  `src/{host,guest}/accounts/kinds/cfx.ts`, `src/host/launch/hints/fivem.ts`, `src/shared/apps/catalogue-modding.ts`,
  `sandbox/scripts/add-firewall-port.ps1`, `sandbox/templates/fivem/**`, `docs/fivem.md`, `src/selftest/fivem.test.ts`.
- **P6 Android, Kotlin, MAUI, signing**: `src/guest/toolchains/mobile/{android,android-repo}.ts`,
  `src/guest/toolchains/languages/kotlin.ts`, `src/guest/devtools/android.ts`,
  `src/{host,guest}/accounts/kinds/{keystore,play}.ts`, `src/host/launch/hints/android.ts`,
  `src/shared/apps/catalogue-mobile.ts`, `src/guest/apps/resolvers-mobile.ts`, `docs/android.md`,
  `src/selftest/android.test.ts`; shared edit `languages/java.ts` (`ensureJdk(major)`, kotlin). Exports:

  ```ts
  export interface AndroidSdkRequest { readonly packages: readonly string[]; readonly ndk?: string | 'auto' | false }
  export interface AndroidSdk { readonly root: string; readonly javaHome: string | null; readonly installed: readonly string[] }
  export async function ensureAndroidSdk(env: ToolEnv, req: AndroidSdkRequest): Promise<AndroidSdk>;
  export function androidEnv(sdk: AndroidSdk): Record<string, string>;
  ```

- **P7 Flutter, Dart, React Native / Expo, iOS-in-the-cloud**: `src/guest/toolchains/mobile/{flutter,dart,react-native}.ts`,
  `src/{host,guest}/accounts/kinds/{expo,appstore}.ts`, `src/host/launch/hints/mobile.ts`, `docs/mobile.md`,
  `src/selftest/mobile.test.ts`; uses P6's `ensureAndroidSdk` (stub against the interface) and P1's VS step.

## 4. Risks, real-PC checks, tests

Needs a real PC: SteamCMD `config.vdf` + ssfn between sandboxes; Steam client in `tools\steam` on a mapped folder;
Epic Launcher seeing engines in `tools\` after manifests are restored; UE editor from a read-only PC engine; DDC; Unity
`.ulf` portability, Library LMDB on the mapped workspace (may fail like SQLite WAL), NSIS into a mapped folder, Hub;
sdkmanager `.temp` and long NDK paths on a mapped folder; Gradle signing env; FXServer reachable from the PC on
30120/40120, artifact signature, txAdmin; free space on mapped folders and the contained image; mapped-folder count
limits; vGPU for editors; Flutter desktop boot time; MAUI Windows target.

Other risks: big installs fill the PC disk (`acceptLicense` + free-space checks + sizes in `sandbox data`); the agent
can use every shared account (warnings on every surface, off by default); Unity Pro seat churn; read-only libraries
expose game files (opt-in per game ID).

Tests (self-test only, temp folders, `SecretStore.memory()`): P1: store seal/open/unreadable; leases (claim, one
holder, stale, release at final sync); delivery gates (share off, toolchain off, another project tightening, holder
busy, secrets only in the one-shot file); handoff (no lease -> dropped, contained path, link -> dropped, oversize ->
dropped, first check writes nothing, flush); `forgetEverywhere`; `readBoundedFile` growth race; UTF-16 round trip;
`account` CLI grammar (`--help`, import not implied); accounts view on all surfaces (`npm test app`); `ensurePersisted`
(staging, marker, refusal when short via injected statfs, pruning); `pcInstalls` placement, never in `LocalOverrides`;
markers / implications / licence gates; `config.example.json` equals `DEFAULTS`. P2: VDF parser limits; Steam payload
from a fake steamcmd folder; workshop/build arguments; library discovery from a fixture `libraryfolders.vdf`. P3:
LauncherInstalled.dat writer; DDC env; Godot version from `project.godot`; SHA512-SUMS pick; catalogue entries. P4:
ProjectVersion parsing; Release-API fixture with SRI; module -> component mapping; ulf adapter. P5: versions-API
fixture; secrets cfg on the sandbox disk only; RedM argument; scaffolds. P6: repository-XML parse + SHA-1; package
refusal; keystore apply; env vars. P7: releases_windows.json pick and `.fvmrc`; pubspec flutter vs dart; RN/Expo hint;
expo and appstore adapters.

## 5. P8: Perplexity and computer-use agent tools (added 2026-11-02)

Owner's request: Perplexity credentials copied into the sandbox and Perplexity installed (optional), for "Perplexity
computer use", plus similar tools. Research (sources in the P8 report, summarised here):

- **Perplexity Computer** (cloud agent) has an official Computer MCP server: `https://www.perplexity.ai/rest/computer/mcp`
  (HTTP, OAuth with the Perplexity account, uses account credits). Claude Code keeps MCP OAuth tokens in
  `.credentials.json` (`mcpOAuth`), which saved Claude accounts already carry. Codex keeps them in
  `$CODEX_HOME/.credentials.json` only with `mcp_oauth_credentials_store = "file"`: P8 adds `.credentials.json` to
  `harnesses.codex.home.loginFiles` and sets that key at boot (like `codexWithoutInnerSandbox`, only when unset).
- **Perplexity API** (`PERPLEXITY_API_KEY`, `pplx-...`, billed separately from Pro): copyable. MCP server npm
  `@perplexity-ai/mcp-server` (bin `dist/index.js`, tools perplexity_search/ask/research/reason) or remote
  `https://api.perplexity.ai/mcp` with a Bearer header.
- **Comet** (Chromium agentic browser): installer `https://www.perplexity.ai/rest/browser/download?platform=win_x64&channel=stable`
  (307 to a presigned R2 URL, ~238 MB, hash changes per release: check the Authenticode signer O/CN = `PERPLEXITY AI,
  INC.`, issuer GlobalSign GCC R45 EV CodeSigning CA 2020). Preferred install: unpack with 7-Zip
  (exe -> UPDATER.PACKED.7Z -> mini_installer.exe -> CHROME.PACKED.7Z -> chrome.7z -> Chrome-bin) and run portable from
  `tools\apps\comet` (no per-boot reinstall, no updater, no app-bound encryption). Fallback: `--install --silent` each
  boot. Launch with `--user-data-dir=%LOCALAPPDATA%\AgentSandbox\comet-profile` (sandbox disk) and
  `--remote-debugging-port=0` bound to 127.0.0.1 (port from `DevToolsActivePort`). Must be tested: runs unregistered.
- **Comet / Chromium sign-ins cannot be copied from the PC** (DPAPI, maybe app-bound; reading them would be infostealer
  behaviour) and a profile on the data disk fails (rename-over refused; new DPAPI keys every boot). What works: capture
  and restore the allow-listed cookies over CDP (`Storage.getCookies` / `Storage.setCookies`).
- **Not added (Decided):** the Perplexity desktop app ("Personal Computer"): Store-only MSIX, Windows Sandbox has no
  Store, 767 MB reinstall every boot; the Computer MCP gives agents the same. ChatGPT Atlas (macOS, discontinued),
  Claude desktop Cowork (needs Virtual Machine Platform), Edge Copilot Mode / Gemini in Chrome (Microsoft/Google
  sign-in brokers, US previews), Codex app computer use (Store-only, not in the UK/EEA), Anthropic computer-use
  reference (Docker). Opera Neon, Manus, Dia, Skyvern: later, not verified enough.

New catalogue entries (category `agents` / `browsers`, `userOnly: true`): `perplexity-mcp` (npm locked version,
`mcp: { name: 'sbx-perplexity', ... }`, env `PERPLEXITY_API_KEY`), `perplexity-computer-mcp` (remote HTTP MCP entry,
no install), `comet` (resolver + new `AppEntry.signer` field checked in a `.ps1` / C# helper; portable unpack),
`comet-mcp` (npm, `COMET_PATH`), `chrome-devtools-mcp` (npm), `browser-use-mcp` (`uvx --from 'browser-use[cli]'
browser-use --mcp`). How MCP add-ons are registered follows `writeAddonMcpServers` (Claude) and the Codex config.

New service-account kinds (add to `SERVICE_KINDS`, `PAYLOADS`, `SERVICE_SPECS`; shares in `OFF_IS_SAFER`):

| Kind | Payload | maxBytes | returns | singleHolder | sources | Guest adapter |
| --- | --- | --- | --- | --- | --- | --- |
| `perplexity` | `{apiKey: /^pplx-[A-Za-z0-9_-]{8,200}$/}` | 1 KB | no | no | typed, file (`.env` line) | env `PERPLEXITY_API_KEY` only; MCP config references the variable (`${PERPLEXITY_API_KEY}` in Claude headers; Codex `bearer_token_env_var`) |
| `comet` | `{cookies: <=200 x {name <=256, value <=8 KB, domain (allow-list, default perplexity.ai), path, expires?, secure, httpOnly, sameSite}}` | 256 KB | yes | no (last writer wins; said in the UI) | sandbox only | apply: start Comet with the profile, `Storage.setCookies` over CDP, delete the file; `current()`: `Storage.getCookies` filtered to the allow-list |

`usedBy` gains `'perplexity'` (perplexity-mcp or comet on) and `'comet'`. UI wording: "Your Comet sign-in can't be
copied from this PC: Windows locks it to your PC account. Sign in once inside a sandbox and it is kept for the next
ones." and "Perplexity Pro does not include API use; the API key is billed separately." Security notes on every
surface: the agent can use these accounts (read the key, spend Computer credits, act as you in Comet); use a
separate API project with a spending limit; never import the PC's main browser profile, never capture saved
passwords, localStorage or history; agentic browsing is open to prompt injection from pages.

P8 owns: `src/{host,guest}/accounts/kinds/{perplexity,comet}.ts`, `src/shared/apps/catalogue-agents-web.ts`,
`src/guest/apps/resolvers-agents-web.ts`, `src/guest/apps/comet-unpack.ts`, a signer-check script under
`sandbox/scripts/`, `docs/agents-web.md`, `src/selftest/agents-web.test.ts`. Shared edits (small, listed in its
report): the two kinds in `shared/accounts/kinds.ts` / `payloads.ts`, `AppEntry.signer`, codex `loginFiles` +
`mcp_oauth_credentials_store`, catalogue/resolver spreads.

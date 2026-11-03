// Which toolchains a sandbox gets for "auto" settings, decided on the host at launch (so the launch table can say why):
// a language is installed when the project uses it, and a folder that is no project yet gets the languages this PC has.
// Pure: file names and the PC's languages in, decisions out.
import type { Toolchains } from '../types.js';
import { isToolchainReady } from '../../shared/readiness.js';
import { projectUses } from './versions.js';

/** Files that show a project uses a language (looked for in the workspace and one folder down). */
export const MARKERS = {
  python: [
    'pyproject.toml',
    'requirements.txt',
    'setup.py',
    'setup.cfg',
    'Pipfile',
    'uv.lock',
    'poetry.lock',
    '.python-version',
    '*.py',
    '*.ipynb',
  ],
  rust: ['Cargo.toml', 'rust-toolchain', 'rust-toolchain.toml'],
  msvc: ['*.vcxproj', 'CMakePresets.json', 'CMakeUserPresets.json'],
  unreal: ['*.uproject', '*.uplugin'],
  unity: ['ProjectVersion.txt'],
  godot: ['project.godot'],
  steam: ['steam_appid.txt', 'steam_api64.dll', 'steam_api.dll'],
  fivem: ['fxmanifest.lua', '__resource.lua'],
  // Decided from file contents (host/launch/hints): Gradle's com.android plugin, an AndroidManifest.xml deeper down,
  // <UseMaui>, a pubspec's flutter: section, react-native / expo in package.json.
  android: [],
  flutter: [],
  dart: [],
  reactNative: [],
  cpp: [
    'CMakeLists.txt',
    'Makefile',
    'meson.build',
    'premake5.lua',
    'Cargo.toml',
    '*.vcxproj',
    '*.c',
    '*.cpp',
    '*.cc',
    '*.h',
    '*.hpp',
  ],
  dotnet: ['*.sln', '*.slnx', '*.csproj', '*.fsproj', '*.vbproj', 'global.json', '*.cs'],
  go: ['go.mod', 'go.work', '*.go'],
  java: [
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'mvnw',
    'gradlew',
    '.java-version',
    '.sdkmanrc',
    '*.java',
    '*.kt',
  ],
  ruby: ['Gemfile', '*.gemspec', '.ruby-version', '*.rb'],
  php: ['composer.json', 'artisan', '.php-version', '*.php'],
  deno: ['deno.json', 'deno.jsonc', 'deno.lock'],
  bun: ['bun.lock', 'bun.lockb', 'bunfig.toml'],
  uv: ['uv.lock'],
  // VS Code is decided from this PC (hints are not needed): see decideToolchains.
  vscode: [],
  // Windows PowerShell 5.1 runs any .ps1: PowerShell 7 is decided from script contents (hints.pwsh) or this PC.
  pwsh: [],
} as const;

export type AutoToolchain = keyof typeof MARKERS;
export const AUTO_TOOLCHAINS = Object.keys(MARKERS) as AutoToolchain[];

/**
 * Toolchains that come under licence terms and are big downloads (1-60 GB): "auto" installs them only once you accept
 * the licence (toolchains.<name>.acceptLicense). A project file can never accept one for you (local-config policy).
 */
export const LICENSED_TOOLCHAINS = ['msvc', 'unreal', 'unity', 'fivem', 'android'] as const;
export type LicensedToolchain = (typeof LICENSED_TOOLCHAINS)[number];

/** Files of any ecosystem: a folder with none of them is no project yet. */
const PROJECT_FILES = [...new Set([...Object.values(MARKERS).flat(), 'package.json', 'deno.json', '*.ts', '*.js'])];

export interface ToolchainDecision {
  on: boolean;
  reason: string;
}

/**
 * The decision per toolchain. true/false are kept; "auto" is on when the project has one of its marker files, or, in
 * a folder that is no project yet, when this PC has the language installed. Rust needs a linker (MSVC or C/C++).
 * hints: reasons found by reading files (a script that calls vcvars/vswhere) or about this PC
 * ("builds Rust with MSVC"), which turn an "auto" toolchain on like a marker file does.
 */
export function decideToolchains(
  settings: Toolchains,
  entries: string[],
  pcHas: AutoToolchain[],
  hints: Partial<Record<AutoToolchain, string>> = {},
): Record<AutoToolchain, ToolchainDecision> {
  const fresh = !projectUses(entries, PROJECT_FILES);
  const decide = (name: AutoToolchain): ToolchainDecision => {
    const setting = settings[name].enabled;
    if (setting !== 'auto') return { on: setting, reason: setting ? 'enabled in config' : 'disabled in config' };
    if (!isToolchainReady(name)) return { on: false, reason: 'coming in a later version' };
    const marker = MARKERS[name].map((m) => entries.find((e) => projectUses([e], [m]))).find(Boolean);
    if (marker) return { on: true, reason: marker };
    if (hints[name]) return { on: true, reason: hints[name]! };
    if (fresh && pcHas.includes(name)) return { on: true, reason: 'installed on this PC (new folder)' };
    return { on: false, reason: 'not used by this project' };
  };
  const result = Object.fromEntries(AUTO_TOOLCHAINS.map((name) => [name, decide(name)])) as Record<
    AutoToolchain,
    ToolchainDecision
  >;
  // Rust links with MSVC when this PC does (its rustup host is *-msvc), otherwise with MinGW's gcc.
  if (result.rust.on && settings.msvc.enabled === 'auto' && !result.msvc.on && pcHas.includes('msvc'))
    result.msvc = { on: true, reason: 'Rust on this PC builds with MSVC' };
  applyImplications(settings, result);
  if (result.rust.on && !result.msvc.on && !result.cpp.on && settings.cpp.enabled !== false)
    result.cpp = { on: true, reason: 'the linker for Rust' };
  // uv installs the Python tools (`uv tool install`), so Python tools turn an "auto" uv on.
  if (result.python.on && settings.uv.enabled === 'auto' && settings.python.tools.length > 0 && !result.uv.on)
    result.uv = { on: true, reason: 'needed for toolchains.python.tools' };
  if (settings.vscode.enabled === 'auto' && pcHas.includes('vscode'))
    result.vscode = { on: true, reason: 'installed on this PC' };
  return result;
}

/** An "auto" toolchain another one needs is turned on (with the reason), unless you turned it off. */
function imply(
  settings: Toolchains,
  result: Record<AutoToolchain, ToolchainDecision>,
  name: AutoToolchain,
  reason: string,
): void {
  if (settings[name].enabled === 'auto' && !result[name].on) result[name] = { on: true, reason };
}

/**
 * What one toolchain brings along (Android for Flutter and React Native, a JDK for Android, .NET for Godot's C#
 * build), and the licence gates: a licensed "auto" toolchain is off until its licence is accepted. Android is implied
 * before its gate (Flutter alone never accepts the Android licence) and the JDK after it.
 */
function applyImplications(settings: Toolchains, result: Record<AutoToolchain, ToolchainDecision>): void {
  if (result.flutter.on) imply(settings, result, 'android', 'Flutter builds for Android');
  if (result.reactNative.on) imply(settings, result, 'android', 'React Native builds for Android');
  if (result.godot.on && settings.godot.dotnet === true) imply(settings, result, 'dotnet', "Godot's .NET build");
  if (result.unreal.on && settings.unreal.visualStudio === 'autosdk')
    imply(settings, result, 'msvc', 'Unreal builds from the portable MSVC (AutoSDK)');
  // Unreal's licence acceptance covers the MSVC it builds from (the same Visual Studio terms).
  const autosdkLicence = settings.unreal.visualStudio === 'autosdk' && settings.unreal.acceptLicense;
  for (const name of LICENSED_TOOLCHAINS) {
    if (settings[name].enabled !== 'auto' || !result[name].on || settings[name].acceptLicense) continue;
    if (name === 'msvc' && autosdkLicence) continue;
    result[name] = {
      on: false,
      reason: 'would be used (' + result[name].reason + '); set toolchains.' + name + '.acceptLicense to install it',
    };
  }
  if (result.android.on) imply(settings, result, 'java', 'the Android SDK needs a JDK (17 or newer)');
}

/** The settings with every "auto" replaced by the decision (what the sandbox receives). */
export function resolveToolchains(
  settings: Toolchains,
  decisions: Record<AutoToolchain, ToolchainDecision>,
): Toolchains {
  const out = structuredClone(settings);
  for (const name of AUTO_TOOLCHAINS) (out[name] as { enabled: boolean | 'auto' }).enabled = decisions[name].on;
  return out;
}

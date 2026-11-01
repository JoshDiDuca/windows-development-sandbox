// Which toolchains a sandbox gets for "auto" settings, decided on the host at launch (so the launch table can say why):
// a language is installed when the project uses it, and a folder that is no project yet gets the languages this PC has.
// Pure: file names and the PC's languages in, decisions out.
import type { Toolchains } from '../types.js';
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
  // MSVC is a 1-2 GB licensed download: "auto" only installs it once its licence is accepted.
  if (settings.msvc.enabled === 'auto' && result.msvc.on && !settings.msvc.acceptLicense)
    result.msvc = {
      on: false,
      reason: 'would be used (' + result.msvc.reason + '); set toolchains.msvc.acceptLicense to install it',
    };
  // Unreal is a ~10 GB licensed install every boot: "auto" only installs it once its licence is accepted.
  if (settings.unreal.enabled === 'auto' && result.unreal.on && !settings.unreal.acceptLicense)
    result.unreal = {
      on: false,
      reason: 'would be used (' + result.unreal.reason + '); set toolchains.unreal.acceptLicense to install it',
    };
  if (result.rust.on && !result.msvc.on && !result.cpp.on && settings.cpp.enabled !== false)
    result.cpp = { on: true, reason: 'the linker for Rust' };
  // uv installs the Python tools (`uv tool install`), so Python tools turn an "auto" uv on.
  if (result.python.on && settings.uv.enabled === 'auto' && settings.python.tools.length > 0 && !result.uv.on)
    result.uv = { on: true, reason: 'needed for toolchains.python.tools' };
  if (settings.vscode.enabled === 'auto' && pcHas.includes('vscode'))
    result.vscode = { on: true, reason: 'installed on this PC' };
  return result;
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

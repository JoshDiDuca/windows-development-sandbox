// Which toolchain and database steps this sandbox runs, in the order their PATH entries are listed, and what each
// step depends on. The scheduler (scheduler.ts) runs them.
import type { Toolchains, ToolVersions } from '../../core/types.js';
import { appsNeedMesa, appsNeedUv, prefetchApps, setupApps } from '../apps/index.js';
import { dryRun } from '../runtime/paths.js';
import { wanted } from './detect.js';
import { DATABASE_NAMES, setupDatabase } from '../databases/index.js';
import { setupGit } from './tools/git.js';
import { setupGo } from './languages/go.js';
import { setupJava } from './languages/java.js';
import { setupCli } from './tools/cli.js';
import { setupPyenv, setupVolta, wantsPyenv, wantsVolta } from './managers.js';
import { setupCpp } from './native/cpp.js';
import { setupDotnet } from './native/dotnet.js';
import { setupMesa } from './native/mesa.js';
import { setupMsvc } from './native/msvc/index.js';
import { fetchDirectX, setupUnreal } from './native/unreal.js';
import { setupUnrealEngines } from './engines/unreal-engines.js';
import { fetchRustupInit, setupRust } from './native/rust.js';
import { setupNode } from './languages/node.js';
import { setupPwsh } from './tools/pwsh.js';
import { setupPython } from './languages/python.js';
import { setupBun, setupDeno, setupUv } from './runtimes.js';
import { fetchPhp, setupPhp } from './languages/php.js';
import { setupRuby } from './languages/ruby.js';
import { fetchVcRuntime, setupVcRuntime } from './native/vcruntime.js';
import { setupVscode } from './tools/vscode.js';
import type { ToolchainOptions, ToolchainStep, ToolCtx } from './step.js';
import {
  ensureVisualStudio,
  prefetchVisualStudio,
  visualStudioSaved,
  visualStudioWanted,
} from './native/visual-studio.js';
import { duringSession } from '../runtime/project-context.js';
import { setupSteam } from './steam/steam.js';
import { setupGodot } from './engines/godot.js';
import { setupUnity } from './engines/unity.js';
import { setupFivem } from './fivem/fivem.js';
import { setupAndroid } from './mobile/android.js';
import { setupFlutter } from './mobile/flutter.js';
import { setupDart } from './mobile/dart.js';
import { setupReactNative } from './mobile/react-native.js';
import { setupKotlin } from './languages/kotlin.js';
import {
  rustHost,
  rustCaches,
  cargoDefaults,
  cargoShim,
  linkGate,
  resolveTargetDir,
  targetSummary,
} from './native/rust-extras.js';
import { setupPythonTools } from './languages/python-tools.js';

export function plan(config: Toolchains, versions: ToolVersions, o: ToolchainOptions): ToolchainStep[] {
  const apps = Boolean(o.apps && (o.apps.install.length || Object.keys(o.apps.custom).length));
  const java = wanted(config.java.enabled, 'java');
  const python = wanted(config.python.enabled, 'python');
  const unreal = wanted(config.unreal.enabled, 'unreal');
  const android = wanted(config.android.enabled, 'android');
  // One Visual Studio for every toolchain that needs the real one (Unreal, Flutter desktop, Unity IL2CPP).
  const vs = visualStudioWanted(config, (setting, name) => wanted(setting, name));
  const ctx: ToolCtx = {
    refresh: o.refresh,
    pcInstalls: o.pcInstalls ?? { items: [] },
    duringSession: duringSession(),
  };
  // Downloads that run ahead of their steps (the scheduler starts them at once); a dry run downloads nothing.
  const ahead = (work: () => Promise<void>): { fetch?: () => Promise<void> } => (dryRun ? {} : { fetch: work });
  const deferred = o.deferHeavy === true && !dryRun;
  return [
    {
      name: 'Git',
      enabled: o.gitEnabled,
      shared: true,
      install: (env) => setupGit(env, o.hostGit, o.refresh, o.gitAccess),
    },
    // Before Node: with package.json pins, Volta's node/npm/pnpm/yarn come first on PATH.
    { name: 'Volta', enabled: wantsVolta(config.node.volta), install: (env) => setupVolta(env) },
    { name: 'Node ' + versions.node.spec, enabled: true, install: (env) => setupNode(env, versions, config.node) },
    { name: 'Python', enabled: python, install: (env) => setupPython(env, config.python, versions) },
    { name: 'pyenv-win', enabled: python && wantsPyenv(config.python.pyenv), install: (env) => setupPyenv(env) },
    {
      name: 'C/C++',
      enabled: wanted(config.cpp.enabled, 'cpp') || wanted(config.rust.enabled, 'rust'),
      install: (env) => setupCpp(env, config.cpp),
    },
    // Visual Studio brings MSVC and the real vswhere: the portable MSVC (and its stand-in vswhere) stays out. Only the
    // first install goes to the background: a saved copy is back in seconds, before the agent starts.
    {
      name: 'Visual Studio',
      enabled: vs !== null,
      shared: true,
      background: deferred && !visualStudioSaved(vs!),
      ...ahead(() => prefetchVisualStudio(vs!)),
      install: async (env) => {
        await ensureVisualStudio(env, vs!, { lowPriority: deferred });
      },
    },
    {
      name: 'Unreal',
      enabled: unreal,
      shared: true,
      after: ['Visual Studio'],
      ...ahead(() => fetchDirectX(config.unreal)),
      install: (env) => setupUnreal(env, config.unreal, ctx),
    },
    // Each project's engine (its .uproject's EngineAssociation) on its PATH: not shared, a project that joins later
    // gets its own. It registers every engine too, so this PC's engines work without the licence step above.
    {
      name: 'Unreal engines',
      enabled: unreal,
      after: ['Unreal'],
      install: (env) => setupUnrealEngines(env, config.unreal, ctx),
    },
    {
      name: 'MSVC',
      enabled: wanted(config.msvc.enabled, 'msvc') && vs === null,
      install: (env) => setupMsvc(env, config.msvc),
    },
    // Rust links with MSVC (msvc host) or MinGW's gcc (GNU host): whichever it uses goes first.
    {
      name: 'Rust',
      enabled: wanted(config.rust.enabled, 'rust'),
      // Only the msvc host links with Visual Studio (and Unreal's tools): the GNU host does not wait for them.
      after: rustHost(config).endsWith('-msvc') ? ['C/C++', 'MSVC', 'Visual Studio', 'Unreal'] : ['C/C++'],
      ...ahead(fetchRustupInit),
      install: async (env) => {
        await setupRust(env, { ...config.rust, host: rustHost(config) }, o.refresh);
        const rust = resolveTargetDir(config.rust);
        Object.assign(env.vars, rustCaches(rust));
        env.summary.push(targetSummary(rust));
        if (!dryRun) {
          cargoDefaults(rustHost(config));
          cargoShim(env, rust);
          linkGate(env, rust, rustHost(config));
        }
      },
    },
    {
      name: '.NET',
      enabled: wanted(config.dotnet.enabled, 'dotnet'),
      install: (env) => setupDotnet(env, config.dotnet, o.refresh),
    },
    { name: 'Go', enabled: wanted(config.go.enabled, 'go'), install: (env) => setupGo(env, config.go) },
    { name: 'Java', enabled: java, install: (env) => setupJava(env, config.java) },
    { name: 'Kotlin', enabled: java && config.java.kotlin, after: ['Java'], install: (env) => setupKotlin(env, ctx) },
    // Game engines, stores and mobile: each module keeps its big installs in tools (persisted.ts).
    {
      name: 'Android SDK',
      enabled: android,
      after: ['Java'],
      install: (env) => setupAndroid(env, config.android, ctx),
    },
    {
      name: 'Steam',
      enabled: wanted(config.steam.enabled, 'steam'),
      install: (env) => setupSteam(env, config.steam, ctx),
    },
    {
      name: 'Unity',
      enabled: wanted(config.unity.enabled, 'unity'),
      after: ['Visual Studio', 'Android SDK'],
      install: (env) => setupUnity(env, config.unity, ctx),
    },
    {
      name: 'Godot',
      enabled: wanted(config.godot.enabled, 'godot'),
      after: ['.NET', 'Android SDK'],
      install: (env) => setupGodot(env, config.godot, ctx),
    },
    {
      name: 'FiveM server',
      enabled: wanted(config.fivem.enabled, 'fivem'),
      install: (env) => setupFivem(env, config.fivem, ctx),
    },
    {
      name: 'Flutter',
      enabled: wanted(config.flutter.enabled, 'flutter'),
      after: ['Visual Studio', 'Android SDK'],
      install: (env) => setupFlutter(env, config.flutter, ctx),
    },
    { name: 'Dart', enabled: wanted(config.dart.enabled, 'dart'), install: (env) => setupDart(env, config.dart, ctx) },
    {
      name: 'React Native',
      enabled: wanted(config.reactNative.enabled, 'reactNative'),
      after: ['Android SDK'],
      install: (env) => setupReactNative(env, config.reactNative, ctx),
    },
    { name: 'Ruby', enabled: wanted(config.ruby.enabled, 'ruby'), install: (env) => setupRuby(env, config.ruby) },
    // PHP installs the Visual C++ runtime itself: one installer at a time.
    // Many apps (bat, delta, Neovim, most GUIs, your own programs) are built against it too, and so is what Visual
    // Studio builds: a Visual Studio put back from the data disk does not bring it, as its installer did.
    {
      name: 'Visual C++ runtime',
      enabled: config.vcRuntime.enabled || apps || vs !== null,
      shared: true,
      ...ahead(fetchVcRuntime),
      install: async (env) => {
        await setupVcRuntime(env);
      },
    },
    {
      name: 'PHP',
      enabled: wanted(config.php.enabled, 'php'),
      after: ['Visual C++ runtime'],
      ...ahead(() => fetchPhp(config.php)),
      install: (env) => setupPhp(env, config.php),
    },
    { name: 'Deno', enabled: wanted(config.deno.enabled, 'deno'), install: (env) => setupDeno(env) },
    { name: 'Bun', enabled: wanted(config.bun.enabled, 'bun'), install: (env) => setupBun(env) },
    // Headroom (an agent add-on) installs with uv: the uv step runs for it too, before the apps.
    {
      name: 'uv',
      enabled: wanted(config.uv.enabled, 'uv') || appsNeedUv(o.apps),
      install: (env) => setupUv(env),
    },
    { name: 'PowerShell 7', enabled: wanted(config.pwsh.enabled, 'pwsh'), install: (env) => setupPwsh(env, o.refresh) },
    // The openssl tool comes from Git's install: after Git.
    {
      name: 'CLI tools',
      enabled: Object.values(config.cli).some((v) => v !== false),
      after: ['Git'],
      install: (env) => setupCli(env, config.cli, o.gitAccess, o.refresh),
    },
    {
      name: 'Mesa 3D',
      enabled: config.mesa.enabled || appsNeedMesa(o.apps),
      shared: true,
      install: (env) => setupMesa(env, config.mesa),
    },
    {
      name: 'VS Code',
      enabled: wanted(config.vscode.enabled, 'vscode'),
      shared: true,
      install: (env) => setupVscode(env, o.refresh),
    },
    // Desktop apps and extra tools (apps.install / apps.custom); games and 3D apps copy Mesa's OpenGL next to them.
    {
      name: 'Apps',
      enabled: apps,
      shared: true,
      after: ['Mesa 3D', 'Visual C++ runtime', 'uv'],
      ...ahead(() => prefetchApps(o.apps!, { gitAccess: o.gitAccess, refresh: o.refresh })),
      install: (env) => setupApps(env, o.apps!, { gitAccess: o.gitAccess, refresh: o.refresh }),
    },
    {
      name: 'Python tools',
      enabled: python && config.python.tools.length > 0,
      after: ['Python', 'uv'],
      install: (env) => setupPythonTools(env, config.python.tools),
    },
    // DynamoDB Local runs on Java: the Java step installs the JDK first instead of racing it.
    // One server per database in the sandbox: a project that joins later shares the one the boot started.
    ...o.databases.map((db): ToolchainStep => ({
      name: DATABASE_NAMES[db.database],
      enabled: true,
      shared: true,
      after: db.database === 'dynamodb' && java ? ['Java'] : [],
      install: (env) => setupDatabase(env, db),
    })),
  ];
}

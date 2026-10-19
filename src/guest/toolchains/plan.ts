// Which toolchain and database steps this sandbox runs, in the order their PATH entries are listed, and what each
// step depends on. The scheduler (scheduler.ts) runs them.
import type { Toolchains, ToolVersions } from '../../core/types.js';
import { appsNeedMesa, appsNeedUv, setupApps } from '../apps/index.js';
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
import { setupRust } from './native/rust.js';
import { setupNode } from './languages/node.js';
import { setupPwsh } from './tools/pwsh.js';
import { setupPython } from './languages/python.js';
import { setupBun, setupDeno, setupUv } from './runtimes.js';
import { setupPhp } from './languages/php.js';
import { setupRuby } from './languages/ruby.js';
import { setupVcRuntime } from './native/vcruntime.js';
import { setupVscode } from './tools/vscode.js';
import type { ToolchainOptions, ToolchainStep } from './step.js';
import { rustHost, rustCaches, cargoDefaults, cargoShim, linkGate } from './native/rust-extras.js';
import { setupPythonTools } from './languages/python-tools.js';

export function plan(config: Toolchains, versions: ToolVersions, o: ToolchainOptions): ToolchainStep[] {
  const apps = Boolean(o.apps && (o.apps.install.length || Object.keys(o.apps.custom).length));
  const java = wanted(config.java.enabled, 'java');
  const python = wanted(config.python.enabled, 'python');
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
    { name: 'MSVC', enabled: wanted(config.msvc.enabled, 'msvc'), install: (env) => setupMsvc(env, config.msvc) },
    // Rust links with MSVC (msvc host) or MinGW's gcc (GNU host): whichever it uses goes first.
    {
      name: 'Rust',
      enabled: wanted(config.rust.enabled, 'rust'),
      after: ['C/C++', 'MSVC'],
      install: async (env) => {
        await setupRust(env, { ...config.rust, host: rustHost(config) }, o.refresh);
        Object.assign(env.vars, rustCaches(config.rust));
        if (!dryRun) {
          cargoDefaults(rustHost(config));
          cargoShim(env, config.rust);
          linkGate(env, config.rust, rustHost(config));
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
    { name: 'Ruby', enabled: wanted(config.ruby.enabled, 'ruby'), install: (env) => setupRuby(env, config.ruby) },
    // PHP installs the Visual C++ runtime itself: one installer at a time.
    // Many apps (bat, delta, Neovim, most GUIs, your own programs) are built against it too.
    {
      name: 'Visual C++ runtime',
      enabled: config.vcRuntime.enabled || apps,
      shared: true,
      install: async (env) => {
        await setupVcRuntime(env);
      },
    },
    {
      name: 'PHP',
      enabled: wanted(config.php.enabled, 'php'),
      after: ['Visual C++ runtime'],
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

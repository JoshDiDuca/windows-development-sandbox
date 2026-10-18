// Languages and tools installed inside the sandbox.
import { z } from 'zod';
import { enabled, EnabledSchema, Packages, StringsSchema, toggle } from './common.js';

export const ToolchainsSchema = z.strictObject({
  node: z.strictObject({
    version: z
      .string()
      .min(1)
      .describe(
        'Default Node version for nvm. "host" = the Node on this PC. A project\'s .nvmrc / .node-version wins.',
      ),
    extraVersions: StringsSchema.describe(
      "More Node versions to install (switch with nvm use). On top of the up to 3 versions copied from this PC's nvm, not counted towards that limit.",
    ),
    corepack: z
      .boolean()
      .describe('pnpm and yarn through corepack (a project\'s "packageManager" in package.json picks the version).'),
    volta: EnabledSchema.describe(
      'Volta: true, false, or "auto" = when the project\'s package.json has "volta" pins or this PC uses Volta. With pins, Volta\'s node/npm/yarn/pnpm come first on PATH.',
    ),
    globalPackages: Packages(
      'npm packages installed globally into the default Node version',
      '["typescript", "npm-check-updates"]',
    ),
  }),
  python: z.strictObject({
    enabled: enabled(
      'Python 3 (CPython with pip).',
      'pyproject.toml, requirements.txt, setup.py, Pipfile or .python-version',
    ),
    version: z
      .string()
      .min(1)
      .describe('Python 3 version prefix, e.g. "3" or "3.12". A project\'s .python-version wins.'),
    python2: z.boolean().describe('Also install Python 2.7 as python2 / pip2.'),
    pyenv: EnabledSchema.describe(
      'pyenv-win (pyenv install / local / global): true, false, or "auto" = when this PC uses pyenv. .python-version is honoured either way, and `uv python install` always works.',
    ),
    tools: Packages(
      'Python command-line tools installed with `uv tool install` (needs uv)',
      '["poetry", "ruff", "pre-commit"]',
    ),
  }),
  rust: z.strictObject({
    enabled: enabled('Rust via rustup (cargo, rustc).', 'Cargo.toml or rust-toolchain(.toml)'),
    toolchain: z.string().min(1).describe('Default toolchain, e.g. "stable". rust-toolchain.toml in a project wins.'),
    host: z
      .string()
      .min(1)
      .describe(
        'Host triple, or "auto": x86_64-pc-windows-msvc when the MSVC toolchain is on (like most PCs), else x86_64-pc-windows-gnu (MinGW is its linker).',
      ),
    components: Packages('Extra rustup components', '["rust-src", "llvm-tools"]'),
    targets: Packages('Extra rustup targets', '["wasm32-unknown-unknown"]'),
    crates: Packages(
      'Binaries for cargo: prebuilt via cargo-binstall when the crate publishes a Windows build, else compiled with `cargo install --locked` (slow the first time)',
      '["sccache", "cargo-nextest", "cargo-deny"]',
    ),
    targetDir: z
      .string()
      .min(1)
      .describe(
        '"shared": cargo\'s default target\\ (shared with builds on this PC, so builds on either side invalidate the other), "separate": <workspace>\\target\\sandbox (kept, no cross-talk), "local": on the sandbox\'s own disk (fastest, lost every boot), or a guest path.',
      ),
    linker: z
      .enum(['lld', 'gnu'])
      .describe(
        'GNU host: "lld" links with Rust\'s own lld through MinGW\'s gcc (much less memory than GNU ld), "gnu" with GNU ld.',
      ),
    linkSlots: z
      .union([z.literal('auto'), z.number().int().min(1).max(32)])
      .describe(
        'GNU host: how many programs may link at the same time in the whole sandbox (other links wait). "auto" = one per 3 GB of sandbox memory after 6 GB, 2 to 8 (the memory governor slows links down too when memory runs short).',
      ),
  }),
  msvc: z.strictObject({
    enabled: enabled(
      "MSVC (cl, link) and the Windows SDK, portable from Microsoft's Visual Studio manifest (~1-2 GB once), with vcvars64.bat and vswhere.",
      'a .vcxproj, CMakePresets.json, a script calling vcvars/vswhere, or a Rust project when this PC builds Rust with MSVC',
    ),
    acceptLicense: z
      .boolean()
      .describe(
        'Required to install MSVC: you accept the Visual Studio licence terms (https://visualstudio.microsoft.com/license-terms/), which need a Visual Studio licence.',
      ),
    msvcVersion: z.string().min(1).describe('"latest" or an MSVC tools version prefix, e.g. "14.44".'),
    sdkVersion: z.string().min(1).describe('"latest" or a Windows SDK build, e.g. "26100" or "10.0.22621".'),
  }),
  cpp: z.strictObject({
    enabled: enabled(
      "MinGW-w64 GCC with CMake, Ninja, premake5 and mingw32-make (also Rust's linker).",
      'CMakeLists.txt, Makefile, meson.build, premake5.lua or Cargo.toml',
    ),
    flexBison: z
      .boolean()
      .describe(
        'win_flex / win_bison, the parser generators many C/C++ projects (game engines among them) need; CMake finds them.',
      ),
  }),
  dotnet: z.strictObject({
    enabled: enabled('.NET SDK (C#, F#).', 'a .sln, .slnx, .csproj, .fsproj or global.json'),
    channels: StringsSchema.describe('SDK channels, e.g. ["LTS", "8.0"]. A project\'s global.json is installed too.'),
    tools: Packages('Global .NET tools (`dotnet tool install -g`)', '["dotnet-ef", "csharpier"]'),
    workloads: Packages('SDK workloads (`dotnet workload install`)', '["aspire", "wasm-tools"]'),
    frameworkTargets: StringsSchema.describe(
      '.NET Framework reference assemblies (targeting packs) from NuGet, so net4x and old-style .csproj projects build without Visual Studio, e.g. ["net48", "net472", "net462"]. The 4.8 runtime itself ships with Windows.',
    ),
    netfx35: z
      .boolean()
      .describe(
        '.NET Framework 3.5 runtime (a Windows feature, enabled from Windows Update on every boot; a few minutes).',
      ),
  }),
  go: z.strictObject({
    enabled: enabled('Go.', 'go.mod or go.work'),
    version: z
      .string()
      .min(1)
      .describe(
        '"stable" or a version prefix such as "1.23". A go.mod asking for newer fetches it itself (GOTOOLCHAIN=auto).',
      ),
    tools: Packages('Go tools (`go install <path>@<version>`)', '["golang.org/x/tools/gopls@latest"]'),
  }),
  java: z.strictObject({
    enabled: enabled(
      'Java: Eclipse Temurin JDK.',
      'pom.xml, build.gradle(.kts), settings.gradle(.kts), mvnw, gradlew or .java-version',
    ),
    version: z
      .string()
      .min(1)
      .describe('"lts" (newest LTS) or a major version such as "21". A project\'s .java-version or .sdkmanrc wins.'),
    maven: z.boolean().describe("Apache Maven (mvn). A project's mvnw works either way."),
    gradle: z.boolean().describe("Gradle (gradle). A project's gradlew works either way."),
  }),
  ruby: z.strictObject({
    enabled: enabled(
      'Ruby (RubyInstaller, with gem and bundler). Gems with C extensions need MSYS2, which is not included.',
      'Gemfile, a .gemspec or .ruby-version',
    ),
    version: z.string().min(1).describe('Version prefix, e.g. "3" or "3.3". A project\'s .ruby-version wins.'),
    gems: Packages('Gems installed globally', '["rubocop"]'),
  }),
  php: z.strictObject({
    enabled: enabled(
      'PHP (with the Visual C++ runtime it needs, installed on every boot).',
      'composer.json, artisan or .php-version',
    ),
    version: z.string().min(1).describe('Version prefix, e.g. "8" or "8.3". A project\'s .php-version wins.'),
    composer: z.boolean().describe('Composer.'),
  }),
  deno: z.strictObject({ enabled: enabled('Deno.', 'deno.json, deno.jsonc or deno.lock') }),
  pwsh: z.strictObject({
    enabled: EnabledSchema.describe(
      'PowerShell 7 (pwsh), portable (~110 MB once); `powershell` stays Windows PowerShell 5.1. true, false, or "auto" = when a .ps1 at the root or one folder down has #Requires -Version 7 / -PSEdition Core or a `pwsh ...` usage line, or, in a folder that is no project yet, when this PC has PowerShell 7.',
    ),
  }),
  cli: z
    .strictObject({
      gh: EnabledSchema.describe(
        'GitHub CLI (gh). Only with provisioning.git.access "full": gh can push and merge through the GitHub API, past a read-only git. Your PC\'s gh login is never copied; `gh auth login` inside persists (GH_CONFIG_DIR), unless a token you saved for sandboxes is handed over (github.shareToken). "auto" = when the project has a .github folder.',
      ),
      zstd: EnabledSchema.describe('Zstandard (zstd). "auto" = off; set true to get it.'),
      openssl: EnabledSchema.describe(
        '`openssl` on PATH, from the copy Git for Windows ships (its mingw64\\bin is not put on PATH, so it cannot shadow MinGW\'s gcc). "auto" = on.',
      ),
    })
    .describe('Small portable command-line tools from their GitHub releases, installed once into tools\\cli.'),
  bun: z.strictObject({
    enabled: enabled(
      'Bun (JavaScript runtime and package manager; claude-mem needs it).',
      'bun.lock, bun.lockb or bunfig.toml',
    ),
  }),
  uv: z.strictObject({
    enabled: enabled(
      'uv (fast Python package and tool manager; claude-mem needs it for its search index).',
      'uv.lock, a [tool.uv] pyproject.toml, toolchains.python.tools, or an agent installed with uv',
    ),
  }),
  vcRuntime: toggle(
    'Microsoft Visual C++ runtime for tools that need it (a real installer, so it runs on every boot, ~15 s). PHP installs it regardless.',
  ),
  mesa: z.strictObject({
    enabled: z
      .boolean()
      .describe(
        "Mesa 3D (llvmpipe): OpenGL 4.5 in software for games and apps when there is no GPU (sandbox.vGpu off). Copy opengl32.dll and libgallium_wgl.dll from %MESA_DIR% next to the program's .exe.",
      ),
    vulkan: z
      .boolean()
      .describe(
        'Also software Vulkan 1.4 (Mesa lavapipe) with the Khronos loader, registered for every program; for wgpu set WGPU_BACKEND=vulkan.',
      ),
  }),
  vscode: z.strictObject({
    enabled: EnabledSchema.describe(
      'Portable VS Code inside the sandbox (code on PATH, desktop shortcut); its settings and extensions persist. true, false, or "auto" = when VS Code is installed on this PC.',
    ),
    setup: z
      .boolean()
      .describe(
        "Point VS Code at the sandbox's own tools (JDK, Python, Go, compilers, .NET, Git, PowerShell 7 and Git Bash terminals) and install the language extensions for the toolchains in use.",
      ),
    recommended: z
      .boolean()
      .describe('Also install the extensions a project recommends in its .vscode/extensions.json.'),
    extensions: z
      .array(z.string().regex(/^[\w-]+\.[\w-]+$/, 'publisher.name, e.g. eamodio.gitlens'))
      .describe('More extensions to install in every sandbox, e.g. eamodio.gitlens, ms-azuretools.vscode-docker.'),
  }),
  environment: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'letters, digits and _ only'), z.string())
    .describe(
      'Extra environment variables for the agent and every terminal, e.g. registry mirrors: {"NPM_CONFIG_REGISTRY": "https://...", "PIP_INDEX_URL": "https://..."}.',
    ),
});

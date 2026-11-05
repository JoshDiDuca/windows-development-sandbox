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
        '"auto" (default): on the sandbox\'s own disk when C: has 25 GB free at boot, else "separate" (builds then write through the mapped workspace, which can overload this PC\'s disk). "shared": cargo\'s default target\\ (shared with builds on this PC, so builds on either side invalidate the other), "separate": <workspace>\\target\\sandbox (kept, no cross-talk), "local": on the sandbox\'s own disk (fastest, lost every boot), or a guest path.',
      ),
    linker: z
      .enum(['lld', 'gnu'])
      .describe(
        '"lld" (default) links with Rust\'s own lld: through MinGW\'s gcc on the GNU host (much less memory than GNU ld), and instead of link.exe on the MSVC host (link.exe writes executables into mapped folders as all zeros: os error 1392). "gnu" keeps GNU ld / link.exe.',
      ),
    linkSlots: z
      .union([z.literal('auto'), z.number().int().min(1).max(32)])
      .describe(
        'GNU host: how many programs may link at the same time in the whole sandbox (other links wait). "auto" = one per 6 GB of sandbox memory, 1 to 4 (the memory governor slows links down too when memory runs short).',
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
  unreal: z.strictObject({
    enabled: enabled(
      'Unreal Engine development: Visual Studio Community 2022 with the C++ game workload (MSVC, a Windows 11 SDK, .NET Framework targeting packs, Unreal integration and the Epic Games Launcher) and the DirectX End-User Runtime. Visual Studio is installed once and kept on the data disk (~6.5 GB); later boots put it back in seconds. The engine itself comes from the Epic Games Launcher or its source.',
      'a .uproject or .uplugin',
    ),
    acceptLicense: z
      .boolean()
      .describe(
        'Required to install: you accept the Visual Studio Community licence terms (https://visualstudio.microsoft.com/license-terms/) and the DirectX End-User Runtime licence.',
      ),
    components: StringsSchema.describe(
      'More Visual Studio workload or component IDs to add, e.g. ["Microsoft.VisualStudio.Component.VC.Llvm.Clang"].',
    ),
    visualStudio: z
      .enum(['full', 'buildtools'])
      .describe(
        '"full": Visual Studio Community with the C++ game workload (the IDE, its debugger and Unreal integration). "buildtools": only the Visual Studio Build Tools (MSVC, the Windows SDK and the .NET Framework parts UnrealBuildTool needs; no IDE). Either is installed once and kept on the data disk (tools\\visualstudio\\persist, ~6.5 GB for Community); later boots put it back in seconds.',
      ),
    persistEngines: z
      .boolean()
      .describe(
        'Engines the Epic Games Launcher installs go to tools\\unreal\\engines (kept between sandboxes, 40-60 GB each) and are registered with the launcher again every boot. Off: they go on the sandbox disk and are lost when it closes. Engines installed on this PC can be mapped instead (pcInstalls.unrealEngines).',
      ),
    derivedDataCache: z
      .enum(['persisted', 'local'])
      .describe(
        '"persisted": the engine\'s local derived data cache (compiled shaders, 10-50 GB) in tools\\unreal\\ddc, kept between sandboxes. "local": Unreal\'s own place on the sandbox disk (rebuilt every boot).',
      ),
  }),
  unity: z.strictObject({
    enabled: enabled(
      "Unity: the editor version a project asks for, from Unity's release API (checked against its published hash), installed into tools\\unity\\<version> (6-7 GB each), with the modules you list.",
      'ProjectSettings/ProjectVersion.txt',
    ),
    acceptLicense: z
      .boolean()
      .describe(
        'Required to install: you accept the Unity terms of service (https://unity.com/legal/terms-of-service), and the editor needs a Unity licence (Personal is free). A project file cannot accept it for you.',
      ),
    version: z
      .string()
      .min(1)
      .describe(
        '"project" = the version in ProjectSettings/ProjectVersion.txt, or an editor version such as "6000.0.32f1".',
      ),
    modules: z
      .array(z.string().regex(/^[a-z0-9-]+$/))
      .describe(
        'Editor modules to add: "android" (4-5 GB, also the Android SDK), "webgl" (1.5 GB), "windows-il2cpp" (adds Visual Studio\'s C++ parts), "ios" (Xcode project export only: iOS builds need a Mac).',
      ),
    hub: z.boolean().describe('Also Unity Hub, with the installed editors listed in it.'),
    keepVersions: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe(
        'How many editor versions to keep in tools\\unity; older ones are removed (the least recently used first).',
      ),
  }),
  godot: z.strictObject({
    enabled: enabled(
      'Godot from its official builds (checked against the published SHA-512 sums), self-contained in tools\\godot\\<version> with `godot` (the console build) on PATH.',
      'project.godot',
    ),
    version: z
      .string()
      .min(1)
      .describe(
        '"project" = the version project.godot was saved with (else the newest stable), or a version such as "4.3".',
      ),
    dotnet: EnabledSchema.describe(
      'The .NET (C#) build of Godot and the .NET SDK: true, false, or "auto" = when the project has a .csproj.',
    ),
    exportTemplates: z.boolean().describe('Also the export templates for that version (~1.2 GB), for exporting games.'),
    keepVersions: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe('How many Godot versions to keep; older ones are removed (the least recently used first).'),
  }),
  steam: z.strictObject({
    enabled: enabled(
      'SteamCMD (`steamcmd` on PATH, Valve-signed, ~0.3 GB) and `sbx-steam` for logging in, downloading apps and workshop items, and uploading builds (ContentBuilder) and workshop items.',
      'steam_appid.txt, steam_api64.dll, steam_api.dll, or an app_build / workshop_item .vdf',
    ),
    client: z
      .boolean()
      .describe(
        'Also the Steam client (1-1.5 GB, in tools\\steam), for testing the Steamworks API, the overlay or in-game uploads. You sign in to it in each sandbox.',
      ),
    sdkFolder: z
      .string()
      .describe(
        'Where the Steamworks SDK is in the sandbox (relative paths are inside the project); it sets STEAMWORKS_SDK. Empty = not set. The SDK is never downloaded (it needs a Steamworks partner login).',
      ),
  }),
  fivem: z.strictObject({
    enabled: enabled(
      'A FiveM / RedM server (FXServer with txAdmin) for resource development, from the Cfx.re artifacts (the game client is not supported). `sbx-fivem serve` starts it.',
      'fxmanifest.lua or __resource.lua (up to 3 folders down)',
    ),
    acceptLicense: z
      .boolean()
      .describe(
        'Required to install: you accept the Cfx.re platform terms (https://fivem.net/terms) and the FXServer licence. A project file cannot accept it for you.',
      ),
    game: z.enum(['gta5', 'rdr3']).describe('"gta5" = FiveM, "rdr3" = RedM.'),
    artifact: z
      .string()
      .regex(/^(recommended|optional|latest|\d+)$/)
      .describe('The server build: "recommended", "optional", "latest", or a build number.'),
    txAdmin: z.boolean().describe('Start the server with txAdmin (its web panel on port 40120).'),
    keepVersions: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe('How many server builds to keep in tools\\fivem\\artifacts.'),
  }),
  android: z.strictObject({
    enabled: enabled(
      'The Android SDK (command-line tools, platform-tools, build-tools, platforms, NDK and CMake as needed) in tools\\android-sdk, with a JDK. No emulator (Windows Sandbox cannot run one): use a device over the network, or build only.',
      'a Gradle build using com.android, an AndroidManifest.xml (up to 3 folders down), a .NET MAUI project, or a Flutter / React Native / Godot Android project',
    ),
    acceptLicense: z
      .boolean()
      .describe(
        'Required to install: you accept the Android SDK licence (https://developer.android.com/studio/terms) and the licences sdkmanager shows. A project file cannot accept them for you.',
      ),
    platforms: StringsSchema.describe(
      'Platforms to install, e.g. ["android-35"]; "project" = the compileSdk the project\'s Gradle files ask for.',
    ),
    buildTools: z.string().min(1).describe('"latest" or a build-tools version such as "35.0.0".'),
    ndk: z
      .union([z.literal(false), z.string().min(1)])
      .describe(
        '"auto" = when the project uses native code (ndkVersion, CMake or ndk-build), false = never, or a version.',
      ),
    cmake: z
      .union([z.literal(false), z.string().min(1)])
      .describe('"auto" = when the project builds native code with CMake, false = never, or a version.'),
    packages: Packages('More sdkmanager packages (not the emulator or system images)', '["extras;google;usb_driver"]'),
  }),
  flutter: z.strictObject({
    enabled: enabled(
      'Flutter (with its Dart) from the official releases (checked against their SHA-256), with the Android SDK for Android builds.',
      'a pubspec.yaml with a flutter: section',
    ),
    version: z
      .string()
      .min(1)
      .describe(
        '"project" = the version in .fvmrc (else the newest stable), "stable", "beta", or a version such as "3.24.5".',
      ),
    windowsDesktop: z
      .boolean()
      .describe(
        "Windows desktop builds: needs Visual Studio Build Tools' C++ parts (a real installer: it runs every boot, ~5 GB on the sandbox disk).",
      ),
    precache: StringsSchema.describe(
      'Platforms whose engine files are downloaded ahead (flutter precache), e.g. ["android", "web"].',
    ),
  }),
  dart: z.strictObject({
    enabled: enabled(
      'The Dart SDK (without Flutter), checked against its published SHA-256.',
      'a pubspec.yaml without a flutter: section',
    ),
    version: z.string().min(1).describe('"stable", "beta" or a version such as "3.5.4".'),
  }),
  reactNative: z.strictObject({
    enabled: enabled(
      'React Native / Expo: the Android SDK and JDK for Android builds (Node is always there). iOS builds run in EAS Build (the cloud).',
      'a package.json depending on react-native or expo',
    ),
    easCli: z.boolean().describe('Also eas-cli (Expo Application Services) as a global npm package.'),
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
    templates: Packages('Project templates (`dotnet new install`)', '["MonoGame.Templates.CSharp"]'),
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
    kotlin: z
      .boolean()
      .describe("Also the Kotlin compiler (kotlinc) from JetBrains' releases. Gradle builds fetch their own."),
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

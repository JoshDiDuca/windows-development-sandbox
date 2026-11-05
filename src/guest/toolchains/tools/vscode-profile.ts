// What VS Code is told about the sandbox: the settings that point it at the sandbox's own tools, and the extensions
// for the languages in use. Pure (tested); vscode.ts finds the paths and writes them.

/** Where the sandbox's tools are (absent = not installed). */
export interface ToolPaths {
  javaHome?: string;
  python?: string;
  goRoot?: string;
  go?: string;
  gcc?: string;
  cl?: string;
  cmake?: string;
  dotnet?: string;
  node?: string;
  pwsh?: string;
  git?: string;
  bash?: string;
  php?: string;
  ruby?: string;
  deno?: string;
}

/** The JDK's major version from its folder name (jdk-21.0.5+11 -> 21). */
const javaMajor = (home: string): string | undefined =>
  /(?:jdk|jre)?-?(\d{1,2})(?:[.+_-]|$)/i.exec(home.split(/[\\/]/).pop() ?? '')?.[1];

/** User settings for the sandbox's VS Code. Only keys with a value are set; the caller removes those it set before. */
export function vscodeSettings(p: ToolPaths): Record<string, unknown> {
  const profiles: Record<string, unknown> = {};
  if (p.pwsh) profiles['PowerShell 7'] = { path: p.pwsh, args: ['-NoLogo'] };
  if (p.bash) profiles['Git Bash'] = { path: p.bash, args: ['--login', '-i'] };
  const settings: Record<string, unknown> = {
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'workbench.startupEditor': 'none',
    'git.path': p.git,
    'terminal.integrated.profiles.windows': Object.keys(profiles).length ? profiles : undefined,
    'terminal.integrated.defaultProfile.windows': p.pwsh ? 'PowerShell 7' : undefined,
    'python.defaultInterpreterPath': p.python,
    'java.jdt.ls.java.home': p.javaHome,
    'java.configuration.runtimes': p.javaHome
      ? [{ name: 'JavaSE-' + (javaMajor(p.javaHome) ?? '21'), path: p.javaHome, default: true }]
      : undefined,
    'maven.terminal.useJavaHome': p.javaHome ? true : undefined,
    'go.goroot': p.goRoot,
    'go.alternateTools': p.go ? { go: p.go } : undefined,
    'C_Cpp.default.compilerPath': p.cl ?? p.gcc,
    'cmake.cmakePath': p.cmake,
    'dotnet.dotnetPath': p.dotnet ? p.dotnet.replace(/[\\/]dotnet\.exe$/i, '') : undefined,
    'dotnetAcquisitionExtension.existingDotnetPath': p.dotnet
      ? [{ extensionId: 'ms-dotnettools.csharp', path: p.dotnet }]
      : undefined,
    'php.validate.executablePath': p.php,
    'php.debug.executablePath': p.php,
    'rubyLsp.rubyVersionManager': p.ruby ? { identifier: 'none' } : undefined,
    'deno.path': p.deno,
    'powershell.powerShellAdditionalExePaths': p.pwsh ? { 'PowerShell 7 (sandbox)': p.pwsh } : undefined,
    'npm.packageManager': 'auto',
  };
  return Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined));
}

/** Extensions per toolchain (Marketplace ids). */
const BY_TOOLCHAIN: Readonly<Record<string, readonly string[]>> = {
  node: ['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode'],
  python: ['ms-python.python', 'ms-python.debugpy'],
  java: [
    'redhat.java',
    'vscjava.vscode-java-debug',
    'vscjava.vscode-java-test',
    'vscjava.vscode-maven',
    'vscjava.vscode-gradle',
  ],
  go: ['golang.go'],
  rust: ['rust-lang.rust-analyzer', 'vadimcn.vscode-lldb'],
  cpp: ['ms-vscode.cpptools', 'ms-vscode.cmake-tools'],
  msvc: ['ms-vscode.cpptools', 'ms-vscode.cmake-tools'],
  // Unreal C++ (IntelliSense from the generated .code-workspace) and the C# of the *.Build.cs / *.Target.cs rules.
  unreal: ['ms-vscode.cpptools', 'ms-dotnettools.csharp'],
  dotnet: ['ms-dotnettools.csharp'],
  ruby: ['shopify.ruby-lsp'],
  php: ['bmewburn.vscode-intelephense-client', 'xdebug.php-debug'],
  deno: ['denoland.vscode-deno'],
  pwsh: ['ms-vscode.powershell'],
};
const BY_DATABASE: Readonly<Record<string, readonly string[]>> = {
  postgres: ['mtxr.sqltools', 'mtxr.sqltools-driver-pg'],
  mysql: ['mtxr.sqltools', 'mtxr.sqltools-driver-mysql'],
  mongodb: ['mongodb.mongodb-vscode'],
  redis: ['redis.redis-for-vscode'],
};
export const EXTENSION_ID = /^[\w-]+\.[\w-]+$/;

/** The extensions to have: always EditorConfig, then per toolchain and database in use, the project's, and yours. */
export function vscodeExtensions(o: {
  toolchains: string[];
  databases: string[];
  recommended: string[];
  extra: string[];
}): string[] {
  const all = [
    'editorconfig.editorconfig',
    ...o.toolchains.flatMap((t) => BY_TOOLCHAIN[t] ?? []),
    ...o.databases.flatMap((d) => BY_DATABASE[d] ?? []),
    ...o.recommended,
    ...o.extra,
  ];
  return [...new Set(all.map((e) => e.toLowerCase()))].filter((e) => EXTENSION_ID.test(e));
}

/** Extensions not installed yet, from the folder names in VS Code's extensions folder (publisher.name-1.2.3). */
export function missingExtensions(wanted: string[], folders: string[]): string[] {
  const have = folders.map((f) => f.toLowerCase());
  return wanted.filter((id) => !have.some((f) => f.startsWith(id + '-')));
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Toolchains } from '../../../core/types.js';
import { dataDir, localDir } from '../../runtime/paths.js';
import { exists, mkdirp } from '../../runtime/fs.js';
import { execOutput } from '../../runtime/process.js';
import { ensureCompiled } from '../../runtime/csc.js';
import { arch, tool, type ToolEnv } from '../tool-env.js';
import { wanted } from '../detect.js';
import { cargoJobs, cargoLinkerVar, chooseTargetDir } from '../../../shared/memory/index.js';
import { linkerSlots } from '../../governor/decide.js';
import { warn } from '../../runtime/log.js';
import { freeBytes } from '../persisted.js';

/**
 * "auto" (the default): build on the sandbox's own disk when C: has 25 GB free, else keep the target next to the
 * project, which writes every object file through the mapped workspace to this PC's disk. Other values stay as set.
 */
export function resolveTargetDir(
  rust: Toolchains['rust'],
  free: number = freeBytes((process.env.SystemDrive ?? 'C:') + '\\'),
  note: (text: string) => void = warn,
): Toolchains['rust'] {
  if (rust.targetDir !== 'auto') return rust;
  const chosen = chooseTargetDir(rust.targetDir, free);
  if (chosen.warning) note(chosen.warning);
  return { ...rust, targetDir: chosen.targetDir };
}

/** One summary line for the agent: where cargo builds. */
export function targetSummary(rust: Toolchains['rust']): string {
  const target = cargoTarget(rust.targetDir);
  if (target) return 'rust builds: ' + target + ' (CARGO_TARGET_DIR)';
  return rust.targetDir === 'shared'
    ? 'rust builds: target\\ in each project (shared with this PC)'
    : 'rust builds: target\\sandbox in each project (on the mapped workspace)';
}

/**
 * Where cargo builds: shared with the PC's target\, one on the sandbox's disk, or a path. "separate" sets no variable:
 * the cargo shim (sandbox/csharp/CargoShim.cs) gives every checkout its own target\sandbox, so git worktrees of several
 * agents never overwrite each other's builds.
 */
const cargoTarget = (targetDir: Toolchains['rust']['targetDir']): string | null => {
  if (targetDir === 'shared' || targetDir === 'separate') return null;
  if (targetDir === 'local') return path.join(localDir, 'cargo-target');
  return targetDir;
};

/** "separate": tools\shims\cargo\cargo.exe in front of the real cargo, which it runs with the checkout's target dir. */
export function cargoShim(env: ToolEnv, rust: Toolchains['rust']): void {
  const real = path.join(tool('rust', 'cargo', 'bin'), 'cargo.exe');
  if (rust.targetDir !== 'separate' || !exists(real)) return;
  const dir = mkdirp(tool('shims', 'cargo'));
  fs.copyFileSync(ensureCompiled('cargoshim'), path.join(dir, 'cargo.exe'));
  env.prepend.unshift(dir);
  env.vars.AGENT_REAL_CARGO = real;
}

/**
 * GNU host: Rust links through tools\shims\linkgate.exe (sandbox/csharp/LinkGate.cs), which lets only `linkSlots` links
 * run at once in the whole sandbox and, with linker "lld", has MinGW's gcc use Rust's own lld instead of GNU ld.
 */
export function linkGate(env: ToolEnv, rust: Toolchains['rust'], host: string): void {
  const gcc = tool('mingw', 'mingw64', 'bin', 'gcc.exe');
  if (!host.endsWith('-pc-windows-gnu') || !exists(gcc)) return;
  const gate = path.join(mkdirp(tool('shims')), 'linkgate.exe');
  fs.copyFileSync(ensureCompiled('linkgate'), gate);
  const slots = rust.linkSlots === 'auto' ? linkerSlots(os.totalmem() / 1024 ** 2, os.cpus().length) : rust.linkSlots;
  env.vars.AGENT_LINK_SLOTS = String(slots);
  env.vars.AGENT_REAL_LINKER = gcc;
  env.vars.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = gate;
  const rustEnv = { ...process.env, RUSTUP_HOME: tool('rust', 'rustup'), CARGO_HOME: tool('rust', 'cargo') };
  const sysroot =
    rust.linker === 'lld'
      ? execOutput(tool('rust', 'cargo', 'bin', 'rustc.exe'), ['--print', 'sysroot'], { env: rustEnv })
      : '';
  const lld = sysroot ? path.join(sysroot, 'lib', 'rustlib', host, 'bin', 'gcc-ld') : '';
  if (lld && exists(path.join(lld, 'ld.lld.exe'))) env.vars.AGENT_LLD_DIR = lld;
  env.summary.push(
    'rust linking: ' +
      (env.vars.AGENT_LLD_DIR ? 'lld' : 'GNU ld') +
      ', at most ' +
      env.vars.AGENT_LINK_SLOTS +
      ' at once',
  );
}

/**
 * MSVC host: link.exe writes an executable into a mapped folder (the workspace, C:\AgentData) as all zeros, so a
 * fresh build script or test program fails with "The file or directory is corrupted and unreadable" (os error 1392).
 * Rust's own lld (a copy of rust-lld.exe named lld-link.exe, which is how lld picks its mode) writes them whole.
 * `rust.linker` "gnu" keeps link.exe; a linker the user set for the target wins.
 */
export function lldLink(env: ToolEnv, rust: Toolchains['rust'], host: string): void {
  if (!host.endsWith('-pc-windows-msvc') || rust.linker !== 'lld') return;
  const variable = cargoLinkerVar(host);
  if (process.env[variable]) return;
  const rustEnv = { ...process.env, RUSTUP_HOME: tool('rust', 'rustup'), CARGO_HOME: tool('rust', 'cargo') };
  const sysroot = execOutput(tool('rust', 'cargo', 'bin', 'rustc.exe'), ['--print', 'sysroot'], { env: rustEnv });
  const lld = sysroot ? path.join(sysroot, 'lib', 'rustlib', host, 'bin', 'rust-lld.exe') : '';
  if (!lld || !exists(lld)) return;
  const shim = path.join(mkdirp(tool('shims')), 'lld-link.exe');
  fs.copyFileSync(lld, shim);
  env.vars[variable] = shim;
  env.summary.push('rust linking: lld (link.exe writes empty files into mapped folders)');
}

/**
 * Cargo defaults that fit Windows, written only when there is no $CARGO_HOME\config.toml yet: fewer parallel jobs
 * (parallel rustc ran out of paging file) and, for the GNU host, only line tables as debug info (full debug info made
 * test executables bigger than the 2 GB Windows allows).
 */
export function cargoDefaults(host: string): void {
  const file = tool('rust', 'cargo', 'config.toml');
  if (exists(file) || !exists(path.dirname(file))) return;
  // Several agents often build at once: up to 4 jobs each (8 each crashed Windows inside the sandbox on 13 Oct 2026),
  // and about 4 GB of memory per job. The daemon lowers it further per session (CARGO_BUILD_JOBS) when several build.
  const jobs = cargoJobs(os.cpus().length, os.totalmem() / 1024 ** 3, 1);
  const gnu = host.endsWith('-gnu');
  fs.writeFileSync(
    file,
    [
      '# Written by windows-development-sandbox once; edit freely, it is never overwritten.',
      '[build]',
      'jobs = ' + jobs,
      '',
      ...(gnu
        ? ['[profile.dev]', 'debug = "line-tables-only"', '', '[profile.test]', 'debug = "line-tables-only"', '']
        : []),
    ].join('\n'),
  );
}

/**
 * Where cargo builds and where sccache keeps its cache. Cargo fingerprints hold absolute paths and the host toolchain,
 * so a target\\ shared with builds on the PC rebuilds every time the side changes: "separate" (the default) keeps a
 * sandbox one next to it. sccache's cache persists unless the project sets SCCACHE_DIR itself.
 */
export function rustCaches(rust: Toolchains['rust']): Record<string, string> {
  const target = cargoTarget(rust.targetDir);
  return {
    ...(target ? { CARGO_TARGET_DIR: target } : {}),
    ...(process.env.SCCACHE_DIR ? {} : { SCCACHE_DIR: path.join(dataDir, 'cache', 'sccache') }),
  };
}

/** "auto": the msvc host when the MSVC step runs (as on most PCs), else GNU with MinGW. */
export function rustHost(config: Toolchains): string {
  if (config.rust.host !== 'auto') return config.rust.host;
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64';
  // Unreal's Visual Studio is a full MSVC too (rustc finds it through the Setup API).
  const msvc = wanted(config.msvc.enabled, 'msvc') || wanted(config.unreal.enabled, 'unreal');
  return cpu + (msvc ? '-pc-windows-msvc' : '-pc-windows-gnu');
}

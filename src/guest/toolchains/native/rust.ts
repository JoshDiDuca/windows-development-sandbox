// Rust: rustup + cargo, with crates installed prebuilt where possible (binstall.ts).
import path from 'node:path';
import type { Toolchains } from '../../../core/types.js';
import { dryRun } from '../../runtime/paths.js';
import { execHeavy as execAsync } from '../../runtime/pools.js';
import { exists } from '../../runtime/fs.js';
import { log } from '../../runtime/log.js';
import { arch, tool, versionOf, type ToolEnv } from '../tool-env.js';
import { downloadFile } from '../install.js';
import { installOnce } from '../package-ledger.js';
import { crateInstaller } from './binstall.js';
import { installedMsvcEnv } from './msvc/index.js';

/** rustup-init.exe (the small installer; the toolchain itself downloads when it runs), kept with Rust's tools. */
export async function fetchRustupInit(): Promise<void> {
  const init = tool('rust', 'rustup-init.exe');
  if (exists(init) || exists(path.join(tool('rust', 'cargo'), 'bin', 'rustup.exe'))) return;
  await downloadFile(
    'https://static.rust-lang.org/rustup/dist/' +
      (arch === 'arm64' ? 'aarch64' : 'x86_64') +
      '-pc-windows-msvc/rustup-init.exe',
    init,
  );
}

export async function setupRust(env: ToolEnv, config: Toolchains['rust'], refresh: boolean): Promise<void> {
  const RUSTUP_HOME = tool('rust', 'rustup');
  const CARGO_HOME = tool('rust', 'cargo');
  const rustEnv = { env: { ...process.env, RUSTUP_HOME, CARGO_HOME } };
  const rustup = path.join(CARGO_HOME, 'bin', 'rustup.exe');
  if (dryRun) {
    log('(dry run) would provision Rust ' + config.toolchain + ' (' + config.host + ')');
    return;
  }
  if (!exists(rustup)) {
    const init = tool('rust', 'rustup-init.exe');
    log('Installing Rust with rustup (~300 MB once; the toolchain downloads after rustup itself) ...');
    await fetchRustupInit();
    await execAsync(
      init,
      [
        '-y',
        '--no-modify-path',
        '--profile',
        'default',
        '--default-host',
        config.host,
        '--default-toolchain',
        config.toolchain,
      ],
      rustEnv,
    );
  } else {
    // The host can change (GNU <-> msvc with toolchains.msvc): install the toolchain for it; a no-op when it is there.
    await execAsync(rustup, ['set', 'default-host', config.host], { ...rustEnv, stdio: 'ignore' });
    await execAsync(rustup, ['toolchain', 'install', config.toolchain, '--profile', 'default', '--no-self-update'], {
      ...rustEnv,
      stdio: 'ignore',
    });
    await execAsync(rustup, ['default', config.toolchain], { ...rustEnv, stdio: 'ignore' });
    if (refresh) await execAsync(rustup, ['update'], rustEnv);
  }
  Object.assign(env.vars, { RUSTUP_HOME, CARGO_HOME });
  env.prepend.push(path.join(CARGO_HOME, 'bin'));
  env.summary.push(
    'rust: ' + versionOf(path.join(CARGO_HOME, 'bin', 'rustc.exe'), ['--version'], rustEnv) + ' [' + config.host + ']',
  );
  const toolchainKey = 'rustup@' + config.toolchain;
  await installOnce(env, toolchainKey + ' components', config.components, (c) =>
    execAsync(rustup, ['component', 'add', c], rustEnv),
  );
  await installOnce(env, toolchainKey + ' targets', config.targets, (t) =>
    execAsync(rustup, ['target', 'add', t], rustEnv),
  );
  // cargo install links with MSVC's link.exe (msvc host) or MinGW's gcc (GNU host). Those steps ran first, but their
  // PATH only reaches the agent at the end, so it is put together here.
  const msvc = config.host.endsWith('-msvc') ? installedMsvcEnv() : null;
  const mingw = tool('mingw', 'mingw64', 'bin');
  const cargoEnv = msvc
    ? {
        env: {
          ...rustEnv.env,
          ...msvc.vars,
          PATH: [path.join(CARGO_HOME, 'bin'), ...msvc.path, process.env.PATH ?? ''].join(path.delimiter),
        },
      }
    : {
        env: {
          ...rustEnv.env,
          CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER: path.join(mingw, 'gcc.exe'),
          PATH: [path.join(CARGO_HOME, 'bin'), mingw, process.env.PATH ?? ''].join(path.delimiter),
        },
      };
  // Prebuilt through cargo-binstall where the crate publishes a Windows build, else compiled (same "cargo" keys).
  await installOnce(env, 'cargo', config.crates, crateInstaller(CARGO_HOME, cargoEnv));
}

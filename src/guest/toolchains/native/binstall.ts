// toolchains.rust.crates with prebuilt binaries: cargo-binstall (from its own GitHub release) fetches a crate's
// published Windows build in seconds; only crates without one are compiled with `cargo install --locked`.
import fs from 'node:fs';
import path from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import { execHeavy as execAsync } from '../../runtime/pools.js';
import { exists } from '../../runtime/fs.js';
import { log, warn } from '../../runtime/log.js';
import { errMsg } from '../../../core/util/errors.js';
import { binstallAsset } from '../catalogue.js';
import { arch, tool } from '../tool-env.js';
import { installFromGithub } from '../install.js';

/**
 * cargo-binstall.exe into CARGO_HOME\bin (so `cargo binstall` works for the agent too). Downloaded into its own
 * tools\cargo-binstall folder first: downloader.archive replaces its destination, which must never be cargo's bin.
 */
const ensureBinstall = async (cargoBin: string): Promise<boolean> => {
  const target = path.join(cargoBin, 'cargo-binstall.exe');
  if (exists(target)) return true;
  try {
    const dir = tool('cargo-binstall');
    if (!exists(path.join(dir, 'cargo-binstall.exe'))) {
      await installFromGithub('cargo-bins/cargo-binstall', binstallAsset(arch), {
        dest: dir,
        what: 'cargo-binstall for prebuilt Rust tools (~10 MB once)',
        locate: 'cargo-binstall.exe',
      });
    }
    fs.copyFileSync(path.join(dir, 'cargo-binstall.exe'), target);
    return true;
  } catch (e) {
    warn('cargo-binstall unavailable, compiling crates with cargo install instead: ' + errMsg(e));
    return false;
  }
};

/**
 * Returns the installer for one crate: `cargo binstall` (prebuilt only: its own compile fallback is off, so a crate
 * without a Windows build is compiled by our `cargo install` with the linker settings in `cargoEnv`), then
 * `cargo install --locked`. cargo-binstall is fetched on first use, so boots with every crate installed download
 * nothing.
 */
export function crateInstaller(cargoHome: string, cargoEnv: SpawnOptions): (crate: string) => Promise<void> {
  const cargo = path.join(cargoHome, 'bin', 'cargo.exe');
  let binstall: Promise<boolean> | null = null;
  // quick-install's install statistics are opt-out; the sandbox opts out.
  const binstallEnv: SpawnOptions = {
    ...cargoEnv,
    env: { ...(cargoEnv.env ?? process.env), BINSTALL_DISABLE_TELEMETRY: 'true' },
  };
  return async (crate) => {
    binstall ??= ensureBinstall(path.join(cargoHome, 'bin'));
    if (await binstall) {
      try {
        await execAsync(
          cargo,
          ['binstall', '--no-confirm', '--locked', '--disable-strategies', 'compile', crate],
          binstallEnv,
        );
        return;
      } catch {
        log('No prebuilt ' + crate + ' for Windows; compiling it with cargo (takes a few minutes) ...');
      }
    }
    await execAsync(cargo, ['install', '--locked', crate], cargoEnv);
  };
}

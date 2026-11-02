import type { Config, DatabasePlan, GitAccess } from '../../core/types.js';
import type { PcInstallManifest } from '../../shared/paths/pc-installs.js';
import type { ToolEnv } from './tool-env.js';

/** apps: the boot only (apps are machine-wide; a project that joins later shares them). */
export interface ToolchainOptions {
  gitEnabled: boolean;
  gitAccess: GitAccess;
  hostGit: boolean;
  refresh: boolean;
  databases: DatabasePlan[];
  apps?: Config['apps'];
  /** pcInstalls: this PC's games, engines and editors mapped read-only (session.json). */
  pcInstalls?: PcInstallManifest;
}

/** What a toolchain module's step gets besides its settings. */
export interface ToolCtx {
  readonly refresh: boolean;
  readonly pcInstalls: PcInstallManifest;
  /** A project joins a running sandbox: machine-wide installs (Visual Studio) wait for a restart. */
  readonly duringSession: boolean;
}

/** One installer the scheduler runs: a toolchain, the apps, or a database server. */
export interface ToolchainStep {
  readonly name: string;
  readonly enabled: boolean;
  /** Steps that finish first (they are earlier in the plan). */
  readonly after?: readonly string[];
  /**
   * The step's effect is machine-wide and the same for every project (an installer, a registry entry, a shortcut, the
   * git guard): a project added after boot reuses what the boot's run contributed instead of running it again.
   */
  readonly shared?: boolean;
  install(env: ToolEnv): Promise<void> | void;
}

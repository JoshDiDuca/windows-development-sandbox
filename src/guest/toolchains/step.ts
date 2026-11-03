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
  /**
   * Boot only: the heavy installs (Visual Studio, and what depends on it) run in the background after the agent has
   * started. Off with a VPN or network.allowOnly (their firewall would cut the downloads), in a dry run and when a
   * project joins a running sandbox.
   */
  deferHeavy?: boolean;
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
  /**
   * Download only what `install` will need (no-op when it is there). The scheduler starts every step's fetch at once,
   * outside the step slots and `after`; only the net pool limits them. A failure is ignored: install downloads again.
   */
  fetch?(): Promise<void>;
  /** At boot, runs after the agent has started (the steps that depend on it follow it). */
  readonly background?: boolean;
  install(env: ToolEnv): Promise<void> | void;
}

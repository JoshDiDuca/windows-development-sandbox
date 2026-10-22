// Saved logins, per agent: the logic behind `sandbox account` and the Accounts tab. Returns data, never prints.
// Claude keeps its own file format (AccountStore); every other agent that declares `home` in its settings uses
// AgentAccountStore (a folder of its login files).
import path from 'node:path';
import {
  AccountStore,
  AgentAccountStore,
  hostClaudeDir,
  hostGlobalStateFile,
  type Account,
  type AccountRow,
} from '../../host/profile/index.js';
import { SandboxChannel } from '../../host/channel/index.js';
import { isSandboxRunning } from '../../host/sandbox/index.js';
import { expandPath, fail } from '../../core/util/index.js';
import type { Context } from '../commands/context.js';

export type AccountsContext = Pick<Context, 'storageRoot' | 'dataPath' | 'loaded'>;

/** An agent in the Accounts tab. */
export interface AgentAccounts {
  readonly name: string;
  /** Its login can be saved and switched (it declares where it lives). */
  readonly kept: boolean;
  /** "Save this PC's login" works (we know where the agent keeps it on this PC). */
  readonly canSavePc: boolean;
}

/** What was saved or activated. */
export interface AccountRef {
  readonly name: string;
  readonly email: string | null;
  /** Something worth telling after a switch (e.g. plugins were copied, or could not be). */
  readonly note?: string;
}

const CLAUDE = 'claude';

export class AccountsService {
  private readonly claude: AccountStore;

  constructor(private readonly ctx: AccountsContext) {
    this.claude = new AccountStore(ctx.storageRoot, ctx.loaded.config.claudeProfile.sharePluginsAcrossAccounts);
  }

  /** Claude first, then the other agents that keep a login, then the ones that cannot. */
  agents(): AgentAccounts[] {
    const all = Object.entries(this.ctx.loaded.config.harnesses).map(([name, h]) => ({
      name,
      kept: name === CLAUDE || Boolean(h.home),
      canSavePc: name === CLAUDE || Boolean(h.home?.hostDir),
    }));
    return [
      ...all.filter((a) => a.name === CLAUDE),
      ...all.filter((a) => a.name !== CLAUDE && a.kept),
      ...all.filter((a) => a.name !== CLAUDE && !a.kept),
    ];
  }

  /** The store, the sandbox folder of the agent's login, and its login files (non-Claude agents). */
  private other(agent: string): { store: AgentAccountStore; stateDir: string; hostDir: string | null } {
    const home =
      this.ctx.loaded.config.harnesses[agent]?.home ??
      fail(
        agent in this.ctx.loaded.config.harnesses
          ? '"' + agent + '" does not keep its login between sandboxes, so there is nothing to save.'
          : 'Unknown agent "' + agent + '".',
        'Agents with saved logins: ' +
          this.agents()
            .filter((a) => a.kept)
            .map((a) => a.name)
            .join(', '),
      );
    return {
      store: new AgentAccountStore(this.ctx.storageRoot, agent, home.loginFiles),
      stateDir: path.join(this.ctx.dataPath, 'state', agent),
      hostDir: home.hostDir ? expandPath(home.hostDir, this.ctx.loaded.base) : null,
    };
  }

  list(agent = CLAUDE): AccountRow[] {
    return agent === CLAUDE ? this.claude.list(this.ctx.dataPath) : this.other(agent).store.list(this.ctx.dataPath);
  }

  /** Name of the login the sandbox uses now for this agent, if any. */
  activeName(agent = CLAUDE): string | null {
    return agent === CLAUDE
      ? this.claude.activeFor(this.ctx.dataPath)
      : this.other(agent).store.activeFor(this.ctx.dataPath);
  }

  /** Saves the sandbox's login, or this PC's when fromHost. */
  save(name: string, fromHost: boolean, agent = CLAUDE): AccountRef {
    if (agent === CLAUDE) {
      const saved: Account = this.claude.save(this.ctx.dataPath, name, fromHost ? this.hostLogin() : null);
      return { name: saved.name, email: saved.email };
    }
    const { store, stateDir, hostDir } = this.other(agent);
    if (fromHost && !hostDir)
      fail(
        "Saving this PC's " + agent + ' login is not supported.',
        'Sign in inside the sandbox, then save that login.',
      );
    store.save(this.ctx.dataPath, name, fromHost && hostDir ? hostDir : stateDir, !fromHost);
    return { name, email: null };
  }

  /** Makes the sandbox use a saved login. Running sessions keep the old one until restart(). */
  activate(name: string, agent = CLAUDE): AccountRef {
    if (agent === CLAUDE) {
      const a = this.claude.activate(this.ctx.dataPath, name);
      return { name: a.name, email: a.email, note: this.claude.pluginNote ?? undefined };
    }
    const { store, stateDir } = this.other(agent);
    store.activate(this.ctx.dataPath, name, stateDir);
    return { name, email: null };
  }

  /** The agent's default login, if it keeps logins and one is set. */
  defaultName(agent = CLAUDE): string | null {
    return agent === CLAUDE ? this.claude.defaultName() : this.other(agent).store.defaultName();
  }

  /**
   * Makes the sandbox use `wanted`, else the agent's default, when it uses another login now (a launch, or a session
   * started with --account). Returns the login it then uses; null when the agent keeps no login or none is saved.
   */
  ensure(agent: string, wanted: string | null): string | null {
    if (!this.agents().some((a) => a.name === agent && a.kept)) return null;
    const name = wanted ?? this.defaultName(agent);
    if (!name) return this.activeName(agent);
    if (name !== this.activeName(agent)) this.activate(name, agent);
    else if (agent === CLAUDE) this.claude.syncPlugins(this.ctx.dataPath);
    return name;
  }

  /** Whether a session of this agent is running that would pick up a new login on restart. */
  hasRunningSessions(agent = CLAUDE): boolean {
    return (
      isSandboxRunning() && new SandboxChannel(this.ctx.dataPath).runningSessions().some((s) => s.harness === agent)
    );
  }

  /** Restarts the agent's running sessions (conversations continue); returns the sandbox's own message. */
  async restart(agent = CLAUDE): Promise<string> {
    return (await new SandboxChannel(this.ctx.dataPath).restart(agent)).message;
  }

  /** @deprecated Claude-only names kept for callers written before accounts were per agent. */
  hasRunningClaude(): boolean {
    return this.hasRunningSessions(CLAUDE);
  }
  restartClaude(): Promise<string> {
    return this.restart(CLAUDE);
  }

  setDefault(name: string, agent = CLAUDE): void {
    if (agent === CLAUDE) this.claude.setDefault(name);
    else this.other(agent).store.setDefault(name);
  }

  remove(name: string, agent = CLAUDE): void {
    if (agent === CLAUDE) this.claude.remove(name);
    else this.other(agent).store.remove(name);
  }

  rename(name: string, to: string, agent = CLAUDE): void {
    if (agent === CLAUDE) this.claude.rename(name, to);
    else this.other(agent).store.rename(name, to);
  }

  /** This PC's Claude login location (config folder + global state file). */
  private hostLogin(): { claudeDir: string; globalStateFile: string } {
    const profile = this.ctx.loaded.config.claudeProfile;
    return { claudeDir: hostClaudeDir(profile), globalStateFile: hostGlobalStateFile(profile) };
  }
}

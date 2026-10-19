// The shapes the repo guard saves before launch and reports afterwards, and the rule every check implements.

/** What a finding is about (also the persisted findings' schema). */
export const FINDING_KINDS = ['hook', 'config', 'git', 'command', 'agent'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** A git folder's own state: config lines, hooks, redirect files. */
export interface GitState {
  readonly config: string[];
  readonly hooks: Record<string, string>;
  readonly redirects: string[];
  /** Hooks in a core.hooksPath folder inside the project, by relative path (missing in older snapshots). */
  readonly pathHooks?: Record<string, string>;
}
export interface RepoSnapshot extends GitState {
  readonly gitDir: boolean;
  readonly commands: Record<string, string>;
  /** Fingerprints of AGENT_FILES (missing in snapshots of older versions: then they are not checked). */
  readonly agent?: Record<string, string>;
  /** Other git folders: submodules (.git/modules/...) and repositories nested in the project, by relative path. */
  readonly repos?: Record<string, GitState>;
}
export interface RepoFinding {
  readonly kind: FindingKind;
  readonly detail: string;
}

export type GuardRuleKind = 'commands' | 'agent-files' | 'nested-repos' | 'git-dir';

/** One check: compares the workspace with its pre-launch snapshot and neutralises what is new. */
export interface GuardRule {
  readonly kind: GuardRuleKind;
  check(workspace: string, before: RepoSnapshot): RepoFinding[];
}

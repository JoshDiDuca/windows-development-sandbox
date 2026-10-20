// Agents as entries of `harnesses` in your settings: their names, the entry a new agent gets, and the lists that
// adding and removing one change. Node side (it checks names with the config schema); the agents run writes them.
import { DEFAULTS } from '../../../core/config/index.js';
import { HarnessSchema, NameSchema, describeIssues } from '../../../core/schema/index.js';
import type { Harness } from '../../../core/types.js';

/** How a new agent gets into the sandbox. */
export type AgentSource = 'npm' | 'uv' | 'host';

/** Names an agent cannot have. */
const RESERVED: readonly string[] = ['shell', 'pwsh', 'powershell', 'cmd', 'close'];

/** Nothing wrong with the name (true), or what is wrong. Pure. */
export function agentNameProblem(name: string, taken: readonly string[]): true | string {
  const typed = name.trim();
  if (!typed) return 'Type a name.';
  const parsed = NameSchema.safeParse(typed);
  if (!parsed.success) return 'Use letters, numbers, - and _ only.';
  if (taken.some((t) => t.toLowerCase() === typed.toLowerCase())) return typed + ' is an agent already.';
  // Shell sessions are listed by these names, and sandbox shell / close are commands.
  if (RESERVED.includes(typed.toLowerCase())) return typed + ' is taken by the sandbox; choose another name.';
  return true;
}

/** The command a package usually provides: "@scope/my-agent@latest" gives "my-agent". Pure. */
export function commandFromPackage(pkg: string): string {
  const version = pkg.lastIndexOf('@');
  const bare = version > 0 ? pkg.slice(0, version) : pkg;
  return (bare.split(/[\\/]/).pop() ?? '').replace(/[^A-Za-z0-9._-]/g, '');
}

/** The config entry for a new agent. Pure. */
export function newAgent(source: AgentSource, what: string, command: string, hostDir = 'auto'): Harness {
  const common = { arguments: [], environment: {} };
  if (source === 'npm') return { ...common, npmPackage: what, npmBin: command };
  if (source === 'uv') return { ...common, uvPackage: what, uvBin: command };
  return { ...common, hostExecutable: what, hostDir };
}

/** The entry of an agent, checked the way the config file checks it. Returns the entry or what is wrong. */
export function checkedAgent(harness: Harness): Harness | string {
  const checked = HarnessSchema.safeParse(harness);
  return checked.success ? harness : describeIssues(checked.error).join('; ');
}

/** What `harnesses` should say with `name` added. Pure. */
export function withAgent(current: unknown, name: string, harness: Harness): Record<string, unknown> {
  return { ...(current && typeof current === 'object' ? (current as Record<string, unknown>) : {}), [name]: harness };
}

/** What `harnesses` should say with `name` taken out. Pure. */
export function withoutAgent(current: unknown, name: string): Record<string, unknown> {
  const rest = { ...(current && typeof current === 'object' ? (current as Record<string, unknown>) : {}) };
  delete rest[name];
  return rest;
}

/** The agents of `names` that are not built in (only these can be removed). Pure. */
export function addedAgents(names: readonly string[]): string[] {
  return names.filter((n) => !(n in DEFAULTS.harnesses));
}

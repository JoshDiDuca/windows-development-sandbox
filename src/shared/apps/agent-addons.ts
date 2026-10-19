// How agent add-ons plug into the agents. Pure: the sandbox writes what these return (guest/setup/managed-policy.ts,
// guest/setup/addon-mcp.ts, guest/setup/headroom.ts, guest/boot/guide.ts), the self-test checks them. Everything goes
// into the sandbox's own Claude files (managed settings, its .claude.json), never into a file on this PC.
// - rtk documents its Claude Code hook as a PreToolUse entry for Bash that runs `rtk hook claude`.
// - Headroom is a proxy: Claude Code reaches the API through it (ANTHROPIC_BASE_URL in the managed settings' env).
// - MCP servers (Playwright, Context7) are user-scope servers named sbx-... in the sandbox's .claude.json.
import type { AddonMcp } from './catalogue.js';

/** One hook command in Claude Code's settings. */
interface ClaudeHook {
  readonly type: 'command';
  readonly command: string;
}

/** Claude Code's managed-settings.json as the sandbox writes it. */
export interface ManagedSettings {
  readonly permissions?: { readonly deny: readonly string[] };
  readonly hooks?: {
    readonly PreToolUse: readonly { readonly matcher: string; readonly hooks: readonly ClaudeHook[] }[];
  };
  readonly env?: Readonly<Record<string, string>>;
}

/** The command Claude Code runs for rtk's hook: the program by its full path (quoted, forward slashes for Git Bash). */
export function rtkHookCommand(exe: string): string {
  return '"' + exe.replace(/\\/g, '/') + '" hook claude';
}

/**
 * The managed settings for the git deny rules, rtk's Bash hook when rtk is installed (`rtkExe`) and the Headroom proxy
 * when it runs (`headroomUrl`). Null when there is nothing to write (the file is removed then).
 */
export function claudeManagedSettings(
  deny: readonly string[],
  rtkExe: string | null,
  headroomUrl: string | null = null,
): ManagedSettings | null {
  if (!deny.length && !rtkExe && !headroomUrl) return null;
  return {
    ...(deny.length ? { permissions: { deny } } : {}),
    ...(rtkExe
      ? { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: rtkHookCommand(rtkExe) }] }] } }
      : {}),
    ...(headroomUrl ? { env: { ANTHROPIC_BASE_URL: headroomUrl } } : {}),
  };
}

/** The line every agent's sandbox guide gets while rtk is installed (Claude's commands go through it on their own). */
export const RTK_GUIDE_LINE =
  "- rtk is on PATH and compacts command output: Claude Code's Bash commands go through it on their own; in other agents prefix shell commands with `rtk` (`rtk git status`, `rtk cargo test`, `rtk ls`).";

/** Headroom listens here, on loopback only (its default port). */
export const HEADROOM_PORT = 8787;
/** The only upstream Headroom forwards to: Anthropic's API, set on its command line. */
export const HEADROOM_UPSTREAM = 'https://api.anthropic.com';

/** Claude Code's ANTHROPIC_BASE_URL while the proxy runs. */
export function headroomUrl(port: number = HEADROOM_PORT): string {
  return 'http://127.0.0.1:' + port;
}

/** `headroom proxy` on loopback, forwarding only to Anthropic's API, with no telemetry. */
export function headroomArgs(port: number = HEADROOM_PORT): string[] {
  return [
    'proxy',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--anthropic-api-url',
    HEADROOM_UPSTREAM,
    '--no-telemetry',
  ];
}

/**
 * Headroom's own switches: HEADROOM_OFFLINE refuses every connection Headroom would make on its own (telemetry, update
 * checks, model downloads, usage polling) and keeps only the forwarding of the agent's requests.
 */
export const HEADROOM_ENV: Readonly<Record<string, string>> = {
  HEADROOM_OFFLINE: '1',
  HEADROOM_TELEMETRY: 'off',
  HEADROOM_BEACON: 'off',
  HEADROOM_UPDATE_CHECK: 'off',
  DO_NOT_TRACK: '1',
  HF_HUB_OFFLINE: '1',
  PYTHONIOENCODING: 'utf-8',
};

/** Variables the proxy never gets: keys, tokens and passwords of the agents (it only forwards what Claude sends). */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/** The environment Headroom starts with: the sandbox's, minus anything secret, plus its own switches. */
export function headroomEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base))
    if (value !== undefined && !SECRET_NAME.test(name) && !/^(ANTHROPIC|OPENAI|CLAUDE)_/i.test(name)) env[name] = value;
  return { ...env, ...HEADROOM_ENV };
}

/** The guide line while the proxy runs. */
export function headroomGuideLine(logFile: string): string {
  return (
    "- Headroom compresses Claude Code's requests: Claude Code reaches the API through its proxy on " +
    headroomUrl() +
    ' (log: `' +
    logFile +
    '`). If Claude Code cannot reach the API, the proxy stopped: it starts again with the next sandbox, or turn Headroom off in Apps.'
  );
}

/** A user-scope MCP server in Claude Code's .claude.json. */
export interface McpServerConfig {
  readonly type: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** The name prefix of the sandbox's own MCP servers: names with it are the sandbox's to add and remove. */
export const ADDON_MCP_PREFIX = 'sbx-';

/** The MCP server of an installed add-on: `node <folder>\<script> <args>` (Node is on PATH in every sandbox). */
export function addonMcpServer(folder: string, mcp: AddonMcp): McpServerConfig {
  const script = folder.replace(/[\\/]+$/, '') + '\\' + mcp.script.replace(/\//g, '\\');
  return { type: 'stdio', command: 'node', args: [script, ...(mcp.args ?? [])], env: {} };
}

/**
 * The user-scope MCP servers with the add-ons' servers set: every sbx-... server that `known` lists and that is not in
 * `servers` is removed (an add-on turned off); servers of your own are never touched.
 */
export function withAddonMcpServers(
  current: Readonly<Record<string, unknown>>,
  servers: Readonly<Record<string, McpServerConfig>>,
  known: readonly string[],
): Record<string, unknown> {
  const kept = Object.fromEntries(Object.entries(current).filter(([name]) => !known.includes(name) || name in servers));
  return { ...kept, ...servers };
}

/** The guide line for the add-ons' MCP servers and tools (none: no line). */
export function addonGuideLine(mcpNames: readonly string[], ccusage: boolean): string[] {
  return [
    ...(mcpNames.length ? ['- MCP servers in Claude Code from Apps: ' + mcpNames.join(', ') + '.'] : []),
    ...(ccusage ? ['- ccusage is on PATH: `ccusage daily` (or `monthly`, `session`) reports token use and cost.'] : []),
  ];
}

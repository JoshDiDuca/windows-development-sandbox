// How agent add-ons plug into the agents. Pure: the sandbox writes what these return (guest/setup/managed-policy.ts,
// guest/setup/addon-mcp.ts, guest/setup/headroom.ts, guest/boot/guide.ts), the self-test checks them. Everything goes
// into the sandbox's own Claude files (managed settings, its .claude.json), never into a file on this PC.
// - rtk documents its Claude Code hook as a PreToolUse entry for Bash that runs `rtk hook claude`.
// - Headroom is a proxy: Claude Code reaches the API through it (ANTHROPIC_BASE_URL in the managed settings' env).
// - MCP servers (Playwright, Context7, Perplexity ...) are user-scope servers named sbx-... in the sandbox's
//   .claude.json, and for the add-ons marked `codex` also [mcp_servers.sbx-...] tables in its Codex config.toml.
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

/** A user-scope MCP server in Claude Code's .claude.json: a program it starts, or a remote server over HTTP. */
export type McpServerConfig =
  | {
      readonly type: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    }
  | { readonly type: 'http'; readonly url: string };

/** The name prefix of the sandbox's own MCP servers: names with it are the sandbox's to add and remove. */
export const ADDON_MCP_PREFIX = 'sbx-';

/** What the sandbox knows about an installed add-on beyond its folder: its program, and variables found at boot. */
export interface AddonPlace {
  /** The add-on's program (for `program` servers). */
  readonly exe?: string | null;
  /** Variables only the sandbox can tell (a path), added to the entry's fixed ones. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The MCP server of an installed add-on: `node <folder>\<script> <args>` (Node is on PATH in every sandbox), its own
 * program, or its remote address. Null when a program server's program is missing.
 */
export function addonMcpServer(folder: string, mcp: AddonMcp, place: AddonPlace = {}): McpServerConfig | null {
  if (mcp.url) return { type: 'http', url: mcp.url };
  const env = { ...(mcp.env ?? {}), ...(place.env ?? {}) };
  if (mcp.program) return place.exe ? { type: 'stdio', command: place.exe, args: [...(mcp.args ?? [])], env } : null;
  if (!mcp.script) return null;
  const script = folder.replace(/[\\/]+$/, '') + '\\' + mcp.script.replace(/\//g, '\\');
  return { type: 'stdio', command: 'node', args: [script, ...(mcp.args ?? [])], env };
}

/** An add-on's server as Codex runs it: the Claude Code one, plus the agent variables Codex must pass on. */
export type CodexMcpServer = McpServerConfig & { readonly envVars?: readonly string[] };

/** A TOML string (JSON's escapes are TOML's basic-string escapes). */
const tomlString = (s: string): string => JSON.stringify(s);
/** A TOML key: bare when it can be, else quoted. */
const tomlKey = (k: string): string => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k));

/** A table header's dotted key, its parts unquoted ([mcp_servers."sbx-x".env] -> mcp_servers, sbx-x, env). */
function headerPath(line: string): string[] | null {
  const m = /^\s*\[\[?\s*(.*?)\s*\]\]?\s*(#.*)?$/.exec(line);
  if (!m) return null;
  const parts: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  let at = 0;
  while (at < m[1].length) {
    re.lastIndex = at;
    const part = re.exec(m[1]);
    if (!part) return null;
    try {
      parts.push(part[1] !== undefined ? (JSON.parse('"' + part[1] + '"') as string) : (part[2] ?? part[3]));
    } catch {
      return null; // An escape JSON does not know: not one of the sandbox's names.
    }
    at = re.lastIndex;
    if (!part[4]) break;
  }
  return parts;
}

/** The TOML tables of one server. */
function codexServerToml(name: string, server: CodexMcpServer): string[] {
  const head = '[mcp_servers.' + tomlKey(name) + ']';
  const mark = '# Set by the sandbox while this add-on is on in Apps (removed when it is off).';
  if (server.type === 'http') return [head, mark, 'url = ' + tomlString(server.url)];
  const lines = [
    head,
    mark,
    'command = ' + tomlString(server.command),
    'args = [' + server.args.map(tomlString).join(', ') + ']',
  ];
  if (server.envVars?.length) lines.push('env_vars = [' + server.envVars.map(tomlString).join(', ') + ']');
  const env = Object.entries(server.env);
  if (env.length)
    lines.push(
      '',
      '[mcp_servers.' + tomlKey(name) + '.env]',
      ...env.map(([k, v]) => tomlKey(k) + ' = ' + tomlString(v)),
    );
  return lines;
}

/**
 * Codex's config.toml with the add-ons' servers as [mcp_servers.<name>] tables: every table of a `known` sbx-...
 * server is removed first (an add-on turned off), then the servers on are added at the end. Your own servers and
 * settings stay as they are. A server whose name is used some other way in the file (an inline table, dotted keys)
 * is left out (`skipped`), so the file never gets the same key twice. `changed` is false when nothing changes.
 */
export function codexWithAddonMcpServers(
  toml: string,
  servers: Readonly<Record<string, CodexMcpServer>>,
  known: readonly string[],
): { toml: string; changed: boolean; skipped: string[] } {
  const ours = (p: string[] | null): boolean =>
    p !== null && p[0] === 'mcp_servers' && p.length >= 2 && known.includes(p[1]) && p[1].startsWith(ADDON_MCP_PREFIX);
  const kept: string[] = [];
  let skipping = false;
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) skipping = ours(headerPath(line));
    if (!skipping) kept.push(line);
  }
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const rest = kept.join('\n');
  const skipped: string[] = [];
  const blocks: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    if (new RegExp('(^|[\\s.{,])["\']?' + escaped + '["\']?\\s*[.=]', 'm').test(rest)) {
      skipped.push(name);
      continue;
    }
    blocks.push(codexServerToml(name, server).join('\n'));
  }
  const text = [rest, ...blocks].filter((b) => b !== '').join('\n\n') + '\n';
  const normalised = toml.replace(/\r\n/g, '\n');
  const changed = text !== normalised && !(text === '\n' && normalised === '');
  return { toml: changed ? text : toml, changed, skipped };
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

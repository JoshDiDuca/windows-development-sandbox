// The agent add-ons' MCP servers (Playwright, Context7) in the sandbox's own Claude Code: user-scope servers named
// sbx-... in its .claude.json, set every boot while the add-on is on and removed again when it is off. Your servers
// (from this PC or added in the sandbox) are never touched, and nothing on this PC changes.
import fs from 'node:fs';
import path from 'node:path';
import { addonMcpServer, APPS, type McpServerConfig, withAddonMcpServers } from '../../shared/apps/index.js';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { claudeDir } from '../runtime/session.js';
import { log, warn } from '../runtime/log.js';
import { installedMcpAddons } from './agent-addons.js';

/** The names of every MCP server an add-on can add (the ones the sandbox may remove). */
const ADDON_MCP_NAMES = APPS.flatMap((a) => (a.mcp ? [a.mcp.name] : []));

/** Sets the add-ons' MCP servers in the sandbox's .claude.json; the names that are on. */
export function writeAddonMcpServers(): string[] {
  const servers: Record<string, McpServerConfig> = {};
  for (const { id, folder } of installedMcpAddons()) {
    const mcp = APPS.find((a) => a.id === id)?.mcp;
    if (mcp) servers[mcp.name] = addonMcpServer(folder, mcp);
  }
  const file = path.join(claudeDir, '.claude.json');
  let state: unknown = {};
  if (fs.existsSync(file)) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      state = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      // Never rewrite a file Claude Code could not read either: its login and state are in it.
      warn('Claude Code MCP servers from Apps: ' + file + ' is not valid JSON, left as it is');
      return [];
    }
  } else if (!Object.keys(servers).length) return [];
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return [];
  const current = (state as Record<string, unknown>).mcpServers;
  const before = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const after = withAddonMcpServers(before as Record<string, unknown>, servers, ADDON_MCP_NAMES);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    fs.mkdirSync(claudeDir, { recursive: true });
    writeJsonAtomic(file, { ...state, mcpServers: after });
  }
  const names = Object.keys(servers);
  if (names.length) log('Claude Code MCP servers from Apps: ' + names.join(', '));
  return names;
}

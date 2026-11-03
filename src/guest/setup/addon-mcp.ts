// The agent add-ons' MCP servers (Playwright, Context7, Perplexity ...) in the sandbox's own Claude Code: user-scope
// servers named sbx-... in its .claude.json, set every boot while the add-on is on and removed again when it is off.
// The add-ons marked `codex` also go into the sandbox's Codex config.toml as [mcp_servers.sbx-...] tables. Your servers
// (from this PC or added in the sandbox) are never touched, and nothing on this PC changes. No secret is written:
// a server that needs a key reads it from the agent's environment (PERPLEXITY_API_KEY).
import fs from 'node:fs';
import path from 'node:path';
import {
  addonMcpServer,
  APPS,
  codexWithAddonMcpServers,
  type AddonMcp,
  type CodexMcpServer,
  type McpServerConfig,
  withAddonMcpServers,
} from '../../shared/apps/index.js';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { cometExe } from '../browser/comet.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { dryRun } from '../runtime/paths.js';
import { claudeDir, session, stateDir } from '../runtime/session.js';
import { log, warn } from '../runtime/log.js';
import { installedMcpAddons } from './agent-addons.js';

/** The names of every MCP server an add-on can add (the ones the sandbox may remove). */
const ADDON_MCP_NAMES = APPS.flatMap((a) => (a.mcp ? [a.mcp.name] : []));

/** Variables only this sandbox can tell an add-on's server (where Comet is). */
function placeEnv(id: string): Record<string, string> {
  if (id !== 'comet-mcp') return {};
  const exe = cometExe();
  return exe ? { COMET_PATH: exe } : {};
}

/** The servers of the add-ons that are on and installed, with their catalogue entry. */
function addonServers(): { mcp: AddonMcp; server: McpServerConfig }[] {
  return installedMcpAddons().flatMap(({ id, folder, exe }) => {
    const mcp = APPS.find((a) => a.id === id)?.mcp;
    const server = mcp ? addonMcpServer(folder, mcp, { exe, env: placeEnv(id) }) : null;
    return mcp && server ? [{ mcp, server }] : [];
  });
}

/** Sets the add-ons' MCP servers in the sandbox's .claude.json (and Codex's config.toml); the names that are on. */
export function writeAddonMcpServers(): string[] {
  const on = addonServers();
  writeCodexAddonMcpServers(on);
  const servers: Record<string, McpServerConfig> = Object.fromEntries(on.map(({ mcp, server }) => [mcp.name, server]));
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

/** The add-ons marked for Codex in its config.toml (state\codex), when Codex is one of this sandbox's agents. */
function writeCodexAddonMcpServers(on: readonly { mcp: AddonMcp; server: McpServerConfig }[]): void {
  if (dryRun || !session.agents?.codex) return;
  const file = path.join(stateDir, 'codex', 'config.toml');
  const servers: Record<string, CodexMcpServer> = Object.fromEntries(
    on
      .filter(({ mcp }) => mcp.codex)
      .map(({ mcp, server }) => [mcp.name, { ...server, ...(mcp.envVars?.length ? { envVars: mcp.envVars } : {}) }]),
  );
  const before = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!before && !Object.keys(servers).length) return;
  const known = APPS.flatMap((a) => (a.mcp?.codex ? [a.mcp.name] : []));
  const result = codexWithAddonMcpServers(before, servers, known);
  for (const name of result.skipped)
    warn('Codex MCP servers from Apps: ' + name + ' is already in config.toml in another form, left as it is');
  if (result.changed) {
    mkdirp(path.dirname(file));
    fs.writeFileSync(file, result.toml, 'utf8');
  }
  const names = Object.keys(servers).filter((n) => !result.skipped.includes(n));
  if (names.length) log('Codex MCP servers from Apps: ' + names.join(', '));
}

// Agent and editor files that tools on this PC run things from: only their runnable part is fingerprinted and guarded.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { fileExists, isLink } from '../../core/util/index.js';
import { hash } from './file-hash.js';
import type { GuardRule, RepoFinding, RepoSnapshot } from './types.js';

const CLAUDE_RISKY_KEYS = [
  'hooks',
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'otelHeadersHelper',
  'statusLine',
  'env',
  'enableAllProjectMcpServers',
  'enabledMcpjsonServers',
  'disableAllHooks',
  // Plugins bring their own hooks and MCP servers.
  'enabledPlugins',
  'extraKnownMarketplaces',
] as const;
const VSCODE_RISKY_KEY =
  /path|executable|command|interpreter|shell|profile|args|env|exec|program|server|launch|runtime|binary|alternatetools|home|goroot|tsdk|sdk/i;
const MAX_AGENT_FILE_BYTES = 1024 * 1024;

function claudeRisk(d: unknown): unknown {
  const s = (_.isPlainObject(d) ? d : {}) as Record<string, unknown>;
  const permissions = (_.isPlainObject(s.permissions) ? s.permissions : {}) as Record<string, unknown>;
  return {
    ..._.pick(s, CLAUDE_RISKY_KEYS),
    permissions: _.pick(permissions, ['defaultMode', 'additionalDirectories']),
    // A whole-tool rule ("Bash", "Bash(*)") lets Claude Code on this PC run any command without asking; narrow rules
    // (Bash(npm test), what "always allow" writes) are ordinary edits.
    broadAllow: (Array.isArray(permissions.allow) ? permissions.allow : []).filter(
      (r) => typeof r !== 'string' || !r.includes('(') || /\(\s*:?\*\s*\)\s*$/.test(r),
    ),
  };
}

/**
 * Project files that tools on this PC act on by themselves: Claude Code runs a project's hooks, helpers and MCP
 * servers, VS Code runs folder-open tasks and the programs workspace settings point at, direnv runs .envrc. For each,
 * only the part that can run something is compared (`risky`), so the agent may still edit the rest.
 */
const AGENT_FILES = {
  '.claude/settings.json': (d) => claudeRisk(d),
  '.claude/settings.local.json': (d) => claudeRisk(d),
  '.mcp.json': (_d, text) => text,
  '.vscode/tasks.json': (d) => (JSON.stringify(d).match(/"runOn"\s*:\s*"folderOpen"/) ? d : null),
  '.vscode/settings.json': (d) =>
    _.pickBy(_.isPlainObject(d) ? (d as object) : {}, (_v, k) => VSCODE_RISKY_KEY.test(k)),
  '.envrc': (_d, text) => text,
} as const satisfies Record<string, (data: unknown, text: string) => unknown>;
type AgentFile = keyof typeof AGENT_FILES;
const AGENT_FILE_NAMES = Object.keys(AGENT_FILES) as AgentFile[];

/** What can run in one agent file, as a short fingerprint (null = the file is not there). */
function agentRisk(workspace: string, rel: AgentFile): string | null {
  const file = path.join(workspace, ...rel.split('/'));
  if (!fs.existsSync(file)) return null;
  if (isLink(file) || isLink(path.dirname(file)) || !fileExists(file)) return 'link-or-not-a-file';
  if (fs.statSync(file).size > MAX_AGENT_FILE_BYTES) return 'too-large-' + hash(file);
  const text = fs.readFileSync(file, 'utf8');
  const errors: ParseError[] = [];
  const data = parseJsonc(text, errors, { allowTrailingComma: true });
  const risk = AGENT_FILES[rel](rel === '.envrc' ? null : data, text);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(risk ?? null) + (errors.length && rel !== '.envrc' && rel !== '.mcp.json' ? hash(file) : ''))
    .digest('hex');
}

export function agentSnapshot(workspace: string): Record<string, string> {
  return Object.fromEntries(
    AGENT_FILE_NAMES.flatMap((rel) => {
      const r = agentRisk(workspace, rel);
      return r ? [[rel, r]] : [];
    }),
  );
}

/** Agent files whose runnable part changed are moved to the quarantine folder (with the rest of your edits). */
function guardAgentFiles(workspace: string, before: Record<string, string>): RepoFinding[] {
  const changed = AGENT_FILE_NAMES.filter((rel) => {
    const now = agentRisk(workspace, rel);
    return now !== null && now !== before[rel];
  });
  if (!changed.length) return [];
  const target = path.join(workspace, 'agent-sandbox-quarantine', String(Date.now()));
  fs.mkdirSync(target, { recursive: true });
  return changed.map((rel) => {
    const what =
      rel + ' (the sandbox added something it would run on this PC: hooks, MCP servers, helper commands or tasks';
    try {
      fs.renameSync(path.join(workspace, ...rel.split('/')), path.join(target, rel.replace(/\//g, '_')));
    } catch (e) {
      return {
        kind: 'agent',
        detail:
          what +
          '; could not be moved: ' +
          (e as NodeJS.ErrnoException).code +
          '. Check it before you open this folder in Claude Code or VS Code)',
      };
    }
    return { kind: 'agent', detail: what + '; moved to ' + target + ')' };
  });
}

/** Hooks, helper commands and MCP servers in .claude/ and .mcp.json, VS Code folder-open tasks and programs, .envrc. */
export class AgentFilesRule implements GuardRule {
  readonly kind = 'agent-files';

  check(workspace: string, before: RepoSnapshot): RepoFinding[] {
    // Snapshots from before these checks existed have no baseline: checking against nothing would move your own files.
    return before.agent ? guardAgentFiles(workspace, before.agent) : [];
  }
}

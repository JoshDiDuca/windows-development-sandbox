// What is copied from this PC, and how the terminal attaches.
import { z } from 'zod';
import { NameSchema, StringsSchema } from './common.js';

export const SecretsSchema = z.strictObject({
  strip: z
    .boolean()
    .describe(
      'Remove credentials from everything copied into the sandbox (your Claude settings.json "env" and credential helpers, MCP servers\' env, headers and arguments): AWS, Azure, Google Cloud, Cloudflare, hosting, CI, registries, payment, AI API keys, database URLs, anything named *_TOKEN / *_SECRET / *PASSWORD* / *_KEY or *PROD*, and values that look like keys.',
    ),
  allow: StringsSchema.describe(
    'Variable names that may go in anyway; * matches anything, e.g. ["AWS_REGION", "AWS_PROFILE", "MY_APP_*"].',
  ),
  patterns: StringsSchema.describe(
    'More variable names to treat as secrets; * matches anything, e.g. ["ACME_*", "*_INTERNAL_URL"].',
  ),
  warnFiles: z
    .boolean()
    .describe(
      'Warn at launch about files in the workspace that usually hold secrets (.env, *.pem, credentials.json, ...). The agent CAN read them: Windows Sandbox maps the whole folder.',
    ),
});
export const AttachSchema = z.strictObject({
  enabled: z.boolean().describe('Allow sandbox claude --terminal / sandbox attach from this PC.'),
  reuseSession: z
    .boolean()
    .describe(
      "sandbox claude -t in a running sandbox reattaches to this folder's session when no terminal on this PC is attached to it (--new always starts another).",
    ),
  auto: z
    .boolean()
    .describe(
      'Starting an agent attaches this terminal automatically, as if you passed -t (only in an interactive terminal).',
    ),
  autoHide: z
    .boolean()
    .describe(
      'Hide the Windows Sandbox window whenever this terminal attaches; it keeps running (sandbox show brings it back).',
    ),
  confirmCtrlC: z
    .boolean()
    .describe(
      'In an attached terminal and the sandbox window, a single Ctrl+C is held back (the title says so) and only a second one within 1.5 seconds reaches the agent: a Ctrl+C meant as "copy" no longer stops it. Esc still stops an agent.',
    ),
});
export const AgentCommandsSchema = z.strictObject({
  enabled: z
    .boolean()
    .describe(
      "(Beta) Typing an agent's own command on this PC (claude, codex, ...) starts it in a hidden sandbox for the folder you are in and attaches that terminal. Adds one folder to the start of YOUR PATH; off removes it. SANDBOX_AGENT_DIRECT=1 runs the real agent instead.",
    ),
  agents: z
    .union([z.literal('auto'), z.array(NameSchema)])
    .describe('"auto" = every agent installed on this PC, or a list of agent names, e.g. ["claude", "codex"].'),
});
export const ClaudeProfileSchema = z.strictObject({
  enabled: z.boolean().describe('Copy selected Claude settings from this PC into the sandbox.'),
  hostDir: z.string().describe('Your Claude folder, or "auto" (~/.claude or CLAUDE_CONFIG_DIR).'),
  include: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/)).describe('Files and folders copied from it.'),
  globalStateFile: z.string().describe('Your .claude.json, or "auto". Empty string = do not copy.'),
  copyCredentials: z.boolean().describe('Copy your Claude LOGIN into the sandbox. Prefer sandbox account instead.'),
  overwrite: z.boolean().describe('Refresh these settings from this PC on every launch.'),
  sharePluginsAcrossAccounts: z
    .boolean()
    .describe(
      'When you switch Claude accounts, copy your Claude plugins (and which ones are enabled) into a data set that has none yet. Off by default: plugins are code that runs in your sessions.',
    ),
  syncHistory: z.boolean().describe('Bring conversation history in, and sync new history back (path-translated).'),
  historyScope: z
    .enum(['project', 'all'])
    .describe(
      'Which history comes in: "project" = only the projects in this sandbox (other projects\' conversations, file backups and prompts stay on this PC), "all" = everything. Only this sandbox\'s projects ever sync back.',
    ),
  syncClaudeMem: z
    .boolean()
    .describe('Bring claude-mem data into the sandbox (its settings and backups stay on this PC).'),
  syncClaudeMemBack: z
    .boolean()
    .describe(
      "Also copy claude-mem's database back to this PC when the sandbox closes. Off by default: what is in it is loaded into every Claude session on this PC, so a compromised agent could plant instructions there.",
    ),
});

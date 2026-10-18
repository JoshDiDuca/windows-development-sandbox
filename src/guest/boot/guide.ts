// Tells the agent where it is. A generated section (between markers, rewritten every boot) is added to the agent's
// global instructions: Claude's CLAUDE.md and Codex's AGENTS.md inside the sandbox. It never travels back to this PC.
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, session, stateDir, workspace } from '../runtime/session.js';
import { dataDir, launchDir, toolsDir } from '../runtime/paths.js';
import { RTK_GUIDE_LINE } from '../../shared/apps/index.js';
import { installedRtk } from '../setup/agent-addons.js';

const BEGIN = '<!-- agent-sandbox:begin (generated every boot, do not edit) -->';
const END = '<!-- agent-sandbox:end -->';

/** Drives other than C: are subst drives onto C:\Mirror\<letter> (mapped folders shown at their PC paths). */
const mirrorLine = (): string[] => {
  // Only the ones bootstrap.ps1 could create (a letter already in use is reported there and skipped).
  const drives = (session.substDrives ?? []).filter((d) => fs.existsSync(d.letter + ':\\'));
  if (!drives.length) return [];
  return [
    '- ' +
      drives.map((d) => d.letter + ':').join(', ') +
      ' = mapped folders at their PC paths (subst onto `' +
      drives.map((d) => d.target).join('`, `') +
      '`; real-path tools may print that form).',
  ];
};

/** Deliberately tiny: it is loaded into every conversation. */
export interface GuideProject {
  guest: string;
  host: string;
}

export function sandboxGuide(
  toolSummary: string[],
  lan: 'blocked' | 'open' | 'offline' = 'blocked',
  projects: GuideProject[] = [],
  addons: string[] = [],
): string {
  return [
    BEGIN,
    '## Sandbox manifest — you are in a DISPOSABLE Windows Sandbox',
    'Wiped on close: everything except the paths below (installers, winget/choco, C:\\Users, Program Files, registry).',
    '- RW, persists: `' + workspace + '` = host folder ' + session.workspaceHost,
    // Projects started from other folders while this sandbox runs: every agent here can see them.
    ...projects.map(
      (p) =>
        '- RW, persists: `' +
        p.guest +
        '` = host folder ' +
        p.host +
        ' (another project in this sandbox; your own is `%AGENT_WORKSPACE%`)',
    ),
    '- RW, persists: `' +
      toolsDir +
      '` (toolchains) — put portable exes in `' +
      path.join(toolsDir, 'bin') +
      '` (on PATH)',
    '- RW, persists: `' +
      stateDir +
      '` (agent config/history; do not edit logins) · logs: `' +
      path.join(dataDir, 'logs') +
      '`',
    '- RO: `' + launchDir + "` (this boot's scripts) · lost on close: everything else, incl. `C:\\nvm` (Node symlink)",
    ...mirrorLine(),
    '- Tools: ' + toolSummary.join(' · '),
    // Agent add-ons that change how the agent should work (rtk).
    ...addons,
    '- Persistent installs: `npm i -g` (per nvm version), `pip`, `cargo install`, `dotnet tool -g`, `uv tool`, `bun add -g`. Real installers must re-run each boot via a hook (ask the user).',
    '- Mapped folders (workspace, C:\\AgentData) allow NO symlinks or junctions: pnpm runs hoisted (set), npm workspaces / `file:` deps and deno node_modules dirs fail there (use a folder on C:\\ outside them), bun cannot save its lockfile there (`bun install --no-save`).',
    '- Network: ' +
      (lan === 'offline'
        ? 'OFF'
        : lan === 'blocked'
          ? 'internet yes, host LAN blocked'
          : 'internet yes, host LAN NOT blocked this time') +
      '. Other sessions may share this workspace; the user may be typing from the host.',
    END,
  ].join('\n');
}

/** Inserts or replaces the generated section, keeping whatever else the file contains (the host's CLAUDE.md). */
export function upsertGuide(file: string, guide: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  const without = start >= 0 && end > start ? current.slice(0, start) + current.slice(end + END.length) : current;
  fs.writeFileSync(file, without.trimEnd() + (without.trim() ? '\n\n' : '') + guide + '\n', 'utf8');
}

/**
 * Claude Code loads the machine-wide managed memory (C:\Program Files\ClaudeCode\CLAUDE.md on Windows) before the
 * user and project CLAUDE.md, in every session. The sandbox is disposable and we are admin, so the manifest lives
 * there: the user's own global CLAUDE.md and every project's CLAUDE.md stay exactly as they are.
 * Codex/Gemini have no machine-level file, so the block goes into their sandbox-only global instruction files.
 */
export function managedClaudeMd(): string {
  return path.join(
    process.env.AGENT_MANAGED_DIR ?? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode'),
    'CLAUDE.md',
  );
}

export function writeGuides(
  toolSummary: string[],
  lan: 'blocked' | 'open' | 'offline',
  projects: GuideProject[] = [],
): string {
  const guide = sandboxGuide(toolSummary, lan, projects, installedRtk() ? [RTK_GUIDE_LINE] : []);
  const managed = managedClaudeMd();
  fs.mkdirSync(path.dirname(managed), { recursive: true });
  fs.writeFileSync(managed, guide + '\n', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'SANDBOX.md'), guide + '\n', 'utf8');
  upsertGuide(path.join(stateDir, 'codex', 'AGENTS.md'), guide);
  upsertGuide(path.join(stateDir, 'gemini', '.gemini', 'GEMINI.md'), guide);
  removeGuide(path.join(claudeDir, 'CLAUDE.md'));
  return managed;
}

/** Older versions put the block into the user's CLAUDE.md; take it out again. */
const removeGuide = (file: string): void => {
  if (!fs.existsSync(file)) return;
  const current = fs.readFileSync(file, 'utf8');
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start >= 0 && end > start)
    fs.writeFileSync(file, (current.slice(0, start) + current.slice(end + END.length)).trim() + '\n', 'utf8');
};

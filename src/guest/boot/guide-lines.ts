// The folder and tool lines of the sandbox guide. Pure (no guest state), so the self-test can import it.
import path from 'node:path';

/** A folder mapped from the PC at boot for other projects (a project root, or a single project). */
export interface MappedFolder {
  readonly host: string;
  readonly guest: string;
  /** A project root: every folder in it is a project of this sandbox. */
  readonly root?: boolean;
}

/** A project registered after boot, with the tools it got. */
export interface GuideProject {
  guest: string;
  host: string;
  name?: string;
  tools?: readonly string[];
}

const within = (parent: string, child: string): boolean => {
  const rel = path.win32.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.win32.isAbsolute(rel));
};

/**
 * Where the agent can write and what persists: the launch folder, then every mapped project root as `<guest>\*` = host
 * `<host>\*` (any folder in it is a project, yours or another agent's) and every project mapped at boot, then the
 * projects registered since.
 */
export function projectFolderLines(
  workspace: string,
  workspaceHost: string,
  mapped: readonly MappedFolder[],
  projects: readonly GuideProject[],
): string[] {
  const roots = mapped.filter((m) => m.root);
  const insideRoot = roots.some((r) => within(r.guest, workspace));
  const line = (guest: string, host: string, note = ''): string =>
    '- RW, persists: `' + guest + '` = host folder ' + host + note;
  return [
    ...(insideRoot ? [] : [line(workspace, workspaceHost)]),
    ...roots.map((r) =>
      line(
        path.win32.join(r.guest, '*'),
        path.win32.join(r.host, '*'),
        ' (project root: every project in it persists, your own is `%AGENT_WORKSPACE%`)',
      ),
    ),
    ...mapped
      .filter((m) => !m.root && !within(workspace, m.guest) && !roots.some((r) => within(r.guest, m.guest)))
      .map((m) => line(m.guest, m.host, ' (another project in this sandbox)')),
    // Projects started from other folders while this sandbox runs: every agent here can see them.
    ...projects
      .filter((p) => !roots.some((r) => within(r.guest, p.guest)) && !within(workspace, p.guest))
      .map((p) => line(p.guest, p.host, ' (another project in this sandbox; your own is `%AGENT_WORKSPACE%`)')),
  ];
}

/**
 * The tools: one line for the launch folder's project; with other projects in the sandbox each line names its project
 * (a project that has not been set up yet is not listed: its tools are decided from its own files).
 */
export function toolLines(
  primaryName: string,
  toolSummary: readonly string[],
  projects: readonly GuideProject[],
): string[] {
  const others = projects.filter((p) => p.tools?.length && p.name && p.name !== primaryName);
  if (!others.length) return ['- Tools: ' + toolSummary.join(' · ')];
  return [
    '- Tools (' + primaryName + '): ' + toolSummary.join(' · '),
    ...others.map((p) => '- Tools (' + p.name + '): ' + p.tools!.join(' · ')),
    "- Tools by project: each project gets the tools its own files ask for; python and rust already installed here are on every project's PATH.",
  ];
}

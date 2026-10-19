// Which folders are mapped into the sandbox: the launch folder, the data folder, the workspace, your extra folders and
// the tools copied from this PC. Everything is checked before it can reach the .wsb.
import path from 'node:path';
import type { GenerateOptions, ResolvedMapping } from '../../core/types.js';
import { assertNoGuestOverlap } from '../../core/config/index.js';
import { assertSafeMapping } from '../../core/safe-paths.js';
import { dirExists, errMsg, fail, isInsideOrEqual, UserError } from '../../core/util/index.js';
import { shownByRoot, type BootProjects } from './boot-projects.js';
import {
  deriveGuest,
  isValidGuestPath,
  guestConflict,
  guestFix,
  PROJECTS_GUEST,
  sandboxFolder,
  tidyGuestPath,
} from '../../shared/paths/index.js';
import { dataMapping } from '../storage/providers/index.js';
import { GUEST } from './wsb-file.js';
import { guestGitDir, planView } from '../workspace-view/index.js';
import { insideProject } from '../../core/local-config/index.js';

/**
 * Every mapping, placed. An extra folder appears at its `guest` path, or at the same path as on this PC when it has
 * none. A folder that cannot appear there (a reserved or relative path, one already in use, a folder that is not
 * there, a whole drive, this tool's own folders) stops the launch; every such folder is listed in one message.
 */
export function collectMappings(
  o: GenerateOptions,
  launchPath: string,
  boot: BootProjects = { roots: [], projects: [], notes: [] },
  notes: string[] = [],
): ResolvedMapping[] {
  const { config, dataPath, workspaceHost, harnessName } = o.run;
  assertGuestPath(config.guestWorkspace, 'guestWorkspace');
  // workspaceFilter: the sandbox gets the project's filtered view (no git-ignored files) and its real .git beside it.
  const view = planView(config, o.run.storageRoot, workspaceHost);
  // A launch folder inside a project root is shown by the root, at the place it has whichever project starts the
  // sandbox.
  const inRoot = !view && shownByRoot(boot.roots, workspaceHost, config.guestWorkspace);
  const mappings: ResolvedMapping[] = [
    { host: launchPath, guest: GUEST.launch, readOnly: true },
    ...(o.dataMappings ?? [dataMapping({ dataPath, guest: GUEST.data })]),
    ...(inRoot
      ? []
      : [{ host: view ? view.options.view : workspaceHost, guest: config.guestWorkspace, readOnly: config.readOnly }]),
    ...(view?.hostGit
      ? [{ host: view.hostGit, guest: guestGitDir(config.guestWorkspace), readOnly: config.readOnly }]
      : []),
  ];
  // Project roots and other projects, so they can join the running sandbox without a restart (launch/boot-projects.ts).
  const projects: ResolvedMapping[] = [];
  for (const m of [...boot.roots, ...boot.projects]) {
    assertGuestPath(m.guest, 'project folder for ' + m.host);
    projects.push({ host: m.host, guest: m.guest, readOnly: false });
  }
  const taken = [
    { guest: config.guestWorkspace, what: 'the project' },
    ...(view?.hostGit ? [{ guest: guestGitDir(config.guestWorkspace), what: "the project's .git" }] : []),
    { guest: PROJECTS_GUEST, what: 'the other projects' },
    ...projects.map((p) => ({ guest: p.guest, what: p.host })),
  ];
  const outside = new Set((o.run.outsideMappings ?? []).map((h) => path.resolve(h).toLowerCase()));
  const problems: string[] = [];
  const missing: string[] = [];
  const extra: ResolvedMapping[] = [];
  for (const m of config.mappings) {
    const host = m.host;
    if (!dirExists(host)) {
      if (m.optional) missing.push(host);
      else
        problems.push(
          host + ': the folder does not exist. Fix: create it, correct the path, or mark the mapping "optional": true.',
        );
      continue;
    }
    try {
      assertSafeMapping(host, o.packageRoot, o.run.storageRoot);
    } catch (e) {
      problems.push(errMsg(e) + (e instanceof UserError && e.fix ? ' Fix: ' + e.fix : ''));
      continue;
    }
    // A folder inside the project with no guest path of its own is already there (unless the filtered view hides it).
    if (!m.guest && !view && isInsideOrEqual(workspaceHost, host)) {
      notes.push(
        host +
          ' is inside the project, so it is already in the sandbox at ' +
          deriveGuest(host, workspaceHost, config.guestWorkspace) +
          '.',
      );
      continue;
    }
    // A second mapping of (part of) the project would show it without the filter (the git-ignored .env files) and
    // writable when the project is read-only: a repo's .sandbox-config.json must not undo either.
    const inProject = insideProject(workspaceHost, host);
    if (inProject && view) {
      problems.push(
        host +
          ': it is inside the project, and workspaceFilter.enabled keeps git-ignored files out of the sandbox. Fix: remove the mapping, or turn the filter off in your own settings.',
      );
      continue;
    }
    const readOnly = m.readOnly || (inProject && config.readOnly);
    const wanted = tidyGuestPath(m.guest ?? deriveGuest(host, workspaceHost, config.guestWorkspace));
    // The same folder at the same place twice (your settings and the project file): once is enough.
    if (
      extra.some((x) => x.host.toLowerCase() === host.toLowerCase() && x.guest.toLowerCase() === wanted.toLowerCase())
    )
      continue;
    const conflict = guestConflict(wanted, [...taken, ...extra.map((x) => ({ guest: x.guest, what: x.host }))]);
    if (conflict) {
      problems.push(host + ': ' + conflict + '. Fix: ' + guestFix(m.guest));
      continue;
    }
    const label = outside.has(path.resolve(host).toLowerCase()) ? 'outside the project, allowed' : undefined;
    extra.push({ host, guest: wanted, readOnly, ...(label ? { label } : {}) });
  }
  if (problems.length)
    fail(
      (problems.length === 1
        ? 'A mapped folder cannot be used:\n  '
        : problems.length + ' mapped folders cannot be used:\n  ') + problems.join('\n  '),
    );
  if (missing.length)
    notes.push(
      'Skipped ' +
        (missing.length === 1 ? 'an optional folder' : missing.length + ' optional folders') +
        ' not on this PC: ' +
        missing.join(', '),
    );
  mappings.push(...extra, ...projects);
  const { probe } = o;
  if (probe.nodeDir) mappings.push({ host: probe.nodeDir, guest: GUEST.hostTools + '\\node', readOnly: true });
  if (probe.harnessExe && harnessName !== 'none')
    mappings.push({ host: probe.harnessExe.dir, guest: GUEST.hostTools + '\\agents\\' + harnessName, readOnly: true });
  if (probe.gitDir) mappings.push({ host: probe.gitDir, guest: GUEST.hostTools + '\\git', readOnly: true });
  if (probe.nvmDir) mappings.push({ host: probe.nvmDir, guest: GUEST.hostTools + '\\nvm', readOnly: true });
  // Placement keeps extra folders apart; this guards the rest (and where the folders really are: F:\x is
  // C:\Mirror\F\x).
  assertNoGuestOverlap(mappings);
  assertNoGuestOverlap(mappings.map((m) => ({ guest: sandboxFolder(m.guest) })));
  return mappings;
}

/** The schema checks this already; the host re-checks what goes into the .wsb and the subst list anyway. */
function assertGuestPath(guest: string, what: string): void {
  if (!isValidGuestPath(guest))
    fail(
      what + ' is not a usable sandbox folder: ' + guest,
      'Use a folder under C:\\ (not Windows, Program Files, Users, AgentData, Mirror, ...) or on drive D: to Z:, e.g. C:\\Assets or F:\\SteamLibrary\\steamapps\\common\\Game.',
    );
}

// The projects feature's work: your project list, roots and the all-projects setting, through ProjectsService. Talks
// only through io. Changes what is mapped from the next start; a running sandbox keeps what it has.
import path from 'node:path';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { fail } from '../../../core/util/index.js';
import { hereDir } from '../../../cli/commands/projects/here.js';
import { ProjectsService } from '../../../cli/services/index.js';
import { implement, type AppContext } from '../../context.js';
import { cancelled, type OperationIO } from '../../kernel/index.js';
import {
  addProject,
  allProjects,
  chooseProjects,
  excludeProject,
  includeProject,
  listProjects,
  projectRoots,
  removeProject,
} from './projects.def.js';

const NEXT_START = 'This changes what is mapped from the next start.';

function runningNote(): string {
  return isSandboxRunning()
    ? ' The running sandbox keeps what it has; start a project in it (sandbox claude there) and it joins without a restart when it can, or you are offered one.'
    : '';
}

/** The folder given, or one picked from the known projects (or this folder) when it was left out. */
async function pickFolder(ctx: AppContext, io: OperationIO, given: string | undefined): Promise<string> {
  if (given) return path.resolve(given);
  const here = hereDir(ctx);
  const chosen = await io.choose({
    title: 'Which folder?',
    choices: [
      { value: here, label: 'This folder (' + here + ')' },
      ...new ProjectsService(ctx)
        .rows()
        .filter((r) => !r.here)
        .map((r) => ({ value: r.folder, label: r.folder })),
    ],
  });
  if (chosen === undefined) cancelled();
  return chosen;
}

export const listProjectsRun = implement(listProjects, async (ctx) => new ProjectsService(ctx).list());

export const chooseProjectsRun = implement(chooseProjects, async (ctx, _input, io) => {
  const service = new ProjectsService(ctx);
  const rows = service.rows().filter((r) => !r.root);
  if (!rows.length)
    return {
      message:
        'No projects to choose from yet (projects in a root are always mapped with it). Start one with sandbox claude in its folder.',
    };
  const all = service.settings().all;
  const picked = await io.checklist({
    title: 'Projects mapped at every start, so they open without a restart (every agent in the sandbox can see them):',
    choices: rows.map((r) => ({ value: r.folder, label: r.folder + (r.here ? '  (this folder)' : '') })),
    checked: rows.filter((r) => all && !r.excluded).map((r) => r.folder),
  });
  if (picked === undefined) cancelled();
  const { mapped, excluded } = service.choose(rows, picked);
  return {
    message: mapped + ' project(s) mapped at every start, ' + excluded + ' excluded. ' + NEXT_START + runningNote(),
  };
});

export const addProjectRun = implement(addProject, async (ctx, input, io) => {
  const folder = await pickFolder(ctx, io, input.projectFolder);
  const service = new ProjectsService(ctx);
  const dir = service.add(folder);
  const all = service.settings().all;
  return {
    message: 'Added ' + dir + ' to your projects.' + (all ? ' ' + NEXT_START : ''),
    ...(all ? {} : { next: 'Next: sandbox projects all on   (map every project at every start)' }),
  };
});

export const removeProjectRun = implement(removeProject, async (ctx, input, io) => {
  const dir = await pickFolder(ctx, io, input.projectFolder);
  const yes = await io.confirm({
    title: 'Forget ' + path.basename(dir) + '?',
    lines: ['The project is dropped from your list of projects.', 'Nothing in ' + dir + ' is touched.'],
    yes: 'Forget',
    danger: true,
    implied: true,
  });
  if (!yes) cancelled();
  const { dir: forgotten, removed } = new ProjectsService(ctx).forget(dir);
  return {
    message: removed
      ? 'Removed ' + forgotten + ' from your projects (nothing in the folder was touched).'
      : forgotten + ' was not in your projects.',
  };
});

export const includeProjectRun = implement(includeProject, async (ctx, input, io) => {
  const dir = await pickFolder(ctx, io, input.projectFolder);
  const service = new ProjectsService(ctx);
  const changed = service.include(dir);
  return { message: includeOrExcludeText(service, 'include', dir, changed) };
});

export const excludeProjectRun = implement(excludeProject, async (ctx, input, io) => {
  const dir = await pickFolder(ctx, io, input.projectFolder);
  const service = new ProjectsService(ctx);
  const changed = service.exclude(dir);
  return { message: includeOrExcludeText(service, 'exclude', dir, changed) };
});

/** The sentence include and exclude print. */
function includeOrExcludeText(
  service: ProjectsService,
  action: 'include' | 'exclude',
  dir: string,
  changed: boolean,
): string {
  return (
    (changed
      ? (action === 'exclude' ? 'Excluded ' : 'Included ') + path.resolve(dir) + '. ' + NEXT_START
      : 'Nothing changed.') +
    (action === 'include' && !service.settings().all
      ? ' Mapping all projects is off: sandbox projects all on maps your projects at every start.'
      : '') +
    (changed ? runningNote() : '')
  );
}

export const allProjectsRun = implement(allProjects, async (ctx, input) => {
  const service = new ProjectsService(ctx);
  if (input.state === undefined)
    return { message: 'Mapping all projects at every start is ' + (service.settings().all ? 'on' : 'off') + '.' };
  service.setAll(input.state === 'on');
  return {
    message:
      'Mapping all projects at every start is ' +
      input.state +
      '. ' +
      NEXT_START +
      (input.state === 'on' ? ' Every agent in the sandbox can then see all of those projects.' : '') +
      runningNote(),
  };
});

export const projectRootsRun = implement(projectRoots, async (ctx, input, io) => {
  const service = new ProjectsService(ctx);
  if (input.change === 'list') {
    const list = service.settings().roots;
    return {
      message: list.length ? list.join('\n') : 'No project roots. Add one: sandbox projects roots add <folder>',
    };
  }
  if (!input.rootFolder) fail('Which folder?', 'Usage: sandbox projects roots ' + input.change + ' <folder>');
  if (input.change === 'add') {
    const { dir, added } = service.addRoot(input.rootFolder);
    return {
      message: added
        ? 'Added the project root ' +
          dir +
          ': every project in it (also new ones) opens without a restart. Every agent in the sandbox can see all of them. ' +
          NEXT_START +
          runningNote()
        : dir + ' is a root already.',
    };
  }
  const dir = path.resolve(input.rootFolder);
  const yes = await io.confirm({
    title: 'Remove the root ' + path.basename(dir) + '?',
    lines: ['Its projects are no longer opened without a restart.', 'Nothing in ' + dir + ' is touched.'],
    yes: 'Remove',
    danger: true,
    implied: true,
  });
  if (!yes) cancelled();
  const { removed } = service.removeRoot(dir);
  return { message: removed ? 'Removed the project root ' + dir + '. ' + NEXT_START : dir + ' was not a root.' };
});

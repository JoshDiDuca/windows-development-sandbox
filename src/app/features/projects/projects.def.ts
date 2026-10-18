// The projects a sandbox can open without a restart: the list, roots, include/exclude, the all-projects setting, and
// choosing the ticked ones. Pure: schemas, labels and the view; projects.run.ts does the work.
import { z } from 'zod';
import {
  action,
  defineOperation,
  defineQuery,
  defineView,
  fieldsOf,
  type Field,
  type Item,
  type Page,
  type Section,
} from '../../kernel/index.js';

export const ProjectRowSchema = z.object({
  folder: z.string().describe('The project folder on this PC'),
  here: z.boolean().describe('The folder you are in is inside it'),
  known: z.boolean().describe('Started with this tool before'),
  root: z.string().nullable().describe('The project root it is in, if any'),
  excluded: z.boolean().describe('Excluded from the projects mapped at every start'),
  mappedAtStart: z.boolean().describe('Mapped at every start'),
  running: z.string().nullable().describe('Its name and how it got into the running sandbox, if it is there'),
});
export type ProjectRow = z.output<typeof ProjectRowSchema>;

export const ProjectsListSchema = z.object({
  all: z.boolean().describe('Every project is mapped at every start (except excluded ones)'),
  roots: z.array(z.string()).describe('Folders of projects, each opened without a restart'),
  exclude: z.array(z.string()).describe('Folders left out of the projects mapped at every start'),
  projects: z.array(ProjectRowSchema).describe('Every project worth listing'),
});
export type ProjectsList = z.output<typeof ProjectsListSchema>;

const Message = z.object({ message: z.string().describe('What happened') });
const FolderText = (what: string) =>
  z
    .string()
    .optional()
    .describe(what + ' (. = this folder; asked when left out)');

export const listProjects = defineQuery({
  id: 'projects.list',
  title: 'Projects',
  summary: 'list your projects, roots and the all-projects setting',
  input: z.object({}),
  output: ProjectsListSchema,
  cli: { name: 'projects', action: 'list', json: true },
});

export const chooseProjects = defineOperation({
  id: 'projects.choose',
  title: 'Choose the projects mapped at every start…',
  summary: 'tick the projects mapped at every start; the rest are excluded',
  input: z.object({}),
  output: Message,
  text: (o) => o.message,
  cli: { name: 'projects', action: 'choose' },
});

export const addProject = defineOperation({
  id: 'projects.add',
  title: 'Add a project…',
  summary: 'remember a project folder',
  input: z.object({ projectFolder: FolderText('The project folder') }),
  output: z.object({
    message: z.string().describe('What happened'),
    next: z.string().optional().describe('What to do next, when mapping all projects is off'),
  }),
  text: (o) => (o.next ? o.message + '\n' + o.next : o.message),
  cli: { name: 'projects', action: 'add', positional: ['projectFolder'] },
});

export const removeProject = defineOperation({
  id: 'projects.remove',
  title: 'Forget project',
  summary: 'forget a project (nothing in the folder is touched)',
  input: z.object({ projectFolder: FolderText('The project folder') }),
  output: Message,
  danger: true,
  text: (o) => o.message,
  cli: { name: 'projects', action: 'remove', positional: ['projectFolder'] },
});

export const includeProject = defineOperation({
  id: 'projects.include',
  title: 'Include',
  summary: 'map a project at every start again',
  input: z.object({ projectFolder: FolderText('The project folder') }),
  output: Message,
  text: (o) => o.message,
  cli: { name: 'projects', action: 'include', positional: ['projectFolder'] },
});

export const excludeProject = defineOperation({
  id: 'projects.exclude',
  title: 'Exclude',
  summary: 'leave a project out of the projects mapped at every start',
  input: z.object({ projectFolder: FolderText('The project folder') }),
  output: Message,
  text: (o) => o.message,
  cli: { name: 'projects', action: 'exclude', positional: ['projectFolder'] },
});

export const allProjects = defineOperation({
  id: 'projects.all',
  title: 'Map all projects at every start',
  summary: 'map every project at every start, or not',
  input: z.object({ state: z.enum(['on', 'off']).optional().describe('on or off (left out: say which it is)') }),
  output: Message,
  text: (o) => o.message,
  cli: { name: 'projects', action: 'all', positional: ['state'] },
});

export const projectRoots = defineOperation({
  id: 'projects.roots',
  title: 'Project roots',
  summary: 'list, add or remove project roots',
  input: z.object({
    change: z.enum(['list', 'add', 'remove']).default('list').describe('list, add or remove'),
    rootFolder: z.string().optional().describe('(add, remove) the folder that holds your projects'),
  }),
  output: Message,
  text: (o) => o.message,
  cli: { name: 'projects', action: 'roots', positional: ['change', 'rootFolder'] },
});

/** The folder fields: their names end in Folder, so the menu and the web give them the folder picker. */
const rootField: Field = fieldsOf(projectRoots.input).find((f) => f.name === 'rootFolder')!;
const projectField: Field = fieldsOf(addProject.input).find((f) => f.name === 'projectFolder')!;

const ROOT_DESCRIPTION = 'Every project in this folder (also new ones) opens without a restart.';

function atStart(p: ProjectRow): string {
  return p.root ? 'root' : p.excluded ? 'excluded' : p.mappedAtStart ? 'mapped' : '-';
}

function projectItem(p: ProjectRow): Item {
  return {
    id: 'project:' + p.folder,
    label: p.folder,
    marked: p.here,
    icon: 'project',
    hint: p.running ?? (p.root ? 'in a root' : p.excluded ? 'excluded' : p.mappedAtStart ? 'mapped' : '-'),
    description: p.here ? 'This is the folder you started the menu in.' : undefined,
    details: ['At start: ' + atStart(p), 'In the sandbox: ' + (p.running ?? 'not open')],
    cells: { here: p.here ? '*' : '', folder: p.folder, atStart: atStart(p), running: p.running ?? '-' },
    actions: [
      action(removeProject, { projectFolder: p.folder }, { key: 'f', verb: 'forget project', importance: 1 }),
      p.excluded
        ? action(includeProject, { projectFolder: p.folder })
        : action(excludeProject, { projectFolder: p.folder }),
    ],
  };
}

function rootItem(r: string): Item {
  return {
    id: 'root:' + r,
    label: r,
    hint: 'root',
    icon: 'folder',
    description: ROOT_DESCRIPTION,
    keys: 'f removes the root.',
    actions: [
      action(
        projectRoots,
        { change: 'remove', rootFolder: r },
        { label: 'Remove the root', key: 'f', verb: 'remove root', importance: 1 },
      ),
    ],
  };
}

/** The projects page: the settings, the project roots, and the projects (the same rows as the menu's Projects). */
export function projectsPage(o: ProjectsList): Page {
  const settings: Section = {
    id: 'settings',
    facts: [
      {
        id: 'all',
        label: 'All projects',
        value: o.all ? 'on (every project below is mapped at every start, except excluded ones)' : 'off',
      },
      {
        id: 'roots',
        label: 'Roots',
        value: o.roots.length ? o.roots.join(', ') : 'none (sandbox projects roots add <folder>)',
      },
    ],
    actions: [
      action(
        allProjects,
        { state: o.all ? 'off' : 'on' },
        { label: o.all ? 'Stop mapping all projects' : 'Map all projects at every start' },
      ),
    ],
    notes: [{ text: 'sandbox projects all on|off', tone: 'muted', only: 'cli' }],
  };
  const roots: Section = {
    id: 'roots',
    title: 'Project roots',
    items: [
      {
        id: '@add-root',
        label: '+ Add a project root…',
        description:
          'Pick a folder that holds your projects: every project in it (also new ones) opens without a restart.',
        primary: action(
          projectRoots,
          { change: 'add' },
          { label: 'Choose the folder…', verb: 'choose folder', fields: [rootField] },
        ),
      },
      ...o.roots.map(rootItem),
    ],
  };
  const projects: Section = {
    id: 'projects',
    title: 'Projects',
    columns: [
      { key: 'here', label: '' },
      { key: 'folder', label: 'FOLDER' },
      { key: 'atStart', label: 'AT START' },
      { key: 'running', label: 'RUNNING SANDBOX' },
    ],
    // The web lists the rows in full (its table cannot carry the row actions: forget, include, exclude).
    columnsOn: 'cli',
    items: o.projects.map(projectItem),
    notes:
      o.projects.length === 0
        ? [{ text: 'No projects yet: start one with sandbox claude in its folder.', tone: 'muted' }]
        : [{ text: '* = this folder.  Choose with: sandbox projects choose', tone: 'muted', only: 'cli' }],
  };
  return {
    title: 'Projects',
    sections: [settings, roots, projects],
    actions: [
      action(chooseProjects, {}, { label: 'Choose…' }),
      action(addProject, {}, { fields: [projectField] }),
      action(
        projectRoots,
        { change: 'add' },
        { label: 'Add a project root…', key: 'a', verb: 'add root', importance: 1, fields: [rootField] },
      ),
    ],
  };
}

export const projectsView = defineView({
  id: 'projects',
  title: 'Projects',
  summary: 'The projects a sandbox opens without a restart: roots, your projects, all or chosen.',
  queries: { projects: listProjects },
  operations: [chooseProjects, addProject, removeProject, includeProject, excludeProject, allProjects, projectRoots],
  build: ({ projects }) => projectsPage(projects),
});

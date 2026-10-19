// Apps installed in the sandbox: entries from the catalogue (shared/apps.ts) and programs of your own.
import { z } from 'zod';
import { APPS } from '../../shared/apps/index.js';

const CATALOGUE_IDS = APPS.filter((a) => !a.setting).map((a) => a.id) as [string, ...string[]];
export const AppIdSchema = z.enum(CATALOGUE_IDS);
/** The apps a project's .sandbox-config.json may add: not the add-ons that are yours only (they change what the agents run or send). */
const PROJECT_IDS = APPS.filter((a) => !a.setting && !a.userOnly).map((a) => a.id) as [string, ...string[]];
export const ProjectAppIdSchema = z.enum(PROJECT_IDS);
export const CustomAppIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, 'lower-case letters, digits and - only');

const compiles = (pattern: string): boolean => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

export const CustomAppSchema = z
  .strictObject({
    name: z.string().min(1).max(80).describe('The name on the desktop shortcut, e.g. "My Tool".'),
    github: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, 'owner/repo, e.g. sharkdp/bat')
      .optional()
      .describe('GitHub repository (owner/repo): the file comes from its latest release.'),
    asset: z
      .string()
      .max(200)
      .refine(compiles, 'not a valid pattern')
      .optional()
      .describe('With github: a pattern (regular expression) matching the release file, e.g. windows.*x64\\.zip$'),
    url: z
      .string()
      .url()
      .startsWith('https://', 'https:// only')
      .optional()
      .describe('Or a direct https:// download link (zip, 7z, exe or msi).'),
    sha256: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, '64 hex characters')
      .optional()
      .describe('SHA-256 of the download (GitHub releases usually publish one; then this is not needed).'),
    unpack: z
      .enum(['archive', 'file', 'nsis', 'msi'])
      .optional()
      .describe(
        'archive (zip, 7z, tar: the default), file (a single .exe), nsis (an installer 7-Zip can open) or msi.',
      ),
    exe: z.string().min(1).max(200).describe('The program to start (found anywhere in the download), e.g. mytool.exe.'),
    cli: z
      .boolean()
      .optional()
      .describe('A command-line tool: its folder goes on PATH instead of getting a desktop shortcut.'),
  })
  .refine((a) => (a.github && a.asset ? !a.url : Boolean(a.url) && !a.github && !a.asset), {
    message: 'give github + asset, or url (not both)',
  });

/** What a project file may say about apps: catalogue apps it adds to yours (no add-ons that are yours only). */
export const ProjectAppsSchema = z.strictObject({
  install: z
    .array(ProjectAppIdSchema)
    .describe(
      'Apps from the catalogue this project adds to yours (agent add-ons such as rtk, Headroom and the MCP servers are set in your own settings only).',
    ),
});

export const AppsSchema = z.strictObject({
  install: z
    .array(AppIdSchema)
    .describe(
      'Apps from the catalogue to install in every sandbox (the Apps screen in the menu lists them by category). Each is downloaded once and kept.',
    ),
  custom: z
    .record(CustomAppIdSchema, CustomAppSchema)
    .describe(
      'Programs of your own: a GitHub release or a download link, and the program to start. Installed like the catalogue apps.',
    ),
});

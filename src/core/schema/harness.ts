// An agent (claude, codex, ...) the sandbox can run.
import { z } from 'zod';
import { secret, StringsSchema } from './common.js';

/** A folder below the agent's state folder: plain names only, no drive, no "..". */
const SubfolderSchema = z
  .string()
  .regex(/^(?!.*(^|[\\/])\.\.([\\/]|$))[A-Za-z0-9._ -]+([\\/][A-Za-z0-9._ -]+)*$/, 'a plain relative folder');

/** Where an agent keeps its login and settings inside the sandbox, so logins can be saved and switched. */
export const HarnessHomeSchema = z.strictObject({
  env: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), SubfolderSchema)
    .describe('Environment variable -> folder (below the sandbox state folder) the agent keeps its data in.'),
  profileDirs: z
    .array(SubfolderSchema.refine((d) => !d.split(/[\\/]/).includes('.'), 'a plain relative folder'))
    .max(8)
    .optional()
    .describe(
      "Folders below the sandbox's user profile (e.g. .qwen, .config/opencode) the agent keeps its data in: each becomes a link to state\\<agent>\\profile\\<folder>, so it survives between sandboxes.",
    ),
  loginFiles: z
    .array(SubfolderSchema)
    .describe("Files that make up the login, relative to the agent's own state folder (state\\<agent>)."),
  hostDir: z
    .string()
    .optional()
    .describe(
      "The agent's own folder on this PC (e.g. ~/.codex): loginFiles are read from it to save this PC's login.",
    ),
  hostFiles: z
    .record(SubfolderSchema, SubfolderSchema)
    .optional()
    .describe(
      'For an agent whose login sits at another place on this PC than in the sandbox: loginFile -> its path below hostDir on this PC (e.g. profile/.local/share/opencode/auth.json -> .local/share/opencode/auth.json with hostDir ~). Login files not listed are read at the same relative path.',
    ),
  providersFile: SubfolderSchema.optional().describe(
    'A login file that is a JSON object keyed by provider id (opencode: auth.json): the accounts list shows those ids (never the values).',
  ),
  copyPcLogin: z
    .boolean()
    .optional()
    .describe(
      "Copy this PC's login for the agent into the sandbox at every launch (instead of a saved login). Needs hostDir. Only your own settings can turn it on, never a project file.",
    ),
});

export const HarnessSchema = z
  .strictObject({
    hostExecutable: z
      .string()
      .optional()
      .describe('Executable copied from this PC when installed here (e.g. claude.exe).'),
    hostDir: z
      .string()
      .optional()
      .describe('Folder of hostExecutable on this PC, or "auto" to search PATH and ~/.local/bin.'),
    npmPackage: z.string().optional().describe('npm package installed inside the sandbox when there is no host copy.'),
    npmBin: z.string().optional().describe('Command the npm package provides.'),
    uvPackage: z
      .string()
      .optional()
      .describe('Python package installed with `uv tool install` inside the sandbox (e.g. aider-chat).'),
    uvBin: z.string().optional().describe('Command the uv package provides.'),
    arguments: StringsSchema.describe('Arguments always passed to the agent.'),
    environment: z
      .record(z.string(), secret(z.string()))
      .describe(
        'Environment variables for the agent (API keys go here). Their values are shown as *** and are handed to the sandbox in a one-shot file, never kept in the launch folder. The agent can read its own environment.',
      ),
    home: HarnessHomeSchema.optional().describe(
      'Where its login lives inside the sandbox; leave out when the agent cannot be pointed at a folder (then its login is not kept between sandboxes).',
    ),
    localState: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), SubfolderSchema)
      .optional()
      .describe(
        "Environment variable -> folder below the agent's own state folder (state\\<agent>) for SQLite databases. SQLite cannot run in a mapped folder, so the agent runs from a copy on the sandbox's disk (the variable points to it) that is copied from and back to that folder.",
      ),
    bootReset: z
      .array(SubfolderSchema)
      .max(32)
      .optional()
      .describe(
        "Files and folders below the agent's own state folder (state\\<agent>) that only work on the machine that wrote them (keys sealed with Windows DPAPI, local accounts it created). Every sandbox is a new machine, so they are deleted at each boot and the agent sets them up again.",
      ),
    resumeArguments: StringsSchema.optional().describe(
      'Arguments used when the agent is restarted in place (e.g. after an account switch) so it resumes the conversation.',
    ),
    resumeOneArguments: StringsSchema.optional().describe(
      'Arguments that reopen one conversation, with {id} where its id goes (claude: --resume {id}). Used instead of resumeArguments when the conversation of a session is known.',
    ),
  })
  .refine(
    (h) => !h.resumeOneArguments || h.resumeOneArguments.some((a) => a.includes('{id}')),
    'needs {id} in resumeOneArguments',
  )
  .refine((h) => h.hostExecutable || h.npmPackage || h.uvPackage, 'needs hostExecutable, npmPackage or uvPackage')
  .refine((h) => !h.uvPackage || h.uvBin, 'needs uvBin when uvPackage is set')
  .refine((h) => !h.npmPackage || h.npmBin, 'needs npmBin when npmPackage is set');

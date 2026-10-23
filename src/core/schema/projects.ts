// Several projects in one running sandbox. User config only: these settings map folders of this PC into the sandbox,
// so a project's .sandbox-config.json can never set them (LocalOverrides has no `projects`).
import { z } from 'zod';

export const ProjectsSchema = z.strictObject({
  all: z
    .boolean()
    .describe(
      'Map every project you have started before (and every folder in your roots) at every start, except those in exclude, so all of them open in the running sandbox without a restart. Every agent in the sandbox can then see all of them. Each one is still only set up when you first use it.',
    ),
  exclude: z.array(z.string().min(1)).describe('Projects left out when "all" is on (folders on this PC).'),
  roots: z
    .array(z.string().min(1))
    .describe(
      'Folders whose subfolders are your projects (e.g. "F:\\\\Code"), mapped read/write at every start. Any project inside one, including ones you create later, opens in the running sandbox at once, without a restart. Every agent in the sandbox can see all of them.',
    ),
  askToAddRoot: z
    .boolean()
    .describe('When you start a project whose parent folder is not a root yet, ask once whether to add it.'),
  declinedRoots: z.array(z.string().min(1)).describe('Parent folders you said no to (not asked again).'),
  allowOutsideMappings: z
    .union([z.literal('ask'), z.boolean()])
    .describe(
      'A project\'s .sandbox-config.json may map folders from outside the project (e.g. a game folder on another drive). "ask" = an interactive launch asks once per project and set of folders, and remembers your answer; true = always allowed (still listed when you approve the file); false = never (the launch stops and says which folders). Only your own settings decide this, never a project file.',
    ),
  wsbShare: z
    .boolean()
    .describe(
      'On Windows 11 24H2+ with the Windows Sandbox command line (wsb), add other folders to the running sandbox with `wsb share` (untested). Otherwise starting a project outside every root offers a restart.',
    ),
  liveFolders: z
    .enum(['off', 'hcs'])
    .describe(
      'ALPHA, UNTESTED ON A REAL PC: "hcs" adds a project folder to the running sandbox through the Host Compute Service where `wsb share` is missing (one administrator prompt per add or remove; always read-only in this alpha). If it fails, the sandbox may close: save your work first. Turn it on before the sandbox starts. "off" (default) offers a restart instead. The real-PC tests still to pass are in docs/design/hcs-live-folders.md ("Test plan").',
    ),
});

// Reopening the sessions of the last sandbox. User config only: it starts sandboxes on this PC, so a project's
// .sandbox-config.json can never set it (LocalOverrides has no `resume`).
import { z } from 'zod';

export const RESUME_SESSIONS = ['ask', 'always', 'afterCrash', 'never'] as const;

export const ResumeSchema = z.strictObject({
  sessions: z
    .enum(RESUME_SESSIONS)
    .describe(
      'When a sandbox starts after one that had agent sessions: "ask" lists them and asks whether to reopen them (without a terminal it only says they can be reopened), "always" reopens them, "afterCrash" reopens them only when the last sandbox ended unexpectedly, "never" leaves it to you (Sessions reopens them). Terminal tabs you opened yourself in the sandbox are never reopened.',
    ),
  restartAfterCrash: z
    .boolean()
    .describe(
      'When the sandbox ends because Windows Sandbox crashed or ran out of memory, start it again by itself and reopen its sessions (at most 3 times in 6 hours).',
    ),
});

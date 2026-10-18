// The GitHub setting (the token itself is not a setting: it is kept encrypted by `sandbox github login`).
import { z } from 'zod';

export const GithubSchema = z.strictObject({
  shareToken: z
    .boolean()
    .describe(
      'Give each sandbox the GitHub token you saved with `sandbox github login` (best a fine-grained token limited to some repositories and permissions), so gh and https git work there without logging in. Only with provisioning.git.access "full". The agent in the sandbox can read the token and use it for whatever it allows. A project file (.sandbox-config.json) cannot turn this on.',
    ),
});

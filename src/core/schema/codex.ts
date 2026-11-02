// How Codex runs inside the sandbox. Yours only: a project file (.sandbox-config.json) cannot change it.
import { z } from 'zod';

export const CodexSchema = z.strictObject({
  sandboxMode: z
    .enum(['danger-full-access', 'workspace-write', 'read-only'])
    .describe(
      "Codex's own sandbox. Inside Windows Sandbox Codex's own sandbox only slows it down (it re-grants file permissions over your profile at every boot), so the default is danger-full-access: Windows Sandbox is the sandbox.",
    ),
  approvalPolicy: z
    .enum(['never', 'on-request', 'on-failure', 'untrusted'])
    .describe('When Codex asks before it runs a command. "never" with danger-full-access starts it with no questions.'),
  model: z
    .string()
    .max(100)
    .regex(/^[A-Za-z0-9._:/-]*$/, 'letters, digits and . _ : / - only')
    .describe("The model Codex uses. Empty = Codex's own default."),
  reasoningEffort: z
    .enum(['default', 'minimal', 'low', 'medium', 'high', 'xhigh'])
    .describe('How hard Codex thinks. "default" = Codex\'s own default.'),
  windowsSandbox: z
    .enum(['off', 'unelevated', 'elevated'])
    .describe(
      'Codex\'s Windows sandbox mode in its config.toml. "off" removes the setting so Codex does not set up its sandbox users and firewall rules at every boot.',
    ),
  mcpLoginsInFile: z
    .boolean()
    .describe(
      'Keep the sign-ins of Codex\'s MCP servers in a file in the saved Codex folder (mcp_oauth_credentials_store = "file"), so they survive between sandboxes. A value you set in config.toml is kept.',
    ),
});

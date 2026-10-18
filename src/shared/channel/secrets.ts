// What the host hands the sandbox that must not sit in session.json or in anything in the launch folder (which is
// mapped read-only into the sandbox and kept for days): one file per launch or request in <data>\secrets\<id>.json,
// which the sandbox reads and deletes at once. The folder is next to run\ (not in it): other users of a shared
// sandbox may change run\, never this folder. The agent in the sandbox can still read what it was given (its own
// environment, its login): that is inherent. Every part is optional.
import { z } from 'zod';
import { GithubTokenSchema } from '../github/index.js';

const Environment = z.record(z.string().max(256), z.string().max(65536));

export const SecretsFileSchema = z.strictObject({
  /** The agent the sandbox booted with: its harness environment. */
  harnessEnvironment: Environment.optional(),
  /** harnessSpec of a session request (an agent the sandbox did not boot with). */
  harnessSpecEnvironment: Environment.optional(),
  /** project.harnesses of a request, by agent name. */
  projectHarnessEnvironment: z.record(z.string().max(64), Environment).optional(),
  /** The login of this PC's Claude (claudeProfile.copyCredentials): the text of .credentials.json. */
  claudeCredentials: z
    .string()
    .max(1024 * 1024)
    .optional(),
  /** VPN service credentials (vpn.provider's login), only for the launch's own sandbox. */
  vpn: z.strictObject({ username: z.string().min(1).max(256), password: z.string().min(1).max(1024) }).optional(),
  /** The checked WireGuard config of vpn.provider wireguard-file (holds the private key). */
  wireguardConfig: z
    .string()
    .min(1)
    .max(32 * 1024)
    .optional(),
  /** The GitHub token you saved for sandboxes (github.shareToken), only with git access "full". */
  githubToken: GithubTokenSchema.optional(),
});

export type SecretsFile = z.output<typeof SecretsFileSchema>;

/** The environment a harness gets: its own, then the values that travelled in the secrets file. */
const withEnvironment = <H extends { environment: Record<string, string> }>(
  harness: H,
  environment: Record<string, string> | undefined,
): H => (environment ? { ...harness, environment: { ...harness.environment, ...environment } } : harness);

interface WithHarnesses {
  readonly harnessSpec?: { environment: Record<string, string> };
  readonly project?: { harnesses: Record<string, { environment: Record<string, string> }> };
}

/**
 * A session or project request with the agent environment values from its secrets file put back (the reverse of
 * host/secrets withoutSecrets). In memory only: the sandbox never writes them out again.
 */
export function mergeRequestSecrets<R extends WithHarnesses>(request: R, secrets: SecretsFile): R {
  let merged = request;
  if (request.harnessSpec && secrets.harnessSpecEnvironment)
    merged = { ...merged, harnessSpec: withEnvironment(request.harnessSpec, secrets.harnessSpecEnvironment) };
  if (request.project && secrets.projectHarnessEnvironment) {
    const given = secrets.projectHarnessEnvironment;
    merged = {
      ...merged,
      project: {
        ...request.project,
        harnesses: Object.fromEntries(
          Object.entries(request.project.harnesses).map(([name, h]) => [name, withEnvironment(h, given[name])]),
        ),
      },
    };
  }
  return merged;
}

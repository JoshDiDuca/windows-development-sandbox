// The one shape of an Anthropic API key, for the host and the web (no node imports). A key from the Claude Console
// starts with sk-ant-api, a key from a user workspace with sk-ant-usr.
export const ANTHROPIC_KEY_PATTERN = /^sk-ant-(api|usr)\d{2}-[A-Za-z0-9_-]{20,400}$/;

/** The only part of a key ever shown: sk-ant-...abcd. */
export const ANTHROPIC_KEY_HINT = /^sk-ant-\.\.\.[A-Za-z0-9_-]{4}$/;

/** What is wrong with a typed or found API key, or null when it has the right shape. Never quotes the key. */
export function anthropicKeyProblem(key: string): string | null {
  if (ANTHROPIC_KEY_PATTERN.test(key)) return null;
  if (key.startsWith('sk-ant-oat'))
    return 'That is a Claude subscription token (from claude setup-token), not an API key. Save the subscription login instead.';
  if (key.startsWith('sk-ant-admin')) return 'That is an Admin key: it cannot run Claude. Make an API key instead.';
  return 'An Anthropic API key starts with sk-ant-api or sk-ant-usr and has only letters, digits, - and _ (copy it from the Claude Console).';
}

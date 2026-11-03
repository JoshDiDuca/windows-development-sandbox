// The shape of an Anthropic API key, for the host and the web (no node imports). Any key from the Claude Console is
// accepted, whatever its prefix (sk-ant-api03-..., skt-ant-usr-... and others): only text with spaces or other odd
// characters, or under 20 characters, is refused. Subscription tokens and Admin keys are refused by name.
export const ANTHROPIC_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{19,511}$/;

/** The only part of a key ever shown: its own prefix (sk-ant-, skt-ant-), then ..., then its last 4 characters. */
export const ANTHROPIC_KEY_HINT = /^([A-Za-z0-9]{1,8}-?[A-Za-z]*-?)?\.\.\.[A-Za-z0-9_.-]{4}$/;

/** What is wrong with a typed or found API key, or null when it has the right shape. Never quotes the key. */
export function anthropicKeyProblem(key: string): string | null {
  if (key.startsWith('sk-ant-oat'))
    return 'That is a Claude subscription token (from claude setup-token), not an API key. Save the subscription login instead.';
  if (key.startsWith('sk-ant-admin')) return 'That is an Admin key: it cannot run Claude. Make an API key instead.';
  if (ANTHROPIC_KEY_PATTERN.test(key)) return null;
  return 'That does not look like an API key: paste the whole key (letters, digits, - and _, no spaces).';
}

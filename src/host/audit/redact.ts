// Secrets never reach the audit log: a command line (or a commit message) is scrubbed before it is written. Values that
// are credentials whatever they are called (tokens, keys, passwords in URLs: secret-patterns.ts), and the value after
// a name that says it holds one (--password x, --token=x, API_KEY=x, -p<pw> for mysql, Authorization: ...), become ***.
// The text is already capped (2 KB), so these simple patterns stay cheap.
import { REDACTED } from '../../core/schema/index.js';
import { SECRET_VALUES, SECRET_WORDS } from '../profile/secret-patterns.js';

/** The value patterns, each finding every match; a match runs on to the end of its word (the rest of the secret). */
const VALUES: readonly RegExp[] = SECRET_VALUES.map(
  (r) => new RegExp('(?:' + r.source + ')[^\\s"\'`]*', r.flags.includes('g') ? r.flags : r.flags + 'g'),
);

/**
 * `--name value`, `--name=value`, `/name:value`, `NAME=value`, `$env:NAME = "value"`: the flag's dashes (a value after
 * a space only counts for a flag), the name, the separator, and the value (looked at, not taken: the next word may be
 * a name of its own).
 */
const NAMED =
  /(?<=^|[\s"'`;&|(])(?:\$env:)?(--?|\/)?([A-Za-z][\w.-]{1,63})(\s*[=:]\s*|\s+)(?=("[^"]*"|'[^']*'|[^\s"'`;&|)]+))/g;

/** Headers whose whole value is a credential. */
const HEADERS =
  /\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie|private-token)(\s*:\s*)[^"'\r\n]+/gi;

/** mysql -p<password> / -pPASSWORD (no space), and -u user:password for curl. */
const SHORT = /(\s-p)(?!\s)([^\s"'`]+)|(\s(?:-u|--user)\s+)([^\s:"'`]+):([^\s"'`]+)/g;

/** Does a name (a flag or a variable) say it holds a secret? */
function secretName(name: string): boolean {
  return SECRET_WORDS.test(name.toUpperCase().replace(/[-.]/g, '_'));
}

/** The values after names that say they hold a secret, as *** (see NAMED). */
function redactNamed(text: string): string {
  const cuts: [number, number][] = [];
  for (const m of text.matchAll(NAMED)) {
    const [whole, dashes, name, sep, value] = m;
    if (!secretName(name) || !(dashes || sep.trim()) || value === REDACTED || value.startsWith('-')) continue;
    const start = (m.index ?? 0) + whole.length;
    cuts.push([start, start + value.length]);
  }
  let out = '';
  let from = 0;
  for (const [start, end] of cuts) {
    if (start < from) continue;
    out += text.slice(from, start) + REDACTED;
    from = end;
  }
  return out + text.slice(from);
}

/** `text` with every credential in it replaced by ***. */
export function redactCommandLine(text: string): string {
  let out = text;
  for (const r of VALUES) out = out.replace(r, REDACTED);
  out = out.replace(HEADERS, (_m, name: string, sep: string) => name + sep + REDACTED);
  out = redactNamed(out);
  out = out.replace(SHORT, (m, p: string | undefined, _pw: string, u: string | undefined, user: string) =>
    p ? p + REDACTED : u ? u + user + ':' + REDACTED : m,
  );
  return out;
}

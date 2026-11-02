// The fingerprint of a sign-in: a SHA-256 of its canonical JSON (keys sorted), so the sandbox can tell a renewed one
// from the one it was given without keeping either around. Node only (not for the web bundle).
import crypto from 'node:crypto';

/** JSON with every object's keys sorted, so equal values always give equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value as Record<string, unknown>)
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}

export function fingerprint(payload: unknown): string {
  return crypto.createHash('sha256').update(canonical(payload)).digest('hex');
}

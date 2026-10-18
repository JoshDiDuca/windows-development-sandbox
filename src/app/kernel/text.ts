// Small text helpers every surface formats with the same way: times as "5 min ago", keys as readable labels, counts
// with the right noun. Pure (the browser bundle imports them too).

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function ago(then: number | string | Date, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - new Date(then).getTime()) / 1000));
  if (Number.isNaN(secs)) return '';
  if (secs < 45) return 'just now';
  if (secs < 3600) return Math.round(secs / 60) + ' min ago';
  if (secs < 86400) return Math.round(secs / 3600) + ' h ago';
  return Math.round(secs / 86400) + ' d ago';
}

/** "1 session", "2 sessions". */
export function plural(n: number, noun: string, many: string = noun + 's'): string {
  return n + ' ' + (n === 1 ? noun : many);
}

/** Words written in capitals wherever they appear in a key. */
const UPPER = new Set([
  'mb',
  'gb',
  'cpu',
  'gpu',
  'jdk',
  'sdk',
  'id',
  'url',
  'ui',
  'npm',
  'msvc',
  'uv',
  'api',
  'ssh',
  'vm',
  'io',
]);
/** "harness" is the code's word for an agent; screens say agent. */
const PLAIN: Readonly<Record<string, string>> = { harness: 'agent', harnesses: 'agents' };

/** 1536 -> "1.5 KB" (the same words as core/disk.ts humanBytes, which the CLI prints). */
export function bytesText(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = bytes <= 0 ? 0 : Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return (i === 0 ? String(bytes) : value.toFixed(value < 10 ? 1 : 0)) + ' ' + units[i];
}

/** "memoryMb" -> "Memory MB", "vGpu" -> "V GPU": a readable label from a setting's key. */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => PLAIN[w.toLowerCase()] ?? w);
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (UPPER.has(lower)) return w.toUpperCase();
      return i === 0 ? w[0].toUpperCase() + w.slice(1) : lower;
    })
    .join(' ');
}

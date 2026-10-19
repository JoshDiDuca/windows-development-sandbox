import type { Config, GitAccess } from '../../core/types.js';
import { type AppEntry, appById } from './catalogue.js';

/** A catalogue `exe` that is a regex ("/.../") matches names with a version in them. */
export function exeMatcher(exe: string): (name: string) => boolean {
  const regex = /^\/(.+)\/$/.exec(exe);
  if (regex) {
    const r = new RegExp(regex[1], 'i');
    return (name) => r.test(name);
  }
  return (name) => name.toLowerCase() === exe.toLowerCase();
}

/** Your own program as a catalogue entry (its folder is apps\custom\<id>). */
const customEntry = (id: string, app: Config['apps']['custom'][string]): AppEntry => ({
  id: 'custom/' + id,
  name: app.name,
  category: 'utilities',
  about: 'Your own program.',
  size: '?',
  source: app.github && app.asset ? { github: app.github, asset: app.asset } : { url: app.url! },
  unpack: app.unpack,
  exe: app.exe,
  cli: app.cli,
});

/** The apps to install, in order: 7-Zip first when anything needs it to unpack. */
export function appsToInstall(apps: Config['apps'], gitAccess: GitAccess): { entries: AppEntry[]; skipped: string[] } {
  const chosen = apps.install.flatMap((id) => {
    const e = appById(id);
    return e && !e.setting ? [e] : [];
  });
  const skipped = chosen
    .filter((e) => e.fullGitOnly && gitAccess !== 'full')
    .map((e) => e.name + ' (needs provisioning.git.access "full")');
  const allowed = [
    ...chosen.filter((e) => !(e.fullGitOnly && gitAccess !== 'full')),
    ...Object.entries(apps.custom).map(([id, app]) => customEntry(id, app)),
  ];
  const needs7zip =
    allowed.some((e) => e.needs?.includes('7zip') || e.unpack === 'nsis') && !allowed.some((e) => e.id === '7zip');
  return { entries: [...(needs7zip ? [appById('7zip')!] : []), ...allowed], skipped };
}

/** Does any chosen app install with uv (Headroom), so the uv step must run first? */
export function appsNeedUv(apps: Config['apps'] | undefined): boolean {
  return Boolean(
    apps?.install.some((id) => {
      const source = appById(id)?.source;
      return source !== undefined && 'locked' in source && source.locked === 'uv';
    }),
  );
}

/** Does any chosen app draw with OpenGL (so the Mesa step must run first)? */
export function appsNeedMesa(apps: Config['apps'] | undefined): boolean {
  return Boolean(apps?.install.some((id) => appById(id)?.needs?.includes('mesa')));
}

// New FiveM / RedM resources and server folders from sandbox\templates\fivem (`sbx-fivem new`, `sbx-fivem init`):
// the template's files with {{name}}, {{namespace}}, {{game}} and {{gameLines}} filled in. Never overwrites anything.
// No runtime imports: the self-test loads this file.
import fs from 'node:fs';
import path from 'node:path';
import { sandboxScriptsDir } from '../../../shared/scripts.js';

export const RESOURCE_LANGS = ['lua', 'js', 'ts', 'cs'] as const;
export type ResourceLang = (typeof RESOURCE_LANGS)[number];
export type FivemGame = 'gta5' | 'rdr3';

/** Resource names FXServer takes in `ensure`: letters, digits, - and _. */
export const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const MAX_TEMPLATE_FILES = 64;
const MAX_TEMPLATE_BYTES = 256 * 1024;
const RDR3_WARNING =
  "rdr3_warning 'I acknowledge that this is a prerelease build of RedM, and I am aware my resources *will* become incompatible once RedM ships.'";

/** sandbox\templates\fivem in the launch folder. */
export function fivemTemplatesDir(): string {
  return path.join(sandboxScriptsDir(), 'templates', 'fivem');
}

/** The manifest's game lines (RedM also needs its prerelease acknowledgement). */
export function gameLines(game: FivemGame): string {
  return game === 'rdr3' ? "game 'rdr3'\n" + RDR3_WARNING : "game 'gta5'";
}

/** A resource name as a C# namespace: my-cool_res -> MyCoolRes (a leading digit gets an R). */
export function csNamespace(name: string): string {
  const pascal = name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
  return /^[0-9]/.test(pascal) ? 'R' + pascal : pascal;
}

/** Fills {{key}} placeholders; unknown ones stay as they are. */
export function renderTemplate(text: string, vars: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{([A-Za-z]{1,20})\}\}/g, (all, key: string) => vars[key] ?? all);
}

export function templateVars(name: string, game: FivemGame): Record<string, string> {
  return { name, namespace: csNamespace(name), game, gameLines: gameLines(game) };
}

/** The template's files (relative paths), bounded; links are skipped. */
export function templateFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, depth: number): void => {
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      if (out.length >= MAX_TEMPLATE_FILES) return;
      const full = path.join(current, e.name);
      if (e.isFile()) out.push(path.relative(dir, full));
      else if (e.isDirectory() && depth < 4) walk(full, depth + 1);
    }
  };
  walk(dir, 0);
  return out.sort();
}

function copyRendered(from: string, to: string, vars: Readonly<Record<string, string>>): string[] {
  const files = templateFiles(from);
  for (const rel of files) {
    const src = path.join(from, rel);
    if (fs.statSync(src).size > MAX_TEMPLATE_BYTES) throw new Error('template file too big: ' + rel);
    const dest = path.join(to, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, renderTemplate(fs.readFileSync(src, 'utf8'), vars), { flag: 'wx' });
  }
  return files;
}

export interface NewResource {
  readonly templates: string;
  readonly lang: ResourceLang;
  readonly name: string;
  /** The folder the resource folder goes in (resources\[local] of a server folder, or any folder). */
  readonly into: string;
  readonly game: FivemGame;
}

/** Makes <into>\<name> from the language's template; returns the folder and its files. */
export function scaffoldResource(o: NewResource): { dir: string; files: string[] } {
  if (!RESOURCE_NAME.test(o.name))
    throw new Error('"' + o.name + '" is not a resource name: letters, digits, - and _ only (up to 48)');
  const dir = path.join(o.into, o.name);
  if (fs.existsSync(dir)) throw new Error(dir + ' already exists');
  const files = copyRendered(path.join(o.templates, o.lang), dir, templateVars(o.name, o.game));
  return { dir, files };
}

/** server.cfg with `ensure <name>` added at the end, or null when it already ensures it. */
export function withEnsure(cfg: string, name: string): string | null {
  const line = new RegExp('^\\s*(ensure|start)\\s+' + name.replace(/[-]/g, '\\-') + '\\s*$', 'm');
  if (line.test(cfg)) return null;
  return cfg.replace(/\s*$/, '') + '\nensure ' + name + '\n';
}

/** Where `sbx-fivem new` puts a resource: resources\[local] when the folder is a server folder, else the folder. */
export function resourceHome(folder: string): string {
  return fs.existsSync(path.join(folder, 'server.cfg')) || fs.existsSync(path.join(folder, 'resources'))
    ? path.join(folder, 'resources', '[local]')
    : folder;
}

/** Writes server.cfg (when there is none) and resources\[local] into `dir`; returns what it wrote. */
export function initServerFolder(templates: string, dir: string, name: string, game: FivemGame): string[] {
  const wrote: string[] = [];
  const cfg = path.join(dir, 'server.cfg');
  if (!fs.existsSync(cfg)) {
    const text = renderTemplate(fs.readFileSync(path.join(templates, 'server.cfg'), 'utf8'), templateVars(name, game));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cfg, text, { flag: 'wx' });
    wrote.push('server.cfg');
  }
  const local = path.join(dir, 'resources', '[local]');
  if (!fs.existsSync(local)) {
    fs.mkdirSync(local, { recursive: true });
    wrote.push('resources\\[local]');
  }
  return wrote;
}

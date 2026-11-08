// What the other projects mapped at boot want from the sandbox (a .wsb device, memory, their mappings).
import path from 'node:path';
import _ from 'lodash';
import { planBootProjects } from '../../../host/launch/index.js';
import { KnownProjects } from '../../../host/projects/index.js';
import { isWithin } from '../../../shared/paths/index.js';
import { BOOT_SETTINGS, LOCAL_CONFIG_NAME, strictness, type BootWant } from '../../../core/local-config/index.js';
import { resolveRun } from '../../../core/run/index.js';
import type { GenerateOptions, ResolvedRun } from '../../../core/types.js';
import { dirExists, errMsg, fileExists } from '../../../core/util/index.js';
import type { Context } from '../context.js';

/**
 * The other projects mapped at boot (a restart's, --session's, projects.all's, and the known projects in your roots),
 * with their effective configs: only approved .sandbox-config.json files and the looser values you allowed for each
 * (nothing is asked here). The sandbox boots with what they want too (host/launch/generate.ts).
 */
export async function bootWantsFor(
  ctx: Context,
  run: ResolvedRun,
  extraProjects: string[] | undefined,
): Promise<{ wants: NonNullable<GenerateOptions['bootWants']>; notes: string[] }> {
  const { roots } = run.config.projects;
  const planned = planBootProjects({ run, packageRoot: ctx.packageRoot, extraProjects }).projects.map((p) => p.host);
  const inRoots = new KnownProjects(run.storageRoot)
    .list()
    .map((k) => k.host)
    .filter((h) => roots.some((r) => isWithin(path.resolve(r), h)));
  const folders = _.uniqBy([...(extraProjects ?? []).map((p) => path.resolve(p)), ...planned, ...inRoots], (f) =>
    f.toLowerCase(),
  )
    .filter((f) => !isWithin(run.workspaceHost, f) && dirExists(f))
    .slice(0, 200);
  const projects: BootWant[] = [];
  const notes: string[] = [];
  for (const folder of folders) {
    try {
      const other = await resolveRun({
        packageRoot: ctx.packageRoot,
        loaded: ctx.loaded,
        cwd: folder,
        workspace: folder,
        noAgent: true,
        noLocalConfig: false,
        trustConfig: false,
        scripts: [],
      });
      projects.push({ name: path.basename(folder), config: other.config });
    } catch (e) {
      if (fileExists(path.join(folder, LOCAL_CONFIG_NAME)))
        notes.push('What ' + path.basename(folder) + ' asks for at boot is not included: ' + errMsg(e).split('\n')[0]);
    }
  }
  const keepOff = BOOT_SETTINGS.filter(
    (s) => strictness(s, _.get(ctx.loaded.config, s)) < strictness(s, _.get(run.config, s)),
  );
  return { wants: { projects, keepOff }, notes };
}

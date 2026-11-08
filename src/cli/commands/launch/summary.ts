// The table a launch (or `generate`) prints: what the sandbox gets, from the run, the generated files and prepare.
import { clipboardLine } from '../../../core/clipboard.js';
import type { Generated, ResolvedRun } from '../../../core/types.js';
import type { EnginePlan } from '../../../host/engines/index.js';
import type { Prepared } from './prepare.js';

/** What generateSandbox returned. */
export type GeneratedSandbox = Generated & { readonly personalization: string; readonly enginePlan: EnginePlan };

function agentRow(run: ResolvedRun, generated: GeneratedSandbox, prepared: Prepared | null): string {
  const { config } = run;
  // What the sandbox boots with (the launch folder's settings plus what the other projects at boot want).
  const booted = generated.bootConfig;
  return (
    run.harnessName +
    (prepared?.account ? '  (account: ' + prepared.account + ')' : '') +
    '   Memory: ' +
    generated.memoryMb +
    ' MB   CPU: ' +
    (config.sandbox.cpuLimit === 'none' ? 'all' : 'max ' + config.sandbox.cpuLimit + '%') +
    '   Network: ' +
    booted.sandbox.networking +
    (booted.sandbox.vGpu ? '   vGPU' : '') +
    (config.sandbox.headless ? '   HEADLESS' : '')
  );
}

function versionsRow(run: ResolvedRun): string {
  const { node, python } = run.versions;
  return node.spec + ' (' + node.source + ')   Python: ' + python.spec + ' (' + python.source + ')';
}

function preparedRows(prepared: Prepared | null): string[][] {
  return prepared
    ? [
        ['Ignored files', prepared.filter],
        ['Terminal', prepared.terminal],
        ['History', prepared.history],
        ['Cleanup', prepared.pruned],
      ]
    : [];
}

function toolchainsRow(generated: GeneratedSandbox): string {
  return (
    Object.entries(generated.toolchains)
      .filter(([, d]) => d.on)
      .map(([name, d]) => name + ' (' + d.reason + ')')
      .join(', ') || 'Node only (nothing else used by this project)'
  );
}

function databaseRows(generated: GeneratedSandbox): string[][] {
  if (!generated.databases.length) return [['Databases', 'none needed (databases.<name>.enabled = true adds one)']];
  return generated.databases.map((d, i) => [
    i ? '' : 'Databases',
    d.database +
      (d.database === 'sqlserver'
        ? ' (cannot run in the sandbox; use Postgres or SQLite for local work)'
        : ' on port ' + d.port) +
      '  because ' +
      d.reasons[0] +
      (d.reasons.length > 1 ? ' (+' + (d.reasons.length - 1) + ' more)' : ''),
  ]);
}

function claudeRow(generated: GeneratedSandbox): string {
  const { profile } = generated;
  return profile.staged.length
    ? profile.staged.join(', ') + (profile.credentials ? '  (INCLUDING YOUR LOGIN)' : '')
    : 'no settings copied';
}

function secretsRow(run: ResolvedRun, generated: GeneratedSandbox): string {
  if (!run.config.secrets.strip) return 'NOT stripped (secrets.strip is off)';
  const removed = generated.profile.secretsRemoved;
  return removed.length
    ? 'kept on this PC: ' + removed.join(', ') + '  (secrets.allow lets one through)'
    : 'none found in what is copied';
}

/** Project roots, boot-mapped projects, then any other folder mapped (not the tool's own nor the workspace). */
function mappingRows(run: ResolvedRun, generated: GeneratedSandbox): string[][] {
  const { roots, projects } = generated.projects;
  return [
    ...roots.map((r, i) => [
      i ? '' : 'Project roots',
      r.host + '  ->  ' + r.guest + '  (every project in it opens without a restart)',
    ]),
    ...projects.map((p, i) => [i ? '' : 'Projects', p.host + '  ->  ' + p.guest]),
    ...generated.mappings
      .slice(2)
      .filter((m) => m.guest !== run.config.guestWorkspace && ![...roots, ...projects].some((p) => p.guest === m.guest))
      .map((m) => [
        '  map ' + (m.readOnly ? 'ro' : 'rw'),
        m.host + '  ->  ' + m.guest + (m.label ? '  (' + m.label + ')' : ''),
      ]),
  ];
}

/** The launch summary rows, in the order they are printed. */
export function launchSummary(run: ResolvedRun, generated: GeneratedSandbox, prepared: Prepared | null): string[][] {
  const { config } = run;
  return [
    ['Workspace', run.workspaceHost + '  ->  ' + config.guestWorkspace + (config.readOnly ? '  (read-only)' : '')],
    ['Agent', agentRow(run, generated, prepared)],
    ['Clipboard', clipboardLine(generated.clipboard, generated.bootConfig.sandbox.engine)],
    ...(generated.clipboard.note ? [['', generated.clipboard.note]] : []),
    ['Node', versionsRow(run)],
    ...preparedRows(prepared),
    ['Toolchains', toolchainsRow(generated)],
    ...databaseRows(generated),
    ['Desktop', generated.personalization],
    ['Claude', claudeRow(generated)],
    ['Secrets', secretsRow(run, generated)],
    ...mappingRows(run, generated),
    ['Generated', generated.wsbPath],
  ];
}

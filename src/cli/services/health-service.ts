// Is this PC (and the sandbox) in good shape: the doctor details, the setup checklist. The checks themselves are in
// commands/repair (one engine for doctor and repair). Never prints.
import { spawnSync } from 'node:child_process';
import { expandPath, fail, isWin } from '../../core/util/index.js';
import { detectWsb, doctorRows, insideSandbox, isSandboxRunning } from '../../host/sandbox/index.js';
import { machineDoctorRows } from '../../host/sharing/index.js';
import { KnownProjects, ProjectRegistry } from '../../host/projects/index.js';
import { nativeScript } from '../../host/native.js';
import { refuseInSelfTest } from '../../host/test-guard.js';
import { SYSTEM } from '../../shared/system.js';
import type { Context } from '../commands/context.js';
import { buildChecks, canEnableFeature, type Check } from '../commands/setup/checks.js';
import { ENABLE_COMMAND, gatherFacts, type MachineFacts } from '../commands/setup/facts.js';

/** What `sandbox setup` found out about this PC. */
export interface SetupReport {
  readonly facts: MachineFacts;
  readonly checks: Check[];
  /** The Windows Sandbox feature is off and this edition can have it. */
  readonly canEnable: boolean;
}

export class HealthService {
  constructor(private readonly ctx: Context) {}

  /** The table `doctor` shows: [name, detail] rows (for the agent given, default: this folder's or the default one). */
  doctor(harness: string | undefined = this.ctx.options.harness): string[][] {
    const { ctx } = this;
    const rows = doctorRows(
      ctx.loaded.config,
      harness ?? ctx.loaded.config.defaultHarness,
      ctx.storageRoot,
      ctx.loaded.configPath,
    );
    // Inside a sandbox the feature and "running" rows describe the sandbox itself, and the host rows describe nothing
    // useful.
    if (insideSandbox())
      return [
        ['Where', 'inside a Windows Sandbox started by this tool (run doctor on your PC to check the PC)'],
        ...rows.filter(([name]) => name === 'Config file'),
      ];
    // Several projects: the roots mapped at every start, what the running sandbox has, and whether wsb share is there.
    const p = ctx.loaded.config.projects;
    const registry = isSandboxRunning() ? new ProjectRegistry(ctx.storageRoot).read() : null;
    const wsb = p.wsbShare ? detectWsb() : null;
    return [
      ...rows,
      ...machineDoctorRows(ctx.packageRoot, ctx.dataPath),
      [
        'Project roots',
        p.roots.length
          ? p.roots.map((r) => expandPath(r, ctx.loaded.base)).join(', ')
          : 'none (sandbox projects roots add <folder>)',
      ],
      [
        'All projects',
        p.all
          ? 'on: ' +
            new KnownProjects(ctx.storageRoot).list().length +
            ' known project(s) mapped at every start (' +
            p.exclude.length +
            ' excluded)'
          : 'off',
      ],
      ['Projects running', registry ? registry.projects.map((x) => x.name + ' (' + x.mechanism + ')').join(', ') : '-'],
      [
        'wsb share',
        !p.wsbShare
          ? 'off (projects.wsbShare)'
          : wsb
            ? 'available: ' +
              wsb.exe +
              (wsb.version ? ' ' + wsb.version : '') +
              ' (untested; a failure offers a restart instead)'
            : 'not on this Windows (needs Windows 11 24H2+ with the updated Windows Sandbox): folders outside your roots need a restart',
      ],
    ];
  }

  /** Fails unless this is Windows: Windows Sandbox runs nowhere else. */
  assertWindows(): void {
    if (!isWin)
      fail(
        'Windows Sandbox only runs on Windows.',
        'Run sandbox setup on a Windows 10/11 Pro, Enterprise or Education PC.',
      );
  }

  /** The setup checklist for this PC. */
  setupReport(): SetupReport {
    const facts = gatherFacts(this.ctx.storageRoot);
    return { facts, checks: buildChecks(facts), canEnable: canEnableFeature(facts) };
  }

  /**
   * Runs the enable command in an elevated PowerShell (Windows asks for permission); true if it worked. The helper
   * reads no input and writes nothing to the console (its exit code is the result), so 'ignore' is safe where there is
   * no terminal to give the prompt (the menu and the web).
   */
  enableFeature(stdio: 'inherit' | 'ignore' = 'inherit'): boolean {
    refuseInSelfTest('turn on Windows features');
    return (
      spawnSync(
        SYSTEM.powershell(),
        nativeScript('scripts/run-elevated.ps1', ['-Command', ENABLE_COMMAND + ' | Out-Null']),
        { stdio },
      ).status === 0
    );
  }
}

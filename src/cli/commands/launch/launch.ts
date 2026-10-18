// `launch` / `generate`, and what sandbox claude runs: start a sandbox, or another session in the running one. From a
// folder the running sandbox does not have yet, the folder joins it (no restart) when it can, and otherwise a
// restart that adds it is offered (restart.ts).
import path from 'node:path';
import _ from 'lodash';
import { openEngine, type SandboxEngine } from '../../../host/engines/index.js';
import {
  containedMappings,
  containedPaths,
  providerFor,
  setNameOf,
  type StorageProvider,
} from '../../../host/storage/index.js';
import { generateSandbox, GUEST, vgpuSource, vgpuWarning } from '../../../host/launch/index.js';
import { findSecretFiles } from '../../../host/profile/index.js';
import { RepoGuardStore } from '../../../host/guard/index.js';
import { hostPublicIp, prepareVpn, readVpnLine, vpnNotes } from '../../../host/vpn/index.js';
import {
  assertCanLaunch,
  isSandboxRunning,
  spawnDetached,
  probeHost,
  hideSandboxWindow,
  realContainedDeps,
} from '../../../host/sandbox/index.js';
import { KnownProjects, ProjectRegistry } from '../../../host/projects/index.js';
import { LifeRecord, pageFileRisk, readHostMemory, SessionLedger, takePageFileHint } from '../../../host/life/index.js';
import { isWithin } from '../../../shared/paths/index.js';
import { watcherRunning } from '../../../sync/index.js';
import { protectionsOf } from '../../../core/local-config/index.js';
import { errMsg } from '../../../core/util/index.js';
import { askYesNo } from '../../../core/prompt.js';
import { resolveRun } from '../../../core/run/index.js';
import type { ResolvedMapping, ResolvedRun } from '../../../core/types.js';
import { c, table } from '../../output/index.js';
import { syncAgentCommands } from '../agent-commands.js';
import { requireOnPc, type Context } from '../context.js';
import { joinHere } from '../projects/index.js';
import { offerSetupWhenOff } from '../setup/index.js';
import { useSharedSandbox } from '../shared-use.js';
import {
  beginSharing,
  currentUserName,
  currentUserSid,
  listProcesses,
  runningOwner,
  sessionOf,
  sharingDeps,
  takeSharingNotice,
} from '../../../host/sharing/index.js';
import { packageVersion } from '../../../core/package-info.js';
import { reopenedText, reopenSessions, type Reopen, type Relauncher } from '../sessions/reopen.js';
import { sessionsToResume } from './resume-offer.js';
import {
  startIntoRunning,
  launchIntoRunning,
  contextFor,
  waitForBoot,
  attachHere,
  waitForStart,
  openSession,
  readySandbox,
} from './running.js';
import { startWebOnLaunch } from '../web.js';
import { maybeAddRoot } from './add-root.js';
import { prepare, firstBootNotice } from './prepare.js';
import { bootWantsFor } from './boot-wants.js';
import { launchSummary, type GeneratedSandbox } from './summary.js';

/** A restart that adds a project: map these too, start no session at boot (restart.ts opens them), wait until ready. */
export interface LaunchExtras {
  readonly extraProjects?: string[];
  readonly autoSession?: boolean;
  readonly waitUntilReady?: boolean;
}

/** One launch (or `generate`): from the command line to a started sandbox, a session in it, or the written files. */
class Launcher {
  private readonly options: Context['options'];

  constructor(
    private readonly ctx: Context,
    private readonly generateOnly: boolean,
    private readonly extras: LaunchExtras,
  ) {
    this.options = ctx.options;
  }

  async run(): Promise<number> {
    const { options, generateOnly } = this;
    // attach.auto: an agent started from an interactive terminal attaches it, as with -t.
    if (this.ctx.loaded.config.attach.auto && !options.noAgent && process.stdin.isTTY && process.stdout.isTTY)
      options.terminal = true;
    if (!generateOnly) requireOnPc('launch');
    if (!generateOnly) this.syncAgentCommands();
    if (!generateOnly) {
      const setUp = await offerSetupWhenOff(this.ctx);
      if (setUp !== undefined) return setUp;
    }
    if (!generateOnly && isSandboxRunning()) {
      // Another user's sandbox: an agent session in a project it has, when it is shared; nothing else.
      const ctx = await useSharedSandbox(
        this.ctx,
        options.noAgent ? { kind: 'owner-only', what: 'start a sandbox' } : { kind: 'use' },
      );
      return options.noAgent ? startIntoRunning(ctx, RELAUNCHER) : launchIntoRunning(ctx, RELAUNCHER);
    }
    if (options.sessions.length) return this.launchSessions();
    return this.launchHere();
  }

  /** agentCommands (Beta) follows the config: a setting changed in the file takes effect here too. Never blocks. */
  private syncAgentCommands(): void {
    try {
      syncAgentCommands(this.ctx, this.ctx.loaded.config);
    } catch (e) {
      console.warn('Agent commands (Beta): ' + errMsg(e));
    }
  }

  /**
   * Several sessions: the sandbox starts from the first one's folder with the others' folders mapped too, then they
   * all open in it (each project is set up on demand, in parallel). One --session is an ordinary launch.
   */
  private async launchSessions(): Promise<number> {
    const { ctx, generateOnly, extras } = this;
    const wants = this.options.sessions;
    if (wants.length === 1) return launch(contextFor(ctx, wants[0]), generateOnly, extras);
    const first = contextFor(ctx, wants[0]);
    const others = _.uniqBy(
      wants
        .slice(1)
        .map((w) => w.folder)
        .filter((f) => !isWithin(wants[0].folder, f)),
      (f) => f.toLowerCase(),
    );
    const started = await launch({ ...first, options: { ...first.options, terminal: false } }, generateOnly, {
      ...extras,
      extraProjects: [...(extras.extraProjects ?? []), ...others],
      autoSession: false,
      waitUntilReady: true,
    });
    return generateOnly || started !== 0 ? started : launchIntoRunning(ctx, RELAUNCHER);
  }

  private resolve(): Promise<ResolvedRun> {
    const { options } = this;
    return resolveRun({
      packageRoot: this.ctx.packageRoot,
      loaded: this.ctx.loaded,
      cwd: process.cwd(),
      workspace: options.workspace,
      harness: options.harness,
      noAgent: options.noAgent,
      noLocalConfig: options.noLocalConfig,
      trustConfig: options.trustConfig,
      scripts: options.scripts,
      databases: options.databases,
      headless: options.headless,
      nodeVersion: options.node,
      pythonVersion: options.python,
      ask: askYesNo,
    });
  }

  /** One sandbox for this folder: resolve, prepare, write the launch files, then (unless generate) start it. */
  private async launchHere(): Promise<number> {
    const { ctx, generateOnly } = this;
    const run = await this.resolve();
    const { config } = run;
    // An engine or storage kind that is not available yet stops here, before anything is prepared.
    const engine = await openEngine(config);
    const provider = providerFor(
      config,
      config.storage.contained === 'off'
        ? {}
        : { contained: realContainedDeps(ctx.storageRoot, config.storage.containedMaxGb) },
    );
    if (!generateOnly) assertCanLaunch(isSandboxRunning() ? runningOwner() : undefined);
    // Contained storage: the image is mounted now (before anything reads or writes the data set), and let go of again
    // when the launch fails before the sandbox starts. The background watcher holds it from then on.
    const dataMappings = await this.prepareStorage(provider, run);
    try {
      return await this.launchPrepared(run, engine, dataMappings);
    } catch (e) {
      await provider.release();
      throw e;
    }
  }

  /** The data set's mappings from a contained-storage provider (mounting it), or undefined for plain folders. */
  private async prepareStorage(provider: StorageProvider, run: ResolvedRun): Promise<ResolvedMapping[] | undefined> {
    if (provider.id === 'folder') return undefined;
    if (this.generateOnly)
      return containedMappings(
        run.dataPath,
        containedPaths(run.storageRoot, setNameOf(run.dataPath)).mount,
        GUEST.data,
      );
    console.log('Mounting the contained storage (Windows asks for permission when it is not mounted yet)...');
    return [...(await provider.prepare({ dataPath: run.dataPath, guest: GUEST.data })).mappings];
  }

  private async launchPrepared(
    run: ResolvedRun,
    engine: SandboxEngine,
    dataMappings: ResolvedMapping[] | undefined,
  ): Promise<number> {
    const { ctx, generateOnly, extras } = this;
    const { config } = run;
    if (!generateOnly && !extras.extraProjects) await maybeAddRoot(ctx, run);
    const prepared = generateOnly ? null : await prepare(ctx, run);
    const bootWants = await bootWantsFor(ctx, run, extras.extraProjects);
    // The VPN (vpn.enabled): its server and profile are fetched and checked here, before anything is written.
    const vpn = generateOnly
      ? null
      : await prepareVpn({
          config,
          storageRoot: ctx.storageRoot,
          sandboxRunning: isSandboxRunning(),
          base: run.workspaceHost,
        });
    // This PC's commit (RAM plus paging file) bounds the sandbox's memory as much as free RAM does.
    const hostMemory = generateOnly ? null : readHostMemory(ctx.storageRoot);
    const generated: GeneratedSandbox = generateSandbox(
      {
        packageRoot: ctx.packageRoot,
        ...(hostMemory ? { commitAvailableMb: hostMemory.commitAvailableMb } : {}),
        run,
        harnessArgs: this.options.passthrough,
        probe: probeHost(config, run.harnessName),
        extraProjects: extras.extraProjects,
        autoSession: extras.autoSession,
        bootWants: bootWants.wants,
        ...(vpn ? { vpn } : {}),
        ...(dataMappings ? { dataMappings } : {}),
      },
      engine,
    );

    const notes = [...run.notes, ...bootWants.notes, ...generated.projects.notes, ...generated.mappingNotes];
    for (const note of notes) console.log(note);
    if (generated.memoryNote) console.log(c.yellow(generated.memoryNote));
    if (generated.bootConfig.sandbox.vGpu)
      console.log(c.yellow(vgpuWarning(vgpuSource(ctx.loaded.config.sandbox.vGpu))));
    const risk = hostMemory ? pageFileRisk(hostMemory, generated.memoryMb) : null;
    if (risk && takePageFileHint(ctx.storageRoot)) console.log(c.yellow(risk.text));
    this.warnSecretFiles(run);
    for (const line of vpnNotes(config.vpn)) console.log(c.yellow(line));
    table(launchSummary(run, generated, prepared));
    if (generateOnly) return 0;
    // A restart or sandbox resume reopens sessions itself (they pass the projects they keep).
    const reopen = extras.extraProjects ? [] : await sessionsToResume(ctx, run);
    this.record(run, generated);
    this.share(generated);
    await engine.start(generated.enginePlan);
    this.startWatcher();
    await startWebOnLaunch(this.ctx);
    if (reopen.length) await this.reopenAfterBoot(generated.launchId, reopen);
    return this.afterStart(run, generated);
  }

  private warnSecretFiles(run: ResolvedRun): void {
    const secretFiles = run.config.secrets.warnFiles ? findSecretFiles(run.workspaceHost) : [];
    if (!secretFiles.length) return;
    const shown = secretFiles.slice(0, 12).join(', ') + (secretFiles.length > 12 ? ', ...' : '');
    console.warn(
      c.yellow(
        'Heads-up: the agent can read these files in your workspace, which often hold secrets: ' +
          shown +
          '. Move real credentials out of the folder (or use test ones). Silence with secrets.warnFiles = false.',
      ),
    );
  }

  /**
   * Every folder the sandbox can write is snapshotted before it starts (the guard compares against this), and the
   * projects it starts with are recorded host-side for the commands that run later.
   */
  private record(run: ResolvedRun, generated: GeneratedSandbox): void {
    const { dataPath, storageRoot } = this.ctx;
    const { config } = run;
    const { roots, projects } = generated.projects;
    new RepoGuardStore(dataPath).save(
      run.workspaceHost,
      projects.map((p) => p.host),
      roots.map((r) => r.host),
    );
    new ProjectRegistry(storageRoot).start({
      launchId: generated.launchId,
      protections: protectionsOf(generated.bootConfig),
      primary: { host: run.workspaceHost, guest: config.guestWorkspace },
      roots,
      boot: projects,
      atBoot: { memoryMb: generated.memoryMb, mappings: generated.mappings, widened: generated.widened },
    });
    new KnownProjects(storageRoot).remember(run.workspaceHost);
    new LifeRecord(storageRoot, dataPath).start(config.sandbox.keepAwake);
    new SessionLedger(storageRoot, dataPath).startLaunch({
      primary: run.workspaceHost,
      harness: this.options.noAgent ? null : run.harnessName,
      projects: projects.map((p) => p.host).filter((host) => host.toLowerCase() !== run.workspaceHost.toLowerCase()),
      headless: config.sandbox.headless,
      configPath: this.options.config ? path.resolve(this.options.config) : null,
    });
  }

  /**
   * An all-users install: whose sandbox this is (the record other users read) and, when sharing is on, the folder
   * permissions that let the group use it. Done before the sandbox starts, so it never runs unrecorded.
   */
  private share(generated: GeneratedSandbox): void {
    const deps = sharingDeps(this.ctx.packageRoot);
    if (!deps) {
      if (this.ctx.loaded.config.sharing.otherUsers)
        console.log(
          c.yellow(
            'This sandbox is not shared: sharing.otherUsers is on, but no all-users install was found on this PC. ' +
              'Install for everyone (install.ps1 -Scope AllUsers) to share sandboxes.',
          ),
        );
      return;
    }
    // Only the shared tree may be opened to the group: never a storage folder of your own (your profile, say).
    const inSharedTree = isWithin(deps.usersDir, this.ctx.dataPath);
    if (this.ctx.loaded.config.sharing.otherUsers && !inSharedTree)
      console.log(
        c.yellow(
          'This sandbox is not shared: its data is in ' +
            this.ctx.dataPath +
            ', outside ' +
            deps.usersDir +
            '. Remove storage.root from your config to use the shared folder.',
        ),
      );
    const shared = this.ctx.loaded.config.sharing.otherUsers && inSharedTree;
    // Only an opened folder has permissions to write; a closed one is checked in a moment and usually needs nothing.
    if (shared) console.log('Setting folder permissions...');
    const rows = listProcesses();
    beginSharing(deps, {
      user: currentUserName(),
      sid: currentUserSid(),
      windowsSession: sessionOf(rows) ?? 0,
      dataPath: this.ctx.dataPath,
      shared,
      version: packageVersion(),
      projects: generated.projects.projects.map((p) => ({
        id: path.basename(p.host),
        hostPath: p.host,
        guestPath: p.guest,
      })),
    });
    const notice = shared ? takeSharingNotice(this.ctx.storageRoot) : null;
    if (notice) console.log(c.yellow(notice));
  }

  /** Waits for the boot, then opens the sessions of the last sandbox in it (each in its own tab). */
  private async reopenAfterBoot(launchId: string, reopen: readonly Reopen[]): Promise<void> {
    const { ctx } = this;
    const ready = await waitForBoot(ctx.dataPath, launchId);
    const opened = await reopenSessions(ctx, ready, reopen, RELAUNCHER);
    console.log(reopenedText(opened, reopen.length, reopen));
  }

  /** Absolute: the watcher runs from another folder, and a relative --config there would make it exit silently. */
  private startWatcher(): void {
    const { config } = this.options;
    if (!watcherRunning(this.ctx.dataPath))
      spawnDetached(this.ctx.entry, ['_watch', ...(config ? ['--config', path.resolve(config)] : [])]);
  }

  /** Waits for the boot; the VPN's outcome is said whether the boot worked or not (a failed tunnel can be why). */
  private async bootThenReportVpn(run: ResolvedRun, launchId: string, timed: boolean): Promise<void> {
    try {
      await waitForBoot(this.ctx.dataPath, launchId, timed);
    } catch (e) {
      await this.reportVpn(run);
      throw e;
    }
    await this.reportVpn(run);
  }

  /** Says whether the VPN came up (the sandbox reports it; its address is compared with this PC's). */
  private async reportVpn(run: ResolvedRun): Promise<void> {
    if (!run.config.vpn.enabled) return;
    const line = readVpnLine(this.ctx.dataPath, await hostPublicIp());
    if (!line) return;
    console.log(
      line.level === 'ok' ? c.green(line.text) : line.level === 'warn' ? c.yellow(line.text) : c.red(line.text),
    );
  }

  /** Waits for the boot and attaches when asked to; otherwise says where the agent opens. */
  private async afterStart(run: ResolvedRun, generated: GeneratedSandbox): Promise<number> {
    const { ctx, options, extras } = this;
    const { dataPath, storageRoot } = ctx;
    const { config } = run;
    // Hiding runs alongside; a failure to find the window must never break the launch or an attach.
    const hidden = config.sandbox.headless ? hideSandboxWindow(storageRoot).catch(() => false) : null;
    const headsUp = firstBootNotice(dataPath, generated);
    if (options.terminal || options.noAgent || extras.waitUntilReady) {
      if (headsUp) console.log(headsUp);
      await this.bootThenReportVpn(run, generated.launchId, Boolean(headsUp));
      if (extras.waitUntilReady) return 0;
      // Without an agent there is no session to attach to: the sandbox itself is the result.
      if (options.noAgent) {
        console.log(
          'Sandbox ready. Its window has a terminal in ' +
            config.guestWorkspace +
            '; from here: sandbox exec -- <command>, sandbox stop.',
        );
        return 0;
      }
      return attachHere(ctx, await waitForStart(ctx, generated.launchId, 'Starting ' + run.harnessName));
    }
    // The VPN's outcome is worth waiting for: a failed tunnel with the kill switch on means no internet.
    if (config.vpn.enabled) {
      if (headsUp) console.log(headsUp);
      await this.bootThenReportVpn(run, generated.launchId, Boolean(headsUp));
    } else if (headsUp) console.log(headsUp + '\nFollow along: sandbox logs -f');
    if (hidden)
      console.log(
        (await hidden)
          ? 'Sandbox running headless. Open the window: sbx-show   Attach here: sandbox claude -t'
          : 'Could not find the sandbox window to hide (it may still be starting); run sandbox hide in a moment.',
      );
    else
      console.log(
        'Sandbox starting. ' +
          run.harnessName +
          ' opens in Windows Terminal inside it. Attach here any time: sandbox claude -t',
      );
    return 0;
  }
}

export function launch(ctx: Context, generateOnly = false, extras: LaunchExtras = {}): Promise<number> {
  return new Launcher(ctx, generateOnly, extras).run();
}

/** What a restart (restart.ts) uses to start the sandbox again and reopen its sessions. */
export const RELAUNCHER: Relauncher = { launch, readySandbox, joinHere, openSession };

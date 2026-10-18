// When history and claude-mem move: in before every launch, out every minute while the sandbox runs (history) and
// once more when it closes (history + claude-mem). The watcher runs detached on the host for the sandbox's lifetime.
// Its pid file and log live in host-only storage, never in the data folder the sandbox can write.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../shared/io/index.js';
import { refuseInSelfTest } from '../host/test-guard.js';
import { errMsg, sleep } from '../core/util/index.js';
import { RepoGuardStore } from '../host/guard/index.js';
import { isSandboxRunning, realContainedDeps, spawnDetached } from '../host/sandbox/index.js';
import { readActiveViews, WorkspaceView, type ViewOptions } from '../host/workspace-view/index.js';
import { readForwards, sandboxAddress, startPortForwards } from '../host/network/index.js';
import { AuditCollector, readAuditSettings } from '../host/audit/collect.js';
import { readMarkedProjects, saveDataSize, watchAndMark } from '../host/guard/index.js';
import { sizeWithin } from '../core/disk.js';
import {
  autoRestartAllowed,
  causeSince,
  appendHostMemory,
  cpuPercentBetween,
  KeepAwake,
  LifeRecord,
  HostMemoryStream,
  readHostMemoryAsync,
  readLoadSettings,
  REQUEST_SECONDS,
  WATCHDOG_START,
  watchdogStep,
  type WatchdogState,
  saveCrashReport,
  SessionLedger,
  type StopCause,
} from '../host/life/index.js';
import { SandboxChannel } from '../host/channel/index.js';
import { ProjectRegistry } from '../host/projects/registry.js';
import { ContainedStorage, setNameOf, storageOf } from '../host/storage/index.js';
import { clearSecrets } from '../host/secrets/index.js';
import { endSharing, sharingDeps } from '../host/sharing/index.js';
import { PACKAGE_ROOT } from '../core/package-info.js';
import { syncBack } from './sync-cycle.js';
import os from 'node:os';

const WATCH_INTERVAL_MS = 60 * 1000;
/** The first sync waits this long: the sandbox is still booting. */
const FIRST_SYNC_MS = 30000;
const AUDIT_FLUSH_MS = 10000;
/** How often this PC's memory and CPU are sampled (the sample runs asynchronously: it never holds anything up). */
const WATCHDOG_MS = 10000;
/** The host memory log gets a line this often, and at every sample while the PC is low. */
const HOST_LOG_EVERY_MS = 60000;
/** After the sandbox closed: a moment for its last writes to land before the final sync. */
const SETTLE_MS = 3000;
/** The longest the watcher may take after the sandbox closed (final syncs) before it stops anyway. */
const END_DEADLINE_MS = 3 * 60 * 1000;
/** Measuring the data folder for storage.warnDataGb may take this long at most. */
const SIZE_BUDGET_MS = 20000;

function hostRunDir(dataPath: string): string {
  return path.join(storageOf(dataPath), 'run');
}

function watcherPidFile(dataPath: string): string {
  return path.join(hostRunDir(dataPath), 'watcher-' + path.basename(dataPath) + '.pid');
}

function watcherLog(dataPath: string): string {
  return path.join(storageOf(dataPath), 'logs', 'host-sync-' + path.basename(dataPath) + '.log');
}

/** Signal 0 only asks whether the process exists. pid 0 would mean "my own process group", so it never counts. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function watcherRunning(dataPath: string): boolean {
  try {
    return alive(Number(fs.readFileSync(watcherPidFile(dataPath), 'utf8')));
  } catch {
    return false;
  }
}

/** What the watcher may do about a crash: start the sandbox again (resume.restartAfterCrash), with this CLI. */
export interface WatcherResume {
  readonly restartAfterCrash: boolean;
  readonly entry?: string;
  readonly config?: string;
}

/** The ways the sandbox itself ends badly (the PC going down takes the watcher with it, so it never gets here). */
const RESTARTABLE: readonly StopCause['kind'][] = ['sandboxCrash', 'memory'];

/**
 * The background watcher of one data folder: while the sandbox runs it syncs history back every minute, guards the
 * projects' git folders, keeps filtered workspaces in step, forwards ports, marks downloaded files, records the audit
 * and keeps this PC awake; when the sandbox closes it records how it ended and syncs once more.
 */
export class Watcher {
  private readonly storageRoot: string;
  private readonly life: LifeRecord;
  private readonly ledger: SessionLedger;
  private cause: StopCause | null = null;
  private audit: AuditCollector | null = null;
  private auditTimer: NodeJS.Timeout | null = null;
  private awake: KeepAwake | null = null;
  private views: ViewOptions[] = [];
  private stops: (() => void)[] = [];
  private watchdogTimer: NodeJS.Timeout | null = null;
  /** This PC's memory, read by one long-running HostTools instead of a program per sample. */
  private memoryStream: HostMemoryStream | null = null;
  private watchdog: WatchdogState = WATCHDOG_START;
  private watchdogBusy = false;
  private lastCpu: os.CpuInfo[] = os.cpus();
  private lastHostLog = 0;

  constructor(
    private readonly dataPath: string,
    private readonly resume: WatcherResume = { restartAfterCrash: false },
  ) {
    this.storageRoot = storageOf(dataPath);
    this.life = new LifeRecord(this.storageRoot, dataPath);
    this.ledger = new SessionLedger(this.storageRoot, dataPath);
  }

  /** Runs until the sandbox has closed and the final sync is done (or the end deadline passed). */
  async run(): Promise<void> {
    refuseInSelfTest('start the background sync');
    if (watcherRunning(this.dataPath)) return;
    fs.mkdirSync(hostRunDir(this.dataPath), { recursive: true });
    fs.mkdirSync(path.dirname(watcherLog(this.dataPath)), { recursive: true });
    writeFileAtomic(watcherPidFile(this.dataPath), String(process.pid));
    this.start();
    this.holdContained();
    try {
      await sleep(FIRST_SYNC_MS);
      while (isSandboxRunning()) {
        this.life.beat();
        this.noteSessions();
        this.sync(false);
        await sleep(WATCH_INTERVAL_MS);
      }
      this.recordEnd();
      await sleep(SETTLE_MS);
      // The sandbox is gone: this process ends within minutes whatever happens below (it must never outlive the
      // sandbox).
      setTimeout(() => {
        this.note('final work took too long; stopped.');
        fs.rmSync(watcherPidFile(this.dataPath), { force: true });
        process.exit(0);
      }, END_DEADLINE_MS).unref();
      this.sync(true);
    } finally {
      this.stop();
      await this.releaseContained();
    }
    // After stop(): its pid file is gone, so the sandbox started again gets a watcher of its own.
    this.restartAfterCrash();
  }

  /** Contained storage of this data set (only when a mounted image is on record), else null. */
  private contained(): ContainedStorage | null {
    try {
      const storage = new ContainedStorage(realContainedDeps(this.storageRoot, 64), setNameOf(this.dataPath));
      return storage.isRecorded() ? storage : null;
    } catch {
      // Not a name contained storage can use: there is none.
      return null;
    }
  }

  /** The mounted image stays mounted until the sandbox is gone: this watcher holds it. */
  private holdContained(): void {
    try {
      this.contained()?.hold({ id: 'watcher', pid: process.pid });
    } catch (e) {
      this.note('contained storage: could not record the watcher: ' + errMsg(e));
    }
  }

  /** The sandbox is gone and the last sync done: let go of the image, which dismounts it when nothing else holds it. */
  private async releaseContained(): Promise<void> {
    try {
      const result = await this.contained()?.release('watcher');
      if (result)
        this.note(
          result.dismounted
            ? 'contained storage dismounted'
            : 'contained storage stays mounted: ' + (result.note ?? ''),
        );
    } catch (e) {
      this.note('contained storage: ' + errMsg(e));
    }
  }

  private note(message: string): void {
    try {
      fs.appendFileSync(watcherLog(this.dataPath), new Date().toISOString() + ' ' + message + '\n');
    } catch {
      /* ignore */
    }
  }

  /** Everything that runs alongside the sandbox, in this order. */
  private start(): void {
    const { dataPath, storageRoot } = this;
    // audit.enabled: programs, files, sessions and guard findings into the host-only audit log.
    const auditSettings = readAuditSettings(storageRoot, dataPath);
    const audit = auditSettings?.enabled ? new AuditCollector(dataPath, storageRoot, auditSettings) : null;
    this.audit = audit;
    audit?.start();
    this.auditTimer = audit
      ? setInterval(() => {
          try {
            audit.flush();
          } catch (e) {
            this.note('audit: ' + errMsg(e));
          }
        }, AUDIT_FLUSH_MS)
      : null;
    // storage.markSandboxFiles: programs and scripts that appear in the projects get the "from the internet" mark.
    const stopMarking = watchAndMark(readMarkedProjects(storageRoot, dataPath), (m) => this.note(m));
    // network.forwardPorts: localhost on this PC reaches servers in the sandbox while it runs.
    const stopForwards = startPortForwards(
      readForwards(storageRoot, dataPath),
      () => sandboxAddress(dataPath),
      (m) => this.note('port forward: ' + m),
    );
    // workspaceFilter: each filtered project is kept in step with its view from now until the sandbox closes.
    this.views = readActiveViews(storageRoot, dataPath);
    const viewStops = this.views.flatMap((v) => {
      try {
        return [new WorkspaceView({ ...v, note: (m) => this.note('workspace ' + v.host + ': ' + m) }).watch()];
      } catch (e) {
        this.note('workspace ' + v.host + ': could not watch: ' + errMsg(e));
        return [];
      }
    });
    this.stops = [...viewStops, stopForwards, stopMarking];
    // Memory and CPU of this PC: when low, the sandbox is asked to slow its builds down (host/life/watchdog.ts).
    this.memoryStream = new HostMemoryStream(storageRoot, WATCHDOG_MS / 1000);
    this.memoryStream.start();
    this.watchdogTimer = setInterval(() => void this.watchHost(), WATCHDOG_MS);
    this.watchdogTimer.unref();
    // sandbox.keepAwake, and the life record that tells the next launch how this run ended (host/life).
    this.awake = this.life.read()?.keepAwake ? KeepAwake.start(process.pid, storageRoot) : null;
  }

  /** One watchdog sample: this PC's memory and CPU; asks the sandbox to slow down while the PC is low. Never throws. */
  private async watchHost(): Promise<void> {
    if (this.watchdogBusy) return;
    this.watchdogBusy = true;
    try {
      const settings = readLoadSettings(this.storageRoot, this.dataPath);
      const memory = this.memoryStream?.latest() ?? (await readHostMemoryAsync(this.storageRoot));
      const cpus = os.cpus();
      const cpuPercent = cpuPercentBetween(this.lastCpu, cpus);
      this.lastCpu = cpus;
      const nowMs = Date.now();
      const step = watchdogStep(this.watchdog, {
        memory,
        cpuPercent,
        intervalSeconds: WATCHDOG_MS / 1000,
        nowMs,
        reserveHostMb: settings.reserveHostMb,
        profile: settings.profile,
      });
      this.watchdog = step.state;
      if (memory && (step.state.low || nowMs - this.lastHostLog >= HOST_LOG_EVERY_MS)) {
        this.lastHostLog = nowMs;
        appendHostMemory(
          path.join(this.storageRoot, 'logs', 'host-memory-' + path.basename(this.dataPath) + '.log'),
          memory,
          cpuPercent,
        );
      }
      if (step.changed)
        this.note(
          step.state.low
            ? 'this PC is low (' + step.reason + '): asking the sandbox to slow its builds down'
            : 'this PC has recovered: no longer asking the sandbox to slow down',
        );
      if (step.send)
        new SandboxChannel(this.dataPath).pressure(step.reason, REQUEST_SECONDS, step.severe ? 'severe' : 'slow');
    } catch (e) {
      this.note('host watchdog: ' + errMsg(e));
    } finally {
      this.watchdogBusy = false;
    }
  }

  /** The repo guard, then history and (at the end) claude-mem back to this PC. */
  private sync(final: boolean): void {
    try {
      for (const finding of new RepoGuardStore(this.dataPath).check()) {
        this.note('SECURITY: neutralised a git ' + finding.kind + ' added inside the sandbox: ' + finding.detail);
        this.audit?.guard(finding.kind + ': ' + finding.detail);
      }
    } catch (e) {
      this.note('repo guard failed: ' + errMsg(e));
    }
    try {
      const s = syncBack(this.dataPath, final);
      if (s.history || final)
        this.note(
          (final ? 'sandbox closed; final sync: ' : '') + 'history ' + s.history + ', claude-mem ' + s.claudeMem,
        );
    } catch (e) {
      this.note('sync failed: ' + errMsg(e));
    }
  }

  /** The running sessions and their conversations, for the next launch (resume.sessions). */
  private noteSessions(): void {
    try {
      this.ledger.recordSessions(
        new SandboxChannel(this.dataPath).currentSessions(),
        new ProjectRegistry(this.storageRoot).read(),
      );
    } catch (e) {
      this.note('could not note the running sessions: ' + errMsg(e));
    }
  }

  /** resume.restartAfterCrash: it crashed or ran out of memory: start it again (3 times in 6 hours at most). */
  private restartAfterCrash(): void {
    try {
      const { entry, config, restartAfterCrash } = this.resume;
      if (!restartAfterCrash || !entry || !this.cause || !RESTARTABLE.includes(this.cause.kind)) return;
      const now = new Date();
      if (!autoRestartAllowed(this.ledger.read()?.autoRestarts ?? [], now)) {
        this.ledger.giveUp(now);
        this.note('not starting the sandbox again: it ended unexpectedly 3 times in 6 hours.');
        return;
      }
      this.ledger.recordAutoRestart(now);
      this.note('starting the sandbox again (resume.restartAfterCrash).');
      spawnDetached(entry, ['resume', '--auto', ...(config ? ['--config', path.resolve(config)] : [])]);
    } catch (e) {
      this.note('could not start the sandbox again: ' + errMsg(e));
    }
  }

  /** How the sandbox ended (and a crash report when it crashed), for the next launch. */
  private recordEnd(): void {
    try {
      const last = this.life.read();
      const cause = last ? causeSince(last.lastSeen, this.storageRoot) : null;
      const report = last && cause ? saveCrashReport(this.storageRoot, this.dataPath, last.lastSeen) : null;
      this.life.end(cause, new Date(), report);
      this.cause = cause;
      // Ended with nothing wrong (its window closed, or it shut itself down idle): on purpose.
      if (!cause) this.ledger.markClosedOnPurpose();
      if (cause) this.note('sandbox ended: ' + cause.text + (report ? '; crash report: ' + report : ''));
    } catch (e) {
      this.note('could not record how the sandbox ended: ' + errMsg(e));
    }
  }

  /** Stops what start() started, syncs the filtered workspaces a last time and records the data folder's size. */
  private stop(): void {
    this.awake?.stop();
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.memoryStream?.stop();
    this.stops.forEach((stop) => stop());
    if (this.auditTimer) clearInterval(this.auditTimer);
    try {
      this.audit?.stop();
    } catch (e) {
      this.note('audit: ' + errMsg(e));
    }
    for (const v of this.views) {
      try {
        const s = new WorkspaceView(v).syncAll();
        this.note('workspace ' + v.host + ': final sync ' + s.toHost + ' out, ' + s.toView + ' in');
      } catch (e) {
        this.note('workspace ' + v.host + ': final sync failed: ' + errMsg(e));
      }
    }
    // For the next launch's storage.warnDataGb, only when it can be measured quickly (a big data folder takes minutes).
    try {
      const bytes = sizeWithin(this.dataPath, SIZE_BUDGET_MS);
      if (bytes !== null) saveDataSize(this.storageRoot, this.dataPath, bytes);
    } catch {
      /* best effort */
    }
    // One-shot secrets the sandbox never read (it stopped early) and any login copy left in a launch folder.
    try {
      // Not when a new sandbox already started: its own files are there.
      if (!isSandboxRunning()) clearSecrets(this.storageRoot, this.dataPath);
    } catch (e) {
      this.note('could not remove the one-shot secrets: ' + errMsg(e));
    }
    // An all-users install: the record of whose sandbox this was goes, and the group loses access to the folders.
    const sharing = sharingDeps(PACKAGE_ROOT);
    if (sharing) endSharing(sharing, this.dataPath);
    fs.rmSync(watcherPidFile(this.dataPath), { force: true });
  }
}

/** Body of the detached watcher process (`agent-sandbox _watch`). */
export function watch(dataPath: string, resume?: WatcherResume): Promise<void> {
  return new Watcher(dataPath, resume).run();
}

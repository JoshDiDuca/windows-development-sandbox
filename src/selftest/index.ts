// `agent-sandbox self-test [suite...]`: offline logic and security tests, plus live tests of the session daemon,
// ptyhost and the git guard when running on Windows (they need csc.exe and ConPTY, both part of Windows 10/11). They
// start real processes (the guest runtime, the daemon, csc, git), so they only run on a throwaway machine.
//
// Each area is one suite in its own *.test.ts file; the list below is the order they run in. Give suite names (or a
// comma-separated list) to run only those: `sandbox self-test config`, `npm test -- live-daemon`.
import os from 'node:os';
import path from 'node:path';
import { errMsg } from '../core/util/index.js';
import { createFixtures } from './support/fixtures.js';
import { createHarness, type RunningHarness } from './support/harness.js';
import { liveTestsAvailable } from './support/live.js';
import type { Suite } from './support/suite.js';
import { accountsSuite } from './accounts.test.js';
import { credentialsSuite } from './credentials.test.js';
import { vpnSuite } from './vpn.test.js';
import { agentCommandsSuite } from './agent-commands.test.js';
import { channelSuite } from './channel.test.js';
import { heavyLoadSuite } from './heavy-load.test.js';
import { cliSuite } from './cli.test.js';
import { agentPathsSuite } from './agent-paths.test.js';
import { cmdlineSuite } from './cmdline.test.js';
import { configSuite } from './config.test.js';
import { migrateSuite } from './migrate.test.js';
import { storageSuite } from './storage.test.js';
import { updateSuite } from './update.test.js';
import { installSuite } from './install.test.js';
import { powershellVariablesSuite } from './powershell-variables.test.js';
import { sharedUseSuite } from './shared-use.test.js';
import { updateServiceSuite } from './update-service.test.js';
import { sharingSuite } from './sharing.test.js';
import { dataSuite } from './data.test.js';
import { detectSuite } from './detect.test.js';
import { generateSuite } from './generate.test.js';
import { engineSuite } from './engine.test.js';
import { containedSuite } from './contained.test.js';
import { hcsSuite } from './hcs.test.js';
import { gitAccessSuite } from './git-access.test.js';
import { guestBootSuite } from './guest-boot.test.js';
import { hostileInputSuite } from './hostile-input.test.js';
import { hostSimSuite } from './host-sim.test.js';
import { linksSuite } from './links.test.js';
import { liveDaemonSuite } from './live-daemon.test.js';
import { liveGitSuite } from './live-git.test.js';
import { liveProjectsSuite } from './live-projects.test.js';
import { localConfigSuite } from './local-config.test.js';
import { mirrorSuite } from './mirror.test.js';
import { networkSuite } from './network.test.js';
import { personalizationSuite } from './personalization.test.js';
import { projectsSuite } from './projects.test.js';
import { repairSuite } from './repair.test.js';
import { healthSuite } from './health.test.js';
import { repoGuardSuite } from './repo-guard.test.js';
import { secretsSuite } from './secrets.test.js';
import { setupSuite } from './setup.test.js';
import { syncSuite } from './sync.test.js';
import { testGuardSuite } from './test-guard.test.js';
import { toolchainsSuite } from './toolchains.test.js';
import { webSuite } from './web.test.js';
import { workspaceSuite } from './workspace.test.js';
import { workspaceViewSuite } from './workspace-view.test.js';
import { liveNetworkSuite } from './live-network.test.js';
import { liveTerminalSuite } from './live-terminal.test.js';
import { appSuite } from './app.test.js';
import { auditSuite } from './audit.test.js';
import { layoutSuite } from './layout.test.js';
import { menuSuite } from './menu.test.js';
import { menuPerfSuite } from './menu-perf.test.js';
import { resumeSuite } from './resume.test.js';

/** Every suite, in the order they run. The live ones come last: they are the slowest and need Windows. */
export const SUITES: Suite[] = [
  // settings and project files
  configSuite,
  migrateSuite,
  storageSuite,
  updateSuite,
  updateServiceSuite,
  installSuite,
  powershellVariablesSuite,
  sharingSuite,
  sharedUseSuite,
  workspaceSuite,
  localConfigSuite,
  // the generated sandbox and the guest that boots it
  generateSuite,
  engineSuite,
  containedSuite,
  hcsSuite,
  guestBootSuite,
  mirrorSuite,
  projectsSuite,
  resumeSuite,
  // syncing with this PC
  syncSuite,
  accountsSuite,
  credentialsSuite,
  vpnSuite,
  workspaceViewSuite,
  auditSuite,
  // an untrusted sandbox: what the host refuses to do with what it finds
  linksSuite,
  channelSuite,
  heavyLoadSuite,
  gitAccessSuite,
  repoGuardSuite,
  secretsSuite,
  hostileInputSuite,
  webSuite,
  testGuardSuite,
  // pure helpers and the command line
  layoutSuite,
  toolchainsSuite,
  detectSuite,
  networkSuite,
  personalizationSuite,
  cmdlineSuite,
  agentPathsSuite,
  setupSuite,
  dataSuite,
  repairSuite,
  healthSuite,
  appSuite,
  cliSuite,
  menuSuite,
  menuPerfSuite,
  agentCommandsSuite,
  // every command as its own process
  hostSimSuite,
  // real processes
  liveDaemonSuite,
  liveProjectsSuite,
  liveGitSuite,
  liveNetworkSuite,
  liveTerminalSuite,
];

/** Windows Sandbox (its user is always WDAGUtilityAccount) or a GitHub Actions runner: never someone's PC. */
export function onThrowawayMachine(): boolean {
  return os.userInfo().username.toLowerCase() === 'wdagutilityaccount' || process.env.GITHUB_ACTIONS === 'true';
}

interface Result {
  suite: Suite;
  checks: number;
  failed: number;
  seconds: number;
  note?: string;
}

const withDeadline = async <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(what + ' did not finish within ' + Math.round(ms / 1000) + ' s')), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

const runSuite = async (suite: Suite, t: RunningHarness, f: ReturnType<typeof createFixtures>): Promise<Result> => {
  const checksBefore = t.checks();
  const failedBefore = t.failures();
  const started = Date.now();
  let note: string | undefined;
  if (suite.live && !liveTestsAvailable()) {
    t.section(suite.name);
    t.skip(suite.title + ' (needs Windows with the .NET Framework compiler)');
    note = 'skipped';
  } else {
    try {
      await withDeadline(Promise.resolve(suite.run(t, f)), suite.timeoutMs ?? 120000, 'suite "' + suite.name + '"');
    } catch (e) {
      t.check(
        false,
        'suite "' + suite.name + '" stopped with an unexpected error',
        errMsg(e) + (e instanceof Error && e.stack ? '\n' + e.stack : ''),
      );
    }
  }
  return {
    suite,
    checks: t.checks() - checksBefore,
    failed: t.failures() - failedBefore,
    seconds: (Date.now() - started) / 1000,
    note,
  };
};

const printSummary = (results: Result[]): void => {
  const width = Math.max(...results.map((r) => r.suite.name.length));
  console.log('\n\x1b[36m-- summary\x1b[0m');
  for (const r of results) {
    const state = r.note ?? (r.failed ? r.failed + ' FAILED' : 'ok');
    console.log(
      '  ' +
        r.suite.name.padEnd(width) +
        '  ' +
        String(r.checks).padStart(4) +
        ' checks  ' +
        r.seconds.toFixed(1).padStart(6) +
        ' s  ' +
        state,
    );
  }
  const total = results.reduce((sum, r) => sum + r.checks, 0);
  console.log(
    '  ' +
      'total'.padEnd(width) +
      '  ' +
      String(total).padStart(4) +
      ' checks  ' +
      results
        .reduce((sum, r) => sum + r.seconds, 0)
        .toFixed(1)
        .padStart(6) +
      ' s',
  );
};

/** Resolves "a,b" / ["a", "b"] to suites; throws with the list of valid names for an unknown one. */
export function pickSuites(names: string[]): Suite[] {
  const wanted = names
    .flatMap((n) => n.split(','))
    .map((n) => n.trim())
    .filter(Boolean);
  if (wanted.length === 0) return SUITES;
  const unknown = wanted.filter((name) => !SUITES.some((s) => s.name === name));
  if (unknown.length)
    throw new Error('No test suite called ' + unknown.join(', ') + '. Suites: ' + SUITES.map((s) => s.name).join(', '));
  return SUITES.filter((s) => wanted.includes(s.name));
}

export async function selfTest(packageRoot: string, suiteNames: string[] = []): Promise<number> {
  if (!onThrowawayMachine()) {
    console.error(
      "The self-test only runs inside a Windows Sandbox, so it can never change this PC.\nRun it there: `sandbox start` in this folder, then `npm test` in the sandbox's terminal.",
    );
    return 1;
  }
  let chosen: Suite[];
  try {
    chosen = pickSuites(suiteNames);
  } catch (e) {
    console.error(errMsg(e));
    return 1;
  }
  // Defence in depth (shared/test-guard.ts): with this set, host code refuses outward actions and writes outside temp.
  process.env.AGENT_SANDBOX_SELFTEST = '1';
  const t = createHarness(packageRoot);
  // The machine folder too: a real machine config (an all-users install) must never change what the tests load.
  const saved = {
    home: process.env.AGENT_SANDBOX_HOME,
    machine: process.env.AGENT_SANDBOX_MACHINE_HOME,
    windir: process.env.WINDIR,
    localAppData: process.env.LOCALAPPDATA,
  };
  process.env.AGENT_SANDBOX_HOME = path.join(t.temp, 'user-home');
  process.env.AGENT_SANDBOX_MACHINE_HOME = path.join(t.temp, 'machine-home');
  // The old storage folder (%LOCALAPPDATA%\AgentSandbox) of this PC must not change what the migrations decide.
  process.env.LOCALAPPDATA = t.dir('local-app-data');
  const results: Result[] = [];
  try {
    const f = createFixtures(t);
    for (const suite of chosen) results.push(await runSuite(suite, t, f));
  } catch (e) {
    t.check(false, 'unexpected error: ' + errMsg(e), e instanceof Error ? e.stack : undefined);
  } finally {
    if (saved.home === undefined) delete process.env.AGENT_SANDBOX_HOME;
    else process.env.AGENT_SANDBOX_HOME = saved.home;
    if (saved.machine === undefined) delete process.env.AGENT_SANDBOX_MACHINE_HOME;
    else process.env.AGENT_SANDBOX_MACHINE_HOME = saved.machine;
    if (saved.localAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved.localAppData;
    if (saved.windir === undefined) delete process.env.WINDIR;
    else process.env.WINDIR = saved.windir;
    t.dispose();
  }
  if (results.length > 1) printSummary(results);
  const failures = t.failures();
  console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
  return failures === 0 ? 0 : 1;
}

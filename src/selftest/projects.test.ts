// Several projects in one sandbox: guest paths, joining a running sandbox, the project spec sent to the guest,
// tighten-only protections, boot wants, repo guard and --session. Offline: temp folders only.
import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedRun, SessionStatus } from '../core/types.js';
import { LocalOverridesSchema } from '../core/schema/index.js';
import {
  allowStorePath,
  checkJoin,
  describeMissing,
  missingAtBoot,
  nothingMissing,
  protectionsOf,
  saveAllowed,
} from '../core/local-config/index.js';
import { SandboxChannel, sessionsFirstIn } from '../host/channel/index.js';
import { buildWsb } from '../host/launch/index.js';
import { projectSpec, joinRunning } from '../host/projects/index.js';
import { allProjectsToMap, KnownProjects } from '../host/projects/index.js';
import { NeedsRestart, projectMapper } from '../host/projects/index.js';
import { parseWsbBoot, ProjectRegistry, runningRegistry } from '../host/projects/index.js';
import { RepoGuardStore } from '../host/guard/index.js';
import { findWsb, parseCommands, parseIp, parseList, parseVersion } from '../host/sandbox/index.js';
import { baseEnvFor } from '../guest/boot/project-env.js';
import {
  guestDirFor,
  hostDirFor,
  hubName,
  insideProjects,
  isWithin,
  planProjectMappings,
  projectForGuestDir,
  projectForHostDir,
  PROJECTS_GUEST,
  rootGuestDir,
} from '../shared/paths/index.js';
import { GuestRequestSchema, ProjectSpecSchema, RunDir } from '../shared/channel/index.js';
import { projectFolderName } from '../shared/paths/index.js';
import { syncHistoryOut } from '../sync/index.js';
import { validateOptions, validateProjectsArgs } from '../cli/validate.js';
import { parseCli, parseSessionWant } from '../cli/args.js';
import { severalAgentsArgv } from '../cli/menu/index.js';
import type { Context } from '../cli/commands/context.js';
import { generateSandbox } from '../host/launch/index.js';
import { describeSessions } from '../cli/commands/projects/index.js';
import type { Suite } from './support/suite.js';

/** The error `fn` throws, or null. */
const caught = async (fn: () => unknown): Promise<unknown> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};

export const projectsSuite: Suite = {
  name: 'projects',
  title: 'several projects in one sandbox (paths, joining, policy, specs, --session)',
  run: async (t, f) => {
    t.section('projects: guest paths');
    const projects = [
      { host: 'F:\\Code', guest: 'C:\\Projects\\Code' },
      { host: 'F:\\Code\\api', guest: 'C:\\Projects\\api' },
    ];
    const mapped = { host: 'F:\\Code', guest: 'C:\\Projects\\Code' };
    const webGuest = guestDirFor(mapped, 'F:\\Code\\web\\src');
    t.check(
      isWithin('C:\\code\\a', 'c:\\CODE\\a\\src') &&
        !isWithin('C:\\code\\a', 'C:\\code\\ab') &&
        hubName('F:\\Code\\my app (v2)', []) === 'my-app-v2' &&
        hubName('F:\\Code\\api', ['API', 'api-2']) === 'api-3' &&
        hubName('F:\\' + 'x'.repeat(80), []).length === 48 &&
        projectForHostDir(projects, 'f:\\code\\api\\src')?.guest === 'C:\\Projects\\api' &&
        projectForHostDir(projects, 'F:\\Code\\web')?.guest === 'C:\\Projects\\Code' &&
        projectForHostDir(projects, 'F:\\Other') === null &&
        projectForGuestDir(projects, 'C:\\Projects\\api\\x')?.host === 'F:\\Code\\api' &&
        webGuest === 'C:\\Projects\\Code\\web\\src' &&
        hostDirFor(mapped, webGuest) === 'F:\\Code\\web\\src' &&
        insideProjects('c:\\projects\\api\\src') &&
        !insideProjects('C:\\Projects') &&
        !insideProjects('C:\\ProjectsX\\a') &&
        insideProjects('F:\\Code\\web', ['F:\\Code']) &&
        rootGuestDir(['F:\\Code'], false, 'F:\\Code\\web\\src') === 'C:\\Projects\\Code\\web\\src' &&
        rootGuestDir(['F:\\Code'], false, 'F:\\Other') === null,
      'path helpers: case-insensitive, no prefix matches (a vs ab); ids file-name safe, unique and capped; the most specific folder wins; host <-> guest round trip; C:\\Projects look-alikes are not projects; roots place their folders',
    );
    const plan = planProjectMappings(
      ['F:\\Code', 'E:\\Work\\Code', 'C:\\Users\\me\\src'],
      ['D:\\x\\api', 'D:\\y\\api'],
      false,
    );
    t.equal(
      [
        plan.roots.map((r) => r.guest),
        plan.projects.map((p) => p.guest),
        planProjectMappings([], ['D:\\x\\app'], false, ['C:\\Workspace\\app']).projects[0].guest,
        planProjectMappings(['F:\\Code'], ['D:\\x\\api'], true).projects[0].guest,
        planProjectMappings(['F:\\Code', 'C:\\Users\\me\\src'], [], true).roots.map((r) => r.guest),
      ],
      [
        ['C:\\Projects\\Code', 'C:\\Projects\\Code-2', 'C:\\Projects\\src'],
        ['C:\\Workspace\\api', 'C:\\Workspace\\api-2'],
        'C:\\Workspace\\app-2',
        'D:\\x\\api',
        ['F:\\Code', 'C:\\Projects\\src'],
      ],
      'roots and projects mapped on their own get unique guest folders, never the launch folder\'s place; with "mirror" they appear at their PC path when the sandbox can show it there (C:\\Users\\... cannot)',
    );

    t.section('projects: tighten-only protections when joining a running sandbox');
    const base = protectionsOf(f.baseConfig);
    const same = checkJoin(base, base);
    const readonlyGit = protectionsOf({
      ...f.baseConfig,
      provisioning: { ...f.baseConfig.provisioning, git: { ...f.baseConfig.provisioning.git, access: 'readonly' } },
    });
    const loosening = checkJoin(readonlyGit, base);
    const offline = protectionsOf({ ...f.baseConfig, sandbox: { ...f.baseConfig.sandbox, networking: false } });
    const readOnly = protectionsOf({ ...f.baseConfig, readOnly: true });
    t.check(
      same.stricter.length === 0 &&
        same.looser.length === 0 &&
        checkJoin(base, readonlyGit).stricter.some((s) => s.startsWith('provisioning.git.access')) &&
        loosening.stricter.length === 0 &&
        loosening.looser.some((s) => s.includes('provisioning.git.access stays "readonly"')) &&
        checkJoin(base, offline).stricter.some((s) => s.startsWith('sandbox.networking')) &&
        checkJoin(offline, base).looser.some((s) => s.startsWith('sandbox.networking')) &&
        checkJoin(readOnly, readOnly).stricter.some((s) => s.startsWith('readOnly')),
      'joining: the same settings need no notes; stricter than the running sandbox is refused (git access, networking off), asking for less keeps the sandbox value with a note; a read-only project cannot join',
      JSON.stringify(loosening.looser),
    );
    t.check(
      !LocalOverridesSchema.safeParse({ projects: { roots: ['C:\\'] } }).success &&
        !LocalOverridesSchema.safeParse({ projects: { all: true } }).success,
      "a project's .sandbox-config.json can never set projects.roots or projects.all",
    );

    const strictUser = structuredClone(f.baseConfig);
    strictUser.provisioning.git.access = 'readonly';
    const looseDir = t.dir('proj-loose');
    f.writeLocal(looseDir, { provisioning: { git: { access: 'full' } } });
    const loose = await f.run({ cwd: looseDir, trustConfig: true }, strictUser);
    t.check(
      loose.config.provisioning.git.access === 'readonly' &&
        checkJoin(protectionsOf(strictUser), protectionsOf(loose.config)).stricter.length === 0,
      'a project file cannot loosen git access, so it joins a readonly sandbox as readonly',
    );
    const tightDir = t.dir('proj-tight');
    f.writeLocal(tightDir, { provisioning: { git: { access: 'none' } } });
    const tight = await f.run({ cwd: tightDir, trustConfig: true });

    t.section('projects: registry and joining');
    const storage = t.at('proj-storage');
    const data = path.join(storage, 'data', 'testdata');
    t.dir('proj-storage', 'data', 'testdata');
    const root = t.at('proj-root');
    const inRoot = t.dir('proj-root', 'web');
    const outside = t.dir('proj-outside');
    const primary = new ProjectRegistry(storage).start({
      launchId: '1700000000000-abcdef',
      protections: base,
      primary: { host: f.workA, guest: 'C:\\Workspace\\work-a' },
      roots: [{ host: root, guest: 'C:\\Projects\\proj-root' }],
      boot: [{ host: f.workB, guest: 'C:\\Projects\\work-b' }],
    });
    const registry = new ProjectRegistry(storage).read();
    t.check(
      primary.primary &&
        registry?.projects.length === 2 &&
        registry.projects[1].mechanism === 'boot' &&
        registry.projects[1].name === 'work-b' &&
        new ProjectRegistry(storage).here(path.join(f.workA, 'src'))?.guestDir === 'C:\\Workspace\\work-a\\src' &&
        new ProjectRegistry(storage).here(outside) === null,
      'at launch the registry holds the launch folder (primary) and the projects mapped with it; a folder inside a project finds it, one in no project does not',
    );
    const noWsb = projectMapper({ storageRoot: storage, packageRoot: f.install, wsbShare: true, detect: () => null });
    const web = await noWsb.register(inRoot);
    t.check(
      web.mechanism === 'root' &&
        web.guest === 'C:\\Projects\\proj-root\\web' &&
        (await noWsb.register(inRoot)).name === web.name &&
        new ProjectRegistry(storage).read()?.projects.filter((p) => p.host === inRoot).length === 1,
      'a folder inside a root joins at once, and only once',
    );

    t.section('projects: a registry another copy wrote, lost or left from an earlier sandbox');
    const lostStorage = t.at('proj-lost');
    const lostData = t.dir('proj-lost', 'data', 'testdata');
    const lostRoot = t.dir('proj-lost-root');
    const lostWeb = t.dir('proj-lost-root', 'web');
    const lostLaunch = '1700000000001-abc123';
    t.write(
      path.join(lostStorage, 'launches', lostLaunch, 'session.json'),
      JSON.stringify({
        launchId: lostLaunch,
        workspace: 'C:\\Workspace\\work-a',
        workspaceHost: f.workA,
        roots: ['C:\\Projects\\proj-lost-root'],
      }),
    );
    t.write(
      path.join(lostStorage, 'launches', lostLaunch, 'agent.wsb'),
      '<Configuration><MappedFolders><MappedFolder><HostFolder>' +
        lostRoot +
        '</HostFolder><SandboxFolder>C:\\Projects\\proj-lost-root</SandboxFolder><ReadOnly>false</ReadOnly>' +
        '</MappedFolder></MappedFolders></Configuration>',
    );
    const lostStatus = (id: string): string =>
      t.write(
        path.join(lostData, 'run', 'sandbox.json'),
        JSON.stringify({
          launchId: id,
          phase: 'ready',
          message: 'ready',
          updatedAt: new Date().toISOString(),
          workspaceHost: f.workA,
          guestWorkspace: 'C:\\Workspace\\work-a',
          headless: false,
        }),
      );
    lostStatus(lostLaunch);
    const lostRebuilt = runningRegistry(lostStorage, lostData, base);
    t.check(
      lostRebuilt?.launchId === lostLaunch &&
        lostRebuilt.projects[0]?.host === f.workA &&
        new ProjectRegistry(lostStorage).rootHere(lostWeb)?.guest === 'C:\\Projects\\proj-lost-root',
      'no registry file: it is rebuilt from the launch folder, and a folder in a root is found',
    );
    const lostFile = path.join(lostStorage, 'run', 'projects.json');
    const lostWritten = JSON.parse(fs.readFileSync(lostFile, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(lostFile, JSON.stringify({ ...lostWritten, addedByANewerVersion: { x: 1 } }));
    t.check(
      new ProjectRegistry(lostStorage).read()?.launchId === lostLaunch,
      'a registry with fields from another version is still read',
    );
    fs.writeFileSync(lostFile, JSON.stringify({ ...lostWritten, launchId: '1699999999999-000000', roots: [] }));
    t.check(
      runningRegistry(lostStorage, lostData, base)?.roots.length === 1,
      "a registry left from an earlier sandbox is replaced by the running one's",
    );
    lostStatus('1700000000002-def456');
    t.check(
      runningRegistry(lostStorage, lostData, base) === null,
      'no launch folder for the running sandbox: no registry (never an earlier sandbox one)',
    );
    const needs = await caught(() => noWsb.register(outside));
    const shareOff = await caught(() =>
      projectMapper({ storageRoot: storage, packageRoot: f.install, wsbShare: false }).register(outside),
    );
    const listFails = await caught(() =>
      projectMapper({
        storageRoot: storage,
        packageRoot: f.install,
        wsbShare: true,
        detect: () => ({
          exe: t.at('no-such-wsb.exe'),
          version: '0.1.0',
          commands: ['share', 'list'],
          has: (c) => c === 'share' || c === 'list',
        }),
      }).register(outside),
    );
    t.check(
      needs instanceof NeedsRestart &&
        needs.reason.includes('wsb share needs Windows 11 24H2') &&
        shareOff instanceof NeedsRestart &&
        shareOff.reason.includes('projects.wsbShare') &&
        listFails instanceof NeedsRestart &&
        listFails.reason.includes('wsb share could not find the running sandbox'),
      'a folder outside every root needs a restart when wsb share is missing, switched off, or cannot tell which sandbox is ours, and says why',
    );
    const refusedStorage = await t.thrownMessage(() => noWsb.register(storage));
    const refusedDrive = await t.thrownMessage(() => noWsb.register('C:\\'));
    const refusedRemoval = await t.thrownMessage(() => noWsb.unregister(primary.name));
    t.check(
      refusedStorage.includes('cannot be the workspace') &&
        refusedDrive.includes('whole drive') &&
        refusedRemoval.includes('stays until the sandbox stops'),
      'joining refuses the storage folder and a drive root; the launch folder cannot be removed from a running sandbox',
      [refusedStorage, refusedDrive, refusedRemoval].join(' / '),
    );

    const resolveFor = (run: ResolvedRun) => async (): Promise<ResolvedRun> => run;
    const join = (hostDir: string, resolve: () => Promise<ResolvedRun>) =>
      joinRunning({ storageRoot: storage, dataPath: data, packageRoot: f.install, hostDir, wsbShare: false, resolve });
    const webRun = await f.run({ cwd: inRoot, trustConfig: true });
    const joined = await join(inRoot, resolveFor(webRun));
    const launchFolder = await join(path.join(f.workA, 'sub'), () => Promise.reject(new Error('must not resolve')));
    t.check(
      joined.spec?.workspace === 'C:\\Projects\\proj-root\\web' &&
        ProjectSpecSchema.safeParse(joined.spec).success &&
        joined.spec.harnesses.claude !== undefined &&
        new KnownProjects(storage).list().some((k) => k.host === inRoot) &&
        launchFolder.spec === null,
      'joining builds a valid spec with its guest folder and the agent, and remembers the project; the launch folder (and below) needs no spec',
    );
    const refusedTight = await t.thrownMessage(() => join(tightDir, resolveFor(tight)));
    t.check(
      refusedTight.includes('stricter than the running sandbox') &&
        new ProjectRegistry(storage).read()?.projects.every((p) => p.host !== tightDir) === true,
      'a project that tightens git access beyond the running sandbox is refused without consent, and not registered',
      refusedTight,
    );
    let asked: string[] = [];
    const agreed = await t.thrownMessage(() =>
      joinRunning({
        storageRoot: storage,
        dataPath: data,
        packageRoot: f.install,
        hostDir: tightDir,
        wsbShare: false,
        resolve: resolveFor(tight),
        acceptStricter: async (_name, stricter) => {
          asked = stricter;
          return true;
        },
      }),
    );
    t.check(
      asked.some((s) => s.startsWith('provisioning.git.access')) &&
        !agreed.includes('stricter than the running sandbox'),
      'with your consent it is not refused for its stricter settings',
      agreed,
    );
    const outsideRun = await f.run({ cwd: outside });
    await t.throws(
      () => join(outside, resolveFor(outsideRun)),
      'projects.wsbShare',
      'a folder that cannot be shown lets NeedsRestart reach the caller',
    );

    t.section('projects: the spec and request the guest gets');
    const spec = projectSpec(webRun, web, false);
    const sessionRequest = (extra: Record<string, unknown>) =>
      GuestRequestSchema.safeParse({
        kind: 'session',
        id: 'r1',
        harness: 'claude',
        args: [],
        cwd: spec.workspace,
        createdAt: new Date().toISOString(),
        ...extra,
      });
    const carries = sessionRequest({ project: spec, harnessSpec: f.baseConfig.harnesses.codex }).success;
    const codexId = new SandboxChannel(data, () => true).requestSession('codex', [], spec.workspace, {
      project: spec,
      harnessSpec: f.baseConfig.harnesses.codex,
    });
    const codexRequest = GuestRequestSchema.parse(
      JSON.parse(fs.readFileSync(new RunDir(data).requestFile(codexId), 'utf8')),
    );
    t.check(
      carries &&
        codexRequest.kind === 'session' &&
        codexRequest.harness === 'codex' &&
        codexRequest.cwd === spec.workspace &&
        codexRequest.project?.name === spec.name &&
        codexRequest.harnessSpec?.npmBin === 'codex',
      'a session request carries a project spec and an agent definition: an agent asked for in a joined project is requested there',
    );
    const manyDatabases = Array(9).fill(
      spec.databases[0] ?? { database: 'redis', reasons: [], version: 'x', port: 6379 },
    );
    const manyAgents = Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['a' + i, f.baseConfig.harnesses.codex]));
    t.check(
      !sessionRequest({ project: { ...spec, name: '..\\evil' } }).success &&
        !sessionRequest({ project: { ...spec, extra: 1 } }).success &&
        !sessionRequest({ project: { ...spec, databases: manyDatabases } }).success &&
        !sessionRequest({ project: { ...spec, harnesses: manyAgents } }).success &&
        GuestRequestSchema.safeParse({ kind: 'project', id: 'p1', project: spec, createdAt: 'x' }).success &&
        !GuestRequestSchema.safeParse({ kind: 'project', id: 'p1', createdAt: 'x' }).success,
      'specs are validated: file-name safe ids, no unknown keys, capped lists; "project" requests need a spec',
    );

    t.section('projects: which projects are mapped at boot');
    t.equal(
      allProjectsToMap(['C:\\a', 'C:\\a\\b', 'C:\\work-a\\x', 'C:\\r\\p', 'C:\\ex\\y', 'C:\\gone'], {
        primary: 'C:\\work-a',
        roots: ['C:\\r'],
        exclude: ['C:\\ex'],
        exists: (p) => p !== 'C:\\gone',
      }),
      ['C:\\a'],
      "projects.all: known projects except excluded, missing, nested, the launch folder's and the roots'",
    );
    const rootConfig = structuredClone(f.baseConfig);
    rootConfig.projects = { ...rootConfig.projects, roots: [root, t.at('no-such-root')], all: true };
    new KnownProjects(f.baseConfig.storage.root).remember(outside);
    const gen = f.generate(await f.run({}, rootConfig));
    const session = f.readJson(gen.sessionPath);
    const wsb = fs.readFileSync(gen.wsbPath, 'utf8');
    t.check(
      gen.projects.roots.map((r) => r.guest).join() === 'C:\\Projects\\proj-root' &&
        gen.projects.notes.some((n) => n.includes('no-such-root')) &&
        gen.projects.projects.some((p) => p.host === outside),
      'roots are mapped as C:\\Projects\\<name>, a missing root is skipped with a note, projects.all maps known projects',
      JSON.stringify(gen.projects.notes),
    );
    t.equal(
      {
        rwInWsb: wsb.includes(
          '<HostFolder>' +
            root +
            '</HostFolder><SandboxFolder>C:\\Projects\\proj-root</SandboxFolder><ReadOnly>false</ReadOnly>',
        ),
        projectsDir: session.projectsDir,
        roots: session.roots,
        projectId: session.projectId,
      },
      {
        rwInWsb: true,
        projectsDir: PROJECTS_GUEST,
        roots: ['C:\\Projects\\proj-root', 'C:\\Workspace\\proj-outside'],
        projectId: 'work-a',
      },
      'roots are mapped read/write in the .wsb, and session.json tells the guest where other projects can be',
    );
    // A project is at the same place whether it started the sandbox or joined one another project started.
    const fromRoot = f.generate(await f.run({ cwd: inRoot }, rootConfig));
    t.check(
      f.readJson(fromRoot.sessionPath).workspace === 'C:\\Projects\\proj-root\\web' &&
        guestDirFor(gen.projects.roots[0], inRoot) === 'C:\\Projects\\proj-root\\web' &&
        !fromRoot.mappings.some((m) => m.host.toLowerCase() === inRoot.toLowerCase()) &&
        fs
          .readFileSync(path.join(fromRoot.launchPath, 'env.cmd'), 'utf8')
          .includes('AGENT_WORKSPACE=C:\\Projects\\proj-root\\web'),
      'a project in a root: same guest folder as launch folder or joined (and in env.cmd), and no second mapping of it',
    );
    const asLaunch = f.readJson(f.generate(await f.run({ cwd: outside })).sessionPath).workspace;
    const mirrorRoot = structuredClone(rootConfig);
    mirrorRoot.guestWorkspace = 'mirror';
    const mirrored = f.readJson(f.generate(await f.run({ cwd: inRoot }, mirrorRoot)).sessionPath).workspace;
    const filtered = structuredClone(rootConfig);
    filtered.workspaceFilter = { ...filtered.workspaceFilter, enabled: true };
    const filteredRun = await f.run({ cwd: inRoot }, filtered);
    t.check(
      asLaunch === 'C:\\Workspace\\proj-outside' &&
        gen.projects.projects.find((p) => p.host === outside)?.guest === 'C:\\Workspace\\proj-outside' &&
        mirrored === rootGuestDir([root], true, inRoot) &&
        filteredRun.config.guestWorkspace === 'C:\\Workspace\\web' &&
        filteredRun.notes.some((n) => n.includes('C:\\Projects\\proj-root\\web')),
      'a project outside the roots has the same guest folder as launch folder and mapped at boot; "mirror" puts a folder in a root where the root shows it; workspaceFilter keeps its own mapping, with a note',
      JSON.stringify(filteredRun.notes),
    );
    const badRoot = structuredClone(f.baseConfig);
    badRoot.projects = { ...badRoot.projects, roots: [f.baseConfig.storage.root] };
    await t.throws(
      async () => f.generate(await f.run({}, badRoot)),
      'projects.roots',
      'a root that would expose the storage folder is refused',
    );
    t.check(
      new KnownProjects(f.baseConfig.storage.root).forget(outside) &&
        !new KnownProjects(f.baseConfig.storage.root).list().some((k) => k.host === outside),
      '`sandbox projects remove` forgets a project',
    );

    t.section('projects: repo guard for every project the sandbox can write');
    const guardData = t.at('guard-data');
    const rootG = t.at('guard-root');
    const old = path.join(rootG, 'old');
    t.write(path.join(old, '.git', 'hooks', 'pre-commit'), 'mine');
    t.write(path.join(old, '.git', 'config'), '[core]\n\tbare = false\n');
    new RepoGuardStore(guardData).save(f.workA, [], [rootG]);
    t.write(path.join(old, '.git', 'hooks', 'post-checkout'), 'planted');
    const fresh = path.join(rootG, 'created-later');
    t.write(path.join(fresh, '.git', 'hooks', 'pre-push'), 'planted');
    t.write(path.join(fresh, '.git', 'config'), '[core]\n\tfsmonitor = evil.exe\n\tbare = false\n');
    t.write(path.join(fresh, 'node.exe'), 'planted');
    const found = new RepoGuardStore(guardData).check();
    t.check(
      fs.existsSync(path.join(old, '.git', 'hooks', 'pre-commit')) &&
        !fs.existsSync(path.join(old, '.git', 'hooks', 'post-checkout')),
      'a hook from before the sandbox stays; one added inside it to a project in a root is quarantined',
    );
    t.check(
      !fs.existsSync(path.join(fresh, '.git', 'hooks', 'pre-push')) &&
        !fs.existsSync(path.join(fresh, 'node.exe')) &&
        fs.readFileSync(path.join(fresh, '.git', 'config'), 'utf8').includes('# [agent-sandbox] disabled') &&
        found.some((x) => x.detail.startsWith(fresh)),
      'a project that appeared in a root after the start has hooks, commands and program-running git config removed',
      JSON.stringify(found),
    );

    t.section('projects: history and environment');
    const hostClaude = t.at('hist-host');
    const guestClaude = t.at('hist-guest');
    const bHost = t.at('hist-b');
    t.write(
      path.join(guestClaude, 'projects', projectFolderName('C:\\Projects\\hist-b'), 's.jsonl'),
      JSON.stringify({ cwd: 'C:\\Projects\\hist-b\\src' }) + '\n',
    );
    syncHistoryOut({
      hostClaudeDir: hostClaude,
      guestClaudeDir: guestClaude,
      hostWorkspace: f.workA,
      guestWorkspace: 'C:\\Workspace\\work-a',
      extra: [{ hostWorkspace: bHost, guestWorkspace: 'C:\\Projects\\hist-b' }],
    });
    const back = path.join(hostClaude, 'projects', projectFolderName(bHost), 's.jsonl');
    t.check(
      fs.existsSync(back) && fs.readFileSync(back, 'utf8').includes(JSON.stringify(bHost + '\\src').slice(1, -1)),
      "a joined project's history goes back to ITS folder on this PC, with paths translated",
    );
    const env = baseEnvFor(
      { basePath: 'C:\\Windows', toolVars: ['NVM_HOME', 'CARGO_HOME'], steps: {}, summary: [], lan: 'blocked' },
      {
        Path: 'C:\\tools\\a;C:\\Windows',
        NVM_HOME: 'x',
        CARGO_HOME: 'y',
        CARGO_TARGET_DIR: 'C:\\Workspace\\a\\target',
        AGENT_WORKSPACE: 'C:\\Workspace\\a',
        TEMP: 'C:\\t',
      },
    );
    t.equal(
      [env.PATH, env.NVM_HOME, env.CARGO_TARGET_DIR, env.AGENT_WORKSPACE, env.TEMP],
      ['C:\\Windows', undefined, undefined, undefined, 'C:\\t'],
      "a joined project starts from the boot's base environment: none of the first project's tools or folders",
    );

    t.section('projects: commands');
    const status = (id: string, cwd: string, startedAt: string): SessionStatus => ({
      id,
      launchId: 'l',
      harness: 'claude',
      cwd,
      phase: 'running',
      message: '',
      updatedAt: startedAt,
      startedAt,
    });
    t.equal(
      [
        sessionsFirstIn(
          [
            status('a1', 'C:\\Workspace\\a', '1'),
            status('b1', 'C:\\Projects\\b', '2'),
            status('a2', 'C:\\Workspace\\a\\x', '3'),
            status('b2', 'C:\\Projects\\b\\y', '4'),
          ],
          'C:\\Projects\\b',
        ).map((x) => x.id),
        describeSessions([
          { harness: 'claude', cwd: 'C:\\Workspace\\api', project: 'api' },
          { harness: 'codex', cwd: 'C:\\Projects\\web' },
        ]),
      ],
      [['b2', 'b1', 'a2', 'a1'], '2 sessions (claude in api, codex in web)'],
      "this project's sessions come first, newest first; the restart offer lists the sessions that would end",
    );
    const badAction = await t.thrownMessage(() => validateProjectsArgs(['bogus']));
    const noFolder = await t.thrownMessage(() => validateProjectsArgs(['add']));
    validateProjectsArgs([]);
    validateProjectsArgs(['all', 'on']);
    t.check(
      badAction.includes('projects action') && noFolder.includes('Which folder'),
      '`sandbox projects` rejects an unknown action, and `add` needs a folder',
      badAction + ' / ' + noFolder,
    );

    t.section('projects: several sessions at once (--session agent@folder)');
    const want = parseSessionWant('claude@C:\\code\\a@b', 'C:\\here');
    const own = parseSessionWant('codex@C:\\code\\web|--model o3 "two words"', 'C:\\here');
    t.check(
      want.harness === 'claude' &&
        want.folder === 'C:\\code\\a@b' &&
        parseSessionWant('codex', 'C:\\here').folder === 'C:\\here' &&
        parseSessionWant('gemini@sub', 'C:\\here').folder === 'C:\\here\\sub' &&
        own.folder === 'C:\\code\\web' &&
        JSON.stringify(own.args) === JSON.stringify(['--model', 'o3', 'two words']),
      "--session: the first @ splits agent from folder; no folder means this one; relative folders become absolute; after | come that agent's own arguments (quotes keep words together)",
    );
    const multi = parseCli([
      'launch',
      '--session',
      'claude@' + f.workA + '|--continue',
      '--session',
      'codex@' + f.workB,
      '--session',
      'claude@' + f.workB,
      '-t',
      '--',
      '--verbose',
    ]);
    t.equal(
      {
        sessions: multi.sessions.length,
        terminal: multi.terminal,
        second: multi.sessions[1].harness,
        own: multi.sessions.map((s) => s.args ?? []),
        passthrough: multi.passthrough,
      },
      { sessions: 3, terminal: true, second: 'codex', own: [['--continue'], [], []], passthrough: ['--verbose'] },
      'several --session options parse in order, with -t, own arguments and shared arguments after --',
    );
    const validationContext = (options: ReturnType<typeof parseCli>) =>
      ({
        packageRoot: f.install,
        entry: '',
        options,
        loaded: { config: f.baseConfig, configPath: null, base: t.temp },
        storageRoot: f.baseConfig.storage.root,
        dataPath: t.at('vdata'),
      }) as Context;
    const noAgent = await t.thrownMessage(() => parseSessionWant('@C:\\x'));
    const unknownAgent = await t.thrownMessage(() =>
      validateOptions(validationContext(parseCli(['launch', '--session', 'claud@' + f.workA]))),
    );
    const mixed = await t.thrownMessage(() =>
      validateOptions(validationContext(parseCli(['launch', '--session', 'claude@' + f.workA, '--harness', 'codex']))),
    );
    validateOptions(validationContext(multi));
    t.check(
      noAgent.includes('names no agent') && unknownAgent.includes('Did you mean') && mixed.includes('do not apply'),
      '--session without an agent is refused, an unknown agent suggests the closest one, and it cannot be mixed with --harness/--workspace',
      [noAgent, unknownAgent, mixed].join(' / '),
    );
    t.equal(
      severalAgentsArgv(
        [
          { harness: 'claude', folder: 'C:\\a' },
          { harness: 'codex', folder: 'C:\\b c' },
        ],
        { headless: true, attachFirst: true },
      ).join(' '),
      'launch --session claude@C:\\a --session codex@C:\\b c --headless -t',
      'the menu builds the same command line (so repeat-last works)',
    );
    const multiGen = generateSandbox({
      packageRoot: t.packageRoot,
      run: await f.run(),
      harnessArgs: [],
      probe: f.probe,
      extraProjects: [f.workB, path.join(f.workA, 'sub'), f.workB],
      autoSession: false,
    });
    const multiSession = f.readJson(multiGen.sessionPath);
    t.check(
      multiGen.projects.projects.map((p) => p.guest).join() === 'C:\\Workspace\\work-b' &&
        fs
          .readFileSync(multiGen.wsbPath, 'utf8')
          .includes('<HostFolder>' + f.workB + '</HostFolder><SandboxFolder>C:\\Workspace\\work-b</SandboxFolder>') &&
        multiSession.autoSession === false &&
        multiSession.workspaceHost === f.workA,
      'a multi-project launch maps every other project once; the boot provisions only the launch folder',
    );

    t.section('projects: what a joining project wants at boot (vGPU, its mappings)');
    const games = t.dir('proj-games');
    t.dir('proj-games', 'assets');
    f.writeLocal(games, {
      sandbox: { vGpu: true },
      mappings: [{ host: 'assets', guest: 'F:\\GameAssets', readOnly: true }],
    });
    saveAllowed(
      allowStorePath(f.baseConfig.storage.root),
      path.join(games, '.sandbox-config.json'),
      'sandbox.vGpu',
      true,
      true,
    );
    const gamesRun = await f.run({ cwd: games, trustConfig: true });
    const launchedRun = await f.run();
    const runningBoot = {
      memoryMb: 8192,
      mappings: [{ host: f.workA, guest: 'C:\\Workspace\\work-a', readOnly: false }],
    };
    const wanted = missingAtBoot(protectionsOf(launchedRun.config), runningBoot, gamesRun.config, fs.existsSync);
    const mappedMirror = missingAtBoot(
      protectionsOf(gamesRun.config),
      {
        memoryMb: 8192,
        mappings: [{ host: path.join(games, 'assets'), guest: 'C:\\Mirror\\F\\GameAssets', readOnly: true }],
      },
      gamesRun.config,
      fs.existsSync,
    );
    t.equal(
      {
        settings: wanted.settings,
        memoryMb: wanted.memoryMb,
        mappings: wanted.mappings.map((m) => m.guest),
        nothingMissingWhenMapped: nothingMissing(mappedMirror),
        message: describeMissing('mw2-agent', {
          settings: ['sandbox.vGpu'],
          memoryMb: null,
          mappings: [
            { host: 'C:\\Steam\\common', guest: 'C:\\Steam', readOnly: true },
            { host: 'F:\\SteamLibrary', guest: 'F:\\SteamLibrary', readOnly: true },
          ],
        }),
      },
      {
        settings: ['sandbox.vGpu'],
        memoryMb: null,
        mappings: ['F:\\GameAssets'],
        nothingMissingWhenMapped: true,
        message:
          'mw2-agent wants vGPU and 2 folders (C:\\Steam\\common, F:\\SteamLibrary), but this sandbox started without them.',
      },
      "missingAtBoot: vGPU and the project's folder are missing from a sandbox started without them, nothing when it has both (F:\\x is C:\\Mirror\\F\\x in the .wsb); the message names each missing item",
    );
    const widenedJoin = checkJoin({ ...base, 'sandbox.vGpu': true }, base, ['sandbox.vGpu']);
    t.check(
      JSON.stringify(
        parseWsbBoot(buildWsb(f.baseConfig, 6144, [{ host: 'C:\\a&b', guest: 'F:\\x', readOnly: true }])),
      ) ===
        JSON.stringify({
          memoryMb: 6144,
          mappings: [{ host: 'C:\\a&b', guest: 'C:\\Mirror\\F\\x', readOnly: true }],
          widened: {},
        }) &&
        widenedJoin.stricter.length === 0 &&
        widenedJoin.shared.join() === 'sandbox.vGpu' &&
        checkJoin({ ...base, 'sandbox.vGpu': true }, base).stricter.some((s) => s.startsWith('sandbox.vGpu')),
      'a sandbox started by an older version: memory and folders are read back from its .wsb; vGPU turned on at boot for a project you allowed it for is shared, without that record it is refused',
    );

    // joinRunning asks before anything is registered: restart (NeedsRestart with what is missing), or continue without.
    const storage2 = t.dir('proj-storage2');
    const data2 = t.dir('proj-storage2', 'data', 'testdata');
    new ProjectRegistry(storage2).start({
      launchId: '1700000000001-abcdef',
      protections: protectionsOf(launchedRun.config),
      primary: { host: f.workA, guest: 'C:\\Workspace\\work-a' },
      roots: [{ host: path.dirname(games), guest: 'C:\\Projects\\temp' }],
      boot: [],
      atBoot: { ...runningBoot, widened: {} },
    });
    const joinGames = (choice: 'continue' | 'restart' | 'cancel') =>
      joinRunning({
        storageRoot: storage2,
        dataPath: data2,
        packageRoot: f.install,
        hostDir: games,
        wsbShare: false,
        resolve: resolveFor(gamesRun),
        decide: async () => choice,
      });
    const restartFor = await joinGames('restart').then(
      () => null,
      (e: unknown) => e,
    );
    const cancelled = await t.thrownMessage(() => joinGames('cancel'));
    const notRegistered = !new ProjectRegistry(storage2).read()?.projects.some((p) => p.host === games);
    t.check(
      restartFor instanceof NeedsRestart &&
        restartFor.missing?.settings.includes('sandbox.vGpu') === true &&
        restartFor.missing.mappings.length === 1 &&
        cancelled.includes('Cancelled') &&
        notRegistered &&
        (await joinGames('continue')).missing?.settings.join() === 'sandbox.vGpu',
      '"Restart with them" hands the restart offer what is missing, "Cancel" stops with a short line (neither registers the project), "Continue anyway" joins and says what is missing',
      cancelled,
    );

    // The restart that adds it (and any launch with it mapped at boot) boots with the union.
    const unionGen = generateSandbox({
      packageRoot: t.packageRoot,
      run: launchedRun,
      harnessArgs: [],
      probe: f.probe,
      extraProjects: [games],
      autoSession: false,
      bootWants: { projects: [{ name: 'proj-games', config: gamesRun.config }], keepOff: [] },
    });
    const unionWsb = fs.readFileSync(unionGen.wsbPath, 'utf8');
    t.check(
      unionWsb.includes('<vGPU>Enable</vGPU>') &&
        unionWsb.includes(
          '<HostFolder>' +
            path.join(games, 'assets') +
            '</HostFolder><SandboxFolder>C:\\Mirror\\F\\GameAssets</SandboxFolder><ReadOnly>true</ReadOnly>',
        ) &&
        unionWsb.includes(
          '<HostFolder>' + games + '</HostFolder><SandboxFolder>C:\\Workspace\\proj-games</SandboxFolder>',
        ),
      'the restart plan: vGPU on, and the added project and its mapping are mapped',
    );
    const unionLearns =
      unionGen.widened['sandbox.vGpu'] === 'proj-games' &&
      unionGen.projects.notes.some((n) => n.startsWith('vGPU is on in this sandbox')) &&
      nothingMissing(
        missingAtBoot(
          protectionsOf(unionGen.bootConfig),
          { memoryMb: unionGen.memoryMb, mappings: unionGen.mappings },
          gamesRun.config,
          fs.existsSync,
        ),
      );
    const keptOff = generateSandbox({
      packageRoot: t.packageRoot,
      run: launchedRun,
      harnessArgs: [],
      probe: f.probe,
      extraProjects: [games],
      autoSession: false,
      bootWants: { projects: [{ name: 'proj-games', config: gamesRun.config }], keepOff: ['sandbox.vGpu'] },
    });
    t.check(
      unionLearns && fs.readFileSync(keptOff.wsbPath, 'utf8').includes('<vGPU>Disable</vGPU>'),
      "the registry learns which setting was turned on for which project, after that restart nothing is missing; a device the launch folder's own file switched off stays off",
      JSON.stringify(unionGen.projects.notes),
    );

    t.section('projects: wsb (Windows Sandbox command line) adapter');
    const id = '12345678-1234-1234-1234-1234567890ab';
    const apps = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wsb.exe';
    t.check(
      parseVersion('Windows Sandbox CLI version 0.4.1.0\n') === '0.4.1.0' &&
        parseVersion('nothing') === null &&
        parseIp('172.20.1.5\r\n') === '172.20.1.5' &&
        parseIp('none') === null &&
        parseCommands('Commands:\n  start    Starts a sandbox\n  list     Lists\n  share    Shares\n').join() ===
          'start,list,share' &&
        parseCommands('no commands here').length === 0 &&
        parseList(JSON.stringify([{ Id: id, Status: 'Running', Uptime: '00:10' }]))[0]?.id === id &&
        parseList(JSON.stringify({ WindowsSandboxEnvironments: [{ id, status: 'Stopped' }] }))[0]?.status ===
          'Stopped' &&
        parseList('Id                                    Status   Uptime\n' + id + '  Running  00:01:02\n')[0]
          ?.status === 'Running' &&
        parseList('nothing').length === 0 &&
        findWsb({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', SystemRoot: 'C:\\Windows' }, (p) => p === apps) ===
          apps &&
        findWsb({ SystemRoot: 'C:\\Windows' }, () => false) === null,
      'wsb --version, ip and --help are read, wsb list as an array, an object or a table, other text gives nothing; wsb.exe is looked for at absolute paths only',
    );
  },
};

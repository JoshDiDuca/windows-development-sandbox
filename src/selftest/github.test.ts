// The GitHub token for sandboxes: which tokens are accepted, the sealed store, when a launch hands it over (only in the
// one-shot secrets file), the shared-core operations, the project-file rules, and the gh commands the sandbox runs.
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../app/context.js';
import {
  deleteGithubTokenFlow,
  githubPage,
  githubTokenRowOf,
  saveGithubTokenFlow,
  type GithubStatus,
} from '../app/features/github/index.js';
import { fakeIO } from '../app/kernel/index.js';
import { runDefinition } from '../app/registry.js';
import { pageLines } from '../cli/output/index.js';
import { DEFAULTS } from '../core/config/index.js';
import { applyOverrides, normalizeOverrides } from '../core/local-config/index.js';
import { ConfigSchema, LocalOverridesSchema } from '../core/schema/index.js';
import { checkGithubToken, GithubToken, githubTokenAllowed, prepareGithubToken } from '../host/github/index.js';
import { generateSandbox } from '../host/launch/index.js';
import { insideSandbox } from '../host/sandbox/platform.js';
import { clearSecrets, SecretStore } from '../host/secrets/index.js';
import { RunDir } from '../shared/channel/index.js';
import { SecretsFileSchema, type SecretsFile } from '../shared/channel/secrets.js';
import { ghLoginCommand, ghOutputText, ghSetupGitCommand, githubTokenProblem } from '../shared/github/index.js';
import type { Suite } from './support/suite.js';

const FINE = 'github_pat_' + 'PlantedFine0123456789'.repeat(3);
const CLASSIC = 'ghp_' + 'PlantedClassic0123456789ab';
const OAUTH = 'gho_' + 'PlantedOauth0123456789abcd';

/** Every file under a folder, as text. */
function allText(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(fs.readFileSync(p, 'latin1'));
    }
  };
  walk(dir);
  return out;
}

const message = async (work: () => unknown): Promise<string> => {
  try {
    await work();
    return '';
  } catch (e) {
    const err = e as Error & { fix?: string };
    return err.message + ' ' + (err.fix ?? '');
  }
};

export const githubSuite: Suite = {
  name: 'github',
  title: 'GitHub token: accepted tokens, sealed store, delivery only in the one-shot file, operations, gh on stdin',
  run: async (t, f) => {
    t.section('which tokens are accepted');
    t.check(checkGithubToken(FINE) === 'fine-grained', 'a fine-grained token (github_pat_) is accepted');
    t.check(checkGithubToken(CLASSIC) === 'classic', 'a classic token (ghp_) is accepted');
    for (const [bad, why, expect] of [
      [OAUTH, 'an OAuth token from gh auth token', 'OAuth'],
      ['not-a-token-' + 'x'.repeat(20), 'text that is not a token', 'github_pat_'],
      ['github_pat_ ' + 'x'.repeat(30), 'a token with a space', 'spaces'],
      ['github_pat_\n' + 'x'.repeat(30), 'a token with a line break', 'line breaks'],
      ['ghp_short', 'a token too short', 'length'],
      ['github_pat_' + 'x'.repeat(300), 'a token too long', 'length'],
    ] as const) {
      const text = await message(() => checkGithubToken(bad));
      t.check(
        text.includes(expect) && !text.includes(bad) && !text.includes(bad.slice(4, 24)),
        why + ' is refused, and the refusal does not repeat it',
        text,
      );
    }
    t.check(
      (githubTokenProblem(OAUTH)?.fix ?? '').includes('personal-access-tokens/new'),
      'a refused OAuth token says to create a fine-grained token instead',
    );
    t.check(
      SecretsFileSchema.safeParse({ githubToken: FINE }).success &&
        !SecretsFileSchema.safeParse({ githubToken: 'a b' }).success &&
        !SecretsFileSchema.safeParse({ githubToken: 'x'.repeat(256) }).success,
      'the secrets file holds the token with the same limits',
    );

    t.section('the saved token');
    const storage = t.dir('github-storage');
    const store = new GithubToken(storage, SecretStore.memory());
    t.check(store.state() === 'none' && store.kind() === null, 'nothing is saved at first');
    await t.throws(() => store.save(OAUTH), 'OAuth', 'an OAuth token is not saved');
    t.check(store.state() === 'none', 'and nothing was written');
    t.check(store.save(FINE) === 'fine-grained', 'a fine-grained token is saved');
    const file = path.join(storage, 'github', 'token.json');
    t.check(
      store.state() === 'saved' && store.kind() === 'fine-grained' && !fs.readFileSync(file, 'utf8').includes(FINE),
      'it is saved sealed: the token is not in the file',
    );
    t.check(store.read() === FINE, 'and it opens for the launch');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"sealed": "[^"]*"/, '"sealed": "dpapi1:AAAA"'));
    t.check(store.state() === 'unreadable', 'a token this Windows user cannot open is reported as unreadable');
    t.check(store.remove() && store.state() === 'none' && !store.remove(), 'logout deletes it (once)');

    t.section('when a launch hands it over');
    const config = f.makeConfig();
    const tokens = new GithubToken(config.storage.root, SecretStore.memory());
    t.check(DEFAULTS.github.shareToken === false, 'sharing is off by default');
    t.equal(prepareGithubToken(config, config.storage.root, tokens), { notes: [] }, 'off: nothing, and nothing said');
    config.github.shareToken = true;
    const none = prepareGithubToken(config, config.storage.root, tokens);
    t.check(
      none.token === undefined && none.notes.some((n) => n.includes('sandbox github login')),
      'on without a saved token: not sent, and it says how to save one',
    );
    tokens.save(FINE);
    for (const access of ['readonly', 'none'] as const) {
      const strict = structuredClone(config);
      strict.provisioning.git.access = access;
      const d = prepareGithubToken(strict, config.storage.root, tokens);
      t.check(
        d.token === undefined && !githubTokenAllowed(strict) && d.notes.some((n) => n.includes('"' + access + '"')),
        'git access ' + access + ': not sent, with a note why',
      );
    }
    const unreadable = new GithubToken(t.dir('github-unreadable'), SecretStore.memory());
    unreadable.save(FINE);
    const uFile = path.join(t.at('github-unreadable'), 'github', 'token.json');
    fs.writeFileSync(uFile, fs.readFileSync(uFile, 'utf8').replace(/"sealed": "[^"]*"/, '"sealed": "dpapi1:AAAA"'));
    const u = prepareGithubToken(config, config.storage.root, unreadable);
    t.check(
      u.token === undefined && u.notes.some((n) => n.includes('could not be read')),
      'a token that cannot be decrypted is a warning, not a crash',
    );
    const all = prepareGithubToken(config, config.storage.root, tokens);
    t.check(
      all.token === FINE && all.notes.every((n) => !n.includes(FINE)) && all.notes.some((n) => n.includes('can read')),
      'all on: the token is handed over, the notes never hold it and say the agent can read it',
    );

    const run = await f.run({}, config);
    clearSecrets(config.storage.root, run.dataPath);
    const launched = generateSandbox({
      packageRoot: t.packageRoot,
      run,
      harnessArgs: [],
      probe: f.probe,
      pcLanguages: ['python', 'rust', 'cpp', 'dotnet'],
      githubToken: FINE,
    });
    const session = fs.readFileSync(launched.sessionPath, 'utf8');
    t.check(
      !session.includes(FINE) && !allText(launched.launchPath).some((text) => text.includes(FINE)),
      'the token is in neither session.json nor any file of the launch folder',
    );
    const runDir = new RunDir(run.dataPath);
    const handed = f.readJson(runDir.secretFile(launched.launchId)) as SecretsFile;
    t.check(handed.githubToken === FINE, 'it is only in the one-shot file for the sandbox');
    const runFolder = path.join(run.dataPath, 'run');
    t.check(!fs.existsSync(runFolder) || !allText(runFolder).some((text) => text.includes(FINE)), 'and not in run\\');
    clearSecrets(config.storage.root, run.dataPath);
    const readonlyConfig = structuredClone(config);
    readonlyConfig.provisioning.git.access = 'readonly';
    const readonlyRun = await f.run({}, readonlyConfig);
    const strictLaunch = generateSandbox({
      packageRoot: t.packageRoot,
      run: readonlyRun,
      harnessArgs: [],
      probe: f.probe,
      pcLanguages: [],
      githubToken: FINE,
    });
    const strictHanded = f.readJson(runDir.secretFile(strictLaunch.launchId)) as SecretsFile;
    t.check(
      strictHanded.githubToken === undefined,
      'generateSandbox checks again: a readonly sandbox never gets it, whatever it was given',
    );
    clearSecrets(config.storage.root, run.dataPath);

    t.section("settings: a project's file cannot turn it on");
    t.check(ConfigSchema.safeParse(DEFAULTS).success, 'the defaults are valid');
    t.check(
      !ConfigSchema.safeParse({ ...DEFAULTS, github: { shareToken: true, token: FINE } }).success,
      'there is no setting that holds a token',
    );
    t.check(
      !LocalOverridesSchema.safeParse({ github: { shareToken: true } }).success &&
        !LocalOverridesSchema.safeParse({ github: { shareToken: false } }).success,
      "a project's .sandbox-config.json cannot set github at all",
    );
    await t.throws(
      () => normalizeOverrides({ github: { shareToken: true } }, f.workA, '.sandbox-config.json'),
      'not valid',
      'such a file is refused as invalid',
    );
    const mine = structuredClone(DEFAULTS);
    t.check(
      applyOverrides(mine, normalizeOverrides({ readOnly: true }, f.workA, 'x')).github.shareToken === false,
      'and other project settings leave it as you set it',
    );

    t.section('the shared-core operations');
    const featureStore = new GithubToken(t.dir('github-feature'), SecretStore.memory());
    const { io: loginIO, seen: loginSeen } = fakeIO([FINE]);
    const saved = await saveGithubTokenFlow(loginIO, featureStore);
    t.check(
      loginSeen.questions.length === 1 &&
        loginSeen.questions[0].kind === 'secret' &&
        featureStore.state() === 'saved' &&
        loginSeen.logs.some((l) => l.text.includes('personal-access-tokens/new')) &&
        loginSeen.logs.some((l) => l.text.includes('agent in the sandbox can read')),
      'login shows the steps, asks exactly one hidden question, saves, and warns the agent can read it',
      JSON.stringify(loginSeen.questions),
    );
    t.check(
      !JSON.stringify(saved).includes(FINE) && !JSON.stringify(loginSeen).includes(FINE.slice(12)),
      'nothing it returns or logs holds the token',
    );
    const { io: retryIO, seen: retrySeen } = fakeIO([OAUTH, CLASSIC]);
    await saveGithubTokenFlow(retryIO, featureStore);
    t.check(
      retrySeen.questions.length === 2 &&
        featureStore.kind() === 'classic' &&
        !JSON.stringify(retrySeen).includes(OAUTH.slice(4)) &&
        retrySeen.logs.some((l) => l.text.includes('classic')),
      'a refused token is asked again (the refusal never repeats it), and a classic one is saved with a warning',
    );
    const status = (await runDefinition(
      'github.status',
      {
        storageRoot: t.dir('github-status'),
        dataPath: t.at('github-status', 'data'),
        loaded: { config: { ...DEFAULTS, github: { shareToken: true } } },
      } as unknown as AppContext,
      {},
      fakeIO().io,
    )) as GithubStatus;
    t.check(status.shareToken && status.token === 'none' && status.kind === null, 'status reads the setting');
    const sample: GithubStatus = {
      shareToken: true,
      gitAccess: 'readonly',
      token: 'saved',
      kind: 'classic',
      savedAt: '2026-10-18T10:00:00.000Z',
    };
    const lines = pageLines(githubPage(sample)).join('\n');
    t.check(
      lines.includes('saved (encrypted)') &&
        lines.includes('only handed over with "full"') &&
        lines.includes('classic'),
      'the status page says saved, the git access it needs, and the kind',
      lines,
    );
    t.equal(githubTokenRowOf({ ...sample, token: 'none' }).hint, 'not saved', 'the Settings row says not saved');
    const { io: logoutIO, seen: logoutSeen } = fakeIO([true]);
    const out = await deleteGithubTokenFlow(logoutIO, featureStore);
    t.check(
      out.deleted &&
        logoutSeen.questions.length === 1 &&
        logoutSeen.questions[0].kind === 'confirm' &&
        featureStore.state() === 'none',
      'logout asks to confirm, then deletes',
    );
    const { io: noneIO, seen: noneSeen } = fakeIO();
    t.check(
      !(await deleteGithubTokenFlow(noneIO, featureStore)).deleted && noneSeen.questions.length === 0,
      'logout with nothing saved asks nothing',
    );
    const { io: inputIO, seen: inputSeen } = fakeIO();
    await t.throws(
      () => runDefinition('github.login', {} as AppContext, { token: FINE }, inputIO),
      'does not work',
      'the token is never accepted as an input',
    );
    t.check(inputSeen.questions.length === 0, 'a token passed on the command line asks nothing');
    if (insideSandbox()) {
      const { io, seen } = fakeIO();
      await t.throws(
        () => runDefinition('github.login', {} as AppContext, {}, io),
        'inside the sandbox already',
        'github login refuses inside the sandbox',
      );
      t.check(seen.questions.length === 0, 'and asks no question first');
    }

    t.section('gh in the sandbox: the token on stdin only');
    const base = {
      PATH: 'C:\\x',
      GH_TOKEN: 'other',
      github_token: 'other2',
      GH_CONFIG_DIR: 'C:\\AgentData\\state\\gh',
    };
    const login = ghLoginCommand('C:\\tools\\gh.exe', 'C:\\nvm\\gh-token', FINE, base);
    t.check(
      login.input === FINE + '\n' &&
        !login.args.some((a) => a.includes(FINE)) &&
        login.args.includes('--with-token') &&
        !Object.values(login.env).some((v) => v.includes(FINE)),
      'gh auth login gets the token on stdin, never in its arguments or environment',
      JSON.stringify(login.args),
    );
    t.check(
      login.env.GH_CONFIG_DIR === 'C:\\nvm\\gh-token' &&
        !('GH_TOKEN' in login.env) &&
        !('github_token' in login.env) &&
        login.env.PATH === 'C:\\x',
      'it uses the sandbox-only folder, and other tokens in the environment are dropped (gh would prefer them)',
    );
    const setup = ghSetupGitCommand('C:\\tools\\gh.exe', 'C:\\nvm\\gh-token', base);
    t.check(
      setup.input === undefined && setup.args.join(' ') === 'auth setup-git --hostname github.com',
      'setup-git gets nothing on stdin',
    );
    t.check(
      !ghOutputText('error: bad credentials ' + FINE, FINE).includes(FINE),
      'what gh prints is logged with the token blanked out',
    );
  },
};

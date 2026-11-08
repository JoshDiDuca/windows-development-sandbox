// Credentials: what is encrypted at rest, what never lands in session.json or the launch folder, what the one-shot
// secrets file carries, and that printed settings show *** for secrets.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../core/config/index.js';
import { ConfigSchema, HarnessSchema, redactSecrets, scrubSecrets, secretPaths } from '../core/schema/index.js';
import { SchemaNode } from '../app/kernel/index.js';
import { SandboxChannel } from '../host/channel/index.js';
import { AccountStore, AgentAccountStore } from '../host/profile/index.js';
import { clearSecrets, SecretStore, withoutSecrets } from '../host/secrets/index.js';
import { sharingAclPlan } from '../host/sharing/index.js';
import { RunDir } from '../shared/channel/index.js';
import { mergeRequestSecrets, type SecretsFile } from '../shared/channel/secrets.js';
import type { GuestRequest } from '../core/types.js';
import type { Suite } from './support/suite.js';

const API_KEY = 'sk-planted-ENV-7f3a9c1d';
const LOGIN = 'login-planted-4b2e';

/** Every file under `dir` that contains `needle` (text or not), so a planted secret cannot hide in a corner. */
function filesContaining(dir: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const file = path.join(d, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && fs.statSync(file).size < 20 * 1024 * 1024 && fs.readFileSync(file).includes(needle))
        found.push(path.relative(dir, file));
    }
  };
  walk(dir);
  return found;
}

export const credentialsSuite: Suite = {
  name: 'credentials',
  title: 'secrets: encrypted at rest, kept out of session.json and the launch folder, hidden when printed',
  timeoutMs: 240000,
  run: async (t, f) => {
    t.section('the secret store');
    const memory = SecretStore.memory();
    const sealed = memory.sealJson({ a: 1, key: API_KEY });
    t.check(
      SecretStore.isSealed(sealed) && !sealed.includes(API_KEY) && !sealed.includes('"a"'),
      'a sealed value is one short opaque string',
    );
    t.equal(memory.openJson(sealed), { a: 1, key: API_KEY }, 'it opens again');
    await t.throws(
      () => SecretStore.dpapi().open(sealed),
      'another system',
      'a value sealed by another kind of store is refused, never guessed at',
    );
    if (process.platform === 'win32') {
      const dpapi = SecretStore.dpapi();
      const real = dpapi.seal(API_KEY);
      t.check(
        real.startsWith('dpapi1:') && !real.includes(API_KEY) && dpapi.open(real) === API_KEY,
        'Windows DPAPI (through powershell.exe, nothing on a command line) seals and opens a value',
      );
      await t.throws(
        () => dpapi.open('dpapi1:AAAA'),
        'could not decrypt',
        'a value Windows cannot open fails with a message that says what to do',
      );
    } else t.skip('DPAPI needs Windows');

    t.section('saved Claude logins are encrypted at rest');
    const storage = t.at('cred-storage');
    const dataA = path.join(storage, 'data', 'x');
    const claudeDir = path.join(dataA, 'state', 'claude');
    t.write(path.join(claudeDir, '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"' + LOGIN + '-1"}}');
    t.write(path.join(claudeDir, '.claude.json'), '{"oauthAccount":{"emailAddress":"me@example.com"}}');
    const accounts = new AccountStore(storage);
    accounts.save(dataA, 'personal', null);
    const saved = fs.readFileSync(path.join(storage, 'accounts', 'personal.json'), 'utf8');
    t.check(
      !saved.includes(LOGIN) && saved.includes('me@example.com') && saved.includes('"sealed"'),
      'the file shows the name, date and e-mail only; the tokens are sealed',
    );
    t.check(
      accounts.list(dataA)[0]?.email === 'me@example.com' && accounts.meta('personal')?.name === 'personal',
      'listing needs no decryption',
    );
    t.includes(
      JSON.stringify(accounts.read('personal')?.credentials),
      LOGIN + '-1',
      'reading an account opens it (when switching)',
    );
    t.write(
      path.join(storage, 'accounts', 'old.json'),
      JSON.stringify({
        name: 'old',
        savedAt: '2026-01-01T00:00:00.000Z',
        email: null,
        credentials: { claudeAiOauth: { refreshToken: LOGIN + '-legacy' } },
        oauthAccount: {},
      }),
    );
    const migrated = new AccountStore(storage).list(dataA);
    t.check(
      migrated.some((a) => a.name === 'old') &&
        !fs.readFileSync(path.join(storage, 'accounts', 'old.json'), 'utf8').includes(LOGIN),
      'an account saved plain by an older version is encrypted the first time accounts are listed, and the plain text is gone',
    );
    t.includes(
      JSON.stringify(new AccountStore(storage).read('old')?.credentials),
      LOGIN + '-legacy',
      'and it still opens',
    );
    new AccountStore(storage).activate(dataA, 'old');
    t.includes(
      fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8'),
      LOGIN + '-legacy',
      'switching decrypts it into the sandbox state',
    );

    t.section('other agents: login files are encrypted at rest');
    const codexHome = t.at('cred-codex-home');
    t.write(path.join(codexHome, 'auth.json'), '{"token":"' + LOGIN + '-codex"}');
    const agent = new AgentAccountStore(storage, 'codex', ['auth.json']);
    agent.save(dataA, 'main', codexHome, true);
    const folder = path.join(storage, 'accounts', 'codex', 'main');
    t.check(
      fs.existsSync(path.join(folder, 'auth.json.sealed')) &&
        !fs.existsSync(path.join(folder, 'auth.json')) &&
        filesContaining(folder, LOGIN).length === 0,
      'the login file is stored sealed, never as it was',
    );
    const restored = t.at('cred-codex-to');
    agent.activate(dataA, 'main', restored);
    t.equal(
      fs.readFileSync(path.join(restored, 'auth.json'), 'utf8'),
      '{"token":"' + LOGIN + '-codex"}',
      'switching puts the original file back',
    );
    t.write(path.join(storage, 'accounts', 'codex', 'older', 'auth.json'), '{"token":"' + LOGIN + '-older"}');
    t.write(
      path.join(storage, 'accounts', 'codex', 'older', 'meta.json'),
      JSON.stringify({ name: 'older', savedAt: '2026-01-01T00:00:00.000Z' }),
    );
    agent.list(dataA);
    t.check(
      filesContaining(path.join(storage, 'accounts', 'codex', 'older'), LOGIN).length === 0 &&
        fs.existsSync(path.join(storage, 'accounts', 'codex', 'older', 'auth.json.sealed')),
      'a copy saved plain by an older version is encrypted when the accounts are listed',
    );

    t.section('the agent environment and the Claude login stay out of the launch folder');
    t.write(path.join(f.hostProfile, '.credentials.json'), '{"token":"' + LOGIN + '-host"}');
    const config = f.makeConfig();
    config.harnesses.claude.environment = { ANTHROPIC_API_KEY: API_KEY, DISABLE_AUTOUPDATER: '1' };
    config.claudeProfile.copyCredentials = true;
    const run = await f.run({}, config);
    const gen = f.generate(run);
    const session = fs.readFileSync(gen.sessionPath, 'utf8');
    t.check(
      !session.includes(API_KEY) && !session.includes(LOGIN),
      'session.json holds neither the API key nor the Claude login',
    );
    t.equal(
      filesContaining(gen.launchPath, API_KEY).concat(filesContaining(gen.launchPath, LOGIN + '-host')),
      [],
      'nothing in the launch folder holds them either (it is mapped into the sandbox and kept for days)',
    );
    t.equal(
      (f.readJson(gen.sessionPath).harness as { environment: object }).environment,
      {},
      "the booted agent's environment in session.json is empty",
    );
    const dir = new RunDir(run.dataPath);
    const handed = f.readJson(dir.secretFile(gen.launchId)) as SecretsFile;
    t.check(
      handed.harnessEnvironment?.ANTHROPIC_API_KEY === API_KEY &&
        handed.claudeCredentials?.includes(LOGIN + '-host') === true,
      'both are in the one-shot file in <data>\\secrets for the sandbox to read and delete',
      JSON.stringify(handed),
    );
    t.check(
      path.relative(dir.root, dir.secretsDir).startsWith('..'),
      'the one-shot folder is next to run, not in it: other users of a shared sandbox may change run',
    );
    const plan = sharingAclPlan({
      storageUserDir: storage,
      dataPath: path.join(storage, 'data', 'testdata'),
      groupSid: 'S-1-5-32-545',
      on: true,
    });
    t.check(
      plan.filter((c) => c.rights === 'Modify').every((c) => path.basename(c.path) === 'run') &&
        !plan.some((c) => c.path.includes('secrets')),
      'sharing opens only run for writing, never the secrets folder',
    );
    t.write(path.join(storage, 'launches', 'older', 'claude-profile', '.credentials.json'), '{"x":1}');
    t.check(
      clearSecrets(storage, run.dataPath) >= 2 &&
        !fs.existsSync(dir.secretFile(gen.launchId)) &&
        !fs.existsSync(path.join(storage, 'launches', 'older', 'claude-profile', '.credentials.json')),
      'what the sandbox never read, and a login left in an old launch folder, is removed (at launch and when the sandbox stops)',
    );
    t.write(path.join(f.hostProfile, '.credentials.json'), '{ "token": "secret" }');

    t.section('requests carry no environment values');
    const request: GuestRequest = {
      kind: 'session',
      id: 'req1',
      harness: 'codex',
      args: [],
      cwd: 'C:\\Workspace\\x',
      harnessSpec: { ...config.harnesses.claude, environment: { OPENAI_API_KEY: API_KEY } },
      project: {
        name: 'other',
        workspace: 'C:\\Workspace\\other',
        workspaceHost: 'C:\\other',
        toolchains: DEFAULTS.toolchains,
        versions: run.versions,
        databases: [],
        harnesses: { codex: { ...config.harnesses.claude, environment: { OTHER_KEY: API_KEY + '-2' } } },
        hooks: false,
      },
      createdAt: new Date().toISOString(),
    };
    const stripped = withoutSecrets(request);
    t.check(
      !JSON.stringify(stripped.request).includes(API_KEY) &&
        stripped.secrets?.harnessSpecEnvironment?.OPENAI_API_KEY === API_KEY &&
        stripped.secrets?.projectHarnessEnvironment?.codex?.OTHER_KEY === API_KEY + '-2',
      'withoutSecrets takes the values out of the agent and the project agents',
    );
    t.equal(
      mergeRequestSecrets(stripped.request as typeof request, stripped.secrets ?? {}),
      request,
      'the sandbox puts them back, exactly, in memory',
    );
    t.equal(withoutSecrets({ kind: 'ping', id: 'p', createdAt: 'now' }).secrets, null, 'other requests are untouched');
    const sent = new SandboxChannel(run.dataPath, () => true);
    sent.requestSession('codex', [], 'C:\\Workspace\\x', { harnessSpec: request.harnessSpec as never });
    const requestFiles = fs.readdirSync(dir.requestsDir);
    t.check(
      requestFiles.length === 1 &&
        filesContaining(dir.root, API_KEY).length === 0 &&
        filesContaining(dir.secretsDir, API_KEY).length === 1,
      'the host channel writes the request without the value (nothing in run holds it) and the value into its own one-shot file',
    );
    clearSecrets(storage, run.dataPath);

    t.section('network.proxy takes no login');
    const withProxy = (proxy: string): ReturnType<typeof ConfigSchema.safeParse> =>
      ConfigSchema.safeParse({ ...DEFAULTS, network: { ...DEFAULTS.network, proxy } });
    t.check(
      withProxy('http://proxy.corp:8080').success && withProxy('').success,
      'a proxy address without a login is accepted',
    );
    const refused = withProxy('http://user:pass@proxy.corp:8080');
    t.check(
      !refused.success && JSON.stringify(refused.error?.issues).includes('no user name or password'),
      'a user name and password in the address is refused, with a plain reason',
    );
    t.check(!withProxy('https://token@proxy.corp').success, 'a lone token in front of @ is refused too');

    t.section('secrets print as ***');
    t.check(
      secretPaths().some((p) => p.join('.') === 'harnesses.*.environment.*'),
      'agent environment values are marked secret in the schema',
    );
    t.check(
      new SchemaNode(HarnessSchema).child('environment')?.element?.secret === true,
      'the settings screen knows them as secret too (hidden input, *** in lists)',
    );
    const planted = structuredClone(config);
    const shown = redactSecrets(planted);
    t.check(
      shown.harnesses.claude.environment.ANTHROPIC_API_KEY === '***' &&
        shown.harnesses.claude.environment.DISABLE_AUTOUPDATER === '***' &&
        planted.harnesses.claude.environment.ANTHROPIC_API_KEY === API_KEY &&
        shown.harnesses.codex.arguments.length === planted.harnesses.codex.arguments.length,
      'redactSecrets hides every environment value and leaves the rest and the original alone',
    );
    t.excludes(
      scrubSecrets(JSON.stringify({ anything: 'x ' + API_KEY + ' y' }), planted),
      API_KEY,
      'scrubSecrets removes a secret from any text built from a config',
    );
    const home = t.dir('cred-cli', 'home');
    const cliConfig = t.writeJson(t.at('cred-cli', 'config.json'), {
      storage: { root: t.dir('cred-cli', 'storage') },
      personalization: { enabled: false },
      provisioning: { terminal: { enabled: false } },
      harnesses: {
        planted: { npmPackage: 'planted', npmBin: 'planted', arguments: [], environment: { PLANTED_KEY: API_KEY } },
      },
    });
    const baseEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !['AGENT_SANDBOX_CONFIG', 'AGENT_WORKSPACE'].includes(k)),
    );
    const env = {
      ...baseEnv,
      AGENT_SANDBOX_HOME: home,
      AGENT_LAUNCH_DIR: t.at('cred-cli', 'no-launch'),
      AGENT_DATA_DIR: t.at('cred-cli', 'no-data'),
      NO_COLOR: '1',
      AGENT_SANDBOX_HOST_ONLY: '1',
    };
    for (const args of [
      ['config', 'show'],
      ['doctor', '--json'],
      ['vpn', 'status', '--json'],
      ['status', '--json'],
    ]) {
      const out = await f.runBin('sandbox', [...args, '--config', cliConfig], { cwd: f.workA, env });
      t.check(
        !out.out.includes(API_KEY) && (args[0] !== 'config' || out.out.includes('***')),
        'sandbox ' + args.join(' ') + ' never prints the planted key' + (args[0] === 'config' ? ' (it shows ***)' : ''),
        out.out.slice(0, 400),
      );
    }
  },
};

// Claude accounts: saving logins from the sandbox or this PC, switching, and the names that are refused.
import fs from 'node:fs';
import path from 'node:path';
import { AccountStore } from '../host/profile/index.js';
import { SecretStore } from '../host/secrets/secret-store.js';
import { DEFAULTS } from '../core/config/index.js';
import { accountsPage, accountsText, agentPage, defaultAccount } from '../app/features/accounts/index.js';
import { fakeIO } from '../app/kernel/index.js';
import { runDefinition } from '../app/registry.js';
import { buildProgram, parseCli } from '../cli/args.js';
import { MenuOperations } from '../cli/menu/io-menu.js';
import { menuView } from '../cli/menu/render-view.js';
import { cliInput, definitionFor } from '../cli/operations/index.js';
import { AccountsService } from '../cli/services/index.js';
import type { AppContext } from '../app/context.js';
import type { Fixtures } from './support/fixtures.js';
import type { Harness } from './support/harness.js';
import type { Suite } from './support/suite.js';

export const accountsSuite: Suite = {
  name: 'accounts',
  title: 'Claude accounts (save, switch, remove, safe names)',
  run: async (t, f) => {
    t.section('saving and switching');
    const storage = t.at('acct-storage');
    const dataA = path.join(storage, 'data', 'x');
    const sandboxClaude = path.join(dataA, 'state', 'claude');
    t.write(path.join(sandboxClaude, '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"personal-1"}}');
    t.write(path.join(sandboxClaude, '.claude.json'), '{"oauthAccount":{"emailAddress":"me@personal"},"other":1}');
    new AccountStore(storage).save(dataA, 'personal', null);
    t.write(t.at('host-login', '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"work-1"}}');
    t.write(t.at('host-login.json'), '{"oauthAccount":{"emailAddress":"me@work"}}');
    new AccountStore(storage).save(dataA, 'work', {
      claudeDir: t.at('host-login'),
      globalStateFile: t.at('host-login.json'),
    });
    t.check(
      new AccountStore(storage).list(dataA).length === 2 &&
        new AccountStore(storage).defaultName() === 'personal' &&
        new AccountStore(storage).activeFor(dataA) === 'personal',
      'accounts can be saved from the sandbox and from this PC; the first one saved is the default and active',
    );
    t.check(
      !fs.existsSync(path.join(sandboxClaude, '.agent-sandbox-account')) &&
        fs.existsSync(path.join(storage, 'accounts', 'index.json')),
      'which account is active is recorded host-side, not inside the sandbox',
    );

    t.write(path.join(sandboxClaude, '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"personal-2"}}');
    new AccountStore(storage).activate(dataA, 'work');
    const stateAfter = f.readJson(path.join(sandboxClaude, '.claude.json'));
    t.check(
      fs.readFileSync(path.join(sandboxClaude, '.credentials.json'), 'utf8').includes('work-1') &&
        stateAfter.oauthAccount.emailAddress === 'me@work' &&
        stateAfter.other === 1 &&
        new AccountStore(storage).activeFor(dataA) === 'work',
      'switching swaps in the other credentials and account, keeps the rest of the sandbox state, and marks it active',
    );
    t.includes(
      JSON.stringify(new AccountStore(storage).read('personal')?.credentials),
      'personal-2',
      "the outgoing account's refreshed tokens are saved back before switching",
    );

    t.section('make default, as the menu runs it');
    const menuCtx = {
      packageRoot: t.dir('acct-menu', 'package'),
      options: {},
      loaded: { config: structuredClone(DEFAULTS), configPath: null, base: t.temp },
      storageRoot: storage,
      dataPath: dataA,
    } as unknown as AppContext;
    let said: string | undefined;
    let error: unknown = null;
    try {
      said = await new MenuOperations({} as never, menuCtx).run(
        defaultAccount,
        { agent: 'claude', name: 'personal', noRestart: false },
        [],
      );
    } catch (e) {
      error = e;
    }
    t.check(
      error === null &&
        new AccountStore(storage).defaultName() === 'personal' &&
        new AccountStore(storage).activeFor(dataA) === 'personal',
      'make default from the menu sets the default and switches the sandbox to it',
      String(error instanceof Error ? error.stack : (error ?? said)),
    );

    t.section('sharing plugins between data sets');
    const plugA = path.join(storage, 'data', 'p1', 'state', 'claude');
    const plugB = path.join(storage, 'data', 'p2', 'state', 'claude');
    const plugC = path.join(storage, 'data', 'p3', 'state', 'claude');
    const login = '{"claudeAiOauth":{"refreshToken":"x"}}';
    for (const dir of [plugA, plugB, plugC]) t.write(path.join(dir, '.credentials.json'), login);
    t.write(path.join(plugA, 'plugins', 'installed_plugins.json'), '{"version":2,"plugins":{}}');
    t.write(path.join(plugA, 'plugins', 'cache', 'm', 'p', 'a.js'), 'x');
    t.write(path.join(plugA, 'settings.json'), '{"theme":"dark","enabledPlugins":{"p@m":true}}');
    t.write(path.join(plugB, 'settings.json'), '{"theme":"light","enabledPlugins":{"q@m":false}}');
    const dataP = (n: string): string => path.join(storage, 'data', n);
    const off = new AccountStore(storage);
    off.save(dataP('p1'), 'one', null);
    off.activate(dataP('p2'), 'one');
    t.check(!fs.existsSync(path.join(plugB, 'plugins')), 'plugins are not copied when the setting is off (default)');
    const on = new AccountStore(storage, true);
    on.activate(dataP('p1'), 'one');
    on.activate(dataP('p2'), 'one');
    const settingsB = f.readJson(path.join(plugB, 'settings.json'));
    t.check(
      fs.existsSync(path.join(plugB, 'plugins', 'cache', 'm', 'p', 'a.js')) &&
        settingsB.theme === 'light' &&
        settingsB.enabledPlugins['p@m'] === true &&
        settingsB.enabledPlugins['q@m'] === false &&
        !fs.existsSync(path.join(storage, 'accounts', 'shared-plugins', '.credentials.json')),
      'on: plugins and enabledPlugins reach the other data set; its own settings win and no login travels',
    );
    const sentinel = path.join(storage, 'accounts', 'shared-plugins', 'plugins', 'cache', 'kept.js');
    t.write(sentinel, 'k');
    on.activate(dataP('p1'), 'one');
    t.check(fs.existsSync(sentinel), 'switching with the same plugins does not copy the plugins folder again');
    t.write(path.join(plugA, 'plugins', 'installed_plugins.json'), '{"version":2,"plugins":{"p@m":[]}}');
    on.activate(dataP('p1'), 'one');
    t.check(!fs.existsSync(sentinel), 'once a plugin changed, the switch refreshes the shared set');
    t.write(path.join(plugC, 'plugins', 'installed_plugins.json'), '{}');
    const outside = t.dir('plugin-victim');
    t.write(path.join(outside, 'secret.txt'), 's');
    fs.symlinkSync(outside, path.join(plugC, 'plugins', 'cache'), 'junction');
    on.activate(dataP('p3'), 'one');
    t.check(
      (on.pluginNote ?? '').includes('link') &&
        !fs.existsSync(path.join(storage, 'accounts', 'shared-plugins', 'plugins', 'cache', 'secret.txt')),
      'a link in the plugins is refused (the switch still works) and nothing behind it is copied',
    );

    const dataQ = dataP('p4');
    const plugQ = path.join(dataQ, 'state', 'claude');
    t.write(path.join(plugQ, 'plugins', 'installed_plugins.json'), '{"version":2}');
    t.write(path.join(plugQ, 'plugins', 'cache', 'new.js'), 'n');
    on.syncPlugins(dataQ);
    const plugR = path.join(storage, 'data', 'p5', 'state', 'claude');
    on.syncPlugins(dataP('p5'));
    t.check(
      fs.existsSync(path.join(plugR, 'plugins', 'cache', 'new.js')),
      'launch-time refresh: plugins installed in one data set reach the shared set and the next empty data set',
    );

    await apiKeyAccounts(t, f);

    t.section('removing and refusing');
    new AccountStore(storage).setDefault('work');
    new AccountStore(storage).remove('work');
    t.equal(new AccountStore(storage).defaultName(), null, 'removing the default account clears the default');
    await t.throws(
      () => new AccountStore(storage).activate(dataA, 'nope'),
      'Unknown account',
      'an unknown account cannot be activated',
    );
    await t.throws(
      () => new AccountStore(storage).save(dataA, '../x', null),
      'Invalid account name',
      'a path-like account name is rejected',
    );
    const victim = t.dir('victim');
    const otherData = t.at('acct-storage', 'data', 'd');
    const fromHost = { claudeDir: victim, globalStateFile: victim };
    await t.throws(
      () => new AccountStore(t.at('acct-storage')).save(otherData, 'index', fromHost),
      'Invalid account name',
      'an account cannot be called "index" (it would overwrite the index)',
    );
    await t.throws(
      () => new AccountStore(t.at('acct-storage')).save(otherData, 'con', fromHost),
      'Invalid account name',
      'an account cannot be named after a device (it would open a device)',
    );
  },
};

// Made-up keys with the shape of real ones (sk-ant-api03-...), each with its own last four characters.
const CONSOLE_KEY = 'sk-ant-api03-' + 'c'.repeat(80) + '-Cons';
const TYPED_KEY = 'sk-ant-api03-' + 't'.repeat(80) + '_Type';
const ENV_KEY = 'sk-ant-api03-' + 'e'.repeat(80) + '-Envy';

/** Every file below `root` whose text holds `needle` (relative paths). */
function filesHolding(root: string, needle: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.join(d.parentPath, d.name))
    .filter((file) => fs.readFileSync(file, 'latin1').includes(needle))
    .map((file) => path.relative(root, file).replace(/\\/g, '/'));
}

/** API key accounts: a Console login or a key, saved from the sandbox, this PC or typed, and switched to and back. */
async function apiKeyAccounts(t: Harness, f: Fixtures): Promise<void> {
  t.section('API key accounts: saving');
  const storage = t.at('key-storage');
  const data = path.join(storage, 'data', 'k');
  const claude = path.join(data, 'state', 'claude');
  const store = new AccountStore(storage, false, SecretStore.memory());
  t.write(path.join(claude, '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"sub-1"},"mcpOAuth":{"m":1}}');
  t.write(path.join(claude, '.claude.json'), '{"oauthAccount":{"emailAddress":"me@sub"},"other":1}');
  store.save(data, 'sub', null);

  // A Console login inside the sandbox: Claude keeps the key it made in .claude.json, no claudeAiOauth.
  t.write(path.join(claude, '.credentials.json'), '{"mcpOAuth":{"m":1}}');
  t.writeJson(path.join(claude, '.claude.json'), {
    oauthAccount: { emailAddress: 'me@console' },
    primaryApiKey: CONSOLE_KEY,
    customApiKeyResponses: { approved: [CONSOLE_KEY.slice(-20)], rejected: [] },
    other: 1,
  });
  const consoleSaved = store.save(data, 'console', null);
  const consoleFile = fs.readFileSync(path.join(storage, 'accounts', 'console.json'), 'utf8');
  t.check(
    consoleSaved.kind === 'console' &&
      consoleSaved.email === 'me@console' &&
      consoleSaved.keyHint === 'sk-ant-...Cons' &&
      !consoleFile.includes(CONSOLE_KEY) &&
      consoleFile.includes('sk-ant-...Cons') &&
      store.activeFor(data) === 'console',
    "the sandbox's Console login is saved as a Console account: sealed, with only sk-ant-...last4 readable",
    consoleFile,
  );

  const typed = store.saveApiKey(data, 'typed', '  ' + TYPED_KEY + '\n');
  t.check(
    typed.kind === 'api-key' && typed.keyHint === 'sk-ant-...Type' && store.activeFor(data) === 'console',
    'a typed key is saved as an API key account (trimmed); it is not active until used',
  );
  for (const [bad, why] of [
    ['hello', 'a word'],
    ['sk-ant-oat01-' + 'x'.repeat(60), 'a subscription token'],
    ['sk-ant-admin01-' + 'x'.repeat(60), 'an Admin key'],
    ['sk-ant-api03-short', 'a short key'],
    ['sk-ant-api03-' + 'x'.repeat(60) + '\u001b[31m', 'a key with control characters'],
  ] as const) {
    const message = await t.thrownMessage(() => store.saveApiKey(data, 'bad', bad));
    t.check(
      message.includes('not an Anthropic API key') && !message.includes(bad.length > 13 ? bad.slice(13) : bad),
      'a key with the wrong shape is refused without being quoted: ' + why,
      message,
    );
  }

  // This PC: a Console key in its .claude.json, else ANTHROPIC_API_KEY; --api-key skips a subscription.
  const pc = t.dir('key-pc', 'claude');
  const pcState = t.at('key-pc', '.claude.json');
  t.write(path.join(pc, '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"pc-sub"}}');
  t.write(pcState, '{"oauthAccount":{"emailAddress":"me@pc"}}');
  const pcFiles = { claudeDir: pc, globalStateFile: pcState };
  t.equal(store.save(data, 'pc-sub', pcFiles, { envKey: ENV_KEY }).kind, 'subscription', 'PC: a subscription first');
  const pcKey = store.save(data, 'pc-env', pcFiles, { keyOnly: true, envKey: ENV_KEY });
  t.check(
    pcKey.kind === 'api-key' && pcKey.email === null && store.read('pc-env')?.apiKey === ENV_KEY,
    "PC --api-key: this PC's ANTHROPIC_API_KEY is saved (its subscription is skipped)",
  );
  t.writeJson(pcState, { oauthAccount: { emailAddress: 'me@pc-console' }, primaryApiKey: CONSOLE_KEY });
  t.equal(
    store.save(data, 'pc-console', pcFiles, { keyOnly: true, envKey: ENV_KEY }).kind,
    'console',
    "PC --api-key: this PC's Console login comes before ANTHROPIC_API_KEY",
  );
  await t.throws(
    () =>
      store.save(
        data,
        'none',
        { claudeDir: t.dir('key-empty'), globalStateFile: t.at('key-empty', 'x.json') },
        { keyOnly: true },
      ),
    'No Claude API key found',
    'no key anywhere: says so (and how to type one)',
  );

  // The sandbox is hostile: a planted primaryApiKey that is not a key is never saved.
  const hostileData = path.join(storage, 'data', 'h');
  const hostile = path.join(hostileData, 'state', 'claude');
  t.writeJson(path.join(hostile, '.claude.json'), {
    primaryApiKey: 'sk-ant-api03-' + 'x'.repeat(40) + '\u001b]52;c;evil\u0007',
  });
  await t.throws(
    () => store.save(hostileData, 'hostile', null),
    'No Claude login found',
    'a primaryApiKey from the sandbox without the shape of a key is refused',
  );

  t.section('API key accounts: switching and back');
  t.write(
    path.join(claude, '.credentials.json'),
    '{"claudeAiOauth":{"refreshToken":"console-made"},"mcpOAuth":{"m":2}}',
  );
  store.activate(data, 'sub');
  const subState = f.readJson(path.join(claude, '.claude.json'));
  const subCreds = f.readJson(path.join(claude, '.credentials.json'));
  t.check(
    !('primaryApiKey' in subState) &&
      !subState.customApiKeyResponses.approved.includes(CONSOLE_KEY.slice(-20)) &&
      subState.oauthAccount.emailAddress === 'me@sub' &&
      subState.other === 1 &&
      subCreds.claudeAiOauth.refreshToken === 'sub-1',
    'back to a subscription: the key and its approval leave the sandbox, the subscription is in again',
    JSON.stringify(subState),
  );
  t.check(
    store.read('console')?.kind === 'console' && store.read('console')?.apiKey === CONSOLE_KEY,
    'a key account is never overwritten with what the sandbox holds when switching away from it',
  );

  t.write(path.join(claude, '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"sub-2"},"mcpOAuth":{"m":3}}');
  store.activate(data, 'typed');
  const keyStateNow = f.readJson(path.join(claude, '.claude.json'));
  const keyCreds = f.readJson(path.join(claude, '.credentials.json'));
  t.check(
    keyStateNow.primaryApiKey === TYPED_KEY &&
      keyStateNow.customApiKeyResponses.approved.includes(TYPED_KEY.slice(-20)) &&
      !keyStateNow.customApiKeyResponses.rejected.includes(TYPED_KEY.slice(-20)) &&
      !('oauthAccount' in keyStateNow) &&
      keyStateNow.other === 1 &&
      !('claudeAiOauth' in keyCreds) &&
      keyCreds.mcpOAuth.m === 3,
    'to an API key: the key goes where a Console login keeps it, pre-approved (no prompt); the subscription leaves, MCP logins stay',
    JSON.stringify({ keyStateNow, keyCreds }),
  );
  t.includes(
    JSON.stringify(store.read('sub')?.credentials),
    'sub-2',
    "the outgoing subscription's refreshed tokens are still saved back",
  );
  t.equal(
    filesHolding(storage, TYPED_KEY),
    ['data/k/state/claude/.claude.json'],
    "the key is in the sandbox's Claude state only: not in the account files, the index, run\\ or logs",
  );

  store.activate(data, 'console');
  const consoleState = f.readJson(path.join(claude, '.claude.json'));
  t.check(
    consoleState.primaryApiKey === CONSOLE_KEY &&
      !consoleState.customApiKeyResponses.approved.includes(TYPED_KEY.slice(-20)) &&
      consoleState.oauthAccount.emailAddress === 'me@console' &&
      fs.existsSync(path.join(claude, '.credentials.json')),
    'key to key: the new key replaces the old one and its approval; the Console account brings its e-mail',
  );

  t.section('API key accounts: listing, renaming, removing');
  const rows = store.list(data);
  const kindOf = (n: string): string | undefined => rows.find((r) => r.name === n)?.kind;
  t.check(
    kindOf('sub') === 'subscription' && kindOf('console') === 'console' && kindOf('typed') === 'api-key',
    'list says the kind of every Claude account',
  );
  const text = accountsText({
    agent: 'claude',
    agents: [{ name: 'claude', kept: true, canSavePc: true, accounts: rows }],
  });
  t.check(
    text.includes('KIND') &&
      text.includes('API key sk-ant-...Type') &&
      text.includes('Console sk-ant-...Cons') &&
      text.includes('subscription') &&
      ![TYPED_KEY, CONSOLE_KEY, ENV_KEY].some((k) => text.includes(k.slice(13, 40))),
    'the command line table shows the kind and sk-ant-...last4, never the key',
    text,
  );
  const claudeRows = { name: 'claude', kept: true, canSavePc: true, accounts: rows };
  const menu = menuView(agentPage(claudeRows), { category: 'claude', refresh: false });
  const page = JSON.stringify(accountsPage({ agent: 'claude', agents: [claudeRows] }));
  t.check(
    menu.actions.some((a) => a.key === 'k') &&
      page.includes('+ Save an API key') &&
      page.includes('"API key"') &&
      page.includes('Console sk-ant-...Cons') &&
      !page.includes(TYPED_KEY.slice(13, 40)),
    'menu and web: a Save an API key row (k), and each login says its kind',
  );
  store.rename('typed', 'free');
  t.check(
    store.read('free')?.apiKey === TYPED_KEY && store.meta('free')?.kind === 'api-key' && store.meta('typed') === null,
    'rename keeps the key and its kind',
  );
  store.remove('free');
  t.equal(filesHolding(path.join(storage, 'accounts'), 'sk-ant-...Type'), [], 'remove deletes the key account');

  t.section('API key accounts: the operation and the command line');
  const ctx = {
    packageRoot: t.dir('key-op', 'package'),
    options: {},
    loaded: { config: structuredClone(DEFAULTS), configPath: null, base: t.temp },
    storageRoot: t.dir('key-op', 'storage'),
    dataPath: t.dir('key-op', 'storage', 'data', 'o'),
  } as unknown as AppContext;
  const asked = fakeIO(['sk-ant-api03-nope', TYPED_KEY]);
  const out = (await runDefinition(
    'accounts.save',
    ctx,
    { agent: 'claude', name: 'typed', apiKey: true },
    asked.io,
  )) as { message: string };
  const said = JSON.stringify([out, asked.seen]);
  t.check(
    asked.seen.questions.length === 2 &&
      asked.seen.questions.every((q) => q.kind === 'secret') &&
      (asked.seen.questions[1] as { problem?: string }).problem?.includes('sk-ant-api') === true &&
      out.message === 'Saved account "typed" (API key sk-ant-...Type).' &&
      !said.includes(TYPED_KEY.slice(13)),
    'save --api-key asks for the key hidden, asks again on a bad one, and says only sk-ant-...last4',
    said,
  );
  await t.throws(
    () => runDefinition('accounts.save', ctx, { agent: 'codex', name: 'x', apiKey: true }, fakeIO([]).io),
    'for Claude accounts only',
    'save --api-key is refused for another agent',
  );
  t.write(t.at('key-op', 'pc', '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"pc"}}');
  ctx.loaded.config.claudeProfile.hostDir = t.at('key-op', 'pc');
  ctx.loaded.config.claudeProfile.globalStateFile = t.at('key-op', 'pc', '.claude.json');
  const pcSaved = new AccountsService(ctx, { ANTHROPIC_API_KEY: ENV_KEY }).save('pc-key', true, 'claude', true);
  t.check(
    pcSaved.kind === 'api-key' && pcSaved.keyHint === 'sk-ant-...Envy',
    "save --from-host --api-key takes this PC's ANTHROPIC_API_KEY",
  );
  const used = (await runDefinition(
    'accounts.use',
    ctx,
    { agent: 'claude', name: 'pc-key', noRestart: true },
    fakeIO([]).io,
  )) as { lines: string[] };
  t.check(
    used.lines[0] === 'Sandbox now uses "pc-key" (API key sk-ant-...Envy).' &&
      f.readJson(path.join(ctx.dataPath, 'state', 'claude', '.claude.json')).primaryApiKey === ENV_KEY,
    'use switches the sandbox to the key and says which kind it is',
    used.lines.join('\n'),
  );

  const save = definitionFor('account', ['save'])!;
  const help = buildProgram(() => undefined)
    .commands.find((c) => c.name() === 'account')!
    .helpInformation();
  t.check(
    JSON.stringify(cliInput(save, parseCli(['account', 'save', 'free', '--api-key']))) ===
      JSON.stringify({ name: 'free', apiKey: true }) &&
      JSON.stringify(cliInput(save, parseCli(['account', 'save', 'free', '--api-key', '--from-host']))) ===
        JSON.stringify({ name: 'free', fromHost: true, apiKey: true }) &&
      help.includes('--api-key'),
    'command line: sandbox account save <name> --api-key [--from-host], shown in --help',
    help,
  );
}

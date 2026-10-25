// Claude accounts: saving logins from the sandbox or this PC, switching, and the names that are refused.
import fs from 'node:fs';
import path from 'node:path';
import { AccountStore } from '../host/profile/index.js';
import { DEFAULTS } from '../core/config/index.js';
import { defaultAccount } from '../app/features/accounts/index.js';
import { MenuOperations } from '../cli/menu/io-menu.js';
import type { AppContext } from '../app/context.js';
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

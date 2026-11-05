// What reaches the sandbox from this PC's Claude files, and what is stripped first: API keys, cloud credentials, tokens
// in MCP server definitions. Also the secret-looking files in a workspace that the launch warns about.
import path from 'node:path';
import fs from 'node:fs';
import { DEFAULTS } from '../core/config/index.js';
import {
  findSecretFiles,
  pluginFilter,
  pluginTrimLevel,
  sandboxGlobalState,
  stageClaudeProfile,
  stripMcpServers,
  stripSettings,
} from '../host/profile/index.js';
import type { Suite } from './support/suite.js';

const REMOVED = '[removed by agent-sandbox]';

export const secretsSuite: Suite = {
  name: 'secrets',
  title: 'credentials stripped from everything copied into the sandbox',
  run: (t) => {
    t.section('~/.claude.json');
    const state = sandboxGlobalState(
      {
        primaryApiKey: 'sk-secret',
        oauthAccount: { emailAddress: 'me' },
        mcpServers: { a: {} },
        theme: 'dark',
        projects: {
          'D:/Code/app': { mcpServers: { db: { env: { TOKEN: 'mine' } } } },
          'D:/Other': { mcpServers: { x: { env: { TOKEN: 'other' } } } },
        },
      },
      'D:\\Code\\app',
    );
    const stateText = JSON.stringify(state);
    t.check(!('primaryApiKey' in state), 'the sandbox never gets your API key');
    t.check(!('oauthAccount' in state), 'the sandbox never gets your signed-in account');
    t.includes(stateText, 'mine', "the sandbox gets this project's MCP servers");
    t.excludes(stateText, 'other', 'the sandbox never gets other projects');
    t.equal(state.theme, 'dark', 'ordinary settings are kept');

    t.section('settings.json');
    const secrets = { strip: true, allow: ['AWS_REGION'], patterns: ['ACME_*'], warnFiles: true };
    const removed: string[] = [];
    const settings = stripSettings(
      {
        apiKeyHelper: 'aws-vault exec prod -- get-key',
        model: 'opus',
        env: {
          AWS_ACCESS_KEY_ID: 'x',
          AWS_SECRET_ACCESS_KEY: 'y',
          AWS_REGION: 'eu-west-2',
          AZURE_CLIENT_SECRET: 'z',
          ARM_CLIENT_ID: 'id',
          CLOUDFLARE_API_TOKEN: 't',
          GOOGLE_APPLICATION_CREDENTIALS: 'C:\\key.json',
          PROD_DB_HOST: 'db.internal',
          STRIPE_KEY: 'k',
          ACME_THING: 'a',
          DATABASE_URL: 'postgres://u:p@h/db',
          INNOCENT: 'AKIAABCDEFGHIJKLMNOP',
          SAFE_URL: 'https://example.com',
          DISABLE_TELEMETRY: '1',
          CLAUDE_CODE_USE_BEDROCK: '1',
        },
      },
      secrets,
      removed,
    );
    const env = settings.env as Record<string, string>;
    t.check(
      !('apiKeyHelper' in settings) && settings.model === 'opus',
      'settings: the API key helper goes, ordinary settings stay',
    );
    t.equal(
      Object.keys(env).sort(),
      ['AWS_REGION', 'CLAUDE_CODE_USE_BEDROCK', 'DISABLE_TELEMETRY', 'SAFE_URL'],
      'settings: AWS, Azure, Google, Cloudflare, prod, payment and database credentials (by name or by value) stay on this PC; secrets.allow and ordinary settings pass',
    );
    t.check(
      removed.some((r) => r.endsWith('AWS_SECRET_ACCESS_KEY')),
      'settings: what was removed is reported',
      JSON.stringify(removed),
    );
    t.equal(
      JSON.stringify(stripSettings({ env: { AWS_SECRET_ACCESS_KEY: 'y' } }, { ...secrets, strip: false }, [])),
      '{"env":{"AWS_SECRET_ACCESS_KEY":"y"}}',
      'secrets.strip = false copies settings unchanged',
    );

    t.section('MCP servers');
    const mcp = stripMcpServers(
      {
        mcpServers: {
          gh: {
            command: 'npx',
            args: ['server', '--api-key', 'plain', '--verbose', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
            env: { GITHUB_TOKEN: 'g', LOG_LEVEL: 'debug' },
          },
        },
        projects: {
          'D:/app': {
            mcpServers: {
              api: {
                type: 'http',
                url: 'https://x',
                headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz', Accept: 'json' },
              },
            },
          },
        },
      },
      secrets,
      [],
    );
    const gh = (mcp.mcpServers as Record<string, { args: string[]; env: object }>).gh;
    const api = (mcp.projects as Record<string, { mcpServers: Record<string, { headers: object }> }>)['D:/app']
      .mcpServers.api;
    t.equal(
      gh.args,
      ['server', '--api-key', REMOVED, '--verbose', REMOVED],
      'MCP servers: key arguments and token-looking arguments are removed',
    );
    t.equal(gh.env, { LOG_LEVEL: 'debug' }, 'MCP servers: token env vars are removed, the rest stays');
    t.equal(api.headers, { Accept: 'json' }, 'MCP servers: Authorization headers are removed');

    const sneaky = stripMcpServers(
      {
        mcpServers: {
          r: {
            type: 'http',
            url: 'https://mcp.example.com/mcp?api_key=0123456789abcdef&region=eu',
            headers: { 'X-API-Key': 'k', 'x-auth-token': 't', Accept: 'json' },
            args: [
              '--api-key=deadbeefdeadbeef',
              '--header',
              'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
              '--port=8080',
            ],
          },
        },
      },
      secrets,
      [],
    );
    const r = (sneaky.mcpServers as Record<string, { url: string; headers: object; args: string[] }>).r;
    t.equal(
      r.url,
      'https://mcp.example.com/mcp?api_key=REMOVED&region=eu',
      'MCP servers: ?api_key= in URLs is removed',
    );
    t.equal(r.headers, { Accept: 'json' }, 'MCP servers: X-API-Key style headers are removed');
    t.equal(
      [r.args[0], r.args[2], r.args[3]],
      [REMOVED, REMOVED, '--port=8080'],
      'MCP servers: --flag=value keys and "Authorization: Bearer" arguments are removed, ordinary flags stay',
    );

    t.section('secret-looking files in the workspace');
    const workspace = t.at('secret-ws');
    for (const file of [
      '.env',
      '.env.example',
      'server.pem',
      'README.md',
      'api/credentials.json',
      'node_modules/x/.env',
    ])
      t.write(path.join(workspace, file), 'x');
    t.equal(
      findSecretFiles(workspace).sort(),
      ['.env', 'api\\credentials.json', 'server.pem'],
      'secret-looking workspace files are found for the launch warning (templates and dependencies ignored)',
    );

    t.section('plugins staged from this PC');
    const hostClaude = t.at('plugins-host');
    const plugins = path.join(hostClaude, 'plugins');
    t.write(path.join(plugins, 'installed_plugins.json'), '{"version":2,"plugins":{}}');
    t.write(path.join(plugins, 'known_marketplaces.json'), '{}');
    t.write(path.join(plugins, 'cache', 'm', 'p', '1.0', 'plugin.json'), '{}');
    t.write(path.join(plugins, 'cache', 'm', 'p', '1.0', 'node_modules', 'dep', 'index.js'), 'x');
    t.write(path.join(plugins, 'cache', 'temp_git_1_abc', 'junk.txt'), 'x');
    t.write(path.join(plugins, 'marketplaces', 'm', 'marketplace.json'), '{}');
    t.write(path.join(plugins, 'marketplaces', 'm', '.git', 'HEAD'), 'ref');
    t.write(path.join(plugins, 'marketplaces', 'm.backup', 'old.txt'), 'x');
    t.write(path.join(plugins, 'marketplaces', 'temp_subdir_2.clone', 'junk.txt'), 'x');
    t.write(path.join(hostClaude, 'settings.json'), '{"enabledPlugins":{"p@m":true}}');
    const launch = t.at('plugins-launch');
    const profile = { ...DEFAULTS.claudeProfile, hostDir: hostClaude, globalStateFile: '' };
    const staged = stageClaudeProfile(profile, launch, 'D:/Code/app', DEFAULTS.secrets);
    const out = path.join(launch, 'claude-profile', 'plugins');
    t.check(staged.staged.includes('plugins'), 'plugins are staged');
    t.check(
      fs.existsSync(path.join(out, 'cache', 'm', 'p', '1.0', 'plugin.json')) &&
        fs.existsSync(path.join(out, 'marketplaces', 'm', 'marketplace.json')) &&
        fs.existsSync(path.join(out, 'marketplaces', 'm', '.git', 'HEAD')) &&
        fs.existsSync(path.join(out, 'cache', 'm', 'p', '1.0', 'node_modules', 'dep', 'index.js')),
      'the plugin cache, marketplaces and (when they fit) their git folders and dependencies are copied',
    );
    t.check(
      !fs.existsSync(path.join(out, 'cache', 'temp_git_1_abc')) &&
        !fs.existsSync(path.join(out, 'marketplaces', 'm.backup')) &&
        !fs.existsSync(path.join(out, 'marketplaces', 'temp_subdir_2.clone')),
      'interrupted clones, backups and staging folders of plugins are left out',
    );
    t.check(pluginTrimLevel(plugins) === 0, 'a plugins folder under the cap is not trimmed');
    const git = path.join(plugins, 'marketplaces', 'm', '.git');
    const deps = path.join(plugins, 'cache', 'm', 'p', '1.0', 'node_modules');
    t.check(
      pluginFilter(plugins, 0)(git) &&
        !pluginFilter(plugins, 1)(git) &&
        pluginFilter(plugins, 1)(deps) &&
        !pluginFilter(plugins, 2)(deps),
      'a plugins folder over the cap loses git history first, then node_modules',
    );
    t.check(
      fs.readFileSync(path.join(launch, 'claude-profile', 'settings.json'), 'utf8').includes('p@m'),
      'enabledPlugins reach the sandbox',
    );
  },
};
